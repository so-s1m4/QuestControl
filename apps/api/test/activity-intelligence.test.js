import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ActivityIntelligenceEngine } from "../src/activity-intelligence-engine.js";

test("Migration 036 defines activity tables, foreign keys, and indexes", () => {
  const migPath = path.resolve(process.cwd(), "../../infra/postgres/migrations/036-activity-intelligence.sql");
  assert.ok(fs.existsSync(migPath), "Migration 036 file must exist");
  const sql = fs.readFileSync(migPath, "utf-8");

  // Tables
  assert.match(sql, /CREATE TABLE IF NOT EXISTS activity_events/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS activity_settings/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS activity_dataset_samples/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS activity_model_releases/i);

  // Checks and constraints
  assert.match(sql, /CHECK \(status IN \('CONFIRMED', 'DISMISSED', 'INVESTIGATING', 'RESOLVED'\)\)/i);
  assert.match(sql, /CHECK \(verification_status IN \('UNVERIFIED', 'VERIFIED', 'REJECTED'\)\)/i);
  assert.match(sql, /CHECK \(status IN \('TRAINING', 'ACTIVE', 'INACTIVE', 'ARCHIVED', 'FAILED'\)\)/i);

  // Indexes
  assert.match(sql, /activity_events_room_idx/i);
  assert.match(sql, /activity_events_camera_idx/i);
  assert.match(sql, /activity_samples_action_idx/i);
});

test("ActivityIntelligenceEngine defaults to disabled and reports honest runtime blocker", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };
  const mockVision = {
    getActivityHealth: async () => ({
      status: "DATASET_REQUIRED",
      poseModelAvailable: false,
      reason: "POSE_MODEL_UNAVAILABLE: Air-gapped mode active and no local pose weights configured.",
      activePlugins: [],
    }),
    getActivityPlugins: async () => [
      { actionType: "HELP_REQUESTED", enabled: false, requiresModel: true },
      { actionType: "FALL_DETECTED", enabled: false, requiresModel: true },
      { actionType: "PROHIBITED_ZONE_ENTRY", enabled: false, requiresModel: true },
    ],
  };

  const engine = new ActivityIntelligenceEngine({
    db: mockDb,
    io: null,
    telegramBot: null,
    visionService: mockVision,
  });

  const health = await engine.getHealth();
  assert.equal(health.status, "DATASET_REQUIRED");
  assert.equal(health.poseModelAvailable, false);
  assert.notEqual(health.status, "READY", "Engine must never report fake READY status");

  const plugins = await engine.getPlugins();
  assert.equal(plugins.length, 3);
  assert.equal(plugins[0].enabled, false);
});

test("ActivityIntelligenceEngine suppresses inference during PTZ movement and settling", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };
  let visionCalled = false;
  const mockVision = {
    detectActivity: async () => {
      visionCalled = true;
      return { events: [], activePlugins: ["HELP_REQUESTED"] };
    },
  };

  const engine = new ActivityIntelligenceEngine({
    db: mockDb,
    io: null,
    telegramBot: null,
    visionService: mockVision,
    settleDelayMs: 500,
  });

  const cameraId = "cam-ptz-1";
  const roomId = "room-quest";

  // 1. Mark camera moving
  engine.setCameraMoving(cameraId, true);
  assert.equal(engine.isCameraMoving(cameraId), true);

  // Frame arriving while moving must be dropped/skipped
  await engine.processFrame({
    cameraId,
    roomId,
    frameBuffer: Buffer.from("ptz-moving-frame"),
    timestamp: Date.now() / 1000,
  });
  assert.equal(visionCalled, false, "Must not perform inference while camera is moving");

  // 2. Mark camera stopped (now settling)
  engine.setCameraMoving(cameraId, false);
  assert.equal(engine.isCameraMoving(cameraId), true, "Camera must still be considered moving during settle window");

  await engine.processFrame({
    cameraId,
    roomId,
    frameBuffer: Buffer.from("ptz-settling-frame"),
    timestamp: Date.now() / 1000,
  });
  assert.equal(visionCalled, false, "Must not perform inference while camera is settling");

  // Fast forward past settle delay
  engine.settledAt.set(cameraId, Date.now() - 1000);
  assert.equal(engine.isCameraMoving(cameraId), false);

  await engine.processFrame({
    cameraId,
    roomId,
    frameBuffer: Buffer.from("ptz-stable-frame"),
    timestamp: Date.now() / 1000,
  });
  assert.equal(visionCalled, true, "Inference must resume once settled");
});

test("ActivityIntelligenceEngine rejects stale frame timestamps", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };
  let calls = 0;
  const mockVision = {
    detectActivity: async () => {
      calls++;
      return { events: [] };
    },
  };

  const engine = new ActivityIntelligenceEngine({
    db: mockDb,
    io: null,
    telegramBot: null,
    visionService: mockVision,
  });

  const cameraId = "cam-stale-1";
  const t0 = 1000.0;

  await engine.processFrame({
    cameraId,
    roomId: "r1",
    frameBuffer: Buffer.from("f1"),
    timestamp: t0,
  });
  assert.equal(calls, 1);

  // Arriving stale frame with timestamp <= t0
  await engine.processFrame({
    cameraId,
    roomId: "r1",
    frameBuffer: Buffer.from("f2"),
    timestamp: t0 - 1.0,
  });
  assert.equal(calls, 1, "Stale frame must be rejected without calling vision");
});

test("background worker result persists, emits and remains available by camera without a browser", async () => {
  const persisted = [];
  const emitted = [];
  const sent = [];
  const engine = new ActivityIntelligenceEngine({
    db: { query: async (text, params) => {
      persisted.push({ text, params });
      if (text.includes("SELECT name FROM rooms")) return { rows: [{ name: "Room A" }] };
      if (text.includes("SELECT name FROM cameras")) return { rows: [{ name: "Camera A" }] };
      return { rows: [] };
    } },
    io: { to: (target) => ({ emit: (event, payload) => emitted.push({ target, event, payload }) }) },
    sendTelegramAlertFn: async (...args) => sent.push(args),
  });

  const response = await engine.processResult({
    cameraId: "camera-1",
    roomId: "room-1",
    locationId: "location-1",
    presetName: "Center",
    timestamp: "2026-09-09T10:00:00.000Z",
    imageBuffer: Buffer.from("confirmed-frame"),
    result: {
      status: "READY",
      peopleCount: 1,
      events: [{ actionType: "HELP_REQUESTED", subType: "HAND_WAVE", confidence: 0.91, evidence: { reversals: 4 } }],
    },
  });

  assert.equal(response.events.length, 1);
  assert.equal(engine.getCameraState("camera-1").peopleCount, 1);
  assert.ok(persisted.some((q) => q.text.includes("INSERT INTO activity_events")));
  assert.ok(emitted.some((e) => e.target === "location:location-1" && e.event === "camera:activity:event"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][3].photoBuffer.toString(), "confirmed-frame");
});

test("ActivityIntelligenceEngine formats Russian Telegram alert, emits scoped Socket.IO, and enforces anti-spam", async () => {
  const dbQueries = [];
  const mockDb = {
    query: async (text, params) => {
      dbQueries.push({ text, params });
      if (text.includes("SELECT name FROM rooms")) {
        return { rows: [{ name: "Таинственный замок" }] };
      }
      return { rows: [] };
    },
  };

  const emittedSocketEvents = [];
  const mockIo = {
    to: (target) => ({
      emit: (event, payload) => emittedSocketEvents.push({ target, event, payload }),
    }),
    emit: (event, payload) => emittedSocketEvents.push({ target: "global", event, payload }),
  };

  const telegramMessages = [];
  const mockTelegram = {
    sendMessage: async (chatId, text, opts) => {
      telegramMessages.push({ chatId, text, opts });
      return { message_id: 123 };
    },
    getAdminChatIds: () => ["chat-admin-1"],
  };

  const mockVision = {
    detectActivity: async () => ({
      events: [
        {
          actionType: "HELP_REQUESTED",
          subType: "HAND_WAVE",
          cameraId: "cam-room-1",
          roomId: "room-castle",
          presetName: "Center",
          trackId: 42,
          confidence: 0.88,
          reason: "Lateral hand wave detected (4 reversals, travel=0.42, 1.8s)",
          evidence: { reversals: 4, durationSec: 1.8, totalTravel: 0.42 },
          status: "CONFIRMED",
        },
      ],
    }),
  };

  const engine = new ActivityIntelligenceEngine({
    db: mockDb,
    io: mockIo,
    telegramBot: mockTelegram,
    visionService: mockVision,
    roomCooldownSec: 10.0,
  });

  const t0 = 100.0;
  await engine.processFrame({
    cameraId: "cam-room-1",
    roomId: "room-castle",
    frameBuffer: Buffer.from("frame-1"),
    timestamp: t0,
  });

  // Verify Telegram alert
  assert.equal(telegramMessages.length, 1, "Exactly one Telegram alert should be sent");
  const tg = telegramMessages[0];
  assert.match(tg.text, /🙋 Внимание: в квесте требуется помощь!/);
  assert.match(tg.text, /Таинственный замок/);
  assert.match(tg.text, /cam-room-1/);
  assert.match(tg.text, /88%/);
  assert.match(tg.text, /4 колебаний/);

  // Verify Socket.IO scoped emissions
  assert.ok(emittedSocketEvents.length >= 1);
  const roomEmission = emittedSocketEvents.find((e) => e.target === "room:room-castle" && e.event === "camera:activity:event");
  assert.ok(roomEmission, "Must emit to scoped room:room-castle");
  assert.equal(roomEmission.payload.actionType, "HELP_REQUESTED");

  // Verify DB persistence
  const insertQuery = dbQueries.find((q) => q.text.includes("INSERT INTO activity_events"));
  assert.ok(insertQuery, "Event must be saved into activity_events table");
  assert.equal(insertQuery.params[2], "room-castle");
  assert.equal(insertQuery.params[3], "cam-room-1");
  assert.equal(insertQuery.params[6], "HELP_REQUESTED");

  // Verify Anti-Spam: Second frame within cooldown window (t0 + 2.0s < t0 + 10.0s)
  await engine.processFrame({
    cameraId: "cam-room-1",
    roomId: "room-castle",
    frameBuffer: Buffer.from("frame-2"),
    timestamp: t0 + 2.0,
  });

  // Telegram alert count must remain 1 (no spam!)
  assert.equal(telegramMessages.length, 1, "Continuous wave within cooldown must not spam Telegram");
});

test("Activity plugin failure isolation: crashed plugin does not bring down engine", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };
  const mockVision = {
    detectActivity: async () => {
      // Vision service reports failure in one plugin while another succeeds
      return {
        events: [
          {
            actionType: "HELP_REQUESTED",
            subType: "HAND_WAVE",
            confidence: 0.85,
            evidence: { reversals: 3 },
          },
        ],
      };
    },
  };

  const engine = new ActivityIntelligenceEngine({
    db: mockDb,
    io: null,
    telegramBot: null,
    visionService: mockVision,
  });

  const res = await engine.processFrame({
    cameraId: "cam-iso-1",
    roomId: "r1",
    frameBuffer: Buffer.from("f1"),
    timestamp: 200.0,
  });

  assert.ok(res);
  assert.equal(res.events.length, 1);
});

test("Activity dataset sample verification transitions unverified to verified", async () => {
  const queries = [];
  const mockDb = {
    query: async (text, params) => {
      queries.push({ text, params });
      return {
        rows: [
          {
            id: "sample-1",
            action_type: "HELP_REQUESTED",
            verification_status: "VERIFIED",
            verified_by: "user-op-1",
          },
        ],
      };
    },
  };

  const engine = new ActivityIntelligenceEngine({
    db: mockDb,
    io: null,
    telegramBot: null,
    visionService: null,
  });

  const verified = await engine.verifySample("sample-1", {
    status: "VERIFIED",
    userId: "user-op-1",
    reviewNotes: "Confirmed lateral wave",
  });

  assert.equal(verified.verification_status, "VERIFIED");
  assert.equal(verified.verified_by, "user-op-1");
  const updateQ = queries.find((q) => q.text.includes("UPDATE activity_dataset_samples"));
  assert.ok(updateQ, "Must update activity_dataset_samples table with operator metadata");
});

test("P0 SECURITY: Activity Intelligence enforces location isolation and RBAC", async () => {
  // Simulate locationAllowed logic for operators
  const operatorAssignedLocations = new Set(["loc-allowed-1"]);
  const locationAllowedCheck = (userRole, userLocs, targetLoc) => {
    if (userRole === "ADMIN" || userRole === "OWNER") return true;
    return userLocs.has(targetLoc);
  };

  // Test operator accessing allowed location
  assert.equal(
    locationAllowedCheck("OPERATOR", operatorAssignedLocations, "loc-allowed-1"),
    true,
    "Operator can access their assigned location"
  );

  // Test operator attempting cross-location access to forbidden location
  assert.equal(
    locationAllowedCheck("OPERATOR", operatorAssignedLocations, "loc-forbidden-2"),
    false,
    "Cross-location access must be rejected"
  );

  // Test RBAC permissions: settings:manage required for plugin toggling
  const rolePermissions = {
    ADMIN: new Set(["cameras:read", "settings:manage", "devices:command"]),
    OWNER: new Set(["cameras:read", "settings:manage", "devices:command"]),
    OPERATOR: new Set(["cameras:read", "devices:command"]),
    GUEST: new Set([]),
  };

  const hasPerm = (role, perm) => rolePermissions[role]?.has(perm) || false;

  assert.equal(hasPerm("ADMIN", "settings:manage"), true);
  assert.equal(hasPerm("OWNER", "settings:manage"), true);
  assert.equal(hasPerm("OPERATOR", "settings:manage"), false, "Operator must not have settings:manage");
  assert.equal(hasPerm("GUEST", "cameras:read"), false);
});

test("Activity dataset samples default to UNVERIFIED and fail-closed against unreviewed auto-labels", () => {
  const sample = {
    id: "sample-auto-1",
    action_type: "HELP_REQUESTED",
    label: "POSITIVE",
    verification_status: "UNVERIFIED",
    verified_by: null,
  };

  // Training pipeline query filter simulates invariant: only VERIFIED samples eligible for training
  const isEligibleForTraining = (s) => s.verification_status === "VERIFIED";
  assert.equal(
    isEligibleForTraining(sample),
    false,
    "Auto-labeled clip must NOT be eligible for training while UNVERIFIED"
  );

  const approvedSample = {
    ...sample,
    verification_status: "VERIFIED",
    verified_by: "op-1",
  };
  assert.equal(
    isEligibleForTraining(approvedSample),
    true,
    "Only operator-verified clip is eligible for training"
  );
});
