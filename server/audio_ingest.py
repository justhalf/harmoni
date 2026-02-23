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
import asyncio
import pyaudio
import time
from models import ActiveSession
import logging

logger = logging.getLogger("harmoni")

CHUNK = 1024
FORMAT = pyaudio.paInt16
# Channels are determined dynamically from session.audio_device_channels.
RATE = 16000  # Soniox optimal sample rate (must match RealtimeSTTConfig.sample_rate)

async def audio_ingest_task(queue_a: asyncio.Queue, queue_b: asyncio.Queue, session: ActiveSession):
    """
    Asynchronous task that reads from the local microphone and pushes chunks to the target queues.
    Queue A gets priority for the Soniox broadcast.
    Queue B is a best-effort copy for the Admin Dashboard visualizer.
    """
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
    
    try:
        while True:
            # COOPERATIVE SHUTDOWN CHECK (Lesson #1): This flag is set by the
            # update_audio_device endpoint. We check it BEFORE the blocking read
            # so we exit cleanly without interrupting PortAudio's C internals.
            if session.stop_audio_ingest:
                logger.info("Cooperative shutdown signal received in audio_ingest.")
                break
                
            # asyncio.to_thread wraps the blocking C-level stream.read() so it
            # doesn't starve the event loop. exception_on_overflow=False prevents
            # PortAudio from raising on buffer overruns (common during device switches).
            data = await asyncio.to_thread(stream.read, CHUNK, exception_on_overflow=False)
            
            # MULTI-CHANNEL PASSTHROUGH (Lesson #4): Raw PCM data is passed through
            # as-is, including stereo. The channel count is forwarded to Soniox via
            # RealtimeSTTConfig.num_channels in soniox_client.py. This eliminates the
            # dependency on the deprecated audioop module (removed in Python 3.13).
            
            # Update Liveness monitor
            session.audio_last_received_ts = time.time()
            
            # 1. DSP Filtering hook (e.g., numpy noise reduction here)
            # data = apply_filters(data)
            
            # DROP-OLDEST QUEUE PATTERN (Lesson #2):
            # On QueueFull, pop the oldest chunk then push the new one. This ensures
            # the most recent audio is always available and prevents backpressure from
            # one consumer (e.g., no admin visualizer connected) from blocking the other.
            
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
            # maxsize=1 means only the latest frame is ever buffered, providing
            # true zero-latency when the visualizer picks it up.
            try:
                queue_b.put_nowait(data)
            except asyncio.QueueFull:
                try:
                    queue_b.get_nowait()
                    queue_b.put_nowait(data)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
                
            await asyncio.sleep(0.001)
            
    except asyncio.CancelledError:
        logger.warning("Audio Ingest Task forcibly cancelled (not recommended).")
    except Exception as e:
        logger.error(f"Unexpected error in audio_ingest: {e}")
    finally:
        logger.info("Closing PyAudio stream gracefully...")
        try:
            stream.stop_stream()
            stream.close()
        except: pass
        p.terminate()
        logger.info("PyAudio terminated cleanly.")
