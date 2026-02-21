from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Header
import pyaudio
from typing import Optional
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

app = FastAPI(title="Soniox Translation Broadcast Hub")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = ConnectionManager()
session_state = ActiveSession()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "secret123")

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

@app.on_event("startup")
async def startup_event():
    # Start the async audio and soniox tasks in the background
    app.state.audio_queue_a = asyncio.Queue(maxsize=100) # Soniox Queue
    app.state.audio_queue_b = asyncio.Queue(maxsize=1) # Admin Viz Queue (1 frame = 0 latency backlog)
    
    app.state.audio_ingest_task = asyncio.create_task(
        audio_ingest_task(app.state.audio_queue_a, app.state.audio_queue_b, session_state)
    )
    
    app.state.audio_viz_task = asyncio.create_task(
        audio_viz_broadcaster_task(app.state.audio_queue_b, manager)
    )
    
    # The soniox_task is now triggered manually via the Admin Dashboard
    app.state.soniox_task = None

@app.on_event("shutdown")
async def shutdown_event():
    # Graceful audio ingest shutdown
    session_state.stop_audio_ingest = True
    if getattr(app.state, "audio_ingest_task", None):
        try:
            await app.state.audio_ingest_task
        except Exception:
            pass
            
    if getattr(app.state, "audio_viz_task", None):
        app.state.audio_viz_task.cancel()
    if getattr(app.state, "soniox_task", None):
        app.state.soniox_task.cancel()

# --- Public Endpoints ---

@app.websocket("/ws/listen")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        auth_data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
    except Exception:
        await websocket.close(code=1008, reason="Authentication timeout or invalid format")
        return
        
    token = auth_data.get("token")
    is_admin = auth_data.get("is_admin", False)

    # Authenticate token against active daily session token
    if not token or token != session_state.admin_token:
        # FastAPI handles WS close gracefully
        await websocket.close(code=1008, reason="Invalid session token.")
        return

    await manager.connect(websocket, is_admin)

    # Push initial status so the client immediately knows Stand By vs Live
    try:
        await websocket.send_json({"type": "status", "soniox_active": session_state.soniox_active})
    except Exception:
        pass

    try:
        while True:
            # Keep connection alive, listen for client drops
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

class SonioxToggleReq(BaseModel):
    active: bool

@app.post("/api/admin/soniox/toggle")
async def toggle_soniox(req: SonioxToggleReq, authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {ADMIN_PASSWORD}":
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    
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
async def get_token(authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {ADMIN_PASSWORD}":
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    return {"active_token": session_state.admin_token}

@app.post("/api/admin/token")
async def update_token(req: TokenUpdateReq, authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {ADMIN_PASSWORD}":
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    
    # Update active token
    session_state.admin_token = req.new_token
    
    # Gracefully kick all currently connected clients that don't match the new token rules
    await manager.kick_unauthorized()
    
    return {"status": "success", "active_token": session_state.admin_token}
    
@app.get("/api/admin/audio-devices")
async def get_audio_devices(authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {ADMIN_PASSWORD}":
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    
    p = pyaudio.PyAudio()
    
    # Get host APIs mapping
    host_apis = {}
    for i in range(p.get_host_api_count()):
        try:
            api_info = p.get_host_api_info_by_index(i)
            host_apis[api_info["index"]] = api_info["name"]
        except:
            pass
            
    # Priority for deduplication: WASAPI > DirectSound > MME. Skip WDM-KS (raw pins).
    api_scores = {
        "Windows WASAPI": 2,
        "Windows DirectSound": 3,
        "MME": 3,
        "Windows WDM-KS": -1
    }
    
    unique_devices = {}
    
    for i in range(p.get_device_count()):
        try:
            dev = p.get_device_info_by_index(i)
            if dev.get('maxInputChannels', 0) > 0:
                api_index = dev.get('hostApi')
                api_name = host_apis.get(api_index, "Unknown")
                score = api_scores.get(api_name, 0)
                
                if score < 0: # Skip WDM-KS entirely
                    continue
                    
                name = dev.get('name')
                # MME truncates to 31 chars. Use first 31 chars to group identical devices across APIs
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
    
    return {"devices": devices, "active_device_index": session_state.audio_device_index}

class AudioDeviceUpdateReq(BaseModel):
    device_index: Optional[int] = None

@app.post("/api/admin/audio-device")
async def update_audio_device(req: AudioDeviceUpdateReq, authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {ADMIN_PASSWORD}":
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    
    session_state.audio_device_index = req.device_index
    
    # Lookup the channel count so we can downmix properly
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
    
    # Restart audio ingest task safely
    session_state.stop_audio_ingest = True
    if getattr(app.state, "audio_ingest_task", None):
        try:
            # Wait for C-level pyaudio blocking read to finish
            await app.state.audio_ingest_task
        except Exception:
            pass
            
    # Reset flag
    session_state.stop_audio_ingest = False
    
    # Empty queues for clean restart
    while not app.state.audio_queue_a.empty():
        try: app.state.audio_queue_a.get_nowait()
        except: pass
    while not app.state.audio_queue_b.empty():
        try: app.state.audio_queue_b.get_nowait()
        except: pass
        
    app.state.audio_ingest_task = asyncio.create_task(
        audio_ingest_task(app.state.audio_queue_a, app.state.audio_queue_b, session_state)
    )
    
    return {"status": "success", "active_device_index": session_state.audio_device_index}
    
@app.websocket("/ws/admin/audio")
async def admin_audio_viz(websocket: WebSocket):
    await websocket.accept()
    try:
        auth_data = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
    except Exception:
        await websocket.close(code=1008)
        return
        
    authorization = auth_data.get("authorization")
    # Requires password on initial connection
    if not authorization or authorization != ADMIN_PASSWORD:
        await websocket.close(code=1008)
        return
    await manager.connect_viz(websocket)
    try:
        while True:
            # Continually read to detect client disconnects
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect_viz(websocket)
