# GPBB Harmoni — Agent Instructions & Codebase Guidelines

Welcome to the GPBB Harmoni codebase. This document outlines the commands, architectural paradigms, and code style rules you must follow when operating in this repository. 

**CRITICAL RULE FOR ALL AGENTS**: Before modifying any core logic, you MUST read `lessons.md` to ensure you do not re-introduce previously solved bugs (e.g., PyAudio segmentation faults, WebSocket reconnect loops, mobile browser constraints).

In Windows PowerShell, make sure to activate Conda using this command (through cmd.exe):
```
C:/ProgramData/Miniconda3/Scripts/activate
conda activate d:\Documents\code\GPBB\code\harmoni\.conda
```

---

## 1. Build, Lint, and Test Commands

### Backend (Server - FastAPI / Python)
The backend uses standard Python with `pytest` and `pytest-asyncio`.
*   **Install dependencies**: `pip install -r requirements.txt` (Run inside an activated venv)
*   **Run Development Server**: `fastapi dev main.py` or `uvicorn main.py --reload`
*   **Run All Tests**: `pytest`
*   **Run a Single Test File**: `pytest tests/test_main.py`
*   **Run a Specific Test Case**: `pytest tests/test_main.py::test_function_name`
*   **Run tests with stdout/logs**: `pytest -s -v tests/test_main.py`

### Frontends (Admin & Client - React / Vite / TypeScript)
Both frontends share the same Vite/React/TypeScript stack and use `vitest` for testing.
*   **Install dependencies**: `npm install` (Run within the `admin/` or `client/` directories)
*   **Run Development Server**: `npm run dev`
*   **Build for Production**: `npm run build`
*   **Linting (ESLint)**: `npm run lint`
*   **Run All Tests (Watch mode)**: `npm run test`
*   **Run All Tests (Single run)**: `npx vitest run`
*   **Run a Single Test File**: `npm run test -- path/to/test.test.tsx` (Watch mode) or `npx vitest run path/to/test.test.tsx` (Single run)
*   **Run a Specific Test Case**: `npx vitest run -t "test name matching"`

---

## 2. Code Style & Naming Conventions

### Python (Backend)
*   **Naming**: Use `snake_case` for variables, functions, and file names. Use `PascalCase` for Classes and Pydantic Models.
*   **Types**: Explicit type hinting is mandatory. Use the `typing` module (`Optional`, `List`, `Dict`, `Set`) heavily.
*   **Formatting**: Standard PEP 8 rules apply. 
*   **Imports**: Standard library first, third-party packages second, internal module imports (`models`, `audio_ingest`) last.
*   **Models**: Use Pydantic `BaseModel` for all request/response payloads and complex internal state structures.

### TypeScript / React (Frontend)
*   **Naming**: Use `PascalCase` for React Components and their filenames (e.g., `TokenPrompt.tsx`). Use `camelCase` for functions, hooks, and standard variables.
*   **Types**: Define strict `interface` or `type` aliases for component props and state objects. Avoid `any`.
*   **Components**: Use functional components and React Hooks exclusively. No class components.
*   **CSS**: Tailwind utility classes are mandatory. Do not write custom CSS unless strictly necessary for animations/keyframes that Tailwind cannot handle.
*   **Imports**: React/React-DOM imports first, third-party libraries second, internal components third, and CSS/assets last.

---

## 3. Architecture & Error Handling Guidelines

### Backend Directives
*   **Asynchronous C-Level Calls (CRITICAL)**: When wrapping blocking C-level calls (like PyAudio's `stream.read()`) in `asyncio.to_thread()`, **NEVER use `task.cancel()`**. Cancellation mid-execution causes fatal segmentation faults. Always use a cooperative shutdown loop via a boolean flag (e.g., `session.stop_audio_ingest = True`).
*   **Audio Pipelines**: Pass raw multi-channel PCM to Soniox natively. Avoid using the `audioop` module to downmix audio locally, as it has been removed in Python 3.13.
*   **State Management**: Mutable session state is stored in the `ActiveSession` singleton. It is strictly in-memory and not persisted across restarts. 
*   **Exception Handling**: Use FastAPI's `HTTPException` to return specific API errors. For background task resilience (like Soniox connectivity), use infinite `while True` retry loops with `asyncio.sleep()` backoffs instead of letting the task crash.

### Frontend Directives
*   **React Hook Dependency Management**: If a `useEffect` manages a long-lived connection (like a WebSocket) but needs access to frequently changing state (like TTS settings), **do not** put the state in the dependency array. Instead, mirror the state to a `useRef` and read from the ref inside the connection handler.
*   **Mobile Web Optimization**: 
    *   Prefer `dvh` (Dynamic Viewport Height, e.g., `h-[100dvh]`) over `vh` for full-screen master layouts to dynamically account for the mobile URL bar collapsing.
    *   **Never** use `overflow-x: hidden` on global `html` or `body` tags, as it fundamentally breaks mobile Safari's scroll intent behaviors. Apply `overflow-hidden` locally to the specific clipping container instead.
*   **Authentication Flow**: Do not use optimistic UI authentication. The frontend must issue a POST request (e.g., `/api/admin/login`) and successfully `await` a 200 OK response containing a session token before updating the `isAuthenticated` React state.
*   **Graceful Degradation**: Always check for modern browser API availability before calling them. Features like `crypto.randomUUID()` and `navigator.wakeLock` fail in non-HTTPS local development. Fall back to secure alternatives (e.g., `Math.random()` polyfills).
*   **WebSocket Close Codes**: Handle explicit WebSocket close codes intelligently. Code `1008` (Policy Violation) means the token was revoked; clear the token and return the user to the login prompt rather than auto-reconnecting.
