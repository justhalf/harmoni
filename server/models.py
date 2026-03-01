"""Data models and connection management for the Harmoni live translation server.

Key design decisions:
- ActiveSession is a singleton holding all mutable server state (audio config,
  Soniox status, admin session tokens). It is NOT persisted; a server restart
  resets all state.
- ConnectionManager tracks three independent WebSocket pools: public clients,
  admin dashboards, and admin audio visualizers. Each pool has independent
  lifecycle management with dead-connection cleanup on every broadcast.
"""
from pydantic import BaseModel
from typing import Optional, List, Set, Dict, Union
from fastapi import WebSocket
from dataclasses import dataclass
import hashlib
import os
import logging

def get_jwt_secret() -> str:
    """Generate a stable JWT secret from the admin password."""
    pwd = os.environ.get("ADMIN_PASSWORD", "dev-secret")
    return hashlib.sha256(pwd.encode()).hexdigest()

logger = logging.getLogger("harmoni")

class TranslationToken(BaseModel):
    """Represents a token mapped from Soniox output."""
    text: str
    is_final: bool
    language: str

class ActiveSession(BaseModel):
    """Mutable singleton holding all server-side session state.
    
    This model is NOT persisted. A server restart resets all fields to defaults.
    The admin_token is the public passphrase that clients use to connect via WebSocket.
    """
    admin_token: str = "blue-ocean-42"  # Default startup passphrase; changed via admin UI
    
    # Liveness monitoring: audio_last_received_ts is compared against time.time()
    # in the /health endpoint. If the gap exceeds 5 seconds, audio is considered dead.
    audio_last_received_ts: float = 0.0
    soniox_connected: bool = False
    soniox_activated: bool = False  # True only when admin explicitly enables translation
    current_session_name: Optional[str] = None # Captures the active "KU1" / "Custom" name for the recordings
    session_start_ts: float = 0.0 # Absolute time.time() when the session started
    audio_device_index: Optional[Union[int, str]] = None
    audio_device_channels: int = 1
    # Sample rate is stored so Soniox knows what framerate the raw PCM input uses.
    audio_device_framerate: int = 16000
    # Cooperative shutdown flag for audio_ingest_task. Setting this to True causes
    # the ingest loop to break cleanly on the next iteration, avoiding segfaults
    # from cancelling a blocking PyAudio C-level read. See Lesson #1.
    stop_audio_ingest: bool = False
    # JWT signing secret. Derived from ADMIN_PASSWORD to ensure tokens
    # survive server restarts. This reliably maintains the 12-hour refresh logic.
    jwt_secret: str = get_jwt_secret()
    
@dataclass
class ConnectionManager:
    """Manages the connected React WebSocket clients."""
    active_connections: Set[WebSocket]
    admin_connections: Set[WebSocket]
    admin_viz_connections: Set[WebSocket]

    def __init__(self):
        self.active_connections = set()
        self.admin_connections = set()
        self.admin_viz_connections = set()

    async def _broadcast_health_to_admins(self):
        message = {
            "type": "health",
            "active_clients": len(self.active_connections),
            "active_admins": len(self.admin_connections)
        }
        dead_admins = set()
        for connection in self.admin_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead_admins.add(connection)
        for dead in dead_admins:
            self.admin_connections.remove(dead)

    async def connect(self, websocket: WebSocket, is_admin: bool = False):
        if is_admin:
            self.admin_connections.add(websocket)
            logger.info(f"Admin connected. Total admins: {len(self.admin_connections)}")
        else:
            self.active_connections.add(websocket)
            logger.info(f"Client connected. Total clients: {len(self.active_connections)}")
        await self._broadcast_health_to_admins()

    def disconnect(self, websocket: WebSocket, is_admin: bool = False):
        if is_admin and websocket in self.admin_connections:
            self.admin_connections.remove(websocket)
            logger.info(f"Admin disconnected. Total admins: {len(self.admin_connections)}")
        elif not is_admin and websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Client disconnected. Total clients: {len(self.active_connections)}")
            
        import asyncio
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._broadcast_health_to_admins())
        except Exception:
            pass

    async def connect_viz(self, websocket: WebSocket):
        self.admin_viz_connections.add(websocket)

    def disconnect_viz(self, websocket: WebSocket):
        self.admin_viz_connections.discard(websocket)

    async def kick_unauthorized(self):
        """Forcefully disconnect all standard client connections. Admins are immune.
        
        Uses WebSocket close code 1008 (Policy Violation). The client-side onclose
        handler checks for code 1008 and suppresses auto-reconnect, instead clearing
        the session token and returning to the passphrase prompt. See Lesson #8.
        """
        dead_connections = set()
        for connection in self.active_connections:
            try:
                await connection.close(code=1008, reason="Token revoked")
            except Exception:
                pass
            dead_connections.add(connection)
            
        for dead in dead_connections:
            self.active_connections.remove(dead)
        logger.info(f"Kicked {len(dead_connections)} clients. Active clients: 0")

    async def broadcast(self, message: dict):
        """Fan-out a JSON message to all connected clients and admins.
        
        Dead connections (broken pipes, network drops) are silently collected
        and removed AFTER the broadcast loop completes. This avoids mutating
        the set during iteration.
        """
        dead_connections = set()
        dead_admins = set()
        
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.add(connection)
                
        for connection in self.admin_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead_admins.add(connection)
                
        for dead in dead_connections:
            self.active_connections.remove(dead)
            
        for dead in dead_admins:
            self.admin_connections.remove(dead)

    async def broadcast_audio(self, chunk: bytes):
        """Fan-out binary audio PCM chunk to all admin dashboard visualizers."""
        dead_viz = set()
        for connection in self.admin_viz_connections:
            try:
                await connection.send_bytes(chunk)
            except Exception:
                dead_viz.add(connection)
                
        for dead in dead_viz:
            self.disconnect_viz(dead)
