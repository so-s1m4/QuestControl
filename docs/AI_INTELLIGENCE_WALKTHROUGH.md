# Walkthrough: QuestControl AI Video Intelligence System & Telegram Media Integration

## Overview

The QuestControl local AI camera intelligence system has been upgraded to a **fully autonomous, persistent 24/7 background monitoring solution** with zero cloud dependencies, complete startup resilience, Telegram rich media alerts, and interactive Telegram bot commands.

---

## What Was Added & Hardened

### 1. Resilience & Autonomous Bidirectional Convergence
- **`AiWorkerSupervisor` (`apps/api/src/ai-worker-supervisor.js`)**:
  - Automatically started during Node.js API initialization.
  - **Exponential retry startup loop**: If `ai-service` is booting late or downloading weights, retries up to 15 times with exponential backoff (2s up to 10s).
  - **Periodic Watchdog (30s)**: Compares active worker sessions against PostgreSQL `ai_enabled` cameras. If `ai-service` restarts or a camera is missing, it immediately reconciles workers.
- **Python Worker Self-Bootstrapping (`apps/ai-service/receiver.py`)**:
  - `StreamWorkerManager.bootstrap_from_api()` runs as a daemon thread.
  - Periodically polls `GET /internal/cameras` on the API until available, ensuring that if `ai-service` is deployed or restarted separately, all camera streams start immediately without waiting for API triggers.
- **Deterministic Development Secret Parity**:
  - Standardized `DEV_SECRET_FALLBACK = "development-internal-ai-secret-key-32chars-min"` across Node.js and Python.
  - **Zero-Trust Production Enforcement**: Both Node.js and Python raise a fatal startup exception if `NODE_ENV=production` and `INTERNAL_API_SECRET` is unset, <16 characters, or matches either the dev fallback or legacy insecure strings.

### 2. Rich Telegram Media for Critical Events
- **`TelegramBot` (`apps/api/src/telegram.js`)**:
  - Added native multipart `sendPhoto(chatId, photoBuffer, caption)` using built-in `FormData` and `Blob`.
  - Added native multipart `sendAnimation(chatId, animationBuffer, caption)` for autoplaying animations.
- **Critical Event Snapshots & Clips**:
  - `UNUSUAL_ACTIVITY`: Dispatches an animated clip or photo showing what triggered the anomaly (falls, clustering, rapid motion).
  - `ROOM_EMPTY`: Dispatches a snapshot of the cleared room with verification caption.
  - `CAMERA_OFFLINE`: Dispatches the last recorded frame before the stream disconnected.

### 3. Lightweight Clip Generator (`apps/ai-service`)
- **Circular Buffer Clip Generation**:
  - `CameraStreamSession.get_recent_clip(count=10, duration_ms=400)` converts the last 10 in-memory frames into an optimized animated GIF using local Pillow rendering (zero cloud dependencies, bounded size).
  - Exposed via HTTP endpoint `GET /cameras/:id/clip` and Node.js proxy `GET /cameras/:id/ai/clip`.

### 4. Interactive Telegram Bot Commands
- Operators can request live snapshots or animated clips directly from the Telegram bot:
  - «Пришли снимок из Krampus» / «Снимок Krampus» / «Фото Krampus» / `/photo Krampus`
  - «Клип из Krampus» / «Видео Krampus» / `/clip Krampus`
  - «Статус Krampus» / «Что в Krampus?»
- Fully secured with location RBAC against `telegram_connections` and `user_locations`.
- If an unknown room is queried, the bot lists accessible rooms to help the operator.

---

## Verification & Test Results

### 1. Node.js API Unit Tests
All 29 tests passed:
```bash
npm test
```
```
✔ CameraFrameProvider stores and samples frames correctly (0.69ms)
✔ CameraEventEngine generates PERSON_ENTERED, ROOM_OCCUPIED, and updates state (1.04ms)
✔ CameraVisionController auto-tracking handles dead zone and steering (0.30ms)
✔ CameraAIAgent routes questions to appropriate tools (0.29ms)
✔ CameraEventEngine scopes Socket.IO events to location and camera rooms (0.17ms)
✔ CameraEventEngine loadStatesFromDb populates state on startup (0.43ms)
✔ CameraAIAgent rejects PTZ room inspection when canControlPtz is false (0.11ms)
✔ CameraVisionController manual PTZ locks out auto-tracking for 15s (0.10ms)
✔ CameraEventEngine handleCameraStatus emits CAMERA_OFFLINE and CAMERA_ONLINE (0.19ms)
✔ runMigrations creates schema_migrations and applies pending SQL files (1.73ms)
✔ CameraEventEngine resets people count and emits ROOM_EMPTY on CAMERA_OFFLINE (0.17ms)
✔ Trickle ICE buffer stores candidates and drains cleanly (0.06ms)
✔ CameraFrameProvider correctly ingests frame from AI worker state payload (0.04ms)
✔ LocalVisionService getLatestFrame parses base64 and returns frame buffer (0.17ms)
✔ LocalVisionService sends X-Internal-Secret on all outbound calls (0.30ms)
✔ CameraVisionController inspectRoom fetches fallback frame from visionService when provider has no frames (0.38ms)
✔ CameraAIAgent analyzeCamera fetches fallback frame from visionService when provider has no frames (0.07ms)
✔ Internal secret verification: timing-safe check rejects invalid/missing and accepts valid (0.04ms)
✔ AiWorkerSupervisor retries on initial failure and reconciles on watchdog (80.83ms)
✔ LocalVisionService getRecentClip fetches binary clip with internal secret (0.27ms)
✔ TelegramBot sendPhoto and sendAnimation dispatch multipart payloads (20.41ms)
✔ Telegram command regex matching handles room photo and clip requests (1.28ms)
...
ℹ pass 29
ℹ fail 0
```

### 2. Python AI Service Tests
All 11 tests passed:
```bash
python3 -m unittest test_ai_service.py
```
```
----------------------------------------------------------------------
Ran 11 tests in 0.324s

OK
```
Tests validated:
- `_check_auth` constant-time verification.
- `BoundedSemaphore` CPU backpressure under high concurrent inference load.
- VLM IP pinning (rejects external / public IP addresses).
- `get_recent_clip` animated GIF generation.
- `StreamWorkerManager.bootstrap_from_api` automated camera discovery.

### 3. Angular Web Client Build
```bash
npm run build
```
- Angular build completed cleanly with 0 errors (`dist/web` generated).
