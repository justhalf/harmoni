import asyncio
import pyaudio
import time
from models import ActiveSession

CHUNK = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 16000 # Soniox optimal sample rate

async def audio_ingest_task(queue_a: asyncio.Queue, queue_b: asyncio.Queue, session: ActiveSession):
    """
    Asynchronous task that reads from the local microphone and pushes chunks to the target queues.
    Queue A gets priority for the Soniox broadcast.
    Queue B is a best-effort copy for the Admin Dashboard visualizer.
    """
    p = pyaudio.PyAudio()
    stream = p.open(format=FORMAT,
                    channels=CHANNELS,
                    rate=RATE,
                    input=True,
                    frames_per_buffer=CHUNK)
                    
    print("Audio Ingest Stream Started.")
    
    try:
        while True:
            # Yield to event loop while reading blocking PyAudio stream
            # In a true high-perf scenario, PyAudio callbacks are better, 
            # but this async wrapper serves the structure.
            data = await asyncio.to_thread(stream.read, CHUNK, exception_on_overflow=False)
            
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
                print("WARNING: queue_a (Soniox Audio Queue) is full. Dropping oldest audio frame.")
                
            # 3. Forward to Admin Dashboard (Best Effort - Drop oldest if full)
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
        print("Audio Ingest Task Cancelled.")
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
