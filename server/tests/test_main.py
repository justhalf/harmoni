"""Unit tests for main.py — FastAPI endpoint behavior."""
import pytest
import pytest_asyncio
from unittest.mock import patch, MagicMock, AsyncMock
import asyncio
import os
import sys

# Ensure ADMIN_PASSWORD is set before importing main
os.environ["ADMIN_PASSWORD"] = "test-admin-password"

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from httpx import AsyncClient, ASGITransport
from main import app, session_state, manager


@pytest.fixture(autouse=True)
def reset_session_state():
    """Reset global session state before each test to prevent leakage."""
    session_state.admin_token = "blue-ocean-42"
    session_state.soniox_activated = False
    session_state.soniox_connected = False
    session_state.audio_device_index = None
    session_state.audio_device_channels = 1
    session_state.stop_audio_ingest = False
    yield


@pytest.fixture
def admin_token():
    """Create a valid admin session JWT for use in authenticated requests."""
    import jwt
    import time
    from main import session_state
    
    access_exp = int(time.time()) + (15 * 60)
    token = jwt.encode(
        {"role": "admin", "type": "access", "exp": access_exp}, 
        session_state.jwt_secret, 
        algorithm="HS256"
    )
    return token


@pytest_asyncio.fixture
async def client():
    """Async HTTP client for testing FastAPI endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


# ============================================================
# POST /api/admin/login
# ============================================================

class TestAdminLogin:
    """Tests for admin authentication endpoint."""

    @pytest.mark.asyncio
    async def test_valid_password_returns_session_tokens(self, client):
        """A correct admin password should return an access and refresh token pair."""
        res = await client.post("/api/admin/login", json={"password": "test-admin-password"})
        assert res.status_code == 200
        data = res.json()
        assert "access_token" in data
        assert "refresh_token" in data
        assert len(data["access_token"]) > 0
        assert len(data["refresh_token"]) > 0

    @pytest.mark.asyncio
    async def test_invalid_password_returns_401(self, client):
        """An incorrect admin password should return 401."""
        res = await client.post("/api/admin/login", json={"password": "wrong-password"})
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_empty_password_returns_401(self, client):
        """An empty password should return 401."""
        res = await client.post("/api/admin/login", json={"password": ""})
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_multiple_logins_create_separate_tokens(self, client):
        """Each login should create uniquely signed session tokens."""
        # Due to temporal signing timestamps, successive calls should be unique
        # We sleep for 1.1s to ensure the integer `exp` timestamp ticks over.
        res1 = await client.post("/api/admin/login", json={"password": "test-admin-password"})
        await asyncio.sleep(1.1)
        res2 = await client.post("/api/admin/login", json={"password": "test-admin-password"})
        token1 = res1.json()["access_token"]
        token2 = res2.json()["access_token"]
        assert token1 != token2


# ============================================================
# GET /health
# ============================================================

class TestHealth:
    """Tests for the public health check endpoint."""

    @pytest.mark.asyncio
    async def test_health_returns_status(self, client):
        """Health endpoint should return a structured status response."""
        res = await client.get("/health")
        assert res.status_code == 200
        data = res.json()
        assert "status" in data
        assert data["status"] == "online"
        assert "soniox_connected" in data
        assert "soniox_activated" in data
        assert "active_clients" in data
        assert "active_admins" in data

    @pytest.mark.asyncio
    async def test_health_reflects_soniox_state(self, client):
        """Health should reflect current soniox_activated state."""
        session_state.soniox_activated = True
        session_state.soniox_connected = True
        res = await client.get("/health")
        data = res.json()
        assert data["soniox_activated"] is True
        assert data["soniox_connected"] is True


# ============================================================
# POST /api/verify-token
# ============================================================

class TestVerifyToken:
    """Tests for the public token verification endpoint."""

    @pytest.mark.asyncio
    async def test_valid_token(self, client):
        """Correct passphrase should return valid=true."""
        res = await client.post("/api/verify-token", json={"token": "blue-ocean-42"})
        assert res.status_code == 200
        assert res.json()["valid"] is True

    @pytest.mark.asyncio
    async def test_invalid_token(self, client):
        """Incorrect passphrase should return valid=false."""
        res = await client.post("/api/verify-token", json={"token": "wrong-token"})
        assert res.status_code == 200
        assert res.json()["valid"] is False


# ============================================================
# GET /api/admin/token (requires admin auth)
# ============================================================

class TestGetToken:
    """Tests for the admin passphrase retrieval endpoint."""

    @pytest.mark.asyncio
    async def test_get_token_authenticated(self, client, admin_token):
        """Authenticated request should return the active passphrase."""
        res = await client.get(
            "/api/admin/token",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        assert res.status_code == 200
        assert res.json()["active_token"] == "blue-ocean-42"

    @pytest.mark.asyncio
    async def test_get_token_unauthenticated(self, client):
        """Request without auth should return 401."""
        res = await client.get("/api/admin/token")
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_get_token_invalid_session(self, client):
        """Request with an invalid session token should return 401."""
        res = await client.get(
            "/api/admin/token",
            headers={"Authorization": "Bearer invalid-token"}
        )
        assert res.status_code == 401


# ============================================================
# POST /api/admin/token (requires admin auth)
# ============================================================

class TestUpdateToken:
    """Tests for updating the public passphrase."""

    @pytest.mark.asyncio
    async def test_update_token(self, client, admin_token):
        """Updating the passphrase should change admin_token and return success."""
        res = await client.post(
            "/api/admin/token",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"new_token": "new-passphrase-99"}
        )
        assert res.status_code == 200
        assert res.json()["status"] == "success"
        assert session_state.admin_token == "new-passphrase-99"

    @pytest.mark.asyncio
    async def test_update_token_kicks_clients(self, client, admin_token):
        """Updating the passphrase should kick all connected clients (Lesson #8).

        When the admin changes the session token, kick_unauthorized() must be called
        to close all existing client WebSocket connections with code 1008. This prevents
        an infinite reconnect loop with now-invalid tokens.
        """
        with patch.object(manager, "kick_unauthorized", new_callable=AsyncMock) as mock_kick:
            res = await client.post(
                "/api/admin/token",
                headers={"Authorization": f"Bearer {admin_token}"},
                json={"new_token": "rotated-token-77"}
            )
        assert res.status_code == 200
        mock_kick.assert_called_once()

    @pytest.mark.asyncio
    async def test_update_token_requires_auth(self, client):
        """Updating the passphrase without admin auth should return 401."""
        res = await client.post(
            "/api/admin/token",
            json={"new_token": "sneaky-token"}
        )
        assert res.status_code == 401


# ============================================================
# verify_admin dependency edge cases
# ============================================================

class TestVerifyAdmin:
    """Tests for the verify_admin dependency that guards admin endpoints."""

    @pytest.mark.asyncio
    async def test_missing_bearer_prefix(self, client):
        """Authorization header without 'Bearer ' prefix should return 401."""
        res = await client.get(
            "/api/admin/token",
            headers={"Authorization": "NotBearer some-token"}
        )
        assert res.status_code == 401

    @pytest.mark.asyncio
    async def test_empty_authorization_header(self, client):
        """Empty Authorization header should return 401."""
        res = await client.get(
            "/api/admin/token",
            headers={"Authorization": ""}
        )
        assert res.status_code == 401


# ============================================================
# POST /api/admin/session/toggle (requires admin auth)
# ============================================================

class TestSessionToggle:
    """Tests for starting/stopping the Soniox translation session task."""

    @pytest.mark.asyncio
    async def test_toggle_on_starts_task(self, client, admin_token):
        """Toggling Soniox on should set soniox_activated and return 'started'."""
        # Mock the audio queue and soniox task so we don't actually start them
        app.state.audio_queue_a = asyncio.Queue(maxsize=100)
        app.state.soniox_task = None

        with patch("main.soniox_translation_task", new_callable=AsyncMock):
            with patch("main.asyncio.create_task") as mock_create:
                mock_create.return_value = MagicMock()
                res = await client.post(
                    "/api/admin/session/toggle",
                    headers={"Authorization": f"Bearer {admin_token}"},
                    json={"active": True, "session_name": "KU1"}
                )
        assert res.status_code == 200
        assert res.json()["status"] == "started"
        assert session_state.soniox_activated is True
        assert session_state.current_session_name == "KU1"

    @pytest.mark.asyncio
    async def test_toggle_off_stops_task(self, client, admin_token):
        """Toggling Soniox off should cancel the task and return 'stopped'."""
        mock_task = MagicMock()
        app.state.soniox_task = mock_task
        session_state.soniox_activated = True

        res = await client.post(
            "/api/admin/session/toggle",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"active": False}
        )
        assert res.status_code == 200
        assert res.json()["status"] == "stopped"
        assert session_state.soniox_activated is False
        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_toggle_no_change(self, client, admin_token):
        """Toggling to the current state should return 'no_change'."""
        app.state.soniox_task = None
        session_state.soniox_activated = False

        res = await client.post(
            "/api/admin/session/toggle",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"active": False}
        )
        assert res.status_code == 200
        assert res.json()["status"] == "no_change"

# ============================================================
# POST /api/admin/audio-device (requires admin auth)
# ============================================================

class TestUpdateAudioDevice:
    """Tests for changing the active audio input device."""

    @pytest.mark.asyncio
    async def test_update_audio_device_stops_and_starts_ingest_task(self, client, admin_token):
        """Updating device should signal cooperative shutdown and restart ingest task."""
        mock_ingest_task = AsyncMock()
        app.state.audio_ingest_task = mock_ingest_task
        app.state.soniox_task = None
        app.state.audio_queue_a = asyncio.Queue(maxsize=1)
        app.state.audio_queue_b = asyncio.Queue(maxsize=1)
        session_state.audio_device_index = None

        with patch("main.audio_ingest_task", new_callable=AsyncMock) as mock_task_func:
            with patch("main.pyaudio.PyAudio"):
                with patch("main.asyncio.create_task") as mock_create:
                    mock_create.return_value = MagicMock()
                    res = await client.post(
                        "/api/admin/audio-device",
                        headers={"Authorization": f"Bearer {admin_token}"},
                        json={"device_index": 2}
                    )

        assert res.status_code == 200
        assert res.json()["status"] == "success"
        
        # Verify cooperative shutdown flow
        assert session_state.stop_audio_ingest is False # should be reset to False
        # A new task should have been created
        mock_create.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_update_audio_device_restarts_soniox_task_if_active(self, client, admin_token):
        """Updating device must restart Soniox task to propagate new num_channels."""
        app.state.audio_ingest_task = MagicMock()
        mock_soniox_task = MagicMock()
        # Mock cancel on the task object
        mock_soniox_task.cancel = MagicMock()
        app.state.soniox_task = mock_soniox_task
        app.state.audio_queue_a = asyncio.Queue(maxsize=1)
        app.state.audio_queue_b = asyncio.Queue(maxsize=1)

        with patch("main.audio_ingest_task", new_callable=AsyncMock), \
             patch("main.soniox_translation_task", new_callable=AsyncMock), \
             patch("main.asyncio.create_task") as mock_create, \
             patch("main.pyaudio.PyAudio") as mock_pyaudio_class:
            
            mock_pa_inst = MagicMock()
            mock_pyaudio_class.return_value = mock_pa_inst
            mock_pa_inst.get_device_info_by_index.return_value = {'maxInputChannels': 2}
            
            res = await client.post(
                "/api/admin/audio-device",
                headers={"Authorization": f"Bearer {admin_token}"},
                json={"device_index": 3}
            )

        assert res.status_code == 200
        assert session_state.audio_device_channels == 2
        
        # Check that the old soniox task was cancelled
        mock_soniox_task.cancel.assert_called_once()
        
        # create_task should be called twice: once for audio_ingest, once for soniox
        assert mock_create.call_count == 2
