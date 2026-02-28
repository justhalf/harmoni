"""Unit tests for models.py — ActiveSession and ConnectionManager."""
import pytest
from unittest.mock import AsyncMock

from models import ActiveSession, ConnectionManager


class TestActiveSession:
    """Tests for ActiveSession default values and behavior."""

    def test_default_admin_token(self):
        """Default passphrase is set on initialization."""
        session = ActiveSession()
        assert session.admin_token == "blue-ocean-42"

    def test_default_soniox_state(self):
        """Soniox should be inactive and disconnected by default."""
        session = ActiveSession()
        assert session.soniox_active is False
        assert session.soniox_connected is False

    def test_default_audio_config(self):
        """Audio defaults to system device (None), 1 channel, no shutdown signal."""
        session = ActiveSession()
        assert session.audio_device_index is None
        assert session.audio_device_channels == 1
        assert session.stop_audio_ingest is False


        """audio_last_received_ts should default to 0.0 (no audio received yet)."""
        session = ActiveSession()
        assert session.audio_last_received_ts == 0.0


class TestConnectionManager:
    """Tests for ConnectionManager WebSocket pool management."""

    @pytest.mark.asyncio
    async def test_connect_client(self, manager, mock_websocket):
        """Connecting a client should add it to active_connections."""
        await manager.connect(mock_websocket, is_admin=False)
        assert mock_websocket in manager.active_connections
        assert mock_websocket not in manager.admin_connections

    @pytest.mark.asyncio
    async def test_connect_admin(self, manager, mock_websocket):
        """Connecting an admin should add it to admin_connections."""
        await manager.connect(mock_websocket, is_admin=True)
        assert mock_websocket in manager.admin_connections
        assert mock_websocket not in manager.active_connections

    @pytest.mark.asyncio
    async def test_disconnect_client(self, manager, mock_websocket):
        """Disconnecting a client should remove it from the pool."""
        await manager.connect(mock_websocket, is_admin=False)
        manager.disconnect(mock_websocket, is_admin=False)
        assert mock_websocket not in manager.active_connections

    @pytest.mark.asyncio
    async def test_disconnect_admin(self, manager, mock_websocket):
        """Disconnecting an admin should remove it from the pool."""
        await manager.connect(mock_websocket, is_admin=True)
        manager.disconnect(mock_websocket, is_admin=True)
        assert mock_websocket not in manager.admin_connections

    @pytest.mark.asyncio
    async def test_disconnect_nonexistent_is_safe(self, manager, mock_websocket):
        """Disconnecting a websocket that was never connected should not raise."""
        manager.disconnect(mock_websocket, is_admin=False)
        manager.disconnect(mock_websocket, is_admin=True)

    @pytest.mark.asyncio
    async def test_broadcast_sends_to_all(self, manager):
        """broadcast() should send the message to both clients and admins."""
        client_ws = AsyncMock()
        admin_ws = AsyncMock()
        await manager.connect(client_ws, is_admin=False)
        await manager.connect(admin_ws, is_admin=True)

        client_ws.send_json.reset_mock()
        admin_ws.send_json.reset_mock()

        message = {"type": "test", "data": "hello"}
        await manager.broadcast(message)

        client_ws.send_json.assert_called_once_with(message)
        admin_ws.send_json.assert_called_once_with(message)

    @pytest.mark.asyncio
    async def test_broadcast_cleans_dead_connections(self, manager):
        """Dead connections (raised exceptions) should be removed after broadcast."""
        alive_ws = AsyncMock()
        dead_ws = AsyncMock()
        async def raise_conn_closed(*args, **kwargs):
            raise Exception("Connection closed")
        dead_ws.send_json.side_effect = raise_conn_closed

        await manager.connect(alive_ws, is_admin=False)
        await manager.connect(dead_ws, is_admin=False)

        await manager.broadcast({"test": True})

        assert alive_ws in manager.active_connections
        assert dead_ws not in manager.active_connections

    @pytest.mark.asyncio
    async def test_kick_unauthorized_closes_all_clients(self, manager):
        """kick_unauthorized should close all client connections with code 1008."""
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        admin_ws = AsyncMock()

        await manager.connect(ws1, is_admin=False)
        await manager.connect(ws2, is_admin=False)
        await manager.connect(admin_ws, is_admin=True)

        await manager.kick_unauthorized()

        # All clients removed
        assert len(manager.active_connections) == 0
        # Clients were closed with code 1008 (Policy Violation)
        ws1.close.assert_called_once_with(code=1008, reason="Token revoked")
        ws2.close.assert_called_once_with(code=1008, reason="Token revoked")
        # Admins are immune — NOT closed
        admin_ws.close.assert_not_called()
        assert admin_ws in manager.admin_connections

    @pytest.mark.asyncio
    async def test_connect_viz(self, manager, mock_websocket):
        """connect_viz should add to admin_viz_connections."""
        await manager.connect_viz(mock_websocket)
        assert mock_websocket in manager.admin_viz_connections

    @pytest.mark.asyncio
    async def test_disconnect_viz(self, manager, mock_websocket):
        """disconnect_viz should remove from admin_viz_connections."""
        await manager.connect_viz(mock_websocket)
        manager.disconnect_viz(mock_websocket)
        assert mock_websocket not in manager.admin_viz_connections

    @pytest.mark.asyncio
    async def test_broadcast_audio_sends_bytes(self, manager):
        """broadcast_audio should send bytes to all viz connections."""
        viz_ws = AsyncMock()
        await manager.connect_viz(viz_ws)

        chunk = b'\x00\x01\x02\x03'
        await manager.broadcast_audio(chunk)

        viz_ws.send_bytes.assert_called_once_with(chunk)

    @pytest.mark.asyncio
    async def test_broadcast_audio_cleans_dead_viz(self, manager):
        """Dead viz connections should be removed after broadcast_audio."""
        alive_viz = AsyncMock()
        dead_viz = AsyncMock()
        dead_viz.send_bytes.side_effect = Exception("Broken pipe")

        await manager.connect_viz(alive_viz)
        await manager.connect_viz(dead_viz)

        await manager.broadcast_audio(b'\x00')

        assert alive_viz in manager.admin_viz_connections
        assert dead_viz not in manager.admin_viz_connections
