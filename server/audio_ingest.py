"""Audio ingest pipeline: reads from a local microphone and feeds two async queues.

Architecture:
  Microphone (PyAudio) → asyncio.to_thread(stream.read) → Queue A (Soniox) + Queue B (Admin visualizer)

Key design decisions (see lessons.md):
  - Cooperative shutdown (Lesson #1): The task checks `session.stop_audio_ingest` on
    every loop iteration. Never use task.cancel() because PyAudio's C-level stream.read()
    is a blocking call that segfaults if interrupted mid-execution.
  - Multi-channel passthrough (Lesson #4): Instead of downmixing stereo to mono with
    audioop (removed in Python 3.13), the raw multi-channel PCM is passed through to
    Soniox, which natively supports num_channels > 1 in RealtimeSTTConfig.
  - Drop-oldest queueing (Lesson #2): Both queues use a try/put_nowait pattern that pops
    the oldest chunk on QueueFull instead of blocking. This ensures Queue A (Soniox)
    is never starved by Queue B (visualizer) backpressure.
"""
import os
from datetime import datetime
import asyncio
import pyaudio
import time
import struct
import wave
from models import ActiveSession
import logging
import numpy as np
import soxr

logger = logging.getLogger("harmoni")

CHUNK = 1024
FORMAT = pyaudio.paInt16
# Channels are determined dynamically from session.audio_device_channels.
RATE = 16000  # Soniox optimal sample rate (must match RealtimeSTTConfig.sample_rate)

# How often (in seconds) to flush the recording file to disk
RECORDING_FLUSH_INTERVAL = 10.0


def _resample_for_viz(raw_frames: bytes, src_channels: int, src_sampwidth: int, src_rate: int) -> bytes:
    """Downmix to mono and resample to 16kHz for the visualizer using C-based soxr."""
    if len(raw_frames) == 0:
        return b''
        
    if src_sampwidth == 1:
        # 8-bit PCM is unsigned
        audio_np = np.frombuffer(raw_frames, dtype=np.uint8).astype(np.float32) - 128.0
        audio_np *= 256.0
    elif src_sampwidth == 2:
        audio_np = np.frombuffer(raw_frames, dtype=np.int16).astype(np.float32)
    elif src_sampwidth == 4:
        audio_np = np.frombuffer(raw_frames, dtype=np.int32).astype(np.float32) / 65536.0
    else:
        return b''

    if src_channels > 1:
        audio_np = audio_np.reshape(-1, src_channels).mean(axis=1)
    
    if src_rate != RATE:
        audio_np = soxr.resample(audio_np, src_rate, RATE)
        
    return np.clip(audio_np, -32768, 32767).astype(np.int16).tobytes()


async def audio_ingest_task(queue_a: asyncio.Queue, queue_b: asyncio.Queue, session: ActiveSession):
    """
    Asynchronous task that reads from the local microphone and pushes chunks to the target queues.
    Queue A gets priority for the Soniox broadcast.
    Queue B is a best-effort copy for the Admin Dashboard visualizer.
    """
    device_index = session.audio_device_index
    is_disabled = (device_index == -1)
    is_file = isinstance(device_index, str) and device_index.startswith("file:")

    p = None
    stream = None
    wf = None
    wf_channels = 1
    wf_sampwidth = 2
    wf_framerate = RATE

    # Capture the recording start time once for the PCM filename
    recording_start_time = datetime.now().strftime("%H-%M-%S")

    # Persistent file handle for recording (opened lazily, flushed periodically)
    recording_file = None
    recording_filepath = None
    last_flush_time = time.time()

    if is_file:
        filename = device_index.split(":", 1)[1]
        filepath = os.path.join(os.path.dirname(os.path.dirname(__file__)), "audio_samples", filename)
        try:
            wf = wave.open(filepath, 'rb')
            wf_channels = wf.getnchannels()
            wf_sampwidth = wf.getsampwidth()
            wf_framerate = wf.getframerate()
            # Update session channel count so Soniox configures num_channels correctly
            session.audio_device_channels = wf_channels
            session.audio_device_framerate = wf_framerate
            logger.info(f"Audio Ingest File Stream Started: {filepath} "
                        f"(channels={wf_channels}, sampwidth={wf_sampwidth}, rate={wf_framerate})")
        except Exception as e:
            logger.error(f"Could not open file {filepath}: {e}")
            is_disabled = True

    elif not is_disabled:
        p = pyaudio.PyAudio()
        input_kwargs = {
            "format": FORMAT,
            "channels": session.audio_device_channels,
            "rate": RATE,
            "input": True,
            "frames_per_buffer": CHUNK
        }
        if session.audio_device_index is not None:
            input_kwargs["input_device_index"] = session.audio_device_index

        stream = p.open(**input_kwargs)
        session.audio_device_framerate = RATE
        logger.info(f"Audio Ingest Stream Started. Device Index: {session.audio_device_index} | Channels: {session.audio_device_channels} | Rate: {RATE}")
    else:
        logger.info("Audio Ingest is Disabled.")

    try:
        next_chunk_time = time.perf_counter()
        bytes_per_frame = wf_sampwidth * wf_channels

        while True:
            # COOPERATIVE SHUTDOWN CHECK (Lesson #1)
            if session.stop_audio_ingest:
                logger.info("Cooperative shutdown signal received in audio_ingest.")
                break

            if is_disabled:
                await asyncio.sleep(0.1)
                continue

            if is_file and wf:
                raw_data = wf.readframes(CHUNK)
                if len(raw_data) == 0:
                    wf.rewind()
                    raw_data = wf.readframes(CHUNK)
                    next_chunk_time = time.perf_counter()

                # For Soniox (Queue A): stream original raw data UNMODIFIED. 
                # Configure Soniox client to native framerate instead.
                data_for_soniox = raw_data
                
                # For Visualizer (Queue B): resample to 16kHz AND downmix to mono using C-based soxr.
                # Offload to thread to ensure minimal event loop blocking.
                if wf_framerate != RATE or wf_channels > 1:
                    data_for_viz = await asyncio.to_thread(_resample_for_viz, raw_data, wf_channels, wf_sampwidth, wf_framerate)
                else:
                    data_for_viz = data_for_soniox

                # Pace playback at real-time speed based on the ORIGINAL framerate
                frames_in_chunk = len(raw_data) // bytes_per_frame
                if frames_in_chunk > 0:
                    sleep_time = next_chunk_time - time.perf_counter()
                    if sleep_time > 0:
                        await asyncio.sleep(sleep_time)
                    next_chunk_time += frames_in_chunk / wf_framerate
                else:
                    await asyncio.sleep(0.01)

                data = data_for_soniox
            else:
                # asyncio.to_thread wraps the blocking C-level stream.read()
                data = await asyncio.to_thread(stream.read, CHUNK, exception_on_overflow=False)
                data_for_viz = data  # Mic data is already in the right format

            # MULTI-CHANNEL PASSTHROUGH (Lesson #4)
            # Update Liveness monitor
            session.audio_last_received_ts = time.time()

            # DROP-OLDEST QUEUE PATTERN (Lesson #2)
            # Queue A → Soniox translation pipeline (maxsize=100)
            try:
                queue_a.put_nowait(data)
            except asyncio.QueueFull:
                try:
                    queue_a.get_nowait()
                    queue_a.put_nowait(data)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

            # Queue B → Admin dashboard audio visualizer (maxsize=1)
            viz_data = data_for_viz if is_file else data
            try:
                queue_b.put_nowait(viz_data)
            except asyncio.QueueFull:
                try:
                    queue_b.get_nowait()
                    queue_b.put_nowait(viz_data)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

            # --- AUDIO RECORDING (Phase 3) ---
            # If a session is active, append the raw PCM to the persistent file handle
            if session.current_session_name:
                try:
                    # Lazily open the recording file
                    if recording_file is None:
                        date_str = datetime.now().strftime("%Y-%m-%d")
                        save_dir = os.environ.get("AUDIO_SAVE_DIR", "audio_recordings")
                        day_dir = os.path.join(save_dir, date_str)
                        if not os.path.exists(day_dir):
                            os.makedirs(day_dir, exist_ok=True)
                        recording_filepath = os.path.join(
                            day_dir,
                            f"recording-{session.current_session_name}-{recording_start_time}.pcm"
                        )
                        recording_file = open(recording_filepath, "ab")
                        logger.info(f"Recording to {recording_filepath}")

                    recording_file.write(data)

                    # Flush to disk periodically (every RECORDING_FLUSH_INTERVAL seconds)
                    now = time.time()
                    if now - last_flush_time >= RECORDING_FLUSH_INTERVAL:
                        recording_file.flush()
                        last_flush_time = now
                except Exception as e:
                    logger.error(f"Error saving audio for session {session.current_session_name}: {e}")
            else:
                # Session ended — close the file if it was open
                if recording_file is not None:
                    recording_file.flush()
                    recording_file.close()
                    recording_file = None
                    recording_filepath = None

            await asyncio.sleep(0.001)

    except asyncio.CancelledError:
        logger.warning("Audio Ingest Task forcibly cancelled (not recommended).")
    except Exception as e:
        logger.error(f"Unexpected error in audio_ingest: {e}")
    finally:
        logger.info("Closing audio stream gracefully...")
        # Close recording file if still open
        if recording_file is not None:
            try:
                recording_file.flush()
                recording_file.close()
            except: pass
        if stream:
            try:
                stream.stop_stream()
                stream.close()
            except: pass
        if p:
            p.terminate()
        if wf:
            wf.close()
        logger.info("Audio ingest terminated cleanly.")
