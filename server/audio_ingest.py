import asyncio
import pyaudio
import time
import audioop
from models import ActiveSession
import logging

logger = logging.getLogger("harmoni")

CHUNK = 1024
FORMAT = pyaudio.paInt16
# We determine CHANNELS dynamically from session state.
RATE = 16000 # Soniox optimal sample rate

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
            if session.stop_audio_ingest:
                logger.info("Cooperative shutdown signal received in audio_ingest.")
                break
                
            # Yield to event loop while reading blocking PyAudio stream
            # In a true high-perf scenario, PyAudio callbacks are better, 
            # but this async wrapper serves the structure.
            data = await asyncio.to_thread(stream.read, CHUNK, exception_on_overflow=False)
            
            # Downmix if > 1 channel so Soniox always gets Mono
            if session.audio_device_channels > 1:
                # tomono(data, width_bytes, downmix_left_factor, downmix_right_factor)
                data = audioop.tomono(data, 2, 1, 1)
            
            # Update Liveness monitor
            session.audio_last_received_ts = time.time()
            
            # 1. DSP Filtering hook (e.g., numpy noise reduction here)
            # data = apply_filters(data)
            
            # 2. Forward to Soniox immediately
            try:
                queue_a.put_nowait(data)
            except asyncio.QueueFull:
                try:
                    queue_a.get_nowait()
                    queue_a.put_nowait(data)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
                
            # 3. Forward to Admin Dashboard
            # Queue maxsize is 1, providing true zero-latency buffering
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
