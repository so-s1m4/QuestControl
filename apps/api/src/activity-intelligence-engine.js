import crypto from "node:crypto";

/**
 * ActivityIntelligenceEngine (Node.js API)
 * Coordinates activity intelligence, scoped Socket.IO emission, DB persistence,
 * RBAC endpoints, and Telegram distress notifications.
 */
export class ActivityIntelligenceEngine {
  constructor({
    db,
    io,
    visionService,
    telegramBot,
    sendTelegramAlertFn,
    settleDelayMs = 1200,
    roomCooldownSec = 60,
  } = {}) {
    this.db = db;
    this.io = io;
    this.visionService = visionService;
    this.telegramBot = telegramBot || null;
    this.sendTelegramAlertFn = sendTelegramAlertFn || null;
    this.settleDelayMs = settleDelayMs;
    this.roomCooldownSec = roomCooldownSec;

    /** @type {Map<string, boolean>} */
    this.movingCameras = new Map();
    /** @type {Map<string, number>} */
    this.settledAt = new Map();
    /** @type {Map<string, string>} */
    this.currentPresets = new Map();
    /** @type {Map<string, number>} */
    this.roomCooldowns = new Map();
    /** @type {Map<string, any>} */
    this.roomStates = new Map();
    /** @type {Map<string, any>} */
    this.cameraStates = new Map();
    /** @type {Map<string, number>} */
    this.lastFrameTimestamps = new Map();
  }

  setCameraMoving(cameraId, isMoving, preset = "") {
    this.movingCameras.set(cameraId, Boolean(isMoving));
    if (preset) {
      this.currentPresets.set(cameraId, preset);
    }
    if (!isMoving) {
      this.settledAt.set(cameraId, Date.now() + this.settleDelayMs);
    }
    if (this.visionService?.setCameraMoving) {
      this.visionService.setCameraMoving(cameraId, isMoving, preset).catch(() => {});
    }
  }

  isCameraSettling(cameraId) {
    if (this.movingCameras.get(cameraId)) return true;
    const settleTime = this.settledAt.get(cameraId) || 0;
    return Date.now() < settleTime;
  }

  isCameraMoving(cameraId) {
    return this.isCameraSettling(cameraId);
  }

  async getHealth() {
    if (this.visionService?.getActivityHealth) {
      try {
        return await this.visionService.getActivityHealth();
      } catch (err) {
        return {
          status: "SERVICE_UNAVAILABLE",
          poseModelAvailable: false,
          reason: err.message,
          activePlugins: [],
        };
      }
    }
    return {
      status: "DATASET_REQUIRED",
      poseModelAvailable: false,
      reason: "POSE_MODEL_UNAVAILABLE: Air-gapped mode active and no local pose weights configured.",
      activePlugins: [],
    };
  }

  async getPlugins() {
    if (this.visionService?.getActivityPlugins) {
      try {
        return await this.visionService.getActivityPlugins();
      } catch (err) {
        return [];
      }
    }
    return [];
  }

  async setPluginEnabled(actionType, enabled) {
    if (this.visionService?.setActivityPluginEnabled) {
      return await this.visionService.setActivityPluginEnabled(actionType, enabled);
    }
    return { actionType, enabled };
  }

  async verifySample(sampleId, { status, userId, reviewNotes } = {}) {
    if (!this.db) return null;
    const { rows } = await this.db.query(
      `UPDATE activity_dataset_samples
       SET verification_status = $1, operator_id = $2, verified_at = now(),
           metadata = metadata || $3::jsonb
       WHERE id = $4
       RETURNING *`,
      [status, userId || null, JSON.stringify({ reviewNotes: reviewNotes || "" }), sampleId]
    );
    return rows[0] || null;
  }

  async processFrame({
    cameraId,
    roomId = null,
    locationId = null,
    imageBuffer = null,
    frameBuffer = null,
    timestamp = null,
    presetName = null,
    syntheticPoses = null,
    syntheticPeople = null,
  }) {
    const buf = imageBuffer || frameBuffer || null;
    const isMoving = this.isCameraSettling(cameraId);
    if (isMoving) {
      return { status: "CAMERA_MOVING", events: [] };
    }

    if (timestamp != null) {
      const numTs = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime() / 1000;
      const lastTs = this.lastFrameTimestamps.get(cameraId);
      if (lastTs != null && numTs <= lastTs) {
        return { status: "STALE_FRAME", events: [] };
      }
      this.lastFrameTimestamps.set(cameraId, numTs);
    }

    const preset = presetName || this.currentPresets.get(cameraId) || "default";
    const ts = timestamp || new Date().toISOString();

    if (!this.visionService?.detectActivity) {
      return { status: "SERVICE_UNAVAILABLE", events: [] };
    }

    const result = await this.visionService.detectActivity({
      cameraId,
      roomId,
      presetName: preset,
      timestamp,
      imageBuffer,
      isMoving,
      syntheticPoses,
      syntheticPeople,
    });

    return this.processResult({
      cameraId,
      roomId,
      locationId,
      presetName: preset,
      timestamp: ts,
      result,
      imageBuffer: buf,
    });
  }

  /**
   * Accepts a completed local inference result.  This is used by the
   * background Python worker, so the browser never has to be open for events
   * to be persisted, scoped or notified.
   */
  async processResult({
    cameraId,
    roomId = null,
    locationId = null,
    presetName = null,
    timestamp = null,
    result = {},
    imageBuffer = null,
  }) {
    const preset = presetName || this.currentPresets.get(cameraId) || "default";
    const ts = timestamp || new Date().toISOString();
    const events = Array.isArray(result.events) ? result.events : [];
    const state = {
      cameraId,
      roomId,
      locationId,
      presetName: preset,
      timestamp: ts,
      status: result.status || "READY",
      activeEvents: events,
      peopleCount: result.peopleCount || 0,
    };

    this.cameraStates.set(cameraId, state);
    if (roomId) this.roomStates.set(roomId, state);

    // Scoped Socket.IO emissions
    if (this.io) {
      const payload = { ...state };
      if (locationId) {
        this.io.to(`location:${locationId}`).emit("camera:activity:state", payload);
      }
      if (roomId) {
        this.io.to(`room:${roomId}`).emit("camera:activity:state", payload);
      }
      this.io.to(`camera:${cameraId}`).emit("camera:activity:state", payload);
    }

    // Process and persist events
    for (const ev of events) {
      await this._handleEvent(ev, { roomId, locationId, cameraId, preset, imageBuffer });
    }

    return { status: result.status || "READY", events, state };
  }

  async _handleEvent(ev, { roomId, locationId, cameraId, preset, imageBuffer }) {
    const eventId = ev.id || `act_ev_${crypto.randomUUID()}`;
    const actionType = ev.actionType || ev.action_type || "HELP_REQUESTED";
    const subType = ev.subType || ev.sub_type || "HAND_WAVE";
    const confidence = ev.confidence ?? 1.0;
    const reason = ev.reason || "";
    const evidence = ev.evidence || {};
    const ts = ev.timestamp || new Date().toISOString();

    // 1. Persist to DB
    if (this.db) {
      try {
        await this.db.query(
          `INSERT INTO activity_events(
            id, location_id, room_id, camera_id, preset_name, track_id,
            action_type, sub_type, status, confidence, reason, evidence, created_at
          ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            eventId,
            locationId || null,
            roomId || null,
            cameraId,
            preset || null,
            ev.trackId || null,
            actionType,
            subType,
            ev.status || "CONFIRMED",
            confidence,
            reason,
            JSON.stringify(evidence),
            ts,
          ]
        );
      } catch (dbErr) {
        console.warn("Failed persisting activity event to DB:", dbErr.message);
      }
    }

    // 2. Scoped Socket.IO event emission
    if (this.io) {
      const eventPayload = {
        id: eventId,
        actionType,
        subType,
        cameraId,
        roomId,
        locationId,
        presetName: preset,
        trackId: ev.trackId,
        confidence,
        reason,
        evidence,
        timestamp: ts,
        status: ev.status || "CONFIRMED",
      };
      if (locationId) {
        this.io.to(`location:${locationId}`).emit("camera:activity:event", eventPayload);
      }
      if (roomId) {
        this.io.to(`room:${roomId}`).emit("camera:activity:event", eventPayload);
      }
      this.io.to(`camera:${cameraId}`).emit("camera:activity:event", eventPayload);
    }

    // 3. Telegram notification for HELP_REQUESTED (Russian alert, anti-spam)
    if (actionType === "HELP_REQUESTED") {
      await this._sendTelegramHelpAlert({
        roomId,
        locationId,
        cameraId,
        preset,
        confidence,
        reason,
        evidence,
        imageBuffer,
        timestamp: ts,
        eventId,
      });
    }
  }

  async _sendTelegramHelpAlert({ roomId, locationId, cameraId, preset, confidence, reason, evidence, imageBuffer, timestamp, eventId }) {
    const roomKey = roomId || cameraId;
    const now = Date.now();
    const lastSent = this.roomCooldowns.get(roomKey) || 0;
    const cooldownMs = (this.roomCooldownSec || 60) * 1000;

    if (now - lastSent < cooldownMs) {
      return; // Anti-spam: suppress repeat alert
    }
    // The in-memory map is fast, but it is lost on restart.  The event was
    // persisted before this call, so check previous confirmed help events in
    // PostgreSQL as a restart-safe cooldown source.
    if (this.db) {
      try {
        const { rows } = await this.db.query(
          `SELECT 1 FROM activity_events
           WHERE action_type = 'HELP_REQUESTED' AND id <> $1
             AND created_at > now() - ($2 * interval '1 second')
             AND ((room_id IS NOT NULL AND room_id = $3) OR ($3 IS NULL AND camera_id = $4))
           LIMIT 1`,
          [eventId || "", this.roomCooldownSec || 60, roomId, cameraId]
        );
        if (rows.length) return;
      } catch (err) {
        // A database outage must not disable a live safety notification; the
        // in-memory cooldown still protects this running process.
        console.warn("Failed checking persistent activity Telegram cooldown:", err.message);
      }
    }
    this.roomCooldowns.set(roomKey, now);

    let roomName = "Комната";
    let cameraName = cameraId;
    if (this.db && roomId) {
      try {
        const { rows } = await this.db.query("SELECT name FROM rooms WHERE id = $1", [roomId]);
        if (rows[0]?.name) roomName = rows[0].name;
      } catch {}
    }
    if (this.db && cameraId) {
      try {
        const { rows } = await this.db.query("SELECT name FROM cameras WHERE id = $1", [cameraId]);
        if (rows[0]?.name) cameraName = rows[0].name;
      } catch {}
    }

    const timeFormatted = new Date(timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const confPercent = Math.round(confidence * 100);

    const messageLines = [
      ["Комната", roomName],
      ["Камера", cameraName],
      ["Ракурс", preset || "—"],
      ["Время", timeFormatted],
      ["Уверенность", `${confPercent}%`],
      ["Причина", "Жест рукой (машет) — запрос помощи"],
      ["Колебания руки", evidence?.reversals ? `${evidence.reversals} колебаний (смен направления)` : "—"],
    ];

    if (this.sendTelegramAlertFn) {
      try {
        await this.sendTelegramAlertFn("activityHelpRequested", "🙋 Внимание: в квесте требуется помощь!", messageLines, {
          photoBuffer: imageBuffer || null,
          locationId,
        });
      } catch (err) {
        console.error("Failed sending Telegram help alert via fn:", err.message);
      }
    } else if (this.telegramBot) {
      try {
        const header = "<b>🙋 Внимание: в квесте требуется помощь!</b>\n\n";
        const body = messageLines.map(([k, v]) => `<b>${k}:</b> ${v}`).join("\n");
        const fullText = header + body;
        const chatIds = this.telegramBot.getAdminChatIds ? this.telegramBot.getAdminChatIds() : [];
        for (const chatId of chatIds) {
          if (imageBuffer && this.telegramBot.sendPhoto) {
            await this.telegramBot.sendPhoto(chatId, imageBuffer, fullText);
          } else if (this.telegramBot.sendMessage) {
            await this.telegramBot.sendMessage(chatId, fullText, { parse_mode: "HTML" });
          }
        }
      } catch (err) {
        console.error("Failed sending Telegram help alert via bot:", err.message);
      }
    }
  }

  async getRecentEvents({ roomId, locationId, cameraId, limit = 50 }) {
    if (!this.db) return [];
    let query = "SELECT * FROM activity_events WHERE ";
    const params = [];
    if (roomId) {
      params.push(roomId);
      query += `room_id = $${params.length}`;
    } else if (locationId) {
      params.push(locationId);
      query += `location_id = $${params.length}`;
    } else if (cameraId) {
      params.push(cameraId);
      query += `camera_id = $${params.length}`;
    } else {
      query += "TRUE";
    }
    params.push(Math.min(limit, 100));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const { rows } = await this.db.query(query, params);
    return rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      roomId: r.room_id,
      cameraId: r.camera_id,
      presetName: r.preset_name,
      trackId: r.track_id,
      actionType: r.action_type,
      subType: r.sub_type,
      status: r.status,
      confidence: Number(r.confidence || 0),
      reason: r.reason,
      evidence: r.evidence,
      createdAt: r.created_at,
    }));
  }

  getRoomState(roomId) {
    return this.roomStates.get(roomId) || null;
  }

  getCameraState(cameraId) {
    return this.cameraStates.get(cameraId) || null;
  }
}
