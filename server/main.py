from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import time
from .models import ConnectionManager, ActiveSession
from .audio_ingest import audio_ingest_task
from .soniox_client import soniox_translation_task
import os

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
    audio_queue_a = asyncio.Queue(maxsize=100) # Soniox Queue
    audio_queue_b = asyncio.Queue(maxsize=100) # Admin Viz Queue
    
    app.state.audio_ingest_task = asyncio.create_task(
        audio_ingest_task(audio_queue_a, audio_queue_b, session_state)
    )
    app.state.soniox_task = asyncio.create_task(
        soniox_translation_task(audio_queue_a, manager, session_state)
    )

@app.on_event("shutdown")
async def shutdown_event():
    app.state.audio_ingest_task.cancel()
    app.state.soniox_task.cancel()

# --- Public Endpoints ---

@app.websocket("/ws/listen")
async def websocket_endpoint(websocket: WebSocket, token: str = None):
    # Authenticate token against active daily session token
    if not token or token != session_state.admin_token:
        # FastAPI handles WS close gracefully
        await websocket.close(code=1008, reason="Invalid session token.")
        return

    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive, listen for client drops
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

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
        "active_clients": len(manager.active_connections)
    }

# --- Admin API Endpoints ---

@app.post("/api/admin/token")
async def update_token(new_token: str, authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {ADMIN_PASSWORD}":
        raise HTTPException(status_code=401, detail="Unauthorized Admin")
    
    # Update active token
    session_state.admin_token = new_token
    
    # Gracefully kick all currently connected clients that don't match the new token rules?
    # For now, we leave them connected. The new token only applies to initial auth.
    return {"status": "success", "active_token": session_state.admin_token}
    
@app.websocket("/ws/admin/audio")
async def admin_audio_viz(websocket: WebSocket, authorization: str = None):
    # Requires password on initial connection via query param equivalent
    if not authorization or authorization != ADMIN_PASSWORD:
        await websocket.close(code=1008)
        return
        
    await websocket.accept()
    # In a fully fleshed out version, this loops consuming audio_queue_b
    # and dropping frames if websocket.send_bytes gets backed up.
    try:
        while True:
            await asyncio.sleep(1) # Stub
    except WebSocketDisconnect:
        pass
