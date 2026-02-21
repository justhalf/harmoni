from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Header
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

for logger_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    uv_logger = logging.getLogger(logger_name)
    uv_logger.setLevel(logging.WARNING)
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
    app.state.audio_queue_b = asyncio.Queue(maxsize=100) # Admin Viz Queue
    
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
    if getattr(app.state, "audio_ingest_task", None):
        app.state.audio_ingest_task.cancel()
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
        return {"status": "started"}
        
    # Stop task
    elif not req.active and getattr(app.state, "soniox_task", None):
        session_state.soniox_active = False
        app.state.soniox_task.cancel()
        app.state.soniox_task = None
        session_state.soniox_connected = False
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
    
    # Gracefully kick all currently connected clients that don't match the new token rules?
    # For now, we leave them connected. The new token only applies to initial auth.
    return {"status": "success", "active_token": session_state.admin_token}
    
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
