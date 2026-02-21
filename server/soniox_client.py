import asyncio
import os
import json
from soniox.speech_service import Client
from soniox.transcribe_live import transcribe_stream
from .models import ConnectionManager, ActiveSession

# Ensure this is set via environment variable
SONIOX_API_KEY = os.getenv("SONIOX_API_KEY", "missing_key")

async def soniox_translation_task(audio_queue: asyncio.Queue, manager: ConnectionManager, session: ActiveSession):
    """
    Maintains a single authenticated session to the Soniox Real-Time API.
    Pulls binary audio off Queue A, sends it to Soniox, and broadcasts text tokens to all users.
    """
    client = Client(api_key=SONIOX_API_KEY)

    # Since we are using the official Client wrapper, we can pass our audio queue generator
    def audio_generator():
        while True:
            try:
                # We need blocking/timeout for generator so it doesn't spin, but we are inside an async event loop
                # PyAudio chunks are coming in hot so an async to sync queue wrapper or simple yield is needed.
                # For this scaffolding, we use a simple loop. In production, an AsyncIterator is required for the soniox client.
                pass
            except Exception:
                break
                
    # Note: Modern Soniox Python SDKs handle async natively via AsyncRealtimeSTTSession or websockets directly.
    # Below is the architecture for direct websocket interaction mapping to the Japan regional endpoint.
    
    import websockets
    
    req_url = "wss://stt-rt.jp.soniox.com/transcribe-websocket"
    
    auth_request = {
        "api_key": SONIOX_API_KEY,
        "sample_rate_hertz": 16000,
        "language_hints_strict": False,
        "language_hints": ["id", "en"],
        "translation": {
            "type": "one_way",
            "target_language": "en"
        }
    }
    
    while True:
        try:
            async with websockets.connect(req_url) as ws:
                session.soniox_connected = True
                print("Connected to Soniox (Japan Region)")
                
                # 1. Send authentication and config
                await ws.send(json.dumps(auth_request))
                
                # 2. Wait for successful start response
                start_res = await ws.recv()
                
                async def send_audio():
                    while True:
                        try:
                            # Pull from Queue A
                            chunk = await audio_queue.get()
                            # Send binary audio frame
                            await ws.send(chunk)
                        except Exception as e:
                            print(f"Error sending audio to Soniox: {e}")
                            break
                            
                async def receive_text():
                    while True:
                        try:
                            response = await ws.recv()
                            payload = json.loads(response)
                            # 3. Fast Fan-out: Broadcast directly to React Clients
                            await manager.broadcast(payload)
                        except Exception as e:
                            print(f"Error receiving from Soniox: {e}")
                            break
                            
                # Run send and receive concurrently
                await asyncio.gather(
                    send_audio(),
                    receive_text()
                )
                
        except Exception as e:
            session.soniox_connected = False
            print(f"Soniox connection dropped: {e}. Retrying in 5s...")
            await asyncio.sleep(5)
