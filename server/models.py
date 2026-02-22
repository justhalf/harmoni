from pydantic import BaseModel
from typing import Optional, List, Set, Dict
from fastapi import WebSocket
from dataclasses import dataclass
import logging

logger = logging.getLogger("harmoni")

class TranslationToken(BaseModel):
    """Represents a token mapped from Soniox output."""
    text: str
    is_final: bool
    language: str

class ActiveSession(BaseModel):
    """Holds the securely generated active token for the day."""
    admin_token: str = "blue-ocean-42" # Default hardcoded startup token
    
    # Internal liveness stats
    audio_last_received_ts: float = 0.0
    soniox_connected: bool = False
    soniox_active: bool = False # Track if admin turned it on
    audio_device_index: Optional[int] = None
    audio_device_channels: int = 1
    stop_audio_ingest: bool = False
    admin_sessions: Set[str] = set()
    
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

    async def connect(self, websocket: WebSocket, is_admin: bool = False):
        if is_admin:
            self.admin_connections.add(websocket)
            logger.info(f"Admin connected. Total admins: {len(self.admin_connections)}")
        else:
            self.active_connections.add(websocket)
            logger.info(f"Client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket, is_admin: bool = False):
        if is_admin and websocket in self.admin_connections:
            self.admin_connections.remove(websocket)
            logger.info(f"Admin disconnected. Total admins: {len(self.admin_connections)}")
        elif not is_admin and websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"Client disconnected. Total clients: {len(self.active_connections)}")

    async def connect_viz(self, websocket: WebSocket):
        self.admin_viz_connections.add(websocket)

    def disconnect_viz(self, websocket: WebSocket):
        if websocket in self.admin_viz_connections:
            self.admin_viz_connections.remove(websocket)

    async def kick_unauthorized(self):
        """Forcefully disconnect all standard client connections. (Admins are immune)"""
        dead_connections = set()
        for connection in self.active_connections:
            try:
                # 1008 is the standard WebSocket code for Policy Violation
                await connection.close(code=1008, reason="Token revoked")
            except Exception:
                pass
            dead_connections.add(connection)
            
        for dead in dead_connections:
            self.active_connections.remove(dead)
        logger.info(f"Kicked {len(dead_connections)} clients. Active clients: 0")

    async def broadcast(self, message: dict):
        """Fan-out to all connected clients and admins."""
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
                
        # Cleanup broken pipes
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
