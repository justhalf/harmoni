from pydantic import BaseModel
from typing import Optional, List, Set, Dict
from fastapi import WebSocket
from dataclasses import dataclass

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
    
@dataclass
class ConnectionManager:
    """Manages the connected React WebSocket clients."""
    active_connections: Set[WebSocket]
    admin_connections: Set[WebSocket]

    def __init__(self):
        self.active_connections = set()
        self.admin_connections = set()

    async def connect(self, websocket: WebSocket, is_admin: bool = False):
        if is_admin:
            self.admin_connections.add(websocket)
        else:
            self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket, is_admin: bool = False):
        if is_admin and websocket in self.admin_connections:
            self.admin_connections.remove(websocket)
        elif not is_admin and websocket in self.active_connections:
            self.active_connections.remove(websocket)

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
