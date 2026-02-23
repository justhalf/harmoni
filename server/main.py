"""FastAPI server for GPBB Harmoni live translation.

Architecture overview:
  - Audio ingest task reads from a local microphone and pushes PCM chunks into two queues.
  - Soniox translation task (toggled by admin) pulls from Queue A and streams to the
    Soniox API, broadcasting transcription tokens to all connected WebSocket clients.
  - Audio visualizer task pulls from Queue B and broadcasts raw PCM to admin dashboards.
  - Admin endpoints are protected by session tokens issued via POST /api/admin/login.
  - Public WebSocket clients authenticate with the session passphrase (admin_token).

See lessons.md for detailed bug history and design rationale.
"""
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Header
import pyaudio
from typing import Optional
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import time
from models import ConnectionManager, ActiveSession
from audio_ingest import audio_ingest_task
from soniox_client import soniox_translation_task
from pydantic import BaseModel
import os
import logging
import sys
import secrets
from uvicorn.logging import DefaultFormatter

# 1. Provide a timestamped formatter format
log_format = "%(asctime)s | %(levelprefix)s %(name)s | %(message)s"
date_format = "%Y-%m-%d %H:%M:%S"

# 2. Re-configure existing Uvicorn handlers if it was launched via CLI
formatter = DefaultFormatter(log_format, datefmt=date_format, use_colors=True)

# Set base root logger
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setFormatter(formatter)
logging.basicConfig(level=logging.WARNING, handlers=[console_handler])

for logger_name in ("uvicorn.access",):
    uv_logger = logging.getLogger(logger_name)
    uv_logger.setLevel(logging.WARNING)
    for handler in uv_logger.handlers:
        handler.setFormatter(formatter)

for logger_name in ("uvicorn", "uvicorn.error"):
    uv_logger = logging.getLogger(logger_name)
    uv_logger.setLevel(logging.INFO)
    for handler in uv_logger.handlers:
        handler.setFormatter(formatter)

logger = logging.getLogger("harmoni")
logger.setLevel(logging.INFO)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manages server lifecycle: startup initialization and graceful shutdown.
    
    Startup (before yield):
      Creates audio queues and starts background tasks for audio ingest and
      visualization broadcasting.
    
    Shutdown (after yield):
      Uses cooperative shutdown for audio ingest (Lesson #1) to avoid segfaults,
      then cancels the remaining tasks.
    """
    # === STARTUP ===
    # Queue A: Soniox translation. maxsize=100 provides ~6 seconds of buffering
    # at 16kHz with 1024-sample chunks.
    app.state.audio_queue_a = asyncio.Queue(maxsize=100)
    # Queue B: Admin visualizer. maxsize=1 ensures only the latest frame is buffered,
    # providing zero-latency visualization. See Lesson #2.
    app.state.audio_queue_b = asyncio.Queue(maxsize=1)
    
    app.state.audio_ingest_task = asyncio.create_task(
        audio_ingest_task(app.state.audio_queue_a, app.state.audio_queue_b, session_state)
    )
    
    app.state.audio_viz_task = asyncio.create_task(
        audio_viz_broadcaster_task(app.state.audio_queue_b, manager)
    )
    
    # The soniox_task is now triggered manually via the Admin Dashboard
    app.state.soniox_task = None
    
    yield
    
    # === SHUTDOWN ===
    # Use cooperative shutdown for audio ingest (Lesson #1): set the flag and
    # await the task's natural exit instead of cancelling it.
    session_state.stop_audio_ingest = True
    if getattr(app.state, "audio_ingest_task", None):
        try:
            await app.state.audio_ingest_task
        except Exception:
            pass
    
    # Viz and Soniox tasks don't wrap blocking C calls, so cancel() is safe.
    if getattr(app.state, "audio_viz_task", None):
        app.state.audio_viz_task.cancel()
    if getattr(app.state, "soniox_task", None):
        app.state.soniox_task.cancel()

manager = ConnectionManager()
session_state = ActiveSession()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
if not ADMIN_PASSWORD:
    raise ValueError("ADMIN_PASSWORD not set. Aborting.")

async def audio_viz_broadcaster_task(audio_queue_b: asyncio.Queue, manager: ConnectionManager):
    """Pulls binary PCM data from Queue B and broadcasts to all connected Admin visualizers."""
    while True:
        try:
            chunk = await audio_queue_b.get()
            if manager.admin_viz_connections:
                await manager.broadcast_audio(chunk)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Broadcaster task error: {e}")
            break

app = FastAPI(title="Soniox Translation Broadcast Hub", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Public Endpoints ---

@app.websocket("/ws/listen")
async def websocket_endpoint(websocket: WebSocket):
    """Public WebSocket endpoint for streaming translation tokens.
    
    Auth flow:
    1. Client connects and sends a JSON message with {token, is_admin} within 5 seconds.
    2. Token is validated against session_state.admin_token (the public passphrase).
    3. On success, the connection is registered and receives an initial status push.
    4. On failure, close with code 1008 (Policy Violation) to suppress client reconnect.
    
    The connection then stays open indefinitely, receiving broadcast messages from
    soniox_translation_task. The receive_text() loop exists solely to detect disconnects.
    """
    await websocket.accept()
    try:
        auth_data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
    except Exception:
        await websocket.close(code=1008, reason="Authentication timeout or invalid format")
        return
        
    token = auth_data.get("token")
    is_admin = auth_data.get("is_admin", False)

    if not token or token != session_state.admin_token:
        await websocket.close(code=1008, reason="Invalid session token.")
        return

    await manager.connect(websocket, is_admin)

    # Push initial status so the client immediately knows whether Soniox is active.
    # This prevents the client from showing "Stand By" briefly before the first
    # broadcast arrives.
    try:
        await websocket.send_json({"type": "status", "soniox_active": session_state.soniox_active})
    except Exception:
        pass

    try:
        while True:
            # Keep connection alive; this loop only serves to detect disconnects.
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, is_admin)

class TokenVerifyReq(BaseModel):
    token: str

class TokenUpdateReq(BaseModel):
    new_token: str

@app.post("/api/verify-token")
async def verify_token(req: TokenVerifyReq):
    return {"valid": req.token == session_state.admin_token}

@app.get("/health")
async def get_health():
    # Calculate audio liveness
    audio_is_live = False
    if time.time() - session_state.audio_last_received_ts < 5.0:
        audio_is_live = True

    return {
        "status": "online",
        "audio_live": audio_is_live,
        "soniox_connected": session_state.soniox_connected,
        "soniox_active": session_state.soniox_active,
        "active_clients": len(manager.active_connections),
        "active_admins": len(manager.admin_connections)
    }

# --- Admin API Endpoints ---

class AdminLoginReq(BaseModel):
    password: str

@app.post("/api/admin/login")
async def admin_login(req: AdminLoginReq):
    """Authenticate with the server-side ADMIN_PASSWORD and receive a session token.
    
    Uses secrets.compare_digest() for timing-safe string comparison to prevent
    timing attacks that could leak password length or character matches.
    
    The returned session token is a cryptographically random URL-safe string
    (secrets.token_urlsafe(32) = 43 characters). Multiple concurrent sessions
    are supported (e.g., two admin browser tabs).
    
    Security note (Lesson #11): The frontend MUST send the actual password to
    this endpoint and wait for a 200 OK before granting dashboard access.
    Previously, the frontend simply checked if the password field was non-empty
    and set isAuthenticated=true, completely bypassing server validation.
    """
    if secrets.compare_digest(req.password, ADMIN_PASSWORD):
        new_session_token = secrets.token_urlsafe(32)
        session_state.admin_sessions.add(new_session_token)
        return {"admin_session_token": new_session_token}
    raise HTTPException(status_code=401, detail="Invalid Admin Password")

async def verify_admin(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    token = authorization.split(" ")[1]
    if token not in session_state.admin_sessions:
        raise HTTPException(status_code=401, detail="Invalid or expired session")

class SonioxToggleReq(BaseModel):
    active: bool

@app.post("/api/admin/soniox/toggle")
async def toggle_soniox(req: SonioxToggleReq, _=Depends(verify_admin)):
    # Start task
    if req.active and not getattr(app.state, "soniox_task", None):
        # Empty queue first
        while not app.state.audio_queue_a.empty():
            try:
                app.state.audio_queue_a.get_nowait()
            except asyncio.QueueEmpty:
                break
                
        session_state.soniox_active = True
        app.state.soniox_task = asyncio.create_task(
            soniox_translation_task(app.state.audio_queue_a, manager, session_state)
        )
        await manager.broadcast({"type": "status", "soniox_active": True})
        return {"status": "started"}
        
    # Stop task
    elif not req.active and getattr(app.state, "soniox_task", None):
        session_state.soniox_active = False
        app.state.soniox_task.cancel()
        app.state.soniox_task = None
        session_state.soniox_connected = False
        await manager.broadcast({"type": "status", "soniox_active": False})
        return {"status": "stopped"}
        
    return {"status": "no_change"}

@app.get("/api/admin/token")
async def get_token(_=Depends(verify_admin)):
    return {"active_token": session_state.admin_token}

@app.post("/api/admin/token")
async def update_token(req: TokenUpdateReq, _=Depends(verify_admin)):
    # Update active token
    session_state.admin_token = req.new_token
    
    # Gracefully kick all currently connected clients that don't match the new token rules
    await manager.kick_unauthorized()
    
    return {"status": "success", "active_token": session_state.admin_token}
    
@app.get("/api/admin/audio-devices")
async def get_audio_devices(_=Depends(verify_admin)):
    """List available audio input devices with deduplication.
    
    Windows exposes each physical microphone through multiple host APIs (WASAPI,
    DirectSound, MME, WDM-KS), each as a separate PyAudio device index. This
    endpoint deduplicates them using a two-step algorithm:
    
    1. PRIORITY SCORING: Each host API gets a score. WDM-KS is excluded entirely
       (score -1) because it exposes raw audio pins not suitable for application use.
       DirectSound/MME are preferred (score 3) over WASAPI (score 2) for compatibility.
    
    2. NAME GROUPING: Devices are grouped by the first 31 characters of their name.
       This 31-char boundary matches MME's name truncation limit — MME always truncates
       device names to 31 chars, so a WASAPI device named "Microphone (Realtek Audio)"
       and its MME counterpart "Microphone (Realtek Audio)" will share the same group key.
       Only the highest-scoring entry per group is kept.
    
    See Lesson #3 for more details.
    """
    p = pyaudio.PyAudio()
    
    host_apis = {}
    for i in range(p.get_host_api_count()):
        try:
            api_info = p.get_host_api_info_by_index(i)
            host_apis[api_info["index"]] = api_info["name"]
        except:
            pass
            
    api_scores = {
        "Windows WASAPI": 2,
        "Windows DirectSound": 3,
        "MME": 3,
        "Windows WDM-KS": -1  # Excluded: raw audio pins
    }
    
    unique_devices = {}
    
    for i in range(p.get_device_count()):
        try:
            dev = p.get_device_info_by_index(i)
            if dev.get('maxInputChannels', 0) > 0:
                api_index = dev.get('hostApi')
                api_name = host_apis.get(api_index, "Unknown")
                score = api_scores.get(api_name, 0)
                
                if score < 0:
                    continue
                    
                name = dev.get('name')
                # Group by first 31 chars (MME truncation boundary)
                group_key = name[:31]
                
                if group_key not in unique_devices or score > unique_devices[group_key]['score']:
                    unique_devices[group_key] = {
                        "index": i,
                        "name": f"{name} ({api_name})" if api_name != "Unknown" else name,
                        "channels": dev.get('maxInputChannels'),
                        "defaultSampleRate": dev.get('defaultSampleRate'),
                        "score": score
                    }
        except Exception as e:
            logger.warning(f"Error getting info for audio device {i}: {e}")
            
    p.terminate()
    
    devices = [
        {
            "index": d["index"], 
            "name": d["name"], 
            "channels": d["channels"], 
            "defaultSampleRate": d["defaultSampleRate"]
        } 
        for d in unique_devices.values()
    ]
    devices.sort(key=lambda x: x["index"])
    
    return {
        "devices": devices, 
        "active_device_index": session_state.audio_device_index,
        "active_channels": session_state.audio_device_channels
    }

class AudioDeviceUpdateReq(BaseModel):
    device_index: Optional[int] = None

@app.post("/api/admin/audio-device")
async def update_audio_device(req: AudioDeviceUpdateReq, _=Depends(verify_admin)):
    """Change the active audio input device.
    
    COOPERATIVE RESTART SEQUENCE (Lesson #1):
    1. Update session state with new device index and channel count.
    2. Set stop_audio_ingest = True (cooperative shutdown signal).
    3. Await the existing audio_ingest_task to finish naturally. This is critical
       because the task may be in the middle of a blocking PyAudio stream.read()
       call. Cancelling it would cause a segfault in the PortAudio C library.
    4. Reset the flag, flush both queues, and start a new ingest task.
    """
    session_state.audio_device_index = req.device_index
    
    # Look up channel count for stereo downmix decision (Lesson #4)
    if req.device_index is not None:
        p = pyaudio.PyAudio()
        try:
            info = p.get_device_info_by_index(req.device_index)
            session_state.audio_device_channels = info.get('maxInputChannels', 1)
        except:
            pass
        p.terminate()
    else:
        session_state.audio_device_channels = 1
    
    # Step 1: Signal cooperative shutdown
    session_state.stop_audio_ingest = True
    if getattr(app.state, "audio_ingest_task", None):
        try:
            # Step 2: Wait for the C-level blocking read to complete naturally
            await app.state.audio_ingest_task
        except Exception:
            pass
            
    # Step 3: Reset flag and flush queues for clean restart
    session_state.stop_audio_ingest = False
    
    while not app.state.audio_queue_a.empty():
        try: app.state.audio_queue_a.get_nowait()
        except: pass
    while not app.state.audio_queue_b.empty():
        try: app.state.audio_queue_b.get_nowait()
        except: pass
    
    # Step 4: Start new ingest task with updated device
    app.state.audio_ingest_task = asyncio.create_task(
        audio_ingest_task(app.state.audio_queue_a, app.state.audio_queue_b, session_state)
    )
    
    return {
        "status": "success", 
        "active_device_index": session_state.audio_device_index,
        "active_channels": session_state.audio_device_channels
    }
    
@app.websocket("/ws/admin/audio")
async def admin_audio_viz(websocket: WebSocket):
    await websocket.accept()
    try:
        auth_data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
    except Exception:
        await websocket.close(code=1008)
        return
        
    authorization = auth_data.get("authorization")
    # Requires an active session token on connection
    if not authorization or authorization not in session_state.admin_sessions:
        await websocket.close(code=1008)
        return
    await manager.connect_viz(websocket)
    try:
        while True:
            # Continually read to detect client disconnects
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_viz(websocket)
