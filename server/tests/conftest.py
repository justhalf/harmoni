"""Shared test fixtures for GPBB Harmoni server tests."""
import os
import sys
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

# Add server directory to path so we can import modules directly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Set ADMIN_PASSWORD before importing main (it raises ValueError if unset)
os.environ["ADMIN_PASSWORD"] = "test-admin-password"

from models import ActiveSession, ConnectionManager


@pytest.fixture
def session():
    """Fresh ActiveSession with default values."""
    return ActiveSession()


@pytest.fixture
def manager():
    """Fresh ConnectionManager with no connections."""
    return ConnectionManager()


@pytest.fixture
def mock_websocket():
    """Creates a mock WebSocket that supports send_json, close, and receive_json."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.send_bytes = AsyncMock()
    ws.close = AsyncMock()
    ws.receive_json = AsyncMock()
    ws.receive_text = AsyncMock()
    return ws
