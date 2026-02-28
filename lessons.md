# GPBB Harmoni — Lessons Learned: Bugs & Resolutions

This document catalogs all significant bugs, edge cases, and their resolutions encountered throughout the development of the GPBB Harmoni Live Translation system. Organized by component area for quick reference when debugging similar issues in the future.

---

## Server / Audio Pipeline

### 1. Server Crash on Audio Device Change (Segmentation Fault)
**Symptom**: Changing the audio input device while Soniox translation was live caused a server segfault.
**Root Cause**: `asyncio.CancelledError` was raised inside `audio_ingest_task` while `PyAudio.stream.read()` was executing a blocking C-level call in `asyncio.to_thread()`. The cancellation left the PyAudio stream in a corrupted state, and the subsequent `stream.close()` triggered a segmentation fault in the underlying PortAudio C library.
**Resolution**: Implemented a **cooperative shutdown mechanism** using a `stop_audio_ingest: bool` flag on `ActiveSession`. The `update_audio_device` endpoint sets the flag to `True`, then `await`s the task to finish naturally (the task checks the flag on each loop iteration and breaks cleanly). After the task exits, the flag is reset and a new task is started. This eliminates the race condition between asyncio cancellation and C-level blocking reads.
**Files**: `models.py` (`stop_audio_ingest` field), `audio_ingest.py` (flag check in loop), `main.py` (`update_audio_device` endpoint).

### 2. Audio Queue B Backpressure Causing Visualization Errors
**Symptom**: When no Admin dashboards were connected, `audio_queue_b` filled up and blocked the audio ingest loop, causing visualization errors on the Admin Dashboard.
**Root Cause**: Queue B had no consumer (no admin visualizer connected), so `put_nowait()` raised `QueueFull` on every iteration.
**Resolution**: Both queues use a drop-oldest pattern: on `QueueFull`, the oldest item is popped with `get_nowait()` before the new item is pushed. Queue B uses `maxsize=1` for true zero-latency buffering. This ensures Queue A (Soniox priority) is never blocked by Queue B backpressure.
**Files**: `audio_ingest.py`.

### 3. Duplicate Audio Devices in Dropdown
**Symptom**: The Admin audio device selector showed 3-4 entries for the same physical microphone.
**Root Cause**: Windows exposes each audio device through multiple host APIs (WASAPI, DirectSound, MME, WDM-KS), each as a separate PyAudio device index.
**Resolution**: Implemented a deduplication algorithm in `GET /api/admin/audio-devices` that: (1) assigns priority scores to each host API (WASAPI > DirectSound/MME, WDM-KS excluded), (2) groups devices by the first 31 characters of their name (MME truncation boundary), (3) keeps only the highest-priority entry per group.
**Files**: `main.py` (`get_audio_devices`).

### 4. Stereo Microphones Crash Soniox
**Symptom**: Soniox returned errors or garbled text when certain USB microphones were selected.
**Root Cause**: Some audio devices report `maxInputChannels > 1` (stereo). Soniox expects mono PCM. The raw stereo interleaved data was being sent directly, doubling the effective sample rate from Soniox's perspective.
**Resolution**: Added `audioop.tomono(data, 2, 1, 1)` downmixing in `audio_ingest.py` when `session.audio_device_channels > 1`. The channel count is stored in `ActiveSession` and updated whenever the audio device is changed.
**Files**: `audio_ingest.py`, `models.py` (`audio_device_channels`), `main.py` (`update_audio_device`).

---

## Client (React Consumer)

### 5. `crypto.randomUUID()` Crash on Non-HTTPS Mobile
**Symptom**: The app crashed on mobile browsers when accessed via HTTP (no SSL) during development.
**Root Cause**: `crypto.randomUUID()` is only available in secure contexts (HTTPS or localhost). Tunneling tools like ngrok or direct IP access over HTTP disable the Crypto API entirely.
**Resolution**: Added a fallback ID generator that checks for `crypto.randomUUID` availability before calling it. Falls back to `Math.random().toString(36)` concatenation.
**Files**: `App.tsx` (`generateId` function).

### 6. Desktop Options Menu Immediately Closing
**Symptom**: Clicking the "Options" button on the desktop header strip opened the dropdown momentarily, then it immediately closed.
**Root Cause**: The click event propagated from the Options button up to the root `<div>`, which had an `onClick` handler calling `setIsDisplayMenuOpen(false)`.
**Resolution**: Added `e.stopPropagation()` to the Options button's `onClick` handler, and added `onClick={(e) => e.stopPropagation()}` to the dropdown container itself.
**Files**: `App.tsx`, `LiveTranscription.tsx`.

### 7. Popover Attaching to Invisible `<end>` Newline Characters
**Symptom**: Tapping near line breaks in the English text opened a popover with empty Indonesian text, or the popover floated in mid-air between paragraphs.
**Root Cause**: The `<end>` token was being appended as a `\n` newline character inside a `<span>`. In HTML, `\n` does not render as a visual line break — it is treated as whitespace. The invisible span was still clickable and had a popover attached, causing ghost interactions.
**Resolution**: Refactored `<end>` handling to insert a dedicated `isLineBreak: true` span object that renders as a `<div className="h-4">` spacer instead of text content. The popover click handler explicitly skips `isLineBreak` spans.
**Files**: `App.tsx`.

### 8. WebSocket Reconnect Loop on Token Revocation
**Symptom**: When the admin changed the session token, clients were kicked but immediately entered an infinite reconnect loop, continuously hitting the server with invalid tokens.
**Root Cause**: The `ws.onclose` handler always triggered a `setTimeout` reconnect, regardless of the close code.
**Resolution**: Added a check for `event.code === 1008` (Policy Violation). On 1008, the client clears its `sessionToken` state (returning to the token prompt) and does NOT attempt to reconnect. Auto-reconnect only triggers for unexpected disconnections.
**Files**: `App.tsx`.

### 9. TTS Re-triggering WebSocket Reconnect
**Symptom**: Changing TTS volume or voice selection caused the WebSocket to disconnect and reconnect.
**Root Cause**: The TTS state variables (`isTtsEnabled`, `ttsVolume`, `selectedVoiceURI`, `voices`) were listed in the WebSocket `useEffect` dependency array, causing it to re-run and create a new WebSocket connection on every settings change.
**Resolution**: Introduced `ttsSettingsRef` (a `useRef`) that mirrors the current TTS states. The WebSocket message handler reads from the ref instead of the state directly. The ref is synced via a separate `useEffect` on the TTS states, keeping it out of the WebSocket effect's dependency array.
**Files**: `App.tsx`.

### 10. Wake Lock Not Activating on First Load
**Symptom**: The screen would dim/sleep on mobile despite the Wake Lock hook being active.
**Root Cause**: The Wake Lock API is a powerful browser feature that requires a secure context (HTTPS). On non-HTTPS connections, the API is either unavailable or restricted. Additionally, even on HTTPS, most mobile browsers require an explicit user gesture (click/tap) before granting the lock — the initial programmatic `requestWakeLock()` call on mount is rejected silently.
**Resolution**: Added a secondary `requestWakeLock()` call inside the root `<div>`'s `onClick` handler, so the very first tap anywhere on the app re-requests the lock with a valid user gesture. For non-HTTPS environments, the hook gracefully degrades (checks `'wakeLock' in navigator` before attempting).
**Files**: `App.tsx`.

### 15. Auto-Scroll Overriding User Scroll-Up & "More Below" Button Invisible
**Symptom**: During live streaming, scrolling up was immediately overridden by auto-scroll yanking the view back to the bottom. The "More Below" floating button never appeared.
**Root Cause (Auto-Scroll)**: The `wasAtBottom` check in `onmessage` used `isAutoScrolling.current || scrollHeight - scrollTop - clientHeight < 100`. During rapid streaming, each incoming message triggered `scrollToBottom()`, which set `isAutoScrolling = true` for 350ms and restarted the timer on each call — so `isAutoScrolling` was permanently `true`, making `wasAtBottom` always return `true` regardless of the user's actual scroll position. Multiple attempted fixes using `wheel`/`touchmove` event listeners failed because (a) `useEffect(() => {}, [])` ran at mount when the scroll div was behind an auth gate (`ref.current === null`), so listeners were never attached, and (b) `wheel` events don't fire on iOS Safari for touch scrolling.
**Root Cause (More Below)**: The button was `absolute`-positioned **inside** the `overflow-y-auto` scroll container, which had a CSS `maskImage` gradient applied. The button was clipped by both the overflow and the mask, rendering it invisible even when `showMoreBelow` state was `true`. Additionally, `handleScroll` unconditionally called `setShowMoreBelow(false)` when `atBottom` was true — including during programmatic smooth-scroll animations reaching the bottom, which immediately cleared the indicator after `onmessage` set it.
**Resolution**: (1) Replaced the `isAutoScrolling`-based position check with **scroll-direction tracking** via `lastScrollTopRef` in the React `onScroll` handler — when `scrollTop` decreases by >5px during a non-programmatic scroll, `autoScrollEnabledRef` is set to `false`. (2) Moved the "More Below" button **outside** the scroll container into a `relative` wrapper, so it floats over the visible viewport. (3) Guarded `setShowMoreBelow(false)` with `!isAutoScrolling.current` so programmatic animations don't clear the indicator.
**Files**: `App.tsx`.

---

## Admin Dashboard

### 11. Frontend Authentication Bypass (Security Vulnerability)
**Symptom**: The admin dashboard allowed access with *any* password entered.
**Root Cause**: In `AdminApp.tsx`, the `handleLogin` function simply checked if the password field was not empty (`adminPassword.trim() !== ""`) and immediately set `isAuthenticated(true)`. It completely bypassed checking the password against the backend server. The UI became accessible while backend API calls silently failed with 401s in the background.
**Reflection / Lesson**: When auditing an authentication system, **never start at the backend API layer**. Always start at the exact point of user interaction (the frontend login button) and trace the lifecycle of the authentication state. I initially fell into "tunnel vision" by hyper-focusing on FastAPI dependencies, timing attacks, and backend vulnerabilities, completely missing the fact that the React SPA had a hardcoded bypass allowing anyone into the UI.
**Resolution**: Refactored `handleLogin` to make an actual API call (e.g., to `/api/admin/token`) and `await` a 200 OK response before setting `isAuthenticated(true)`. If the server returns 401, the UI remains locked and displays an "Invalid Password" error.
**Files**: `admin/src/AdminApp.tsx`.

### 12. Admin App Horizontally Scrollable on Mobile
**Symptom**: The admin dashboard could be pinch-zoomed or panned horizontally on mobile, showing empty space to the right.
**Root Cause**: The status tooltip popups were centered (`left-1/2 -translate-x-1/2`) on elements near the right edge of the screen, causing the tooltip to bleed past the viewport boundary. Mobile Safari then expanded the scrollable viewport to accommodate the overflow.
**Resolution (Attempt 1 — Failed)**: Added `overflow-x: hidden` to the global `html, body, #root` CSS. This prevented horizontal scrolling but **broke mobile Safari's URL bar collapse behavior**, because Safari needs the body to be scrollable to detect scroll intent for hiding the URL bar.
**Resolution (Final)**: Removed the global `overflow-x: hidden`. Instead: (1) Changed tooltip alignment from `left-1/2 -translate-x-1/2` to `right-0`, so tooltips expand leftward from the right edge instead of centering and overflowing. (2) Changed all viewport heights from `100vh` to `100dvh` (Dynamic Viewport Height) to properly accommodate the mobile URL bar.
**Key Lesson**: Never use `overflow-x: hidden` on `html` or `body` for mobile web apps — it breaks native mobile browser chrome behaviors. Fix the _elements_ causing overflow instead.
**Files**: `LiveTranscription.tsx`, `AdminApp.tsx`, `index.css`.

### 12. Status Tooltip Clipped at Top of Viewport
**Symptom**: On the admin dashboard, the status tooltip (appearing above the status text) was cut off by the top edge of the container.
**Root Cause**: The tooltip used `bottom-full mb-2` positioning, but the status bar was near the top of the container with `overflow: hidden` or `rounded-2xl` clipping.
**Resolution**: Changed tooltip direction to appear **below** the status text (`top-full mt-3`). Triangle arrow moved from bottom to top of tooltip box (using `border-t border-l` instead of `border-b border-r`). Added `z-50` to ensure proper layering.
**Files**: `LiveTranscription.tsx`.

### 13. Animated "Live" Dot Breaking Layout Width
**Symptom**: After replacing the "●" character with an animated pinging dot (`animate-ping`), the "Live" text dropped to a second line or the status area overflowed.
**Root Cause**: The animated dot was a `flex` container with explicit `h-2.5 w-2.5`, but the parent `<span>` was not using flexbox layout, so the dot and text did not align inline.
**Resolution**: Changed the parent `<span>` to `flex items-center gap-1.5`. Added `shrink-0` to the dot container to prevent it from being compressed. Wrapped the "Live" text in its own `<span>` for proper flex item behavior.
**Files**: `LiveTranscription.tsx`.

### 14. Mobile Bottom Nav Bar Wasting Vertical Space
**Symptom**: The distance from the bottom nav bar labels to the bottom of the screen was excessive, reducing the available space for the translation panels.
**Root Cause**: Large padding (`p-2`, `mt-4 pt-2`) on the mobile nav bar buttons and container, plus `w-6 h-6` icon sizes and `text-xs` labels.
**Resolution**: Progressively reduced: container margin to `mt-1` with no extra padding, button padding to `px-2 py-1`, icon size to `w-5 h-5 mb-0.5`, and label size to `text-[10px]`. Also reduced the master container's mobile padding from `p-8` to `p-4 sm:p-8`.
**Files**: `LiveTranscription.tsx`.

---

## General Patterns & Best Practices

### Cooperative Shutdown over Task Cancellation
When an asyncio task wraps blocking C-level calls (PyAudio, serial ports, etc.), **never use `task.cancel()`**. Instead, use a boolean flag that the task checks on each iteration. `await` the task's natural exit, then restart. This prevents undefined behavior from interrupting native code mid-execution.

### Ref Pattern for Avoiding useEffect Re-runs
When a `useEffect` manages a long-lived resource (WebSocket, timer, subscription) and needs to read frequently-changing state, use a `useRef` to hold that state. Sync the ref from a separate `useEffect`. This prevents the resource-managing effect from re-running on every state change.

### Dynamic Viewport Height (`dvh`) over `vh`
On mobile browsers, `100vh` includes the area behind the URL bar, causing content to be hidden. `100dvh` dynamically adjusts to the visible viewport as the browser chrome appears/disappears. Always prefer `dvh` for mobile-first layouts.

### Tooltip Positioning Near Edges
When a tooltip trigger is near the edge of the viewport, avoid centering the tooltip (`left-1/2 -translate-x-1/2`). Instead, anchor the tooltip to the nearest edge (`right-0` for right-edge triggers). This prevents invisible overflow that causes horizontal scrolling on mobile.

### `select-none` for Status Labels
Interactive status labels ("LIVE", "STANDBY", "Offline") should always have `user-select: none` (Tailwind `select-none`) to prevent accidental text selection on tap, which disrupts the mobile UX.

### Absolute-Positioned Overlays Inside Scrollable Containers
Never place an `absolute`-positioned overlay (e.g., a "More Below" floating button) **inside** a `overflow-y-auto` scroll container. The overlay will scroll with the content and may be clipped by CSS masks or overflow rules, making it invisible. Instead, wrap the scroll container in a `relative` parent and place the overlay as a **sibling** outside the scroll div.

### Auto-Scroll Detection: Track Direction, Not Position
To implement "auto-scroll to bottom unless user scrolled up" in a streaming chat:
1. **Don't use `isAutoScrolling` flags in position checks.** During rapid streaming, programmatic scrolls overlap and keep the flag permanently `true`, making `wasAtBottom` always return `true`.
2. **Don't rely on `wheel`/`touch` events attached via `useEffect`.** They may never attach if the DOM element is conditionally rendered behind an auth gate (ref is `null` at mount time). Also, `wheel` events don't fire on iOS Safari for touch scrolling.
3. **Do track `scrollTop` direction changes in `onScroll`.** When `scrollTop` decreases (user scrolled up), disable auto-scroll. When `scrollTop` brings the user back within threshold of the bottom, re-enable. Since `onScroll` is a React prop (`onScroll={handleScroll}`), it's always correctly attached regardless of conditional rendering.
4. **Guard the direction check with `!isAutoScrolling`** so that programmatic smooth-scroll animations (which also change `scrollTop`) don't falsely trigger "user scrolled up" detection.
