# GPBB Harmoni Live Translation — Architecture Summary

Harmoni is a real-time speech-to-text and translation application. It captures local audio on the server, streams it to a third-party AI provider (Soniox) for transcription and translation (e.g., Indonesian to English), and broadcasts the results to connected web clients in real-time via WebSockets.

The system is divided into three main components:

## 1. Python Server (FastAPI + PyAudio)
*   **Audio Ingestion (`audio_ingest.py`)**: Uses `PyAudio` to capture live microphone input. It operates an asynchronous loop that pushes raw PCM audio chunks into two `asyncio.Queue`s. Queue A is strictly for the Soniox pipeline, and Queue B (best-effort, drop-oldest) is for the Admin audio visualizer.
*   **Soniox Pipeline (`soniox_client.py`)**: Maintains a persistent WebSocket connection to the Soniox API using the `AsyncSonioxClient`. It pulls audio from Queue A, sends it to Soniox, and receives transcription tokens (handling endpoint detection like `<end>` markers). It broadcasts these tokens to all authenticated WebSocket clients.
*   **State & Connection Management (`models.py`)**: Uses an in-memory `ActiveSession` singleton to track mutable server state (audio config, active passphrase, Soniox status). A `ConnectionManager` handles three distinct WebSocket pools: public clients, admin dashboards, and admin visualizers.
*   **API & Routing (`main.py`)**: Exposes REST endpoints for admin controls (login, device selection, passphrase updates) and WebSocket endpoints for real-time bidirectional streaming.

## 2. Admin Dashboard (`admin/` - React/Vite/Tailwind)
*   **Authentication**: Protected by a session token flow that strictly validates against the FastAPI backend (fixing a past vulnerability where frontend routing bypassed actual auth).
*   **Control Panel**: Allows admins to start/stop the Soniox translation task, select the active audio input device (with built-in deduplication for Windows host APIs), and change the public session passphrase to kick/allow clients.
*   **Monitoring**: Features an `AudioVisualizer` component that connects to a dedicated WebSocket to plot raw PCM audio waves in real-time. It also previews the live translation stream.

## 3. Client View (`client/` - React/Vite/Tailwind)
*   **Access Control**: Users are prompted for a session passphrase (`admin_token`). They connect via WebSocket, and if the admin changes the passphrase, the server drops the connection with a 1008 Policy Violation, gracefully kicking the user back to the prompt without entering an infinite reconnect loop.
*   **Live UI**: Renders incoming translation tokens sequentially. It parses Soniox `<end>` markers to format paragraphs cleanly and maps corresponding English/Original text.
*   **Device Features**: Implements Text-to-Speech (TTS) for accessibility and utilizes the browser's Wake Lock API to prevent mobile devices from sleeping during long sessions.

## 🛡️ Key Design Decisions & Resilience (from `lessons.md`)
*   **Cooperative Shutdown**: Instead of using `task.cancel()`—which causes PortAudio C-level segmentation faults during PyAudio blocking reads—the ingest loop checks a `stop_audio_ingest` boolean flag to gracefully exit when switching microphones.
*   **Queue Backpressure**: To prevent a disconnected Admin visualizer from filling up memory and blocking the Soniox audio stream, both queues implement a non-blocking "drop-oldest" fallback on `QueueFull`.
*   **Multi-Channel Audio**: Rather than downmixing stereo to mono locally, the server passes raw multi-channel PCM arrays to Soniox natively since the `RealtimeSTTConfig` handles it, preventing garbled outputs from USB stereo mics.
*   **State De-coupling**: In the React client, fast-updating states (like TTS settings) are mirrored into a `useRef`. This prevents the main WebSocket `useEffect` dependency array from triggering unnecessary network reconnects when users adjust local volume or voices.
