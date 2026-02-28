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

logger = logging.getLogger("harmoni")

CHUNK = 1024
FORMAT = pyaudio.paInt16
# Channels are determined dynamically from session.audio_device_channels.
RATE = 16000  # Soniox optimal sample rate (must match RealtimeSTTConfig.sample_rate)

# How often (in seconds) to flush the recording file to disk
RECORDING_FLUSH_INTERVAL = 10.0


def _convert_wav_frames(raw_frames: bytes, src_channels: int, src_sampwidth: int,
                        src_rate: int, target_channels: int = 1) -> bytes:
    """Convert arbitrary PCM wav frames to 16kHz signed-16-bit-LE with a target channel count.

    Args:
        raw_frames: Raw bytes from wave.readframes()
        src_channels: Source channel count
        src_sampwidth: Source sample width in bytes (1, 2, or 4)
        src_rate: Source sample rate in Hz
        target_channels: Output channel count (1 for mono visualizer, or src_channels for Soniox passthrough)

    Returns:
        Converted bytes in s16le format at 16kHz with target_channels.
    """
    num_samples = len(raw_frames) // src_sampwidth
    if num_samples == 0:
        return b''

    # Step 1: Unpack raw bytes into integer samples
    if src_sampwidth == 1:
        samples = list(struct.unpack(f'{num_samples}b', raw_frames))
    elif src_sampwidth == 2:
        samples = list(struct.unpack(f'<{num_samples}h', raw_frames))
    elif src_sampwidth == 4:
        samples = list(struct.unpack(f'<{num_samples}i', raw_frames))
    else:
        return b''

    # Step 2: Normalize sample values to 16-bit range
    if src_sampwidth == 1:
        samples = [s * 256 for s in samples]
    elif src_sampwidth == 4:
        samples = [s >> 16 for s in samples]

    # Step 3: Channel conversion
    # Organize into frames of [ch0, ch1, ...] per time step
    num_frames = num_samples // src_channels
    if target_channels == 1 and src_channels > 1:
        # Downmix to mono (average all channels)
        mono = []
        for i in range(num_frames):
            frame_start = i * src_channels
            frame_samples = samples[frame_start:frame_start + src_channels]
            mono.append(sum(frame_samples) // len(frame_samples))
        output_samples_per_frame = mono
        out_channels = 1
    elif target_channels == src_channels:
        # Keep all channels as-is (multi-channel passthrough for Soniox)
        output_samples_per_frame = samples
        out_channels = src_channels
    else:
        # Fallback: keep original
        output_samples_per_frame = samples
        out_channels = src_channels

    # Step 4: Resample from src_rate to 16000 Hz per channel using linear interpolation
    if src_rate != RATE:
        ratio = src_rate / RATE
        new_num_frames = int(num_frames / ratio)
        resampled = []
        for i in range(new_num_frames):
            src_pos = i * ratio
            idx = int(src_pos)
            frac = src_pos - idx
            for ch in range(out_channels):
                pos_a = idx * out_channels + ch
                pos_b = (idx + 1) * out_channels + ch
                if pos_b < len(output_samples_per_frame):
                    val = int(output_samples_per_frame[pos_a] * (1 - frac) +
                              output_samples_per_frame[pos_b] * frac)
                elif pos_a < len(output_samples_per_frame):
                    val = output_samples_per_frame[pos_a]
                else:
                    val = 0
                resampled.append(max(-32768, min(32767, val)))
        output_samples_per_frame = resampled

    # Step 5: Pack to s16le bytes
    return struct.pack(f'<{len(output_samples_per_frame)}h', *output_samples_per_frame)


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
        logger.info(f"Audio Ingest Stream Started. Device Index: {session.audio_device_index} | Channels: {session.audio_device_channels}")
    else:
        logger.info("Audio Ingest is Disabled.")

    try:
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

                # For Soniox (Queue A): resample to 16kHz but KEEP original channel count.
                # Soniox handles multi-channel natively via num_channels in RealtimeSTTConfig.
                data_for_soniox = _convert_wav_frames(
                    raw_data, wf_channels, wf_sampwidth, wf_framerate,
                    target_channels=wf_channels
                )

                # For Visualizer (Queue B): resample to 16kHz AND downmix to mono.
                if wf_channels > 1:
                    data_for_viz = _convert_wav_frames(
                        raw_data, wf_channels, wf_sampwidth, wf_framerate,
                        target_channels=1
                    )
                else:
                    data_for_viz = data_for_soniox

                # Pace playback at real-time speed based on the output (16kHz mono)
                viz_samples = len(data_for_viz) // 2
                if viz_samples > 0:
                    await asyncio.sleep(viz_samples / RATE)
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
