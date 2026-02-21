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
logging.basicConfig(level=logging.WARNING, format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s", datefmt=date_format)

for logger_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    logger = logging.getLogger(logger_name)
    logger.setLevel(logging.WARNING)
    for handler in logger.handlers:
        handler.setFormatter(formatter)

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

@app.on_event("startup")
async def startup_event():
    # Start the async audio and soniox tasks in the background
    app.state.audio_queue_a = asyncio.Queue(maxsize=100) # Soniox Queue
    app.state.audio_queue_b = asyncio.Queue(maxsize=100) # Admin Viz Queue
    
    app.state.audio_ingest_task = asyncio.create_task(
        audio_ingest_task(app.state.audio_queue_a, app.state.audio_queue_b, session_state)
    )
    # The soniox_task is now triggered manually via the Admin Dashboard
    app.state.soniox_task = None

@app.on_event("shutdown")
async def shutdown_event():
    if getattr(app.state, "audio_ingest_task", None):
        app.state.audio_ingest_task.cancel()
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
        "active_clients": len(manager.active_connections)
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
    
    # Retrieve the active Queue B created during startup
    audio_queue_b = websocket.app.state.audio_queue_b
    
    # Flush existing old audio so visualization starts instantly with live audio
    while not audio_queue_b.empty():
        try:
            audio_queue_b.get_nowait()
        except asyncio.QueueEmpty:
            break
            
    try:
        async def send_audio():
            while True:
                # Wait for the next chunk of PCM audio from the ingest task
                chunk = await audio_queue_b.get()
                
                # Send the raw binary chunk to the React AudioVisualizer
                await websocket.send_bytes(chunk)
                
                # Yield to event loop
                await asyncio.sleep(0.001)
                
        async def keep_alive():
            while True:
                # Need to continually read from the websocket to detect
                # client disconnects and trigger the except block
                await websocket.receive_text()
                
        await asyncio.gather(send_audio(), keep_alive())
    except WebSocketDisconnect:
        # Admin closed the dashboard tab
        print("Admin Visualizer Disconnected.")
        pass
