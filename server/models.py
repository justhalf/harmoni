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
    
@dataclass
class ConnectionManager:
    """Manages the connected React WebSocket clients."""
    active_connections: Set[WebSocket]

    def __init__(self):
        self.active_connections = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        """Fan-out to all connected clients."""
        dead_connections = set()
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.add(connection)
                
        # Cleanup broken pipes
        for dead in dead_connections:
            self.active_connections.remove(dead)
