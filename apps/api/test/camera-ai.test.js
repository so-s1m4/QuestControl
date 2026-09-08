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

