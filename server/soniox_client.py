"""Soniox real-time speech-to-text client with translation.

Maintains a persistent connection to the Soniox API using the official AsyncSonioxClient.
The architecture uses two concurrent coroutines (send_audio + receive_text) running via
asyncio.gather inside an infinite retry loop with 5-second backoff.

Key behaviors:
  - Queue flush on connect: Stale audio chunks are discarded before starting a new
    Soniox session to prevent sending old buffered audio that would produce out-of-date
    transcriptions.
  - Raw event forwarding: Soniox events are broadcast as-is (via model_dump) to all
    connected WebSocket clients. The frontend is responsible for parsing token fields.
  - Infinite retry: If the Soniox connection drops (network issues, API errors), the
    task sleeps 5 seconds then reconnects automatically. This makes the system resilient
    to transient Soniox outages.
"""
import asyncio
import os
import json
from soniox import AsyncSonioxClient
from soniox.types import RealtimeSTTConfig, TranslationConfig
from models import ConnectionManager, ActiveSession
import logging

logger = logging.getLogger("harmoni")

from dotenv import load_dotenv
load_dotenv()

# Ensure this is set via environment variable
SONIOX_API_KEY = os.getenv("SONIOX_API_KEY", "missing_key")

async def soniox_translation_task(audio_queue: asyncio.Queue, manager: ConnectionManager, session: ActiveSession):
    """
    Maintains a single authenticated session to the Soniox Real-Time API using the official AsyncSonioxClient.
    Pulls binary audio off Queue A, sends it to Soniox, and broadcasts text tokens to all users.
    """
    client = AsyncSonioxClient(
        api_key=SONIOX_API_KEY,
        api_base_url="https://api.jp.soniox.com/v1",
        websocket_base_url="wss://stt-rt.jp.soniox.com/transcribe-websocket",
    )
    
    # Soniox STT configuration:
    # - model "stt-rt-v4" is the real-time streaming model
    # - language_hints=["id", "en"] with strict=False allows auto-detection
    #   between Indonesian and English, while still accepting other languages
    # - enable_endpoint_detection=True inserts <end> tokens at sentence boundaries
    # - Translation is one-way: original language → English
    # - num_channels is read from session state so stereo mics work natively
    #   without audioop downmixing (Lesson #4, audioop removed in Python 3.13)
    config = RealtimeSTTConfig(
        model="stt-rt-v4",
        audio_format="pcm_s16le",
        sample_rate=16000,
        num_channels=session.audio_device_channels,
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
            logger.info("Connecting to Soniox via AsyncSonioxClient...")
            async with client.realtime.stt.connect(config=config) as soniox_session:
                session.soniox_connected = True
                logger.info("Connected to Soniox")
                
                # QUEUE FLUSH: Discard any stale audio buffered while disconnected.
                # Without this, reconnecting would send old audio to Soniox, producing
                # out-of-date transcriptions before catching up to live audio.
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
                        except asyncio.CancelledError:
                            # Usually means the application is dropping the connection or restarting stream
                            logger.info("Soniox translation task send_audio cancelled cleanly.")
                            break
                        except Exception as e:
                            logger.error(f"Error sending audio to Soniox: {e}")
                            break
                            
                async def receive_text():
                    async for event in soniox_session.receive_events():
                        try:
                            if event.error_code:
                                logger.error(f"Soniox API Error ({event.error_code}): {event.error_message}")
                                break
                            
                            # Broadcast the model dict back to clients
                            payload = event.model_dump(exclude_none=True)
                            await manager.broadcast(payload)
                            
                            if event.finished:
                                logger.info("Soniox session finished gracefully.")
                                break
                                
                        except Exception as e:
                            logger.error(f"Error broadcasting from Soniox: {e}")
                            break
                            
                # Run send and receive concurrently. If either coroutine exits
                # (error, cancel, or session.finished), asyncio.gather returns
                # and the outer while-True loop handles reconnection.
                await asyncio.gather(
                    send_audio(),
                    receive_text()
                )
                
        except Exception as e:
            session.soniox_connected = False
            logger.warning(f"Soniox connection dropped: {e}. Retrying in 5s...")
            await asyncio.sleep(5)
