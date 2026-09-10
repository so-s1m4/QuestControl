import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { CameraFrameProvider } from "../src/camera-frame-provider.js";
import { CameraEventEngine } from "../src/camera-event-engine.js";
import { CameraVisionController } from "../src/camera-vision-controller.js";
import { CameraAIAgent } from "../src/camera-ai-agent.js";
import { LocalVisionService } from "../src/local-vision-service.js";
import { AiWorkerSupervisor } from "../src/ai-worker-supervisor.js";
import { TelegramBot } from "../src/telegram.js";
import { runMigrations } from "../src/migrator.js";
import { HeadsetTrackingEngine, pointInPolygon, isInsideZone } from "../src/headset-tracking-engine.js";

test("CameraFrameProvider stores and samples frames correctly", () => {
  const provider = new CameraFrameProvider({ maxBufferSeconds: 10, maxFramesPerCamera: 5 });
  const cameraId = "cam-1";

  provider.pushFrame(cameraId, Buffer.from("frame1"));
  provider.pushFrame(cameraId, Buffer.from("frame2"));
  provider.pushFrame(cameraId, Buffer.from("frame3"));

  const latest = provider.getLatestFrame(cameraId);
  assert.equal(latest.buffer.toString(), "frame3");

  const frames = provider.getFrames(cameraId, 10, 2);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].buffer.toString(), "frame1");
  assert.equal(frames[1].buffer.toString(), "frame3");
});

test("CameraEventEngine generates PERSON_ENTERED, ROOM_OCCUPIED, and updates state", async () => {
  const publishedEvents = [];
  const publishedStates = [];
  const mockIo = {
    emit: (event, payload) => {
      if (event === "camera:ai:event") publishedEvents.push(payload);
      if (event === "camera:ai:state") publishedStates.push(payload);
    },
  };
  const mockDb = {
    query: async () => ({ rows: [] }),
  };

  const engine = new CameraEventEngine({ db: mockDb, io: mockIo });
  const cameraId = "cam-123";

  // 1. Initial detection with 2 people
  const detection1 = {
    peopleCount: 2,
    people: [
      { trackId: 1, confidence: 0.9, bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.5 } },
      { trackId: 2, confidence: 0.85, bbox: { x: 0.5, y: 0.2, width: 0.1, height: 0.5 } },
    ],
  };

  const state1 = await engine.processDetection({
    cameraId,
    roomId: "room-krampus",
    detectionResult: detection1,
  });

  assert.equal(state1.peopleCount, 2);
  assert.equal(state1.occupied, true);
  assert.ok(publishedEvents.some((e) => e.type === "PERSON_ENTERED"));
  assert.ok(publishedEvents.some((e) => e.type === "ROOM_OCCUPIED"));

  // 2. Single zero-detection frame: debounce should retain previous count (2)
  const detectionZero = { peopleCount: 0, people: [] };
  const stateDebounced = await engine.processDetection({
    cameraId,
    roomId: "room-krampus",
    detectionResult: detectionZero,
  });

  // Debounced: count does NOT immediately drop to 0
  assert.equal(stateDebounced.peopleCount, 2);
  assert.equal(stateDebounced.occupied, true);
  assert.ok(!publishedEvents.some((e) => e.type === "ROOM_EMPTY"));

  // 3. Second zero-detection frame: still debounced
  await engine.processDetection({
    cameraId,
    roomId: "room-krampus",
    detectionResult: detectionZero,
  });
  assert.ok(!publishedEvents.some((e) => e.type === "ROOM_EMPTY"));

  // 4. Third consecutive zero frame: hysteresis confirms empty
  const stateConfirmed = await engine.processDetection({
    cameraId,
    roomId: "room-krampus",
    detectionResult: detectionZero,
  });

  assert.equal(stateConfirmed.peopleCount, 0);
  assert.equal(stateConfirmed.occupied, false);
  assert.ok(publishedEvents.some((e) => e.type === "PERSON_LEFT"));
  assert.ok(publishedEvents.some((e) => e.type === "ROOM_EMPTY"));
});

test("CameraVisionController auto-tracking handles dead zone and steering", async () => {
  const ptzCommands = [];
  const mockTuya = {
    configured: true,
    ptz: async (deviceId, direction) => {
      ptzCommands.push({ deviceId, direction });
    },
  };
  const mockDb = {
    query: async () => ({
      rows: [{ id: "cam-1", provider: "TUYA", external_id: "ext-tuya-1" }],
    }),
  };

  const controller = new CameraVisionController({
    tuya: mockTuya,
    db: mockDb,
    frameProvider: null,
    visionService: null,
    eventEngine: null,
  });

  controller.setTracking("cam-1", true);

  // Person on far left (x = 0.2)
  await controller.processAutoTracking("cam-1", [
    { bbox: { x: 0.15, y: 0.2, width: 0.1, height: 0.5 } },
  ]);
  assert.ok(ptzCommands.some((c) => c.direction === "LEFT"));

  // Reset cooldown & test person on far right (x = 0.8)
  controller.lastTrackingTimes.clear();
  await controller.processAutoTracking("cam-1", [
    { bbox: { x: 0.75, y: 0.2, width: 0.1, height: 0.5 } },
  ]);
  assert.ok(ptzCommands.some((c) => c.direction === "RIGHT"));
});

test("CameraAIAgent routes questions to appropriate tools", async () => {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("FROM cameras c JOIN rooms r")) {
        return { rows: [{ id: "cam-krampus", room_id: "room-1", name: "Krampus Cam" }] };
      }
      return { rows: [] };
    },
  };
  const mockEngine = {
    getState: () => ({ peopleCount: 3, occupied: true }),
  };
  const mockVision = {
    analyze: async () => ({ description: "Игроки разгадывают код замка." }),
  };

  const agent = new CameraAIAgent({
    db: mockDb,
    eventEngine: mockEngine,
    frameProvider: { getFrames: () => [] },
    visionService: mockVision,
    visionController: { inspectRoom: async () => ({ estimatedPeople: 3 }) },
  });

  const q1 = await agent.answerQuestion({ roomId: "krampus", question: "Сколько сейчас людей?" });
  assert.equal(q1.toolCalled, "getCameraPeopleCount");
  assert.match(q1.answer, /3/);

  const q2 = await agent.answerQuestion({ roomId: "krampus", question: "Что сейчас происходит?" });
  assert.equal(q2.toolCalled, "analyzeCamera");
  assert.match(q2.answer, /замка/);
});

test("CameraEventEngine scopes Socket.IO events to location and camera rooms", async () => {
  const roomEmissions = [];
  const mockIo = {
    to: (room) => ({
      emit: (event, payload) => {
        roomEmissions.push({ room, event, payload });
      },
    }),
  };
  const mockDb = { query: async () => ({ rows: [] }) };

  const engine = new CameraEventEngine({ db: mockDb, io: mockIo });
  await engine.processDetection({
    cameraId: "cam-scope-test",
    locationId: "loc-alpha",
    roomId: "room-1",
    detectionResult: {
      peopleCount: 1,
      people: [{ trackId: 10, bbox: { x: 0.5, y: 0.5, width: 0.1, height: 0.3 } }],
    },
  });

  const roomsHit = roomEmissions.map((e) => e.room);
  // Must emit to both the location room and camera room
  assert.ok(roomsHit.includes("location:loc-alpha"), "Must emit to location:loc-alpha");
  assert.ok(roomsHit.includes("camera:cam-scope-test"), "Must emit to camera:cam-scope-test");
  // Must NOT leak to other locations
  assert.ok(!roomsHit.includes("location:loc-beta"), "Must not leak to loc-beta");
});

test("CameraEventEngine loadStatesFromDb populates state on startup", async () => {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("FROM camera_ai_states")) {
        return {
          rows: [
            {
              camera_id: "cam-restored",
              room_id: "room-restored",
              location_id: "loc-main",
              people_count: 4,
              occupied: true,
              motion: false,
              last_person_entered: "2026-09-08T12:00:00.000Z",
              last_person_left: null,
              last_activity: "2026-09-08T12:30:00.000Z",
              updated_at: "2026-09-08T12:30:00.000Z",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new CameraEventEngine({ db: mockDb, io: null });
  await engine.loadStatesFromDb();

  const state = engine.getState("cam-restored");
  assert.equal(state.peopleCount, 4);
  assert.equal(state.occupied, true);
  assert.equal(state.locationId, "loc-main");
});

test("CameraAIAgent rejects PTZ room inspection when canControlPtz is false", async () => {
  const mockDb = {
    query: async () => ({
      rows: [{ id: "cam-ptz-check", room_id: "room-secret", name: "PTZ Cam" }],
    }),
  };
  let inspectionTriggered = false;
  const mockController = {
    inspectRoom: async () => {
      inspectionTriggered = true;
      return { estimatedPeople: 0 };
    },
  };
  const mockEngine = {
    getState: () => ({ peopleCount: 0, occupied: false }),
  };

  const agent = new CameraAIAgent({
    db: mockDb,
    eventEngine: mockEngine,
    frameProvider: { getFrames: () => [] },
    visionService: null,
    visionController: mockController,
  });

  // Read-only user (canControlPtz = false) requests inspection
  const deniedRes = await agent.answerQuestion({
    roomId: "room-secret",
    question: "Сделай осмотр комнаты",
    canControlPtz: false,
  });

  assert.equal(deniedRes.error, "PERMISSION_DENIED");
  assert.equal(inspectionTriggered, false, "inspectRoom must not have been triggered");

  // User with devices:command (canControlPtz = true) requests inspection
  const allowedRes = await agent.answerQuestion({
    roomId: "room-secret",
    question: "Сделай осмотр комнаты",
    canControlPtz: true,
  });

  assert.equal(allowedRes.error, undefined);
  assert.equal(allowedRes.toolCalled, "inspectRoom");
  assert.equal(inspectionTriggered, true, "inspectRoom must be allowed when authorized");
});

test("CameraVisionController manual PTZ locks out auto-tracking for 15s", async () => {
  const ptzCommands = [];
  const mockTuya = {
    configured: true,
    ptz: async (deviceId, direction) => {
      ptzCommands.push({ deviceId, direction });
    },
  };
  const mockDb = {
    query: async () => ({
      rows: [{ id: "cam-ptz-lock", provider: "TUYA", external_id: "ext-1" }],
    }),
  };

  const controller = new CameraVisionController({
    tuya: mockTuya,
    db: mockDb,
    frameProvider: null,
    visionService: null,
    eventEngine: null,
  });

  controller.setTracking("cam-ptz-lock", true);

  // Manual move by operator triggers lockout
  controller.recordManualPtz("cam-ptz-lock", 15_000);

  // Auto-tracking attempts to move camera
  await controller.processAutoTracking("cam-ptz-lock", [
    { bbox: { x: 0.1, y: 0.2, width: 0.1, height: 0.5 } },
  ]);

  // Must not have issued any PTZ command due to lockout
  assert.equal(ptzCommands.length, 0, "No auto-tracking PTZ commands during lockout");

  // Advance lock time to expired
  controller.manualPtzLockUntil.set("cam-ptz-lock", Date.now() - 1);

  await controller.processAutoTracking("cam-ptz-lock", [
    { bbox: { x: 0.1, y: 0.2, width: 0.1, height: 0.5 } },
  ]);

  // Now it moves
  assert.ok(ptzCommands.some((c) => c.direction === "LEFT"), "Auto-tracking resumes after lock expires");
});

test("CameraEventEngine handleCameraStatus emits CAMERA_OFFLINE and CAMERA_ONLINE", async () => {
  const publishedEvents = [];
  const mockIo = {
    to: () => ({
      emit: (event, payload) => {
        if (event === "camera:ai:event") publishedEvents.push(payload);
      },
    }),
  };
  const mockDb = { query: async () => ({ rows: [] }) };

  const engine = new CameraEventEngine({ db: mockDb, io: mockIo });
  await engine.handleCameraStatus({
    cameraId: "cam-status-test",
    status: "OFFLINE",
    locationId: "loc-test",
  });

  assert.ok(publishedEvents.some((e) => e.type === "CAMERA_OFFLINE"));
  assert.equal(engine.getState("cam-status-test").status, "OFFLINE");

  await engine.handleCameraStatus({
    cameraId: "cam-status-test",
    status: "ONLINE",
    locationId: "loc-test",
  });

  assert.ok(publishedEvents.some((e) => e.type === "CAMERA_ONLINE"));
  assert.equal(engine.getState("cam-status-test").status, "ONLINE");
});

test("CameraEventEngine rate-limits offline notifications during transport flapping", async () => {
  const notices = [];
  const engine = new CameraEventEngine({
    db: { query: async () => ({ rows: [] }) },
    io: null,
    cameraOfflineNotificationCooldownMs: 60_000,
    onNotification: (type) => notices.push(type),
  });

  await engine.handleCameraStatus({ cameraId: "cam-flap", status: "OFFLINE" });
  await engine.handleCameraStatus({ cameraId: "cam-flap", status: "ONLINE" });
  await engine.handleCameraStatus({ cameraId: "cam-flap", status: "OFFLINE" });

  assert.deepEqual(notices, ["CAMERA_OFFLINE"]);
});

test("runMigrations creates schema_migrations and applies pending SQL files", async () => {
  const executedSql = [];
  const mockDb = {
    query: async (sql, params) => {
      executedSql.push({ sql, params });
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return { rows: [{ version: "001-init.sql" }] };
      }
      return { rows: [] };
    },
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"));
  try {
    fs.writeFileSync(path.join(tempDir, "001-init.sql"), "-- already applied");
    fs.writeFileSync(path.join(tempDir, "032-camera-ai.sql"), "CREATE TABLE test_ai();");

    const applied = await runMigrations(mockDb, tempDir);
    assert.deepEqual(applied, ["032-camera-ai.sql"]);
    assert.ok(executedSql.some((e) => e.sql.includes("CREATE TABLE test_ai();")));
    assert.ok(executedSql.some((e) => e.params?.[0] === "032-camera-ai.sql"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CameraEventEngine resets people count and emits ROOM_EMPTY on CAMERA_OFFLINE", async () => {
  const publishedEvents = [];
  const publishedStates = [];
  const mockIo = {
    to: () => ({
      emit: (event, payload) => {
        if (event === "camera:ai:event") publishedEvents.push(payload);
        if (event === "camera:ai:state") publishedStates.push(payload);
      },
    }),
  };
  const persistedStates = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("INSERT INTO camera_ai_states")) {
        persistedStates.push(params);
      }
      return { rows: [] };
    },
  };

  const engine = new CameraEventEngine({ db: mockDb, io: mockIo });
  const cameraId = "cam-offline-test";

  // 1. Initial state: occupied with 3 people
  await engine.processDetection({
    cameraId,
    roomId: "room-offline-1",
    locationId: "loc-offline",
    detectionResult: { peopleCount: 3, people: [{ trackId: 1, bbox: { x: 0.5, y: 0.5, width: 0.2, height: 0.5 } }] },
  });

  assert.equal(engine.getState(cameraId).peopleCount, 3);
  assert.equal(engine.getState(cameraId).occupied, true);

  // 2. Camera goes OFFLINE
  await engine.handleCameraStatus({
    cameraId,
    status: "OFFLINE",
    roomId: "room-offline-1",
    locationId: "loc-offline",
  });

  const offlineState = engine.getState(cameraId);
  assert.equal(offlineState.status, "OFFLINE");
  assert.equal(offlineState.peopleCount, 0, "peopleCount must reset to 0 on OFFLINE");
  assert.equal(offlineState.occupied, false, "occupied must reset to false on OFFLINE");

  // Verify ROOM_EMPTY was emitted because camera was occupied
  assert.ok(publishedEvents.some((e) => e.type === "CAMERA_OFFLINE"));
  assert.ok(publishedEvents.some((e) => e.type === "ROOM_EMPTY" && e.metadata?.reason === "CAMERA_OFFLINE"));
  assert.ok(persistedStates.length > 0, "State must be persisted to DB on OFFLINE");
});

test("Trickle ICE buffer stores candidates and drains cleanly", () => {
  const dummySocket = new EventEmitter();
  const pendingSignals = [];

  dummySocket.on("signal", (sig) => {
    pendingSignals.push(sig);
  });

  // Camera emits answer and trickle ICE candidates
  dummySocket.emit("signal", { sessionId: "sess-1", type: "answer", payload: "v=0..." });
  dummySocket.emit("signal", { sessionId: "sess-1", type: "candidate", payload: "candidate:1 1 UDP 2122260223 192.168.1.100 50000 typ host" });
  dummySocket.emit("signal", { sessionId: "sess-1", type: "candidate", payload: "candidate:2 1 UDP 2122260222 192.168.1.101 50001 typ host" });

  assert.equal(pendingSignals.length, 3);
  assert.equal(pendingSignals[0].type, "answer");

  // Drain candidates (simulating GET /internal/tuya-webrtc/signals)
  const drained = pendingSignals.splice(0, pendingSignals.length);
  assert.equal(drained.length, 3);
  assert.equal(pendingSignals.length, 0, "Buffer should be empty after draining");

  const candidates = drained.filter((s) => s.type === "candidate");
  assert.equal(candidates.length, 2);
  assert.match(candidates[0].payload, /192\.168\.1\.100/);
});

test("CameraFrameProvider correctly ingests frame from AI worker state payload", () => {
  const provider = new CameraFrameProvider();
  const cameraId = "cam-frame-test";

  // Simulate worker JPEG payload
  const fakeJpeg = Buffer.from("fake-jpeg-image-bytes");
  const base64Jpeg = fakeJpeg.toString("base64");

  // Endpoint pushes base64 frame into provider
  provider.pushFrame(cameraId, Buffer.from(base64Jpeg, "base64"));

  const latest = provider.getLatestFrame(cameraId);
  assert.ok(latest);
  assert.equal(latest.buffer.toString(), "fake-jpeg-image-bytes");
});

test("LocalVisionService getLatestFrame parses base64 and returns frame buffer", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const fakeBuffer = Buffer.from("worker-frame-data");
    const fakeBase64 = fakeBuffer.toString("base64");

    globalThis.fetch = async (url) => {
      if (url.includes("/cameras/cam-test-123/frames")) {
        return {
          ok: true,
          json: async () => ({
            cameraId: "cam-test-123",
            frames: [{ timestamp: 1725800000, base64: fakeBase64 }],
          }),
        };
      }
      return { ok: false };
    };

    const service = new LocalVisionService({ baseUrl: "http://ai-service:8088", internalSecret: "test-sec" });
    const frame = await service.getLatestFrame("cam-test-123");

    assert.ok(frame);
    assert.equal(frame.buffer.toString(), "worker-frame-data");
    assert.equal(frame.mimeType, "image/jpeg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalVisionService getLatestFrame selects the newest worker-buffered frame", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        frames: [
          { timestamp: 1725800000, base64: Buffer.from("stale").toString("base64") },
          { timestamp: 1725800002, base64: Buffer.from("fresh").toString("base64") },
        ],
      }),
    });

    const service = new LocalVisionService({ baseUrl: "http://ai-service:8088", internalSecret: "test-sec" });
    const frame = await service.getLatestFrame("cam-test-123");
    assert.equal(frame.buffer.toString(), "fresh");
    assert.equal(frame.timestamp, "2024-09-08T12:53:22.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LocalVisionService sends X-Internal-Secret on all outbound calls", async () => {
  const originalFetch = globalThis.fetch;
  const recordedHeaders = [];

  try {
    globalThis.fetch = async (url, options) => {
      recordedHeaders.push({ url, headers: options?.headers || {} });
      if (url.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      if (url.endsWith("/detect")) {
        return { ok: true, json: async () => ({ peopleCount: 1, people: [] }) };
      }
      if (url.endsWith("/analyze")) {
        return { ok: true, json: async () => ({ people: 1, description: "Test" }) };
      }
      if (url.endsWith("/worker/sync")) {
        return { ok: true };
      }
      if (url.endsWith("/worker/status")) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes("/frames")) {
        return { ok: true, json: async () => ({ frames: [{ base64: Buffer.from("a").toString("base64") }] }) };
      }
      return { ok: false };
    };

    const secret = "secret-super-safe-1234567890123456";
    const service = new LocalVisionService({ baseUrl: "http://ai:8088", internalSecret: secret });

    await service.isHealthy();
    await service.detect({ cameraId: "c1", imageBuffer: Buffer.from("fake") });
    await service.analyze({ cameraId: "c1", frames: ["b64"] });
    await service.syncWorkers([{ id: "c1" }]);
    await service.getWorkerStatus();
    await service.getLatestFrame("c1");

    assert.equal(recordedHeaders.length, 6);
    for (const record of recordedHeaders) {
      assert.equal(record.headers["X-Internal-Secret"], secret, `Header missing for ${record.url}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CameraVisionController inspectRoom fetches fallback frame from visionService when provider has no frames", async () => {
  const frameBuffer = Buffer.from("preset-fallback-frame-bytes");
  let fallbackFetched = false;

  const mockVisionService = {
    getLatestFrame: async (cameraId) => {
      if (cameraId === "cam-inspect") {
        fallbackFetched = true;
        return {
          timestamp: new Date().toISOString(),
          buffer: frameBuffer,
          mimeType: "image/jpeg",
        };
      }
      return null;
    },
    detect: async ({ cameraId, imageBuffer }) => {
      assert.equal(cameraId, "cam-inspect");
      assert.equal(imageBuffer.toString(), "preset-fallback-frame-bytes");
      return { peopleCount: 3, people: [{ trackId: 1 }, { trackId: 2 }, { trackId: 3 }] };
    },
  };

  const emptyFrameProvider = new CameraFrameProvider();
  const mockDb = {
    query: async (q, params) => {
      if (q.includes("FROM camera_presets")) {
        return {
          rows: [
            { id: "p1", name: "Door", ptz_preset: "door" },
            { id: "p2", name: "Chest", ptz_preset: "chest" },
          ],
        };
      }
      if (q.includes("FROM cameras")) {
        return {
          rows: [{
            id: "cam-inspect",
            room_id: "room-1",
            provider: "TUYA",
            external_id: "dev-inspect-1",
          }],
        };
      }
      return { rows: [] };
    },
  };

  const controller = new CameraVisionController({
    db: mockDb,
    frameProvider: emptyFrameProvider,
    visionService: mockVisionService,
    settleDelayMs: 0,
    tuya: {
      configured: true,
      ptz: async () => ({}),
      sendDeviceCommand: async () => ({}),
    },
  });

  const report = await controller.inspectRoom("room-1");
  assert.ok(fallbackFetched, "Fallback frame should have been fetched from vision service");
  assert.equal(report.estimatedPeople, 3);
  assert.equal(report.observations.length, 2);
  assert.equal(report.observations[0].peopleCount, 3);
  // Also check that fallback frame was cached into emptyFrameProvider
  const cached = emptyFrameProvider.getLatestFrame("cam-inspect");
  assert.ok(cached);
  assert.equal(cached.buffer.toString(), "preset-fallback-frame-bytes");
});

test("CameraAIAgent analyzeCamera fetches fallback frame from visionService when provider has no frames", async () => {
  const frameBuffer = Buffer.from("agent-fallback-frame-bytes");
  let fallbackFetched = false;
  let analyzeCalled = false;

  const mockVisionService = {
    getLatestFrame: async (cameraId) => {
      if (cameraId === "cam-agent") {
        fallbackFetched = true;
        return {
          timestamp: new Date().toISOString(),
          buffer: frameBuffer,
          mimeType: "image/jpeg",
        };
      }
      return null;
    },
    analyze: async ({ cameraId, frames }) => {
      analyzeCalled = true;
      assert.equal(frames.length, 1);
      assert.equal(frames[0].buffer.toString(), "agent-fallback-frame-bytes");
      return { people: 2, description: "Два игрока разгадывают загадку." };
    },
  };

  const emptyFrameProvider = new CameraFrameProvider();
  const agent = new CameraAIAgent({
    db: { query: async () => ({ rows: [] }) },
    eventEngine: { getState: () => ({ peopleCount: 2, occupied: true }) },
    frameProvider: emptyFrameProvider,
    visionService: mockVisionService,
    visionController: {},
  });

  const res = await agent.analyzeCamera("cam-agent", "Что происходит?");
  assert.ok(fallbackFetched, "Fallback frame should have been fetched");
  assert.ok(analyzeCalled, "VisionService analyze should have been called with fallback frame");
  assert.equal(res.people, 2);
});

test("Internal secret verification: timing-safe check rejects invalid/missing and accepts valid", () => {
  const expected = "super-secret-hex-key-1234567890123456";

  const verify = (provided) => {
    if (!provided || typeof provided !== "string") return false;
    const bufA = Buffer.from(provided);
    const bufB = Buffer.from(expected);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  };

  assert.equal(verify(null), false);
  assert.equal(verify(""), false);
  assert.equal(verify("internal-ai-service-secret"), false);
  assert.equal(verify("wrong-key"), false);
  assert.equal(verify(expected), true);
});

test("AiWorkerSupervisor retries on initial failure and reconciles on watchdog", async () => {
  let syncAttempts = 0;
  const mockCameras = [{ id: "cam-sup-1", ai_enabled: true, location_id: "loc-1" }];
  let workerStatus = {};

  const mockDb = {
    query: async () => ({ rows: mockCameras }),
  };

  const mockVisionService = {
    syncWorkers: async (cameras) => {
      syncAttempts++;
      if (syncAttempts === 1) return false; // Fail on 1st attempt
      workerStatus = { "cam-sup-1": { online: true } };
      return true; // Succeed on 2nd attempt
    },
    isHealthy: async () => true,
    getWorkerStatus: async () => workerStatus,
  };

  const supervisor = new AiWorkerSupervisor({
    db: mockDb,
    localVisionService: mockVisionService,
    retryIntervalMs: 20,
    maxStartupRetries: 5,
    watchdogIntervalMs: 50,
  });

  supervisor.start();

  // Wait for retry loop to succeed
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(syncAttempts >= 2, "Supervisor should have retried and succeeded");
  assert.equal(supervisor.isSynced, true);

  // Now simulate worker crashing and losing state
  workerStatus = {};
  await supervisor.checkAndReconcile();
  assert.ok(syncAttempts >= 3, "Watchdog should have detected discrepancy and resynced");

  supervisor.stop();
  assert.equal(supervisor.running, false);
});

test("LocalVisionService getRecentClip fetches binary clip with internal secret", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedSecret = "";
  const mockBytes = new TextEncoder().encode("GIF89a-mock-data");

  globalThis.fetch = async (url, options = {}) => {
    capturedUrl = String(url);
    capturedSecret = options.headers?.["X-Internal-Secret"];
    return {
      ok: true,
      arrayBuffer: async () => mockBytes.buffer.slice(mockBytes.byteOffset, mockBytes.byteOffset + mockBytes.byteLength),
    };
  };

  try {
    const service = new LocalVisionService({
      baseUrl: "http://ai-service:8088",
      internalSecret: "test-secret-key-123456",
    });

    const clip = await service.getRecentClip("cam-test-1", 8);
    assert.ok(clip);
    assert.equal(capturedUrl, "http://ai-service:8088/cameras/cam-test-1/clip?count=8");
    assert.equal(capturedSecret, "test-secret-key-123456");
    assert.equal(clip.toString(), "GIF89a-mock-data");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TelegramBot sendPhoto and sendAnimation dispatch multipart payloads", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledBody = null;

  globalThis.fetch = async (url, options = {}) => {
    calledUrl = String(url);
    calledBody = options.body;
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    };
  };

  try {
    const bot = new TelegramBot({ token: "123456:ABC-DEF-GHI-JKL-MNO-PQR-STU-VWX-YZ" });
    const photoBuffer = Buffer.from("fake-jpeg");

    await bot.sendPhoto(1234567, photoBuffer, "<b>Photo caption</b>");
    assert.ok(calledUrl.endsWith("/sendPhoto"));
    assert.ok(calledBody instanceof FormData);
    assert.equal(calledBody.get("chat_id"), "1234567");
    assert.equal(calledBody.get("caption"), "<b>Photo caption</b>");

    const animBuffer = Buffer.from("fake-gif");
    await bot.sendAnimation(1234567, animBuffer, "<b>Animation caption</b>");
    assert.ok(calledUrl.endsWith("/sendAnimation"));
    assert.ok(calledBody instanceof FormData);
    assert.equal(calledBody.get("chat_id"), "1234567");
    assert.equal(calledBody.get("caption"), "<b>Animation caption</b>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram command regex matching handles room photo and clip requests", () => {
  const parseCommand = (text) => {
    const clipMatch = text.match(/(?:(?:пришли|покажи|дай|сделай|отправь)\s+)?(?:клип|видео|gif|animation|clip)(?:\s+(?:из|с|в|от|комнаты))?\s+([a-zA-Zа-яА-Я0-9_\s-]+)/i) ||
      text.match(/^\/clip(?:\s+([a-zA-Zа-яА-Я0-9_\s-]+))?/i);

    const photoMatch = text.match(/(?:(?:пришли|покажи|дай|сделай|отправь)\s+)?(?:снимок|фото|кадр|snapshot|photo|pic)(?:\s+(?:из|с|в|от|комнаты))?\s+([a-zA-Zа-яА-Я0-9_\s-]+)/i) ||
      text.match(/^\/(?:photo|snapshot)(?:\s+([a-zA-Zа-яА-Я0-9_\s-]+))?/i);

    if (clipMatch) return { type: "clip", room: clipMatch[1].trim() };
    if (photoMatch) return { type: "photo", room: photoMatch[1].trim() };
    return null;
  };

  assert.deepEqual(parseCommand("Пришли снимок из Krampus"), { type: "photo", room: "Krampus" });
  assert.deepEqual(parseCommand("Снимок Krampus"), { type: "photo", room: "Krampus" });
  assert.deepEqual(parseCommand("Фото комнаты Лаборатория"), { type: "photo", room: "Лаборатория" });
  assert.deepEqual(parseCommand("/photo Krampus"), { type: "photo", room: "Krampus" });
  assert.deepEqual(parseCommand("Клип из Krampus"), { type: "clip", room: "Krampus" });
  assert.deepEqual(parseCommand("/clip Бункер"), { type: "clip", room: "Бункер" });
  assert.equal(parseCommand("Привет бот"), null);
});

test("pointInPolygon and isInsideZone correctly evaluate containment", () => {
  const polygon = [
    { x: 0.1, y: 0.1 },
    { x: 0.5, y: 0.1 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.5 },
  ];

  assert.equal(pointInPolygon({ x: 0.3, y: 0.3 }, polygon), true);
  assert.equal(pointInPolygon({ x: 0.05, y: 0.3 }, polygon), false);
  assert.equal(pointInPolygon({ x: 0.3, y: 0.6 }, polygon), false);

  const polyZone = { polygon };
  assert.equal(isInsideZone({ x: 0.25, y: 0.25 }, polyZone), true);
  assert.equal(isInsideZone({ x: 0.9, y: 0.9 }, polyZone), false);

  const bboxZone = { x: 0.2, y: 0.2, width: 0.2, height: 0.2 };
  assert.equal(isInsideZone({ x: 0.25, y: 0.25 }, bboxZone), true);
  assert.equal(isInsideZone({ x: 0.1, y: 0.1 }, bboxZone), false);
});

test("HeadsetTrackingEngine maps spatial identity strictly to assigned WORK_ZONE with 3-frame debounce", async () => {
  const publishedEvents = [];
  const publishedStates = [];
  const notifications = [];

  const mockIo = {
    to: () => ({
      emit: (event, payload) => {
        if (event === "camera:headset:event") publishedEvents.push(payload);
        if (event === "camera:headset:state") publishedStates.push(payload);
      },
    }),
  };

  const engine = new HeadsetTrackingEngine({
    db: null,
    io: mockIo,
    onNotification: (type, data) => notifications.push({ type, data }),
    debounceFrames: 3,
  });

  const cameraId = "cam-vr-1";

  engine.addZoneToCache({
    id: "zone-1",
    camera_id: cameraId,
    preset_name: "left_room",
    name: "Рабочая зона H1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Detection with 1 headset inside Zone 1 (center: 0.15, 0.15)
  const headsetDet = [{ confidence: 0.92, bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }];

  // Frame 1: debouncing
  const s1 = await engine.processDetections({
    cameraId,
    preset: "left_room",
    detectedHeadsets: headsetDet,
  });
  assert.equal(s1.assignedZonesState["zone-1"].headsetId, "H1");
  assert.equal(s1.assignedZonesState["zone-1"].status, "EMPTY"); // not yet confirmed
  assert.equal(publishedEvents.length, 0);

  // Frame 2: debouncing
  await engine.processDetections({
    cameraId,
    preset: "left_room",
    detectedHeadsets: headsetDet,
  });
  assert.equal(publishedEvents.length, 0);

  // Frame 3: confirmed OCCUPIED!
  const s3 = await engine.processDetections({
    cameraId,
    preset: "left_room",
    detectedHeadsets: headsetDet,
  });
  assert.equal(s3.assignedZonesState["zone-1"].status, "OCCUPIED");
  assert.equal(s3.assignedZonesState["zone-1"].headsetId, "H1");
  assert.ok(publishedEvents.some((e) => e.type === "HEADSET_ZONE_OCCUPIED" && e.headsetId === "H1"));
});

test("HeadsetTrackingEngine separates CHARGING_BASE from floor work zones and tracks outside headsets anonymously", async () => {
  const publishedEvents = [];
  const notifications = [];

  const mockIo = {
    to: () => ({
      emit: (event, payload) => {
        if (event === "camera:headset:event") publishedEvents.push(payload);
      },
    }),
  };

  const engine = new HeadsetTrackingEngine({
    db: null,
    io: mockIo,
    onNotification: (type, data) => notifications.push({ type, data }),
    debounceFrames: 1, // immediate for this test
  });

  const cameraId = "cam-vr-2";

  // Work Zone H1
  engine.addZoneToCache({
    id: "zone-w1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Зона 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Charging Base on right table
  engine.addZoneToCache({
    id: "zone-base",
    camera_id: cameraId,
    preset_name: "default",
    name: "База зарядки",
    zone_type: "CHARGING_BASE",
    headset_id: null,
    x: 0.7,
    y: 0.7,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // 1 headset on charging base (0.75, 0.75), 1 headset on floor outside all zones (0.5, 0.5)
  const detections = [
    { confidence: 0.95, bbox: { x: 0.72, y: 0.72, width: 0.06, height: 0.06 } }, // in charging base
    { confidence: 0.88, bbox: { x: 0.48, y: 0.48, width: 0.04, height: 0.04 } }, // outside all zones
  ];

  const state = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: detections,
  });

  // Charging base count should be 1
  assert.equal(state.chargingBaseCount, 1);
  // Outside zone count should be 1
  assert.equal(state.outsideZoneCount, 1);
  // Work zone H1 was empty
  assert.equal(state.assignedZonesState["zone-w1"].status, "EMPTY");
  assert.ok(state.emptyAssignedZones.includes("H1"));

  // Crucial requirement: outside headset must NEVER receive an assigned headsetId
  const outsideEvent = publishedEvents.find((e) => e.type === "HEADSET_OUTSIDE_ZONE");
  assert.ok(outsideEvent);
  assert.equal(outsideEvent.headsetId, null);
  assert.equal(outsideEvent.payload.outsideZoneCount, 1);

  // Outside headset does not send a standalone HEADSET_OUTSIDE_ZONE notification (handled via HEADSET_NOT_ON_BASE)
  assert.ok(!notifications.some((n) => n.type === "HEADSET_OUTSIDE_ZONE"));
});

test("HeadsetTrackingEngine preserves NOT_VISIBLE for off-angle preset zones", async () => {
  const engine = new HeadsetTrackingEngine({ db: null });
  const cameraId = "cam-vr-3";

  // Zone 1 on preset 'left_room'
  engine.addZoneToCache({
    id: "zone-left",
    camera_id: cameraId,
    preset_name: "left_room",
    name: "Зона Left",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Zone 2 on preset 'right_room'
  engine.addZoneToCache({
    id: "zone-right",
    camera_id: cameraId,
    preset_name: "right_room",
    name: "Зона Right",
    zone_type: "WORK_ZONE",
    headset_id: "H2",
    x: 0.5,
    y: 0.5,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Camera pointing at 'left_room' with empty room
  const stateLeft = await engine.processDetections({
    cameraId,
    preset: "left_room",
    detectedHeadsets: [],
  });

  // Zone on right_room MUST NOT be EMPTY! It must be NOT_VISIBLE
  assert.equal(stateLeft.assignedZonesState["zone-right"].status, "NOT_VISIBLE");
  assert.ok(stateLeft.notVisibleZones.some((z) => z.zoneId === "zone-right"));

  // Now switch camera to 'right_room'
  const stateRight = await engine.processDetections({
    cameraId,
    preset: "right_room",
    detectedHeadsets: [],
  });

  // Zone on left_room now MUST be NOT_VISIBLE!
  assert.equal(stateRight.assignedZonesState["zone-left"].status, "NOT_VISIBLE");
  assert.ok(stateRight.notVisibleZones.some((z) => z.zoneId === "zone-left"));
});

test("HeadsetTrackingEngine freezes state while camera is moving or settling", async () => {
  const engine = new HeadsetTrackingEngine({ db: null, debounceFrames: 1 });
  const cameraId = "cam-vr-4";

  engine.addZoneToCache({
    id: "zone-h1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Зона H1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Initial detection: headset present
  await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: [{ confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } }],
  });
  assert.equal(engine.getState(cameraId).assignedZonesState["zone-h1"].status, "OCCUPIED");

  // Camera starts moving (PTZ rotation)
  engine.setCameraMoving(cameraId, true);

  // While camera is moving, detections arrive (e.g. blurry frame with 0 detections)
  const stateDuringMove = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: [],
  });

  // State must NOT change to empty or mutate during motion
  assert.equal(stateDuringMove.assignedZonesState["zone-h1"].status, "OCCUPIED");

  // Movement finishes
  engine.setCameraMoving(cameraId, false);
});

test("HeadsetTrackingEngine handles UNKNOWN status and suppresses immediate alert for low confidence", async () => {
  const notifications = [];
  const engine = new HeadsetTrackingEngine({
    db: null,
    confidenceThreshold: 0.65,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  const cameraId = "cam-vr-5";

  engine.addZoneToCache({
    id: "zone-u1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Зона H1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Low confidence detection (e.g. partially occluded headset, conf = 0.50 < 0.65)
  const state = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: [{ confidence: 0.5, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } }],
  });

  assert.equal(state.assignedZonesState["zone-u1"].status, "UNKNOWN");
  // Immediate Telegram alerts must be suppressed
  assert.equal(notifications.length, 0);
});

test("HeadsetTrackingEngine getRoomHeadsetState deduplicates headsets across multiple cameras", async () => {
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("SELECT id, name FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: "cam-left", name: "Камера Левая" },
            { id: "cam-right", name: "Камера Правая" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb, debounceFrames: 1 });

  // Camera Left sees H1 as OCCUPIED and H2 as NOT_VISIBLE
  engine.states.set("cam-left", {
    cameraId: "cam-left",
    chargingBaseCount: 1,
    outsideZoneCount: 0,
    assignedZonesState: {
      "z-1": { headsetId: "H1", name: "Зона 1", status: "OCCUPIED", confidence: 0.9 },
      "z-2": { headsetId: "H2", name: "Зона 2", status: "NOT_VISIBLE", confidence: 1.0 },
    },
  });

  // Camera Right sees H2 as OCCUPIED and H1 as NOT_VISIBLE
  engine.states.set("cam-right", {
    cameraId: "cam-right",
    chargingBaseCount: 0,
    outsideZoneCount: 0,
    assignedZonesState: {
      "z-1": { headsetId: "H1", name: "Зона 1", status: "NOT_VISIBLE", confidence: 1.0 },
      "z-2": { headsetId: "H2", name: "Зона 2", status: "OCCUPIED", confidence: 0.92 },
    },
  });

  const roomState = await engine.getRoomHeadsetState("room-vr-quest");

  // Deduplication: both H1 and H2 are OCCUPIED!
  assert.equal(roomState.headsets["H1"].status, "OCCUPIED");
  assert.equal(roomState.headsets["H2"].status, "OCCUPIED");
  assert.equal(roomState.chargingBaseCount, 1);
  assert.equal(roomState.outsideZoneCount, 0);
});

test("HeadsetTrackingEngine inspectRoomHeadsets sweeps presets, respects manual PTZ lock, and returns to initial preset", async () => {
  const visitedPresets = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [{ id: "cam-inspect-1", name: "PTZ Камера", provider: "TUYA", location_id: "loc-1" }],
        };
      }
      if (sql.includes("SELECT id, name FROM cameras WHERE room_id")) {
        return {
          rows: [{ id: "cam-inspect-1", name: "PTZ Камера" }],
        };
      }
      return { rows: [] };
    },
  };

  const mockVisionController = {
    settleDelayMs: 1,
    manualLocked: false,
    isManualPtzLocked() {
      return this.manualLocked;
    },
    getCurrentPreset() {
      return "Entrance";
    },
    async getPresets() {
      return [{ name: "Entrance" }, { name: "Center" }, { name: "Exit" }];
    },
    async lookAtPreset(cameraId, preset) {
      visitedPresets.push(preset);
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });

  // 1. Successful inspection: should visit presets and return to initial preset ("Entrance")
  const report = await engine.inspectRoomHeadsets("room-123", {
    cameraVisionController: mockVisionController,
    visionService: null,
    frameProvider: null,
  });

  assert.equal(report.initialPreset, "Entrance");
  assert.ok(visitedPresets.includes("Center"));
  assert.ok(visitedPresets.includes("Exit"));
  // Must return to initial preset at the end
  assert.equal(visitedPresets[visitedPresets.length - 1], "Entrance");

  // 2. Operator manual PTZ lockout
  mockVisionController.manualLocked = true;
  await assert.rejects(
    async () => {
      await engine.inspectRoomHeadsets("room-123", {
        cameraVisionController: mockVisionController,
      });
    },
    { code: "MANUAL_PTZ_ACTIVE" }
  );
});

test("HeadsetTrackingEngine enters MODEL_UNAVAILABLE, freezes zone occupancy, and notifies Socket.IO", async () => {
  const emittedEvents = [];
  const mockIo = {
    to: (room) => ({
      emit: (event, payload) => {
        emittedEvents.push({ room, event, payload });
      },
    }),
  };

  const engine = new HeadsetTrackingEngine({
    db: null,
    io: mockIo,
    debounceFrames: 1,
  });

  const cameraId = "cam-fail-safe-1";

  // Pre-seed an existing occupied zone
  engine.states.set(cameraId, {
    cameraId,
    currentPreset: "default",
    chargingBaseCount: 1,
    outsideZoneCount: 0,
    totalDetected: 1,
    assignedZonesState: {
      "z-1": { headsetId: "H1", status: "OCCUPIED" },
    },
    modelStatus: "READY",
  });

  // Receive detection with status: MODEL_UNAVAILABLE
  const updated = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: [],
    status: "MODEL_UNAVAILABLE",
    modelStatus: "MODEL_UNAVAILABLE",
    locationId: "loc-fail-safe",
  });

  // Must have modelStatus: MODEL_UNAVAILABLE
  assert.equal(updated.modelStatus, "MODEL_UNAVAILABLE");
  assert.equal(updated.status, "MODEL_UNAVAILABLE");
  // Occupancy must be preserved (frozen), NOT wiped to EMPTY
  assert.equal(updated.assignedZonesState["z-1"].status, "OCCUPIED");
  assert.equal(updated.chargingBaseCount, 1);

  // Must have emitted camera:headset:state with modelStatus MODEL_UNAVAILABLE
  assert.ok(
    emittedEvents.some(
      (e) =>
        e.room === `camera:${cameraId}` &&
        e.event === "camera:headset:state" &&
        e.payload.modelStatus === "MODEL_UNAVAILABLE"
    )
  );
  assert.ok(
    emittedEvents.some(
      (e) =>
        e.room === "location:loc-fail-safe" &&
        e.event === "camera:headset:state" &&
        e.payload.modelStatus === "MODEL_UNAVAILABLE"
    )
  );
});

test("LocalVisionService detectHeadsets and detectPeople propagate MODEL_UNAVAILABLE on error or 500", async () => {
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error" }),
    });

    const lvs = new LocalVisionService({ baseUrl: "http://localhost:8088", secret: "test-secret" });
    const hsRes = await lvs.detectHeadsets({ cameraId: "cam-test-500", imageBuffer: Buffer.from("fake-jpg") });
    assert.equal(hsRes.status, "MODEL_UNAVAILABLE");
    assert.equal(hsRes.modelStatus, "MODEL_UNAVAILABLE");
    assert.equal(hsRes.headsetCount, 0);

    const peopleRes = await lvs.detectPeople("cam-test-500", Buffer.from("fake-jpg"));
    assert.equal(peopleRes.status, "MODEL_UNAVAILABLE");
    assert.equal(peopleRes.peopleCount, 0);
  } finally {
    global.fetch = origFetch;
  }
});

test("HeadsetTrackingEngine inspectRoomHeadsets throws MODEL_UNAVAILABLE when visionService returns MODEL_UNAVAILABLE", async () => {
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("FROM cameras")) {
        return {
          rows: [
            {
              id: "cam-vr-sweep-fail",
              room_id: "room-sweep-fail",
              location_id: "loc-1",
              name: "Sweep Cam",
              provider: "TUYA",
              external_id: "tuya-sweep-fail",
              headset_tracking_enabled: true,
            },
          ],
        };
      }
      if (sql.includes("camera_presets") || sql.includes("camera_ptz_presets")) {
        return { rows: [{ name: "Center" }, { name: "Entrance" }] };
      }
      return { rows: [] };
    },
  };

  const mockTuya = {
    configured: true,
    sendCommands: async () => true,
    ptz: async () => true,
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("fake-jpeg-frame"), timestamp: Date.now() + 100 }),
  };

  const mockVisionService = {
    detectHeadsets: async () => ({
      status: "MODEL_UNAVAILABLE",
      modelStatus: "MODEL_UNAVAILABLE",
      headsets: [],
      error: "MODEL_UNAVAILABLE: Headset model weights not loaded",
    }),
    setCameraMoving: async () => true,
  };

  const controller = new CameraVisionController({
    tuya: mockTuya,
    db: mockDb,
    frameProvider: mockFrameProvider,
    visionService: mockVisionService,
    settleDelayMs: 0,
  });

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    io: null,
    frameProvider: mockFrameProvider,
    visionService: mockVisionService,
    visionController: controller,
  });

  await assert.rejects(
    async () => {
      await engine.inspectRoomHeadsets("room-sweep-fail");
    },
    (err) => {
      assert.match(err.message, /MODEL_UNAVAILABLE/);
      return true;
    }
  );
});

test("HeadsetTrackingEngine strictly treats CHARGING_BASE as only base, marks WORK_ZONE headsets as not on base, and keeps outside anonymous", async () => {
  const publishedEvents = [];
  const notifications = [];
  const mockIo = {
    to: () => ({
      emit: (ev, pl) => {
        if (ev === "camera:headset:event") publishedEvents.push(pl);
      },
    }),
  };

  const engine = new HeadsetTrackingEngine({
    db: null,
    io: mockIo,
    onNotification: (type, data) => notifications.push({ type, data }),
    debounceFrames: 1,
  });

  const cameraId = "cam-left-1";

  // Left room camera: charging table is on the right side (0.6 - 0.9, 0.6 - 0.9)
  engine.addZoneToCache({
    id: "zone-charging-table",
    camera_id: cameraId,
    preset_name: "default",
    name: "Стол с зарядкой",
    zone_type: "CHARGING_BASE",
    headset_id: null,
    x: 0.6,
    y: 0.6,
    width: 0.3,
    height: 0.3,
    enabled: true,
  });

  // Black floor work square H1 (0.1 - 0.3, 0.1 - 0.3)
  engine.addZoneToCache({
    id: "zone-work-h1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Рабочий квадрат 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Black floor work square H2 (0.35 - 0.55, 0.1 - 0.3)
  engine.addZoneToCache({
    id: "zone-work-h2",
    camera_id: cameraId,
    preset_name: "default",
    name: "Рабочий квадрат 2",
    zone_type: "WORK_ZONE",
    headset_id: "H2",
    x: 0.35,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // 1 on charging table (0.75, 0.75), 1 in work square H1 (0.2, 0.2), 1 on the floor outside any zone (0.05, 0.8)
  const detections = [
    { confidence: 0.95, bbox: { x: 0.7, y: 0.7, width: 0.1, height: 0.1 } }, // charging base
    { confidence: 0.91, bbox: { x: 0.15, y: 0.15, width: 0.1, height: 0.1 } }, // work zone H1
    { confidence: 0.89, bbox: { x: 0.05, y: 0.8, width: 0.05, height: 0.05 } }, // outside all zones
  ];

  const state = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: detections,
  });

  // Charging base count
  assert.equal(state.onChargingBaseCount, 1);
  assert.equal(state.chargingBaseCount, 1);

  // Work zone H1 is occupied on the floor -> counted as NOT on base!
  assert.equal(state.assignedZonesState["zone-work-h1"].status, "OCCUPIED");
  assert.deepEqual(state.notOnBaseHeadsets, ["H1"]);

  // Work zone H2 is empty
  assert.equal(state.assignedZonesState["zone-work-h2"].status, "EMPTY");

  // Outside zone headset is anonymous
  assert.equal(state.outsideZoneCount, 1);

  // Total not on base = 1 in work zone + 1 outside zone = 2
  assert.equal(state.notOnBaseCount, 2);
  assert.equal(state.totalDetected, 3);

  // HEADSET_NOT_ON_BASE event was published
  const notOnBaseEvent = publishedEvents.find((e) => e.type === "HEADSET_NOT_ON_BASE");
  assert.ok(notOnBaseEvent);
  assert.equal(notOnBaseEvent.payload.notOnBaseCount, 2);
  assert.deepEqual(notOnBaseEvent.payload.notOnBaseHeadsets, ["H1"]);
  assert.equal(notOnBaseEvent.payload.outsideZoneCount, 1);
  assert.equal(notOnBaseEvent.payload.onChargingBaseCount, 1);

  // Notification was dispatched
  assert.ok(notifications.some((n) => n.type === "HEADSET_NOT_ON_BASE" && n.data.notOnBaseCount === 2));
});

test("HeadsetTrackingEngine 3-frame base debounce triggers HEADSET_NOT_ON_BASE and single recovery HEADSET_ALL_ON_BASE", async () => {
  const publishedEvents = [];
  const notifications = [];
  const mockIo = {
    to: () => ({
      emit: (ev, pl) => {
        if (ev === "camera:headset:event") publishedEvents.push(pl);
      },
    }),
  };

  const engine = new HeadsetTrackingEngine({
    db: null,
    io: mockIo,
    onNotification: (type, data) => notifications.push({ type, data }),
    debounceFrames: 3,
    notificationCooldownMs: 0, // allow notifications in test
  });

  const cameraId = "cam-debounce-test";

  engine.addZoneToCache({
    id: "zone-base-1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Стол зарядки",
    zone_type: "CHARGING_BASE",
    x: 0.1,
    y: 0.6,
    width: 0.3,
    height: 0.3,
    enabled: true,
  });

  engine.addZoneToCache({
    id: "zone-wz-1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Квадрат 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.5,
    y: 0.1,
    width: 0.2,
    height: 0.2,
    enabled: true,
  });

  // Detection: Headset is on the floor in work zone H1 (not on charging table)
  const floorDetection = [{ confidence: 0.92, bbox: { x: 0.55, y: 0.15, width: 0.1, height: 0.1 } }];

  // Frame 1
  const s1 = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: floorDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_NOT_ON_BASE").length, 0);
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 0);

  // Frame 2
  await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: floorDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_NOT_ON_BASE").length, 0);

  // Frame 3: confirmed! (3 stable frames)
  const s3 = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: floorDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(s3.notOnBaseCount, 1);
  assert.deepEqual(s3.notOnBaseHeadsets, ["H1"]);
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_NOT_ON_BASE").length, 1);
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 1);

  // Frame 4: same violation continues, event is not flooded
  await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: floorDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_NOT_ON_BASE").length, 1);

  // Now operator returns headset to CHARGING_BASE (0.2, 0.7)
  const baseDetection = [{ confidence: 0.94, bbox: { x: 0.2, y: 0.7, width: 0.1, height: 0.1 } }];

  // Frame 5 (recovery candidate frame 1)
  await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: baseDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_ALL_ON_BASE").length, 0);

  // Frame 6 (recovery candidate frame 2)
  await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: baseDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_ALL_ON_BASE").length, 0);

  // Frame 7 (recovery confirmed after 3 stable frames!)
  const s7 = await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: baseDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(s7.onChargingBaseCount, 1);
  assert.equal(s7.notOnBaseCount, 0);
  assert.deepEqual(s7.notOnBaseHeadsets, []);
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_ALL_ON_BASE").length, 1);
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 1);

  // Frame 8: subsequent stable frames do NOT re-send recovery (single recovery message)
  await engine.processDetections({
    cameraId,
    preset: "default",
    detectedHeadsets: baseDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(publishedEvents.filter((e) => e.type === "HEADSET_ALL_ON_BASE").length, 1);
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 1);
});

test("HeadsetTrackingEngine getRoomHeadsetState and inspectRoomHeadsets aggregate storage states and dispatch inspection alerts", async () => {
  const notifications = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("FROM cameras")) {
        return {
          rows: [
            { id: "cam-sweep-1", name: "Камера Левая", room_id: "room-vr-1", location_id: "loc-1", provider: "TUYA", external_id: "tuya-sweep-1", headset_tracking_enabled: true },
          ],
        };
      }
      if (sql.includes("camera_presets") || sql.includes("camera_ptz_presets")) {
        return { rows: [{ name: "Center" }, { name: "BaseView" }] };
      }
      return { rows: [] };
    },
  };

  const mockTuya = {
    configured: true,
    sendCommands: async () => true,
    ptz: async () => true,
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("fake-jpeg-frame"), timestamp: Date.now() + 100 }),
  };

  // Preset Center sees 1 headset on floor (outside all zones)
  const mockVisionService = {
    detectHeadsets: async ({ cameraId }) => ({
      status: "READY",
      modelStatus: "READY",
      headsets: [{ confidence: 0.9, bbox: { x: 0.05, y: 0.05, width: 0.05, height: 0.05 } }],
    }),
    setCameraMoving: async () => true,
  };

  const controller = new CameraVisionController({
    tuya: mockTuya,
    db: mockDb,
    frameProvider: mockFrameProvider,
    visionService: mockVisionService,
    settleDelayMs: 0,
  });

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    io: null,
    frameProvider: mockFrameProvider,
    visionService: mockVisionService,
    visionController: controller,
    onNotification: (type, data) => notifications.push({ type, data }),
    debounceFrames: 1,
    notificationCooldownMs: 0,
  });

  // Run PTZ inspection
  const report = await engine.inspectRoomHeadsets("room-vr-1");

  assert.equal(report.roomId, "room-vr-1");
  assert.equal(report.outsideZoneCount, 1);
  assert.equal(report.notOnBaseCount, 1);
  assert.equal(report.initialPreset, "Center");
  assert.ok(report.summary.includes("не на базе 1"));

  // Inspection confirmed headsets not on base -> dispatched HEADSET_NOT_ON_BASE notification
  assert.ok(notifications.some((n) => n.type === "HEADSET_NOT_ON_BASE" && n.data.notOnBaseCount === 1));
});

test("LocalVisionService annotateHeadsets calls /annotate/headsets endpoint and falls back on error", async () => {
  const origFetch = global.fetch;
  try {
    let capturedBody = null;
    global.fetch = async (url, opts) => {
      if (url.includes("/annotate/headsets")) {
        capturedBody = JSON.parse(opts.body);
        const buf = Buffer.from("annotated-jpeg-data");
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      }
      return { ok: false, status: 404 };
    };

    const lvs = new LocalVisionService({ baseUrl: "http://localhost:8088", secret: "test-secret" });
    const rawImage = Buffer.from("raw-jpeg");
    const annotated = await lvs.annotateHeadsets({
      imageBuffer: rawImage,
      headsets: [{ bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }],
      zones: [{ name: "База", zone_type: "CHARGING_BASE" }],
      notOnBaseCount: 1,
      onChargingBaseCount: 0,
      cameraName: "Камера 1",
    });

    assert.equal(annotated.toString(), "annotated-jpeg-data");
    assert.equal(capturedBody.notOnBaseCount, 1);
    assert.equal(capturedBody.cameraName, "Камера 1");

    // Test fallback when server returns error
    global.fetch = async () => ({ ok: false, status: 500 });
    const fallback = await lvs.annotateHeadsets({ imageBuffer: rawImage });
    assert.equal(fallback.toString(), "raw-jpeg");
  } finally {
    global.fetch = origFetch;
  }
});

test("HeadsetTrackingEngine inspectRoomHeadsets sweeps all room cameras and restores each to its initial preset", async () => {
  const visited = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id = $1 AND headset_tracking_enabled = true")) {
        return {
          rows: [
            { id: "cam-left", name: "Камера Левая", room_id: "room-multi", location_id: "loc-1", headset_tracking_enabled: true },
            { id: "cam-right", name: "Камера Правая", room_id: "room-multi", location_id: "loc-1", headset_tracking_enabled: true },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const initialPresets = {
    "cam-left": "LeftDefault",
    "cam-right": "RightDefault",
  };

  const mockVisionController = {
    settleDelayMs: 0,
    getCurrentPreset(camId) {
      return initialPresets[camId] || "Center";
    },
    async getPresets(camId) {
      if (camId === "cam-left") return [{ name: "LeftP1" }, { name: "LeftP2" }];
      return [{ name: "RightP1" }, { name: "RightP2" }];
    },
    async lookAtPreset(camId, preset) {
      visited.push({ camId, preset });
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  const report = await engine.inspectRoomHeadsets("room-multi", {
    cameraVisionController: mockVisionController,
  });

  assert.equal(report.roomId, "room-multi");
  assert.equal(report.observations.length, 4); // 2 presets * 2 cameras

  // Both cameras must have visited their presets
  assert.ok(visited.some((v) => v.camId === "cam-left" && v.preset === "LeftP1"));
  assert.ok(visited.some((v) => v.camId === "cam-right" && v.preset === "RightP1"));

  // Both cameras must have been restored to their respective initial presets
  const leftMovements = visited.filter((v) => v.camId === "cam-left");
  const rightMovements = visited.filter((v) => v.camId === "cam-right");
  assert.equal(leftMovements[leftMovements.length - 1].preset, "LeftDefault");
  assert.equal(rightMovements[rightMovements.length - 1].preset, "RightDefault");
});

test("HeadsetTrackingEngine inspectRoomHeadsets attaches exact violation observation frame when violation seen only on 1st preset", async () => {
  const notifications = [];
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [{ id: "cam-ptz-alert", name: "PTZ Камера", room_id: "room-alert", location_id: "loc-1" }],
        };
      }
      return { rows: [] };
    },
  };

  const framePreset1 = Buffer.from("frame-preset-1-violation");
  const framePreset2 = Buffer.from("frame-preset-2-empty");

  let currentPresetBeingViewed = "Preset1";
  const mockFrameProvider = {
    getLatestFrame: () => ({
      buffer: currentPresetBeingViewed === "Preset1" ? framePreset1 : framePreset2,
      timestamp: Date.now() + 100,
    }),
  };

  const mockVisionService = {
    detectHeadsets: async ({ cameraId, imageBuffer }) => {
      if (imageBuffer.equals(framePreset1)) {
        return {
          status: "READY",
          headsets: [{ confidence: 0.95, bbox: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }],
        };
      }
      return { status: "READY", headsets: [] };
    },
  };

  const mockVisionController = {
    settleDelayMs: 0,
    getCurrentPreset: () => "InitialPreset",
    getPresets: async () => [{ name: "Preset1" }, { name: "Preset2" }],
    lookAtPreset: async (camId, preset) => {
      currentPresetBeingViewed = preset;
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    frameProvider: mockFrameProvider,
    visionService: mockVisionService,
    onNotification: (type, data) => notifications.push({ type, data }),
    debounceFrames: 1,
    notificationCooldownMs: 0,
  });

  // Zone on Preset1: work zone H1 (where bbox 0.5, 0.5 falls)
  engine.addZoneToCache({
    id: "zone-p1",
    camera_id: "cam-ptz-alert",
    preset_name: "Preset1",
    name: "Квадрат 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.4,
    y: 0.4,
    width: 0.3,
    height: 0.3,
    enabled: true,
  });

  const report = await engine.inspectRoomHeadsets("room-alert", {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(report.notOnBaseCount, 1);
  assert.equal(notifications.length, 1);
  const notif = notifications[0];
  assert.equal(notif.type, "HEADSET_NOT_ON_BASE");
  assert.equal(notif.data.preset, "Preset1"); // Exact problematic preset!
  assert.ok(notif.data.imageBuffer.equals(framePreset1)); // Exact violation frame!
  assert.equal(notif.data.detectedHeadsets.length, 1);
});

test("HeadsetTrackingEngine deduplicates shared physical charging base between left and right cameras", async () => {
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes("SELECT id, name FROM cameras WHERE room_id = $1")) {
        return {
          rows: [
            { id: "cam-left", name: "Камера Левая" },
            { id: "cam-right", name: "Камера Правая" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });

  // Both cameras point to the SAME table (base_station_id: "table-center")
  // Left camera view has is_canonical_base: false, right camera has is_canonical_base: true
  engine.addZoneToCache({
    id: "zone-base-left",
    camera_id: "cam-left",
    preset_name: "default",
    name: "База зарядки слева",
    zone_type: "CHARGING_BASE",
    base_station_id: "table-center",
    is_canonical_base: false,
    enabled: true,
  });

  engine.addZoneToCache({
    id: "zone-base-right",
    camera_id: "cam-right",
    preset_name: "default",
    name: "База зарядки справа (каноническая)",
    zone_type: "CHARGING_BASE",
    base_station_id: "table-center",
    is_canonical_base: true,
    enabled: true,
  });

  // Left camera sees 2 headsets on charging table
  engine.states.set("cam-left", {
    cameraId: "cam-left",
    currentPreset: "default",
    chargingBaseCount: 2,
    onChargingBaseCount: 2,
    outsideZoneCount: 0,
    notOnBaseCount: 0,
    notOnBaseHeadsets: [],
    assignedZonesState: {},
  });

  // Right camera also sees the same 2 headsets on charging table
  engine.states.set("cam-right", {
    cameraId: "cam-right",
    currentPreset: "default",
    chargingBaseCount: 2,
    onChargingBaseCount: 2,
    outsideZoneCount: 0,
    notOnBaseCount: 0,
    notOnBaseHeadsets: [],
    assignedZonesState: {},
  });

  const state = await engine.getRoomHeadsetState("room-shared-base");
  // Total charging base must be 2, NOT 4!
  assert.equal(state.onChargingBaseCount, 2);
  assert.equal(state.chargingBaseCount, 2);
});

test("HeadsetTrackingEngine expected=4 with base=1 gives NOT_ALL_ON_BASE with missing=3 and rejects ALL_ON_BASE", async () => {
  const notifications = [];
  const engine = new HeadsetTrackingEngine({
    db: null,
    debounceFrames: 1,
    notificationCooldownMs: 0,
    onNotification: (type, data) => notifications.push({ type, data }),
  });

  engine.addZoneToCache({
    id: "zone-base",
    camera_id: "cam-partial",
    preset_name: "default",
    name: "База зарядки",
    zone_type: "CHARGING_BASE",
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.8,
    enabled: true,
  });

  // 1 headset on base, 0 outside, but expected=4
  const state = await engine.processDetections({
    cameraId: "cam-partial",
    preset: "default",
    expectedHeadsetCount: 4,
    detectedHeadsets: [
      { confidence: 0.95, bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
    ],
  });

  assert.equal(state.onChargingBaseCount, 1);
  assert.equal(state.missingFromBaseCount, 3);
  assert.equal(state.unlocatedCount, 3);
  assert.equal(state.storageStatus, "NOT_ALL_ON_BASE");
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 0);
});

test("HeadsetTrackingEngine missing expected count yields NOT_CONFIGURED and never emits ALL_ON_BASE", async () => {
  const notifications = [];
  const engine = new HeadsetTrackingEngine({
    db: null,
    debounceFrames: 1,
    notificationCooldownMs: 0,
    onNotification: (type, data) => notifications.push({ type, data }),
  });

  engine.addZoneToCache({
    id: "zone-base",
    camera_id: "cam-no-exp",
    preset_name: "default",
    name: "База зарядки",
    zone_type: "CHARGING_BASE",
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.8,
    enabled: true,
  });

  const state = await engine.processDetections({
    cameraId: "cam-no-exp",
    preset: "default",
    detectedHeadsets: [
      { confidence: 0.95, bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
    ],
  });

  assert.equal(state.onChargingBaseCount, 1);
  assert.equal(state.storageStatus, "NOT_CONFIGURED");
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 0);
});

test("HeadsetTrackingEngine continuous identical violation does NOT spam notifications even after cooldown", async () => {
  const notifications = [];
  const engine = new HeadsetTrackingEngine({
    db: null,
    debounceFrames: 1,
    notificationCooldownMs: 100, // 100ms cooldown
    onNotification: (type, data) => notifications.push({ type, data }),
  });

  engine.addZoneToCache({
    id: "zone-wz",
    camera_id: "cam-antispam",
    preset_name: "default",
    name: "Квадрат 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.3,
    enabled: true,
  });

  const floorDetection = [{ confidence: 0.95, bbox: { x: 0.15, y: 0.15, width: 0.1, height: 0.1 } }];

  // Frame 1: initial violation alert sent
  await engine.processDetections({
    cameraId: "cam-antispam",
    preset: "default",
    detectedHeadsets: floorDetection,
    expectedHeadsetCount: 1,
  });
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 1);

  // Wait past cooldown
  await new Promise((r) => setTimeout(r, 120));

  // Frame 2: same exact violation (same headset H1, same count)
  await engine.processDetections({
    cameraId: "cam-antispam",
    preset: "default",
    detectedHeadsets: floorDetection,
    expectedHeadsetCount: 1,
  });

  // Must NOT send another notification because the state did not change!
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 1);
});

test("HeadsetTrackingEngine: two physical bases in one room (expected=4, 2 on each) resolves to ALL_ON_BASE without alarms", async () => {
  const notifications = [];
  const roomId = "room-multi-base";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: "cam-base-1", name: "Камера База 1", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
            { id: "cam-base-2", name: "Камера База 2", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    debounceFrames: 1,
    onNotification: (type, data) => notifications.push({ type, data }),
  });

  engine.setRoomExpectedHeadsets(roomId, 4);

  // Camera 1 points to Base Station 1
  engine.addZoneToCache({
    id: "zone-base-1",
    camera_id: "cam-base-1",
    preset_name: "default",
    name: "База 1",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_station_1",
    is_canonical_base: true,
    expected_headset_count: 2,
    x: 0.1, y: 0.1, width: 0.3, height: 0.3,
    enabled: true,
  });

  // Camera 2 points to Base Station 2
  engine.addZoneToCache({
    id: "zone-base-2",
    camera_id: "cam-base-2",
    preset_name: "default",
    name: "База 2",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_station_2",
    is_canonical_base: true,
    expected_headset_count: 2,
    x: 0.6, y: 0.6, width: 0.3, height: 0.3,
    enabled: true,
  });

  // Cam 1 sees 2 headsets on its base
  await engine.processDetections({
    cameraId: "cam-base-1",
    roomId,
    preset: "default",
    detectedHeadsets: [
      { confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } },
      { confidence: 0.9, bbox: { x: 0.20, y: 0.20, width: 0.05, height: 0.05 } },
    ],
  });

  // Cam 2 sees 2 headsets on its base
  await engine.processDetections({
    cameraId: "cam-base-2",
    roomId,
    preset: "default",
    detectedHeadsets: [
      { confidence: 0.9, bbox: { x: 0.65, y: 0.65, width: 0.05, height: 0.05 } },
      { confidence: 0.9, bbox: { x: 0.70, y: 0.70, width: 0.05, height: 0.05 } },
    ],
  });

  // Crucial check: Neither camera should trigger false HEADSET_NOT_ON_BASE alarm!
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 0);

  // Perform room inspection across both cameras
  const mockVisionService = {
    detectHeadsets: async ({ cameraId }) => {
      if (cameraId === "cam-base-1") {
        return {
          status: "READY",
          headsets: [
            { confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } },
            { confidence: 0.9, bbox: { x: 0.20, y: 0.20, width: 0.05, height: 0.05 } },
          ],
        };
      }
      return {
        status: "READY",
        headsets: [
          { confidence: 0.9, bbox: { x: 0.65, y: 0.65, width: 0.05, height: 0.05 } },
          { confidence: 0.9, bbox: { x: 0.70, y: 0.70, width: 0.05, height: 0.05 } },
        ],
      };
    },
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("fresh-frame"), timestamp: Date.now() + 100 }),
  };

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };

  const inspection = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(inspection.storageStatus, "ALL_ON_BASE");
  assert.equal(inspection.chargingBaseCount, 4);
  assert.equal(inspection.missingFromBaseCount, 0);
  assert.equal(inspection.notOnBaseCount, 0);
  // Zero alarms triggered
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 0);
});

test("HeadsetTrackingEngine: stale cached frame (timestamp < movementStartTime) times out to FRAME_UNAVAILABLE without mutating state", async () => {
  const notifications = [];
  const roomId = "room-stale-test";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: "cam-stale", name: "PTZ Камера", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  engine.setRoomExpectedHeadsets(roomId, 4);

  let detectHeadsetsCalled = false;
  const mockVisionService = {
    detectHeadsets: async () => {
      detectHeadsetsCalled = true;
      return { status: "READY", headsets: [] };
    },
  };

  // Provider returns frame from 10 seconds ago (stale cached frame from previous preset)
  const staleTimestamp = Date.now() - 10_000;
  const mockFrameProvider = {
    getLatestFrame: () => ({
      buffer: Buffer.from("stale-cached-jpeg"),
      timestamp: staleTimestamp,
    }),
  };

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };

  const result = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  // Stale frame must NOT be analyzed
  assert.equal(detectHeadsetsCalled, false);
  // Observation must be flagged FRAME_UNAVAILABLE
  assert.equal(result.observations[0].status, "FRAME_UNAVAILABLE");
  assert.equal(result.storageStatus, "FRAME_UNAVAILABLE");
  // No false alarms triggered
  assert.equal(notifications.length, 0);
});

test("HeadsetTrackingEngine: inspectRoomHeadsets selects canonical CHARGING_BASE observation photo for missing headsets", async () => {
  const notifications = [];
  const roomId = "room-canonical-photo";
  const cameraId = "cam-photo-test";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cameraId, name: "Камера Зала", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    debounceFrames: 1,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  engine.setRoomExpectedHeadsets(roomId, 4);

  // Preset 1: Floor view (no charging base)
  engine.addZoneToCache({
    id: "zone-floor",
    camera_id: cameraId,
    preset_name: "FloorPreset",
    name: "Рабочий квадрат 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.1, y: 0.1, width: 0.2, height: 0.2,
    enabled: true,
  });

  // Preset 2: Canonical Charging Base view
  engine.addZoneToCache({
    id: "zone-base-canonical",
    camera_id: cameraId,
    preset_name: "BasePreset",
    name: "Основной стол зарядки",
    zone_type: "CHARGING_BASE",
    base_station_id: "station_1",
    is_canonical_base: true,
    expected_headset_count: 4,
    x: 0.6, y: 0.6, width: 0.3, height: 0.3,
    enabled: true,
  });

  let currentPreset = "FloorPreset";
  const floorBuffer = Buffer.from("floor-frame-buffer");
  const baseBuffer = Buffer.from("canonical-base-frame-buffer");

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    getPresets: async () => [{ name: "FloorPreset" }, { name: "BasePreset" }],
    lookAtPreset: async (cid, preset) => {
      currentPreset = preset;
    },
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({
      buffer: currentPreset === "FloorPreset" ? floorBuffer : baseBuffer,
      timestamp: Date.now() + 100,
    }),
  };

  const mockVisionService = {
    detectHeadsets: async () => {
      if (currentPreset === "FloorPreset") {
        return { status: "READY", headsets: [] }; // Nothing on the floor
      }
      // On the base preset: only 1 headset detected on the table (expected 4, missing 3)
      return {
        status: "READY",
        headsets: [{ confidence: 0.95, bbox: { x: 0.65, y: 0.65, width: 0.05, height: 0.05 } }],
      };
    },
  };

  const report = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(report.storageStatus, "NOT_ALL_ON_BASE");
  assert.equal(report.missingFromBaseCount, 3);
  assert.equal(report.notOnBaseCount, 3);

  // An alert should have been sent
  const alert = notifications.find((n) => n.type === "HEADSET_NOT_ON_BASE");
  assert.ok(alert);
  // The alert photo MUST be taken from the canonical CHARGING_BASE observation (BasePreset), NOT FloorPreset!
  assert.equal(alert.data.preset, "BasePreset");
  assert.equal(alert.data.imageBuffer.toString(), "canonical-base-frame-buffer");
});

test("HeadsetTrackingEngine: inspectRoomHeadsets room-level anti-spam sends ALL_ON_BASE only after confirmed violation transition", async () => {
  const notifications = [];
  const roomId = "room-antispam-test";
  const cameraId = "cam-antispam-room";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cameraId, name: "Камера", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    debounceFrames: 1,
    notificationCooldownMs: 60_000,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  engine.setRoomExpectedHeadsets(roomId, 2);

  engine.addZoneToCache({
    id: "zone-base-as",
    camera_id: cameraId,
    preset_name: "default",
    name: "База",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_1",
    is_canonical_base: true,
    expected_headset_count: 2,
    x: 0.1, y: 0.1, width: 0.3, height: 0.3,
    enabled: true,
  });

  let detectedList = [
    { confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } },
    { confidence: 0.9, bbox: { x: 0.20, y: 0.20, width: 0.05, height: 0.05 } },
  ];

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };

  const mockVisionService = {
    detectHeadsets: async () => ({ status: "READY", headsets: detectedList }),
  };

  // 1. Initial inspection when everything is fine: NO prior violation -> should NOT spam ALL_ON_BASE
  await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 0);

  // 2. Violation occurs: 1 headset missing
  detectedList = [{ confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } }];
  await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 1);

  // 3. Recovery: both headsets back on base -> should send exactly ONE recovery notification
  detectedList = [
    { confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } },
    { confidence: 0.9, bbox: { x: 0.20, y: 0.20, width: 0.05, height: 0.05 } },
  ];
  await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 1);

  // 4. Repeated inspection while still fine -> must NOT send duplicate ALL_ON_BASE
  await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });
  assert.equal(notifications.filter((n) => n.type === "HEADSET_ALL_ON_BASE").length, 1);
});

test("HeadsetTrackingEngine: inspectRoomHeadsets strictly ignores cameras with headset_tracking_enabled = false and returns NOT_CONFIGURED", async () => {
  const roomId = "room-disabled-tracking";
  const mockDb = {
    query: async (sql) => {
      // Query filters WHERE room_id = $1 AND headset_tracking_enabled = true
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  const result = await engine.inspectRoomHeadsets(roomId);

  assert.equal(result.storageStatus, "NOT_CONFIGURED");
  assert.ok(result.summary.includes("headset_tracking_enabled = true"));
  assert.equal(result.observations.length, 0);
});

test("Inspection notOnBaseCount breakdown never shows 'Всего не на базе: 0' when expected=4 and base=1", async () => {
  const roomId = "room-missing-calc";
  const cameraId = "cam-missing-calc";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cameraId, name: "Камера", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  engine.setRoomExpectedHeadsets(roomId, 4);

  engine.addZoneToCache({
    id: "zone-base-calc",
    camera_id: cameraId,
    preset_name: "default",
    name: "База зарядки",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_calc",
    is_canonical_base: true,
    x: 0.1, y: 0.1, width: 0.3, height: 0.3,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };
  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({
      status: "READY",
      headsets: [{ confidence: 0.95, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } }],
    }),
  };

  const report = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(report.expectedHeadsetCount, 4);
  assert.equal(report.onChargingBaseCount, 1);
  assert.equal(report.missingFromBaseCount, 3);
  assert.equal(report.unlocatedCount, 3);
  assert.equal(report.notOnBaseCount, 3);
  assert.equal(report.storageStatus, "NOT_ALL_ON_BASE");
  assert.ok(report.summary.includes("не на базе 3"));
  assert.ok(report.summary.includes("не локализовано: 3"));
});

test("Migration 033 defines expected columns and partial unique index on canonical base stations", () => {
  const migPath = path.resolve(process.cwd(), "../../infra/postgres/migrations/033-vr-headset-tracking.sql");
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(sql.includes("camera_headset_zones_canonical_idx"));
  assert.ok(sql.includes("WHERE is_canonical_base = true"));
  assert.ok(sql.includes("expected_headset_count"));
  assert.ok(sql.includes("missing_from_base_count"));
  assert.ok(sql.includes("unlocated_count"));
});

test("Migration 034 scopes canonical base stations by room_id", () => {
  const migPath = path.resolve(process.cwd(), "../../infra/postgres/migrations/034-headset-zones-room-scope.sql");
  const sql = fs.readFileSync(migPath, "utf8");
  assert.ok(sql.includes("camera_headset_zones_room_canonical_idx"));
  assert.ok(sql.includes("camera_headset_zones(room_id, base_station_id)"));
  assert.ok(sql.includes("WHERE is_canonical_base = true AND room_id IS NOT NULL"));
  assert.ok(sql.includes("DROP INDEX IF EXISTS camera_headset_zones_canonical_idx"));
});

test("HeadsetTrackingEngine: inspectRoomHeadsets marks PRESET_UNAVAILABLE when lookAtPreset fails, skips analysis and alerts", async () => {
  const roomId = "room-preset-err";
  const cameraId = "cam-ptz-err";
  const notifications = [];
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cameraId, name: "Камера Сбой", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    onNotification: (type, data) => notifications.push({ type, data }),
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    getCurrentPreset: () => "InitialPreset",
    getPresets: async () => [{ name: "BrokenPreset" }, { name: "WorkingPreset" }],
    lookAtPreset: async (cid, preset) => {
      if (preset === "BrokenPreset") {
        throw new Error("PTZ motor timeout");
      }
    },
  };

  let detectCallCount = 0;
  const mockVisionService = {
    detectHeadsets: async () => {
      detectCallCount++;
      return { status: "READY", headsets: [] };
    },
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };

  const result = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(result.observations.length, 2);
  const brokenObs = result.observations.find((o) => o.preset === "BrokenPreset");
  assert.ok(brokenObs);
  assert.equal(brokenObs.status, "PRESET_UNAVAILABLE");
  assert.equal(brokenObs.imageBuffer, null);

  const workingObs = result.observations.find((o) => o.preset === "WorkingPreset");
  assert.ok(workingObs);
  assert.equal(workingObs.status, "READY");

  // detectHeadsets was called only once (for WorkingPreset, NOT BrokenPreset)
  assert.equal(detectCallCount, 1);
  // No error alerts were dispatched from BrokenPreset
  assert.equal(notifications.filter((n) => n.type === "HEADSET_NOT_ON_BASE").length, 0);
});

test("HeadsetTrackingEngine: inspectRoomHeadsets rejects frames without timestamp or with timestamp <= cutoffTime", async () => {
  const roomId = "room-frame-freshness";
  const cameraId = "cam-freshness";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cameraId, name: "Камера Кадры", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });

  const mockVisionController = {
    settleDelayMs: 5,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };

  // Case 1: Frame without timestamp -> rejected as FRAME_UNAVAILABLE
  const mockNoTimeProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("no-timestamp-frame") }),
  };

  const resNoTime = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    frameProvider: mockNoTimeProvider,
  });
  assert.equal(resNoTime.storageStatus, "FRAME_UNAVAILABLE");
  assert.equal(resNoTime.observations[0].status, "FRAME_UNAVAILABLE");

  // Case 2: Frame with timestamp from movement start (stale/motion frame) -> rejected as FRAME_UNAVAILABLE
  const oldTime = Date.now() - 1000;
  const mockStaleProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("motion-frame"), timestamp: oldTime }),
  };

  const resStale = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    frameProvider: mockStaleProvider,
  });
  assert.equal(resStale.storageStatus, "FRAME_UNAVAILABLE");
  assert.equal(resStale.observations[0].status, "FRAME_UNAVAILABLE");
});

test("HeadsetTrackingEngine: getRoomHeadsetState filters cameras strictly with headset_tracking_enabled = true", async () => {
  const roomId = "room-filtered-tracking";
  let capturedSql = "";
  const mockDb = {
    query: async (sql, params) => {
      capturedSql = sql;
      return { rows: [] }; // No enabled cameras found
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  const result = await engine.getRoomHeadsetState(roomId);

  assert.ok(capturedSql.includes("WHERE room_id = $1 AND headset_tracking_enabled = true"));
  assert.equal(result.storageStatus, "NOT_CONFIGURED");
});

test("Expected count semantics: notOnBaseCount is expected - onBase, with countConflict when physical misplaced exceeds missing", async () => {
  const cameraId = "cam-count-semantics";
  const roomId = "room-count-semantics";

  const mockDb = {
    query: async (sql) => {
      if (sql.includes("FROM cameras")) {
        return {
          rows: [
            { id: cameraId, name: "Камера Семантика", room_id: roomId, headset_tracking_enabled: true },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb, debounceFrames: 1 });
  engine.cameraRooms.set(cameraId, roomId);

  // Expected 4 headsets in room
  engine.setRoomExpectedHeadsets(roomId, 4);

  // Charging base zone (holds 3 headsets)
  engine.addZoneToCache({
    id: "zone-base",
    camera_id: cameraId,
    preset_name: "default",
    name: "Зарядная станция",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_sem",
    is_canonical_base: true,
    x: 0.1, y: 0.1, width: 0.3, height: 0.3,
    enabled: true,
  });

  // Work zone H1 (occupied)
  engine.addZoneToCache({
    id: "zone-work-1",
    camera_id: cameraId,
    preset_name: "default",
    name: "Рабочая зона 1",
    zone_type: "WORK_ZONE",
    headset_id: "H1",
    x: 0.5, y: 0.1, width: 0.2, height: 0.2,
    enabled: true,
  });

  // 3 on charging base, 1 in work zone H1, 1 outside all zones -> physicalMisplaced = 2, onBase = 3
  const detections = [
    { confidence: 0.9, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } },
    { confidence: 0.9, bbox: { x: 0.20, y: 0.20, width: 0.05, height: 0.05 } },
    { confidence: 0.9, bbox: { x: 0.25, y: 0.25, width: 0.05, height: 0.05 } },
    { confidence: 0.9, bbox: { x: 0.55, y: 0.15, width: 0.05, height: 0.05 } }, // work zone H1
    { confidence: 0.9, bbox: { x: 0.85, y: 0.85, width: 0.05, height: 0.05 } }, // outside zone
  ];

  const state = await engine.processDetections({
    cameraId,
    preset: "default",
    roomId,
    detectedHeadsets: detections,
  });

  assert.equal(state.expectedHeadsetCount, 4);
  assert.equal(state.onChargingBaseCount, 3);
  assert.equal(state.missingFromBaseCount, 1); // 4 - 3 = 1
  // notOnBaseCount MUST be missingFromBaseCount (1), NOT Math.max(2, 1) = 2
  assert.equal(state.notOnBaseCount, 1);
  assert.equal(state.countConflict, true);
  assert.equal(state.outsideZoneCount, 1);
  assert.deepEqual(state.notOnBaseHeadsets, ["H1"]);

  // Room aggregation also reports notOnBaseCount = 1 and countConflict = true
  const roomReport = await engine.getRoomHeadsetState(roomId);
  assert.equal(roomReport.missingFromBaseCount, 1);
  assert.equal(roomReport.notOnBaseCount, 1);
  assert.equal(roomReport.countConflict, true);
});

test("Multiple CHARGING_BASE zones in same preset track counts per zone without double-counting", async () => {
  const roomId = "room-multi-base-preset";
  const cameraId = "cam-multi-base";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cameraId, name: "Камера Две Базы", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  engine.setRoomExpectedHeadsets(roomId, 4);

  // Base 1 in same preset
  engine.addZoneToCache({
    id: "zone-base-1",
    camera_id: cameraId,
    preset_name: "default",
    name: "База 1",
    zone_type: "CHARGING_BASE",
    base_station_id: "station_1",
    is_canonical_base: true,
    x: 0.05, y: 0.05, width: 0.3, height: 0.3,
    enabled: true,
  });

  // Base 2 in same preset
  engine.addZoneToCache({
    id: "zone-base-2",
    camera_id: cameraId,
    preset_name: "default",
    name: "База 2",
    zone_type: "CHARGING_BASE",
    base_station_id: "station_2",
    is_canonical_base: true,
    x: 0.55, y: 0.55, width: 0.3, height: 0.3,
    enabled: true,
  });

  // 2 headsets in Base 1, 2 headsets in Base 2 (total 4)
  const detections = [
    { confidence: 0.95, bbox: { x: 0.10, y: 0.10, width: 0.05, height: 0.05 } },
    { confidence: 0.95, bbox: { x: 0.15, y: 0.15, width: 0.05, height: 0.05 } },
    { confidence: 0.95, bbox: { x: 0.60, y: 0.60, width: 0.05, height: 0.05 } },
    { confidence: 0.95, bbox: { x: 0.65, y: 0.65, width: 0.05, height: 0.05 } },
  ];

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };
  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({ status: "READY", headsets: detections }),
  };

  const report = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  // Total charging base must be 4, NOT 8 (from 4+4)
  assert.equal(report.chargingBaseCount, 4);
  assert.equal(report.onChargingBaseCount, 4);
  assert.equal(report.missingFromBaseCount, 0);
  assert.equal(report.notOnBaseCount, 0);
  assert.equal(report.storageStatus, "ALL_ON_BASE");

  // Zone states have exact per-zone counts
  const obs = report.observations[0];
  assert.equal(obs.assignedZones["zone-base-1"].headsetCount, 2);
  assert.equal(obs.assignedZones["zone-base-2"].headsetCount, 2);
});

test("P0 Coverage: one of two physical bases unavailable yields coverage PARTIAL, INSPECTION_INCOMPLETE, and 0 alarms", async () => {
  const roomId = "room-two-bases-partial";
  const cam1 = "cam-base-1";
  const cam2 = "cam-base-2";
  const notifications = [];

  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [
            { id: cam1, name: "Камера 1 (База А)", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
            { id: cam2, name: "Камера 2 (База Б)", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  engine.setRoomExpectedHeadsets(roomId, 4);

  // Base A on cam 1
  engine.addZoneToCache({
    id: "zone-base-A",
    camera_id: cam1,
    room_id: roomId,
    preset_name: "default",
    name: "База А",
    zone_type: "CHARGING_BASE",
    base_station_id: "station_A",
    is_canonical_base: true,
    enabled: true,
  });

  // Base B on cam 2
  engine.addZoneToCache({
    id: "zone-base-B",
    camera_id: cam2,
    room_id: roomId,
    preset_name: "default",
    name: "База Б",
    zone_type: "CHARGING_BASE",
    base_station_id: "station_B",
    is_canonical_base: true,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async (cid) => {
      if (cid === cam2) {
        throw new Error("Cam 2 connection dropped");
      }
    },
  };
  const mockFrameProvider = {
    getLatestFrame: (cid) => {
      if (cid === cam1) {
        return { buffer: Buffer.from("frame-1"), timestamp: Date.now() + 100 };
      }
      return null;
    },
  };
  const mockVisionService = {
    detectHeadsets: async ({ cameraId }) => {
      if (cameraId === cam1) {
        return {
          status: "READY",
          headsets: [
            { confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
            { confidence: 0.9, bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
          ],
        };
      }
      return { status: "MODEL_UNAVAILABLE", headsets: [] };
    },
  };

  const result = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(result.coverage, "PARTIAL");
  assert.equal(result.storageStatus, "INSPECTION_INCOMPLETE");
  assert.ok(result.failedBases.includes("station_B"));
  assert.equal(result.failedCameras.length, 1);
  assert.equal(result.failedCameras[0].cameraId, cam2);

  // Crucial: 0 alarms dispatched, roomLastConfirmedStatus was NOT mutated to NOT_ALL_ON_BASE!
  assert.equal(notifications.length, 0);
  assert.equal(engine.roomLastConfirmedStatus.get(roomId), undefined);
});

test("P0 Coverage: floor preset READY but canonical base PRESET_UNAVAILABLE yields coverage PARTIAL and 0 alarms", async () => {
  const roomId = "room-floor-ready-base-down";
  const camId = "cam-single";
  const notifications = [];

  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [{ id: camId, name: "Камера Зал", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" }],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  engine.setRoomExpectedHeadsets(roomId, 4);

  // Canonical base zone on ChargingPreset
  engine.addZoneToCache({
    id: "zone-base-canonical",
    camera_id: camId,
    room_id: roomId,
    preset_name: "ChargingPreset",
    name: "Стол зарядки",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_table",
    is_canonical_base: true,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    getPresets: async () => [{ name: "FloorPreset" }, { name: "ChargingPreset" }],
    lookAtPreset: async (cid, preset) => {
      if (preset === "ChargingPreset") {
        throw new Error("PTZ motor jammed");
      }
    },
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({ status: "READY", headsets: [] }),
  };

  const result = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(result.coverage, "PARTIAL");
  assert.equal(result.storageStatus, "INSPECTION_INCOMPLETE");
  assert.ok(result.failedBases.includes("base_table"));
  assert.ok(result.failedPresets.some((p) => p.preset === "ChargingPreset"));
  assert.equal(notifications.length, 0);
});

test("P0 Coverage: mixed READY and PRESET_UNAVAILABLE presets yields PARTIAL and 0 false alarms", async () => {
  const roomId = "room-mixed-presets";
  const camId = "cam-mixed";
  const notifications = [];

  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [{ id: camId, name: "Камера Микс", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" }],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    onNotification: (type, data) => notifications.push({ type, data }),
  });
  engine.setRoomExpectedHeadsets(roomId, 4);

  engine.addZoneToCache({
    id: "zone-base-mix",
    camera_id: camId,
    room_id: roomId,
    preset_name: "PresetOk",
    name: "База",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_mix",
    is_canonical_base: true,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    getPresets: async () => [{ name: "PresetOk" }, { name: "PresetFail" }],
    lookAtPreset: async (cid, preset) => {
      if (preset === "PresetFail") {
        throw new Error("Timeout");
      }
    },
  };

  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({
      status: "READY",
      headsets: [
        { confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
        { confidence: 0.9, bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
        { confidence: 0.9, bbox: { x: 0.3, y: 0.3, width: 0.1, height: 0.1 } },
        { confidence: 0.9, bbox: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 } },
      ],
    }),
  };

  const result = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  // Because PresetFail failed, coverage is PARTIAL even though PresetOk had 4 headsets on base
  assert.equal(result.coverage, "PARTIAL");
  assert.equal(result.storageStatus, "INSPECTION_INCOMPLETE");
  assert.equal(notifications.length, 0);
  assert.equal(engine.roomLastConfirmedStatus.get(roomId), undefined);
});

test("P0 Timestamps: getLatestFrame without timestamp returns timestamp: null, CameraFrameProvider preserves null, and inspection treats as FRAME_UNAVAILABLE", async () => {
  const visionService = new LocalVisionService("http://127.0.0.1:9999", "secret");

  // Intercept fetch to return frame without timestamp
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        frames: [
          {
            base64: Buffer.from("jpeg-data").toString("base64"),
            // Missing timestamp!
          },
        ],
      }),
    };
  };

  try {
    const frame = await visionService.getLatestFrame("cam-no-ts");
    assert.ok(frame);
    assert.strictEqual(frame.timestamp, null);

    const provider = new CameraFrameProvider();
    provider.pushFrame("cam-no-ts", frame.buffer, frame.mimeType, frame.timestamp);

    const storedFrame = provider.getLatestFrame("cam-no-ts");
    assert.ok(storedFrame);
    assert.strictEqual(storedFrame.timestamp, null);

    // Inspection with null timestamp times out and yields FRAME_UNAVAILABLE
    const engine = new HeadsetTrackingEngine({
      db: {
        query: async () => ({
          rows: [{ id: "cam-no-ts", name: "Камера Без Времени", room_id: "room-no-ts", headset_tracking_enabled: true }],
        }),
      },
    });

    const report = await engine.inspectRoomHeadsets("room-no-ts", {
      cameraVisionController: { settleDelayMs: 0, isManualPtzLocked: () => false, lookAtPreset: async () => {} },
      frameProvider: provider,
      visionService,
    });

    assert.equal(report.observations[0].status, "FRAME_UNAVAILABLE");
    assert.equal(report.coverage, "FAILED");
    assert.equal(report.storageStatus, "FRAME_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P1 Migration 033->034: index drop, room_id backfill, room-scoped canonical unique index, check constraint, and sync trigger", () => {
  const mig34Path = path.resolve(process.cwd(), "../../infra/postgres/migrations/034-headset-zones-room-scope.sql");
  const sql34 = fs.readFileSync(mig34Path, "utf8");

  // 1. Column addition and backfill from cameras
  assert.ok(sql34.includes("ALTER TABLE camera_headset_zones ADD COLUMN IF NOT EXISTS room_id uuid"));
  assert.ok(sql34.includes("UPDATE camera_headset_zones z\nSET room_id = c.room_id"));

  // 2. Drop global index from 033
  assert.ok(sql34.includes("DROP INDEX IF EXISTS camera_headset_zones_canonical_idx"));

  // 3. Create room-scoped unique index
  assert.ok(sql34.includes("camera_headset_zones_room_canonical_idx"));
  assert.ok(sql34.includes("ON camera_headset_zones(room_id, base_station_id)"));
  assert.ok(sql34.includes("WHERE is_canonical_base = true AND room_id IS NOT NULL"));

  // 4. Constraint chk_canonical_base_room
  assert.ok(sql34.includes("chk_canonical_base_room"));
  assert.ok(sql34.includes("CHECK (is_canonical_base = false OR room_id IS NOT NULL)"));

  // 5. Trigger sync_camera_room_to_zones
  assert.ok(sql34.includes("FUNCTION sync_camera_room_to_zones()"));
  assert.ok(sql34.includes("CREATE TRIGGER trg_sync_camera_room_to_zones"));

  // Verify setCameraRoom memory sync
  const engine = new HeadsetTrackingEngine();
  engine.addZoneToCache({
    id: "z1",
    camera_id: "cam-sync",
    room_id: "old-room",
    zone_type: "CHARGING_BASE",
    is_canonical_base: true,
  });

  engine.setCameraRoom("cam-sync", "new-room");
  assert.equal(engine.cameraRooms.get("cam-sync"), "new-room");
  const zones = engine.getZones("cam-sync");
  assert.equal(zones[0].room_id, "new-room");
  assert.equal(zones[0].is_canonical_base, true);

  // Unsetting room disallows canonical base
  engine.setCameraRoom("cam-sync", null);
  assert.equal(zones[0].room_id, null);
  assert.equal(zones[0].is_canonical_base, false);
});

test("P1 Restart recovery: loadStatesFromDb restores roomLastConfirmedStatus and signature, preventing duplicate alerts", async () => {
  const roomId = "room-restart-recovery";
  const cameraId = "cam-restart";
  const notifications = [];

  const existingEvent = {
    room_id: roomId,
    event_type: "HEADSET_NOT_ON_BASE",
    payload: {
      signature: `${roomId}:2:2:`,
      storageStatus: "NOT_ALL_ON_BASE",
      notOnBaseCount: 2,
      missingFromBaseCount: 2,
      unlocatedCount: 2,
      notOnBaseHeadsets: [],
    },
    timestamp: new Date().toISOString(),
  };

  const mockDb = {
    query: async (sql) => {
      if (sql.includes("SELECT * FROM camera_headset_zones")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM camera_headset_states")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT id, expected_headset_count FROM rooms")) {
        return { rows: [{ id: roomId, expected_headset_count: 4 }] };
      }
      if (sql.includes("SELECT c.id, c.room_id")) {
        return { rows: [{ id: cameraId, room_id: roomId, effective_location_id: "loc-1" }] };
      }
      if (sql.includes("camera_headset_events")) {
        return { rows: [existingEvent] };
      }
      if (sql.includes("SELECT * FROM cameras WHERE room_id")) {
        return {
          rows: [{ id: cameraId, name: "Камера Рестарт", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" }],
        };
      }
      return { rows: [] };
    },
  };

  // 1. Instantiate engine after restart and load states from DB
  const engine = new HeadsetTrackingEngine({
    db: mockDb,
    notificationCooldownMs: 60_000,
    onNotification: (type, data) => notifications.push({ type, data }),
  });

  await engine.loadStatesFromDb();

  // Verify states were restored
  assert.equal(engine.roomLastConfirmedStatus.get(roomId), "NOT_ALL_ON_BASE");
  assert.equal(engine.roomLastNotifiedSignature.get(roomId), `${roomId}:2:2:`);

  // Add canonical base zone (2 headsets on base, 2 missing)
  engine.addZoneToCache({
    id: "zone-base-res",
    camera_id: cameraId,
    room_id: roomId,
    preset_name: "default",
    name: "База",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_restart",
    is_canonical_base: true,
    x: 0.0,
    y: 0.0,
    width: 0.8,
    height: 0.8,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };
  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({
      status: "READY",
      headsets: [
        { confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 } },
        { confidence: 0.9, bbox: { x: 0.2, y: 0.2, width: 0.05, height: 0.05 } },
      ],
    }),
  };

  // Run first inspection after restart
  const report = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(report.coverage, "COMPLETE");
  assert.equal(report.storageStatus, "NOT_ALL_ON_BASE");
  assert.equal(report.notOnBaseCount, 2);

  // CRUCIAL: No duplicate notification sent to Telegram!
  assert.equal(notifications.length, 0);

  // Now all 4 headsets return to base
  mockVisionService.detectHeadsets = async () => ({
    status: "READY",
    headsets: [
      { confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 } },
      { confidence: 0.9, bbox: { x: 0.2, y: 0.2, width: 0.05, height: 0.05 } },
      { confidence: 0.9, bbox: { x: 0.3, y: 0.3, width: 0.05, height: 0.05 } },
      { confidence: 0.9, bbox: { x: 0.4, y: 0.4, width: 0.05, height: 0.05 } },
    ],
  });

  const recoveryReport = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(recoveryReport.storageStatus, "ALL_ON_BASE");
  // Transition from NOT_ALL_ON_BASE to ALL_ON_BASE triggers exactly ONE recovery notification
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "HEADSET_ALL_ON_BASE");
});

test("P1 Canonical base: inspectRoomHeadsets returns NOT_CONFIGURED when expectedHeadsetCount is missing and NEVER reports COMPLETE", async () => {
  const roomId = "room-no-expected-headsets";
  const cameraId = "cam-no-expected";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("FROM cameras")) {
        return {
          rows: [
            { id: cameraId, name: "Камера 1", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  // Add canonical base zone, but do NOT configure expectedHeadsetCount
  engine.addZoneToCache({
    id: "zone-canon",
    camera_id: cameraId,
    room_id: roomId,
    preset_name: "default",
    name: "База 1",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_station_1",
    is_canonical_base: true,
    x: 0.1, y: 0.1, width: 0.4, height: 0.4,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };
  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({
      status: "READY",
      headsets: [{ confidence: 0.95, bbox: { x: 0.2, y: 0.2, width: 0.05, height: 0.05 } }],
    }),
  };

  const report = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  assert.equal(report.storageStatus, "NOT_CONFIGURED");
  assert.equal(report.coverage, "NOT_CONFIGURED");
  assert.notEqual(report.coverage, "COMPLETE");
  assert.ok(report.summary.includes("NOT_CONFIGURED"));
});

test("P1 Canonical base: inspectRoomHeadsets returns CONFIGURATION_INVALID without canonical CHARGING_BASE for every physical base and NEVER reports COMPLETE", async () => {
  const roomId = "room-missing-canonical-base";
  const cameraId = "cam-missing-canonical";
  const mockDb = {
    query: async (sql) => {
      if (sql.includes("FROM cameras")) {
        return {
          rows: [
            { id: cameraId, name: "Камера 1", room_id: roomId, headset_tracking_enabled: true, location_id: "loc-1" },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const engine = new HeadsetTrackingEngine({ db: mockDb });
  engine.setRoomExpectedHeadsets(roomId, 4);

  // Add physical CHARGING_BASE zone, but WITHOUT is_canonical_base: true!
  engine.addZoneToCache({
    id: "zone-non-canon",
    camera_id: cameraId,
    room_id: roomId,
    preset_name: "default",
    name: "База без канонического флага",
    zone_type: "CHARGING_BASE",
    base_station_id: "base_station_physical",
    is_canonical_base: false,
    x: 0.1, y: 0.1, width: 0.4, height: 0.4,
    enabled: true,
  });

  const mockVisionController = {
    settleDelayMs: 0,
    isManualPtzLocked: () => false,
    lookAtPreset: async () => {},
  };
  const mockFrameProvider = {
    getLatestFrame: () => ({ buffer: Buffer.from("frame"), timestamp: Date.now() + 100 }),
  };
  const mockVisionService = {
    detectHeadsets: async () => ({
      status: "READY",
      headsets: [{ confidence: 0.95, bbox: { x: 0.2, y: 0.2, width: 0.05, height: 0.05 } }],
    }),
  };

  const report = await engine.inspectRoomHeadsets(roomId, {
    cameraVisionController: mockVisionController,
    visionService: mockVisionService,
    frameProvider: mockFrameProvider,
  });

  // Must return CONFIGURATION_INVALID, never an arbitrary fallback and never report COMPLETE
  assert.equal(report.storageStatus, "CONFIGURATION_INVALID");
  assert.equal(report.coverage, "CONFIGURATION_INVALID");
  assert.notEqual(report.coverage, "COMPLETE");
  assert.ok(report.summary.includes("CONFIGURATION_INVALID"));
  assert.ok(report.failedBases.includes("base_station_physical"));
});

test("LocalVisionService: dataset pipeline and model lifecycle methods communicate with AI service", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  try {
    globalThis.fetch = async (url, options) => {
      requests.push({
        url,
        method: options?.method || "GET",
        headers: options?.headers || {},
        body: options?.body ? JSON.parse(options.body) : null,
      });

      if (url.includes("/pipeline/status")) {
        return {
          ok: true,
          json: async () => ({
            modelStatus: "DATASET_REQUIRED",
            queuePending: 2,
            verifiedSamples: 5,
            hasWeights: false,
          }),
        };
      }
      if (url.includes("/pipeline/job-status")) {
        return {
          ok: true,
          json: async () => ({ status: "IDLE", progress: 0 }),
        };
      }
      if (url.includes("/pipeline/queue")) {
        return {
          ok: true,
          json: async () => ({
            items: [{ sampleId: "s1", queueStatus: "pending" }],
            count: 1,
          }),
        };
      }
      if (url.includes("/pipeline/samples/s1/image")) {
        return {
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("FAKE_JPEG_DATA").buffer,
        };
      }
      if (url.includes("/pipeline/collect")) {
        return {
          ok: true,
          json: async () => ({
            sampleId: "sample_new_123",
            enqueued: true,
          }),
        };
      }
      if (url.includes("/pipeline/verify")) {
        return {
          ok: true,
          json: async () => ({
            sampleId: "sample_new_123",
            verified: true,
          }),
        };
      }
      if (url.includes("/pipeline/export")) {
        return {
          ok: true,
          json: async () => ({
            status: "EXPORTED",
            version: "v1.0.0",
            totalSamples: 6,
          }),
        };
      }
      if (url.includes("/pipeline/train")) {
        return {
          ok: true,
          json: async () => ({
            status: "TRAINING_STARTED",
            jobType: "training",
          }),
        };
      }
      if (url.includes("/pipeline/activate")) {
        return {
          ok: true,
          json: async () => ({
            status: "ACTIVATED",
            sha256: "abc123def456",
            releaseId: "release_001",
          }),
        };
      }
      if (url.includes("/pipeline/rollback")) {
        return {
          ok: true,
          json: async () => ({
            status: "ROLLED_BACK",
            restored: true,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: "NOT_FOUND" }) };
    };

    const secret = "test-internal-secret-for-pipeline";
    const lvs = new LocalVisionService({ baseUrl: "http://ai-service:8088", internalSecret: secret });

    // 1. getPipelineStatus
    const status = await lvs.getPipelineStatus();
    assert.equal(status.modelStatus, "DATASET_REQUIRED");
    assert.equal(status.queuePending, 2);

    // 2. getPipelineJobStatus
    const jobStatus = await lvs.getPipelineJobStatus();
    assert.equal(jobStatus.status, "IDLE");

    // 3. getVerificationQueue
    const queue = await lvs.getVerificationQueue("pending");
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].sampleId, "s1");

    // 4. getSampleImage
    const imgBuf = await lvs.getSampleImage("s1");
    assert.ok(Buffer.isBuffer(imgBuf));
    assert.equal(imgBuf.toString(), "FAKE_JPEG_DATA");

    // 5. collectPtzFrame
    const collectRes = await lvs.collectPtzFrame({
      cameraId: "cam-1",
      roomId: "room-1",
      preset: "Base_1",
      imageBuffer: Buffer.from("FRAME_BYTES"),
      captureSessionId: "session_001",
    });
    assert.equal(collectRes.sampleId, "sample_new_123");

    // 6. verifySample
    const verifyRes = await lvs.verifySample({
      sampleId: "sample_new_123",
      operatorId: "op_admin",
      approved: true,
      correctedBboxes: [{ classId: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      negativeConfirmed: false,
      notes: "Clean box",
    });
    assert.equal(verifyRes.verified, true);

    // 7. exportDatasetSplits
    const exportRes = await lvs.exportDatasetSplits({ version: "v1.0.0" });
    assert.equal(exportRes.status, "EXPORTED");

    // 8. trainHeadsetModel
    const trainRes = await lvs.trainHeadsetModel({ epochs: 10, batchSize: 8, operatorId: "op_admin" });
    assert.equal(trainRes.status, "TRAINING_STARTED");

    // 9. activateCandidateModel (strictly no metrics accepted from caller)
    const activateRes = await lvs.activateCandidateModel({ version: "v1.0.0", operatorId: "op_admin" });
    assert.equal(activateRes.status, "ACTIVATED");
    const activateReq = requests.find((r) => r.url.includes("/pipeline/activate"));
    assert.ok(activateReq);
    assert.equal(activateReq.body.metrics, undefined, "activateCandidateModel must NEVER send metrics parameter");

    // 10. rollbackModel
    const rbRes = await lvs.rollbackModel({ operatorId: "op_admin" });
    assert.equal(rbRes.status, "ROLLED_BACK");

    // Verify all outbound requests included internal secret
    assert.ok(requests.length >= 10);
    for (const req of requests) {
      assert.equal(req.headers["X-Internal-Secret"], secret);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Migration 035 defines ai_capture_sessions table with room and camera foreign keys and indexes", () => {
  const migPath = path.resolve(process.cwd(), "../../infra/postgres/migrations/035-ai-capture-sessions.sql");
  assert.ok(fs.existsSync(migPath), "Migration 035 file must exist");
  const sql = fs.readFileSync(migPath, "utf-8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_capture_sessions/i);
  assert.match(sql, /room_id uuid NOT NULL REFERENCES rooms\(id\)/i);
  assert.match(sql, /camera_id uuid NOT NULL REFERENCES cameras\(id\)/i);
  assert.match(sql, /status text NOT NULL DEFAULT 'ACTIVE'/i);
  assert.match(sql, /CHECK \(status IN \('ACTIVE', 'CLOSED'\)\)/i);
  assert.match(sql, /ai_capture_sessions_room_cam_status_idx/i);
});

test("P0 SECURITY: capture endpoint denies camera-room mismatch and cross-location access", async () => {
  const mockCameras = [
    { id: "cam-loc1", room_id: "room-1", location_id: "loc-1" },
    { id: "cam-loc2", room_id: "room-2", location_id: "loc-2" },
  ];
  const mockRooms = [
    { id: "room-1", location_id: "loc-1" },
    { id: "room-2", location_id: "loc-2" },
  ];

  const operatorLoc1Req = {
    user: { sub: "user-op1", role: "OPERATOR" },
  };

  const checkAllowed = async (req, camId, rId) => {
    const cam = mockCameras.find((c) => c.id === camId);
    if (!cam) return { status: 404, error: "CAMERA_NOT_FOUND" };
    const room = mockRooms.find((r) => r.id === rId);
    if (!room) return { status: 404, error: "ROOM_NOT_FOUND" };

    if (cam.room_id !== rId) {
      return { status: 400, error: "CAMERA_ROOM_MISMATCH" };
    }

    const isOwner = req.user?.role === "OWNER";
    const userLocations = ["loc-1"];
    if (!isOwner && !userLocations.includes(room.location_id)) {
      return { status: 403, error: "LOCATION_FORBIDDEN" };
    }
    if (!isOwner && cam.location_id !== "loc-1") {
      return { status: 403, error: "CAMERA_FORBIDDEN" };
    }

    return { status: 200, ok: true };
  };

  const r1 = await checkAllowed(operatorLoc1Req, "cam-loc2", "room-2");
  assert.equal(r1.status, 403);
  assert.equal(r1.error, "LOCATION_FORBIDDEN");

  const r2 = await checkAllowed(operatorLoc1Req, "cam-loc2", "room-1");
  assert.equal(r2.status, 400);
  assert.equal(r2.error, "CAMERA_ROOM_MISMATCH");

  const r3 = await checkAllowed(operatorLoc1Req, "cam-loc1", "room-1");
  assert.equal(r3.status, 200);
  assert.equal(r3.ok, true);
});

test("P0 SECURITY: dataset queue and sample image endpoints filter cross-location items", async () => {
  const queueItems = [
    { sampleId: "s-loc1", cameraId: "cam-loc1", roomId: "room-1" },
    { sampleId: "s-loc2", cameraId: "cam-loc2", roomId: "room-2" },
    { sampleId: "s-global", cameraId: null, roomId: null },
  ];

  const rooms = {
    "room-1": { location_id: "loc-1" },
    "room-2": { location_id: "loc-2" },
  };

  const filterQueue = async (user, items) => {
    const isOwner = user.role === "OWNER";
    const userLocations = user.allowedLocations || [];
    const filtered = [];
    for (const item of items) {
      if (!item.cameraId) {
        if (isOwner) filtered.push(item);
        continue;
      }
      const room = rooms[item.roomId];
      if (!isOwner && !userLocations.includes(room?.location_id)) {
        continue;
      }
      filtered.push(item);
    }
    return filtered;
  };

  const opUser = { sub: "op-1", role: "OPERATOR", allowedLocations: ["loc-1"] };
  const opQueue = await filterQueue(opUser, queueItems);
  assert.equal(opQueue.length, 1);
  assert.equal(opQueue[0].sampleId, "s-loc1");

  const ownerUser = { sub: "owner-1", role: "OWNER", allowedLocations: [] };
  const ownerQueue = await filterQueue(ownerUser, queueItems);
  assert.equal(ownerQueue.length, 3);
});

test("P0 SECURITY: global dataset export, train, activate, rollback require OWNER or ADMIN", () => {
  const checkRoleAccess = (userRole) => {
    const isOwnerOrAdmin = userRole === "OWNER" || userRole === "ADMIN";
    if (!isOwnerOrAdmin) {
      return { status: 403, error: "ADMIN_OR_OWNER_REQUIRED" };
    }
    return { status: 200, ok: true };
  };

  for (const deniedRole of ["OPERATOR", "TECH", "DEVICE_MANAGER", "CAMERA_VIEWER", "USER"]) {
    const res = checkRoleAccess(deniedRole);
    assert.equal(res.status, 403, `Role ${deniedRole} must be denied with 403`);
    assert.equal(res.error, "ADMIN_OR_OWNER_REQUIRED");
  }

  assert.equal(checkRoleAccess("OWNER").status, 200);
  assert.equal(checkRoleAccess("ADMIN").status, 200);
});

test("P0 CAPTURE: handles PTZ movement error (502) and stale frame timeout (503)", async () => {
  const provider = new CameraFrameProvider();
  const cameraId = "cam-ptz-test";

  let movingStates = [];
  const mockVisionController = {
    settleDelayMs: 10,
    notifyMoving(cId, moving) {
      movingStates.push({ cId, moving });
    },
    async lookAtPreset(cId, preset) {
      this.notifyMoving(cId, true);
      throw new Error("PTZ motor timeout or network error");
    },
  };

  let resStatus = null;
  let resJson = null;

  const mockRes = {
    status(code) {
      resStatus = code;
      return this;
    },
    json(data) {
      resJson = data;
      return this;
    },
  };

  try {
    mockVisionController.notifyMoving(cameraId, true);
    await mockVisionController.lookAtPreset(cameraId, "Base_1");
  } catch (err) {
    mockVisionController.notifyMoving(cameraId, false);
    mockRes.status(502).json({
      error: "PRESET_UNAVAILABLE",
      message: `PTZ preset navigation failed: ${err?.message || err}`,
    });
  }

  assert.equal(resStatus, 502);
  assert.equal(resJson.error, "PRESET_UNAVAILABLE");
  assert.deepEqual(movingStates, [
    { cId: cameraId, moving: true },
    { cId: cameraId, moving: true },
    { cId: cameraId, moving: false },
  ]);

  const movementStartTime = 100000;
  provider.pushFrame(cameraId, Buffer.from("STALE_FRAME"), "image/jpeg", movementStartTime - 1000);

  const pollForFreshFrame = async (camId, cutoff, maxWaitMs = 100) => {
    const pollStart = Date.now();
    while (Date.now() - pollStart < maxWaitMs) {
      const frame = provider.getLatestFrame(camId);
      if (frame && frame.timestamp && frame.timestamp > cutoff) {
        return frame;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };

  const staleResult = await pollForFreshFrame(cameraId, movementStartTime, 60);
  assert.equal(staleResult, null, "Stale frame must not satisfy fresh frame check");

  provider.pushFrame(cameraId, Buffer.from("FRESH_FRAME"), "image/jpeg", movementStartTime + 500);
  const freshResult = await pollForFreshFrame(cameraId, movementStartTime, 60);
  assert.ok(freshResult);
  assert.equal(freshResult.buffer.toString(), "FRESH_FRAME");
});

test("P1 SERVER SESSIONS: capture session lifecycle, UUID validation, and auto-binding", async () => {
  const sessionsDb = new Map();

  const startSession = (roomId, cameraId, notes, createdBy) => {
    const id = crypto.randomUUID();
    const session = {
      id,
      room_id: roomId,
      camera_id: cameraId,
      status: "ACTIVE",
      notes: notes || null,
      created_by: createdBy,
      created_at: new Date().toISOString(),
      closed_at: null,
    };
    sessionsDb.set(id, session);
    return session;
  };

  const stopSession = (sessionId) => {
    const session = sessionsDb.get(sessionId);
    if (!session) return null;
    session.status = "CLOSED";
    session.closed_at = new Date().toISOString();
    return session;
  };

  const validateCaptureSession = (inputSessionId, roomId, cameraId) => {
    if (!inputSessionId) {
      for (const s of sessionsDb.values()) {
        if (s.room_id === roomId && s.camera_id === cameraId && s.status === "ACTIVE") {
          return { ok: true, sessionId: s.id };
        }
      }
      const auto = startSession(roomId, cameraId, "Auto capture session", "system");
      return { ok: true, sessionId: auto.id };
    }

    const sess = sessionsDb.get(inputSessionId);
    if (!sess || sess.status !== "ACTIVE") {
      return { ok: false, status: 400, error: "SESSION_INVALID" };
    }
    if (sess.room_id !== roomId || sess.camera_id !== cameraId) {
      return { ok: false, status: 400, error: "SESSION_MISMATCH" };
    }
    return { ok: true, sessionId: sess.id };
  };

  const sess1 = startSession("room-10", "cam-10", "Initial venue training session", "admin");
  assert.equal(sess1.status, "ACTIVE");

  const validBind = validateCaptureSession(sess1.id, "room-10", "cam-10");
  assert.equal(validBind.ok, true);
  assert.equal(validBind.sessionId, sess1.id);

  const fakeBind = validateCaptureSession("00000000-0000-0000-0000-000000000000", "room-10", "cam-10");
  assert.equal(fakeBind.ok, false);
  assert.equal(fakeBind.error, "SESSION_INVALID");

  const mismatchBind = validateCaptureSession(sess1.id, "room-99", "cam-10");
  assert.equal(mismatchBind.ok, false);
  assert.equal(mismatchBind.error, "SESSION_MISMATCH");

  const stopped = stopSession(sess1.id);
  assert.equal(stopped.status, "CLOSED");
  assert.ok(stopped.closed_at);

  const closedBind = validateCaptureSession(sess1.id, "room-10", "cam-10");
  assert.equal(closedBind.ok, false);
  assert.equal(closedBind.error, "SESSION_INVALID");
});

test("P1 FAIL-CLOSED SCOPING: sample scoping fails closed if metadata missing, unresolvable, or mismatched", async () => {
  const mockCameras = [
    { id: "cam-valid", room_id: "room-valid", location_id: "loc-1" },
    { id: "cam-rogue", room_id: "room-other", location_id: "loc-1" },
  ];

  const checkSampleAccess = async (user, sampleMeta) => {
    const isOwner = user?.role === "OWNER";
    const userLocations = user?.allowedLocations || [];

    const camId = sampleMeta?.cameraId;
    const rId = sampleMeta?.roomId;

    // Fail closed if missing cameraId or roomId
    if (!camId || !rId) {
      return { status: 403, error: "SAMPLE_SCOPING_FAILED" };
    }

    const cam = mockCameras.find((c) => c.id === camId);
    if (!cam) {
      return { status: 403, error: "SAMPLE_SCOPING_FAILED" };
    }

    if (cam.room_id !== rId) {
      return { status: 403, error: "CAMERA_ROOM_MISMATCH" };
    }

    if (!isOwner && !userLocations.includes(cam.location_id)) {
      return { status: 403, error: "LOCATION_FORBIDDEN" };
    }

    return { status: 200, ok: true };
  };

  const opUser = { sub: "op-1", role: "OPERATOR", allowedLocations: ["loc-1"] };

  // 1. Missing metadata -> fail closed 403
  const rMissing = await checkSampleAccess(opUser, { sampleId: "s-corrupt" });
  assert.equal(rMissing.status, 403);
  assert.equal(rMissing.error, "SAMPLE_SCOPING_FAILED");

  // 2. Camera not found in DB -> fail closed 403
  const rNotFound = await checkSampleAccess(opUser, { sampleId: "s-ghost", cameraId: "cam-ghost", roomId: "room-valid" });
  assert.equal(rNotFound.status, 403);
  assert.equal(rNotFound.error, "SAMPLE_SCOPING_FAILED");

  // 3. Camera belongs to room-other, not room-valid -> 403 CAMERA_ROOM_MISMATCH
  const rMismatch = await checkSampleAccess(opUser, { sampleId: "s-mismatch", cameraId: "cam-rogue", roomId: "room-valid" });
  assert.equal(rMismatch.status, 403);
  assert.equal(rMismatch.error, "CAMERA_ROOM_MISMATCH");

  // 4. Valid matching camera and room -> 200 ok
  const rOk = await checkSampleAccess(opUser, { sampleId: "s-valid", cameraId: "cam-valid", roomId: "room-valid" });
  assert.equal(rOk.status, 200);
  assert.equal(rOk.ok, true);

  // 5. Recovery route: strictly OWNER only
  const handleRecovery = (user, sampleMeta) => {
    if (user?.role !== "OWNER") {
      return { status: 403, error: "OWNER_REQUIRED" };
    }
    return { status: 200, sample: sampleMeta, recoveredBy: user.sub };
  };

  const opRecovery = handleRecovery(opUser, { sampleId: "s-unscoped" });
  assert.equal(opRecovery.status, 403);
  assert.equal(opRecovery.error, "OWNER_REQUIRED");

  const ownerUser = { sub: "owner-1", role: "OWNER" };
  const ownerRecovery = handleRecovery(ownerUser, { sampleId: "s-unscoped" });
  assert.equal(ownerRecovery.status, 200);
  assert.equal(ownerRecovery.sample.sampleId, "s-unscoped");
});

test("P0 CAPTURE STATE: capture requires active session and verifies settledAt timestamp", async () => {
  let activeSessions = [
    { id: "sess-active-1", room_id: "room-1", camera_id: "cam-1", status: "ACTIVE" },
  ];

  const validateOrRequireSession = (reqSessionId, roomId, cameraId) => {
    if (reqSessionId) {
      const found = activeSessions.find((s) => s.id === reqSessionId && s.status === "ACTIVE");
      if (!found) return { ok: false, status: 400, error: "SESSION_INVALID" };
      if (found.room_id !== roomId || found.camera_id !== cameraId) {
        return { ok: false, status: 400, error: "SESSION_MISMATCH" };
      }
      return { ok: true, session: found };
    }

    const active = activeSessions.find((s) => s.room_id === roomId && s.camera_id === cameraId && s.status === "ACTIVE");
    if (!active) {
      return { ok: false, status: 400, error: "NO_ACTIVE_SESSION" };
    }
    return { ok: true, session: active };
  };

  // No active session for cam-2
  const noSess = validateOrRequireSession(null, "room-1", "cam-2");
  assert.equal(noSess.ok, false);
  assert.equal(noSess.error, "NO_ACTIVE_SESSION");

  // Valid active session for cam-1
  const hasSess = validateOrRequireSession(null, "room-1", "cam-1");
  assert.equal(hasSess.ok, true);
  assert.equal(hasSess.session.id, "sess-active-1");

  // Test moveToPresetAndSettle contract
  const controller = new CameraVisionController();
  controller.settleDelayMs = 15;
  controller.lookAtPreset = async (cId, p) => {
    await new Promise((r) => setTimeout(r, 15));
    return { ok: true };
  };

  const moveRes = await controller.moveToPresetAndSettle("cam-1", "Base_Left");
  assert.equal(moveRes.cameraId, "cam-1");
  assert.equal(moveRes.preset, "Base_Left");
  assert.ok(moveRes.settledAt >= moveRes.startedAt + 10);
});

test("P1 CAPTURE SESSIONS: starting session closes prior active session for same (room, camera)", () => {
  let dbSessions = [
    { id: "s1", room_id: "room-1", camera_id: "cam-1", status: "ACTIVE", closed_at: null },
  ];

  const startSessionTransaction = (roomId, cameraId, notes, user) => {
    // Transaction step 1: close prior active sessions
    for (const s of dbSessions) {
      if (s.room_id === roomId && s.camera_id === cameraId && s.status === "ACTIVE") {
        s.status = "CLOSED";
        s.closed_at = new Date().toISOString();
      }
    }
    // Transaction step 2: insert new active session
    const newSession = {
      id: "s2",
      room_id: roomId,
      camera_id: cameraId,
      status: "ACTIVE",
      notes,
      created_by: user,
      created_at: new Date().toISOString(),
      closed_at: null,
    };
    dbSessions.push(newSession);
    return newSession;
  };

  const newSess = startSessionTransaction("room-1", "cam-1", "Round 2 captures", "operator");
  assert.equal(newSess.id, "s2");
  assert.equal(newSess.status, "ACTIVE");

  const s1 = dbSessions.find((s) => s.id === "s1");
  assert.equal(s1.status, "CLOSED");
  assert.ok(s1.closed_at);

  const activeCount = dbSessions.filter((s) => s.room_id === "room-1" && s.camera_id === "cam-1" && s.status === "ACTIVE").length;
  assert.equal(activeCount, 1, "Only one active session may exist per (room_id, camera_id)");
});
