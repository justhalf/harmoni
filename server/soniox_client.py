import asyncio
import os
import json
from soniox import AsyncSonioxClient
from soniox.types import RealtimeSTTConfig, TranslationConfig
from models import ConnectionManager, ActiveSession

from dotenv import load_dotenv
load_dotenv()

# Ensure this is set via environment variable
SONIOX_API_KEY = os.getenv("SONIOX_API_KEY", "missing_key")

async def soniox_translation_task(audio_queue: asyncio.Queue, manager: ConnectionManager, session: ActiveSession):
    """
    Maintains a single authenticated session to the Soniox Real-Time API using the official AsyncSonioxClient.
    Pulls binary audio off Queue A, sends it to Soniox, and broadcasts text tokens to all users.
    """
    client = AsyncSonioxClient(api_key=SONIOX_API_KEY)
    
    config = RealtimeSTTConfig(
        model="stt-rt-v4",
        audio_format="pcm_s16le",
        sample_rate=16000,
        num_channels=1,
        language_hints=["id", "en"],
        language_hints_strict=False,
        enable_endpoint_detection=True,
        translation=TranslationConfig(
            type="one_way",
            target_language="en"
        )
    )
    
    while True:
        try:
            print("Connecting to Soniox via AsyncSonioxClient...")
            async with client.realtime.stt.connect(config=config) as soniox_session:
                session.soniox_connected = True
                print("Connected to Soniox")
                
                # Flush existing old audio so we only send fresh live audio to Soniox
                while not audio_queue.empty():
                    try:
                        audio_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                        
                async def send_audio():
                    while True:
                        try:
                            # Pull from Queue A
                            chunk = await audio_queue.get()
                            # Send binary audio frame
                            await soniox_session.send_byte_chunk(chunk)
                        except Exception as e:
                            print(f"Error sending audio to Soniox: {e}")
                            break
                            
                async def receive_text():
                    async for event in soniox_session.receive_events():
                        try:
                            if event.error_code:
                                print(f"Soniox API Error ({event.error_code}): {event.error_message}")
                                break
                            
                            # Broadcast the model dict back to clients
                            payload = event.model_dump(exclude_none=True)
                            await manager.broadcast(payload)
                            
                            if event.finished:
                                print("Soniox session finished gracefully.")
                                break
                                
                        except Exception as e:
                            print(f"Error broadcasting from Soniox: {e}")
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
