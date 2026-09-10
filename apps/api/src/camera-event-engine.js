import crypto from "node:crypto";

export class CameraEventEngine {
  constructor({
    db,
    io,
    onNotification,
    zeroHysteresisFrames = 3,
    zeroHysteresisMs = 3000,
    cameraOfflineNotificationCooldownMs = 0,
  } = {}) {
    this.db = db;
    this.io = io;
    this.onNotification = onNotification || null;
    this.zeroHysteresisFrames = zeroHysteresisFrames;
    this.zeroHysteresisMs = zeroHysteresisMs;
    this.cameraOfflineNotificationCooldownMs = Math.max(0, Number(cameraOfflineNotificationCooldownMs) || 0);
    /** @type {Map<string, any>} */
    this.states = new Map();
    /** @type {Map<string, { x: number, y: number, trackId?: number }[]>} */
    this.lastBoxes = new Map();
    /** @type {Map<string, number>} */
    this.lastMotionTimes = new Map();
    /** @type {Map<string, number>} */
    this.lastUnusualTimes = new Map();
    /** @type {Map<string, number>} */
    this.lastDbSaveTimes = new Map();
    /** @type {Map<string, string>} */
    this.cameraLocations = new Map();

    // Hysteresis & Debounce tracking
    /** @type {Map<string, number>} Consecutive zero frames */
    this.zeroFrameCounts = new Map();
    /** @type {Map<string, number>} Timestamp when zero was first seen */
    this.zeroFirstSeen = new Map();
    /** @type {Map<string, number>} Last offline-alert timestamp by camera */
    this.lastOfflineNotificationTimes = new Map();
  }

  async loadStatesFromDb() {
    if (!this.db) return;
    try {
      const { rows } = await this.db.query(`
        SELECT s.*, c.room_id, COALESCE(c.location_id, r.location_id) AS location_id
        FROM camera_ai_states s
        JOIN cameras c ON c.id = s.camera_id
        LEFT JOIN rooms r ON r.id = c.room_id
      `);
      for (const row of rows) {
        if (row.location_id) {
          this.cameraLocations.set(row.camera_id, row.location_id);
        }
        this.states.set(row.camera_id, {
          cameraId: row.camera_id,
          roomId: row.room_id || null,
          locationId: row.location_id || null,
          peopleCount: Number(row.people_count || 0),
          occupied: Boolean(row.occupied),
          motion: Boolean(row.motion),
          lastPersonEntered: row.last_person_entered,
          lastPersonLeft: row.last_person_left,
          lastActivity: row.last_activity,
          lastUpdated: row.updated_at,
          status: "ONLINE",
          people: [],
        });
      }
      console.info(`CameraEventEngine: loaded state for ${rows.length} cameras from database`);
    } catch (err) {
      console.error("CameraEventEngine: failed to load states from database:", err.message);
    }
  }

  getState(cameraId) {
    if (!cameraId) return null;
    const state = this.states.get(cameraId);
    if (state) return state;
    return {
      cameraId,
      roomId: null,
      locationId: this.cameraLocations.get(cameraId) || null,
      peopleCount: 0,
      occupied: false,
      motion: false,
      status: "ONLINE",
      lastPersonEntered: null,
      lastPersonLeft: null,
      lastActivity: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      people: [],
    };
  }

  getAllStates() {
    return Array.from(this.states.values());
  }

  detectMotion(cameraId, currentPeople) {
    const prevBoxes = this.lastBoxes.get(cameraId) || [];
    const currentBoxes = (currentPeople || []).map((p) => ({
      x: p.bbox?.x ?? 0,
      y: p.bbox?.y ?? 0,
      trackId: p.trackId,
    }));
    this.lastBoxes.set(cameraId, currentBoxes);

    if (currentBoxes.length === 0 && prevBoxes.length === 0) return false;
    if (currentBoxes.length !== prevBoxes.length) return true;

    for (let i = 0; i < currentBoxes.length; i++) {
      const c = currentBoxes[i];
      const match = prevBoxes.find((p) => p.trackId && p.trackId === c.trackId) || prevBoxes[i];
      if (match) {
        const dx = Math.abs(c.x - match.x);
        const dy = Math.abs(c.y - match.y);
        if (dx > 0.025 || dy > 0.025) return true;
      }
    }
    return false;
  }

  async processDetection({ cameraId, roomId, locationId, detectionResult }) {
    if (!cameraId || !detectionResult) return this.getState(cameraId);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const prev = this.getState(cameraId);
    const rawCount = Number(detectionResult.peopleCount || 0);
    const prevCount = Number(prev.peopleCount || 0);
    const motion = detectionResult.motion !== undefined ? Boolean(detectionResult.motion) : this.detectMotion(cameraId, detectionResult.people);

    if (locationId) {
      this.cameraLocations.set(cameraId, locationId);
    }
    const effLocationId = locationId || this.cameraLocations.get(cameraId) || prev.locationId || null;

    let confirmedCount = prevCount;
    const eventsToPublish = [];

    // Hysteresis & Debounce:
    // If detection sees 0 people while previous was >0, require 3 consecutive frames AND at least 3 seconds
    if (rawCount === 0 && prevCount > 0) {
      const count = (this.zeroFrameCounts.get(cameraId) || 0) + 1;
      this.zeroFrameCounts.set(cameraId, count);
      if (!this.zeroFirstSeen.has(cameraId)) {
        this.zeroFirstSeen.set(cameraId, now);
      }
      const firstSeen = this.zeroFirstSeen.get(cameraId) || now;
      const elapsed = now - firstSeen;

      if (count >= this.zeroHysteresisFrames || (this.zeroHysteresisMs > 0 && elapsed >= this.zeroHysteresisMs)) {
        // Confirmed empty!
        confirmedCount = 0;
        this.zeroFrameCounts.delete(cameraId);
        this.zeroFirstSeen.delete(cameraId);
      } else {
        // Debounce: keep count as previous to avoid flapping on missed frames
        confirmedCount = prevCount;
      }
    } else {
      // Non-zero detection resets zero hysteresis counters
      this.zeroFrameCounts.delete(cameraId);
      this.zeroFirstSeen.delete(cameraId);
      confirmedCount = rawCount;
    }

    let lastPersonEntered = prev.lastPersonEntered;
    let lastPersonLeft = prev.lastPersonLeft;

    if (confirmedCount > prevCount) {
      lastPersonEntered = nowIso;
      eventsToPublish.push({
        id: crypto.randomUUID(),
        cameraId,
        roomId: roomId || prev.roomId,
        type: "PERSON_ENTERED",
        timestamp: nowIso,
        peopleCount: confirmedCount,
        confidence: 0.92,
        description: `В кадре появился человек (${prevCount} -> ${confirmedCount})`,
        metadata: { prevCount, currentCount: confirmedCount },
      });

      if (prevCount === 0) {
        eventsToPublish.push({
          id: crypto.randomUUID(),
          cameraId,
          roomId: roomId || prev.roomId,
          type: "ROOM_OCCUPIED",
          timestamp: nowIso,
          peopleCount: confirmedCount,
          confidence: 0.95,
          description: "Комната занята игроками",
          metadata: { currentCount: confirmedCount },
        });
      }
    } else if (confirmedCount < prevCount) {
      lastPersonLeft = nowIso;
      eventsToPublish.push({
        id: crypto.randomUUID(),
        cameraId,
        roomId: roomId || prev.roomId,
        type: "PERSON_LEFT",
        timestamp: nowIso,
        peopleCount: confirmedCount,
        confidence: 0.90,
        description: `Человек покинул зону видимости (${prevCount} -> ${confirmedCount})`,
        metadata: { prevCount, currentCount: confirmedCount },
      });

      if (confirmedCount === 0) {
        const emptyEv = {
          id: crypto.randomUUID(),
          cameraId,
          roomId: roomId || prev.roomId,
          type: "ROOM_EMPTY",
          timestamp: nowIso,
          peopleCount: 0,
          confidence: 0.95,
          description: "Комната освободилась",
          metadata: { prevCount },
        };
        eventsToPublish.push(emptyEv);

        // Notify Telegram if configured
        if (this.onNotification) {
          this.onNotification("ROOM_EMPTY", {
            cameraId,
            roomId: roomId || prev.roomId,
            locationId: effLocationId,
            description: "Комната освободилась (все игроки вышли)",
          });
        }
      }
    }

    if (confirmedCount !== prevCount) {
      eventsToPublish.push({
        id: crypto.randomUUID(),
        cameraId,
        roomId: roomId || prev.roomId,
        type: "PEOPLE_COUNT_CHANGED",
        timestamp: nowIso,
        peopleCount: confirmedCount,
        confidence: 0.94,
        description: `Число людей изменилось с ${prevCount} до ${confirmedCount}`,
        metadata: { prevCount, currentCount: confirmedCount },
      });
    }

    if (motion) {
      const lastMotion = this.lastMotionTimes.get(cameraId) || 0;
      if (now - lastMotion > 10_000) {
        this.lastMotionTimes.set(cameraId, now);
        eventsToPublish.push({
          id: crypto.randomUUID(),
          cameraId,
          roomId: roomId || prev.roomId,
          type: "MOTION_DETECTED",
          timestamp: nowIso,
          peopleCount: confirmedCount,
          confidence: 0.88,
          description: "Зафиксировано движение в зоне видимости камеры",
          metadata: {},
        });
      }
    }

    // Check for unusual activity (falls, velocity jumps, crowding)
    if (detectionResult.unusual) {
      const lastUnusual = this.lastUnusualTimes.get(cameraId) || 0;
      if (now - lastUnusual > 25_000) {
        this.lastUnusualTimes.set(cameraId, now);
        const desc = detectionResult.unusualDescription || "Зафиксирована необычная активность в комнате";
        const unusualEv = {
          id: crypto.randomUUID(),
          cameraId,
          roomId: roomId || prev.roomId,
          type: "UNUSUAL_ACTIVITY",
          timestamp: nowIso,
          peopleCount: confirmedCount,
          confidence: 0.90,
          description: desc,
          metadata: { details: desc },
        };
        eventsToPublish.push(unusualEv);

        if (this.onNotification) {
          this.onNotification("UNUSUAL_ACTIVITY", {
            cameraId,
            roomId: roomId || prev.roomId,
            locationId: effLocationId,
            description: desc,
          });
        }
      }
    }

    const nextState = {
      cameraId,
      roomId: roomId || prev.roomId || null,
      locationId: effLocationId,
      peopleCount: confirmedCount,
      occupied: confirmedCount > 0,
      motion,
      status: prev.status || "ONLINE",
      lastPersonEntered,
      lastPersonLeft,
      lastActivity: motion || confirmedCount > 0 ? nowIso : prev.lastActivity,
      lastUpdated: nowIso,
      people: detectionResult.people || [],
    };

    this.states.set(cameraId, nextState);

    // Scoped live state emission (to location room and camera room)
    if (effLocationId) {
      this.emitScoped(`location:${effLocationId}`, "camera:ai:state", nextState);
    }
    this.emitScoped(`camera:${cameraId}`, "camera:ai:state", nextState);

    // Scoped live events emission & persistence
    for (const ev of eventsToPublish) {
      if (effLocationId) {
        this.emitScoped(`location:${effLocationId}`, "camera:ai:event", ev);
      }
      this.emitScoped(`camera:${cameraId}`, "camera:ai:event", ev);
      this.persistEvent(ev).catch((err) =>
        console.error("Failed to persist camera AI event:", err.message)
      );
    }

    // Persist state debounced
    const lastDbSave = this.lastDbSaveTimes.get(cameraId) || 0;
    if (now - lastDbSave > 5000) {
      this.lastDbSaveTimes.set(cameraId, now);
      this.persistState(nextState).catch((err) =>
        console.error("Failed to persist camera AI state:", err.message)
      );
    }

    return nextState;
  }

  async handleCameraStatus({ cameraId, status, roomId, locationId }) {
    if (!cameraId || !status) return;
    const nowIso = new Date().toISOString();
    const prev = this.getState(cameraId);
    const effLocationId = locationId || this.cameraLocations.get(cameraId) || prev.locationId || null;

    if (prev.status === status) return;

    const wasOccupied = Boolean(prev.occupied);
    const nextState = {
      ...prev,
      status,
      lastUpdated: nowIso,
    };

    if (status === "OFFLINE") {
      nextState.peopleCount = 0;
      nextState.occupied = false;
      nextState.motion = false;
      nextState.people = [];
      this.zeroFrameCounts.delete(cameraId);
      this.zeroFirstSeen.delete(cameraId);
    }

    this.states.set(cameraId, nextState);

    const eventType = status === "OFFLINE" ? "CAMERA_OFFLINE" : "CAMERA_ONLINE";
    const desc = status === "OFFLINE" ? "Потерян видеопоток с камеры" : "Видеопоток с камеры восстановлен";

    const ev = {
      id: crypto.randomUUID(),
      cameraId,
      roomId: roomId || prev.roomId,
      type: eventType,
      timestamp: nowIso,
      peopleCount: nextState.peopleCount,
      confidence: 1.0,
      description: desc,
      metadata: { status },
    };

    if (effLocationId) {
      this.emitScoped(`location:${effLocationId}`, "camera:ai:event", ev);
      this.emitScoped(`location:${effLocationId}`, "camera:ai:state", nextState);
    }
    this.emitScoped(`camera:${cameraId}`, "camera:ai:event", ev);
    this.emitScoped(`camera:${cameraId}`, "camera:ai:state", nextState);

    this.persistEvent(ev).catch(() => {});
    this.persistState(nextState).catch(() => {});

    if (status === "OFFLINE") {
      // A failed HLS/WebRTC retry can briefly flip ONLINE → OFFLINE several
      // times. Keep the event timeline intact, but never turn that transport
      // flap into a Telegram storm. A real sustained outage still produces
      // the first notification immediately and another only after cooldown.
      const nowMs = Date.now();
      const lastAlertAt = this.lastOfflineNotificationTimes.get(cameraId) || 0;
      const shouldNotify = !this.cameraOfflineNotificationCooldownMs ||
        nowMs - lastAlertAt >= this.cameraOfflineNotificationCooldownMs;
      if (shouldNotify) this.lastOfflineNotificationTimes.set(cameraId, nowMs);

      if (wasOccupied && shouldNotify) {
        const roomEmptyEv = {
          id: crypto.randomUUID(),
          cameraId,
          roomId: roomId || prev.roomId,
          type: "ROOM_EMPTY",
          timestamp: nowIso,
          peopleCount: 0,
          confidence: 1.0,
          description: "Камера перешла в статус OFFLINE: комната помечена как свободная",
          metadata: { reason: "CAMERA_OFFLINE" },
        };
        if (effLocationId) {
          this.emitScoped(`location:${effLocationId}`, "camera:ai:event", roomEmptyEv);
        }
        this.emitScoped(`camera:${cameraId}`, "camera:ai:event", roomEmptyEv);
        this.persistEvent(roomEmptyEv).catch(() => {});

        if (this.onNotification) {
          this.onNotification("ROOM_EMPTY", {
            cameraId,
            roomId: roomId || prev.roomId,
            locationId: effLocationId,
            description: roomEmptyEv.description,
          });
        }
      }

      if (this.onNotification && shouldNotify) {
        this.onNotification("CAMERA_OFFLINE", {
          cameraId,
          roomId: roomId || prev.roomId,
          locationId: effLocationId,
          description: desc,
        });
      }
    }
  }

  emitScoped(room, event, payload) {
    if (!this.io) return;
    if (typeof this.io.to === "function") {
      this.io.to(room).emit(event, payload);
    } else if (typeof this.io.emit === "function") {
      this.io.emit(event, payload);
    }
  }

  async persistEvent(ev) {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO camera_ai_events(id, camera_id, room_id, type, timestamp, people_count, confidence, description, metadata)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ev.id,
        ev.cameraId,
        ev.roomId || null,
        ev.type,
        ev.timestamp,
        ev.peopleCount,
        ev.confidence,
        ev.description || null,
        JSON.stringify(ev.metadata || {}),
      ]
    );
  }

  async persistState(st) {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO camera_ai_states(camera_id, room_id, people_count, occupied, motion, last_person_entered, last_person_left, last_activity, last_updated)
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(camera_id) DO UPDATE SET
         room_id = excluded.room_id,
         people_count = excluded.people_count,
         occupied = excluded.occupied,
         motion = excluded.motion,
         last_person_entered = excluded.last_person_entered,
         last_person_left = excluded.last_person_left,
         last_activity = excluded.last_activity,
         last_updated = excluded.last_updated`,
      [
        st.cameraId,
        st.roomId || null,
        st.peopleCount,
        st.occupied,
        st.motion,
        st.lastPersonEntered,
        st.lastPersonLeft,
        st.lastActivity,
        st.lastUpdated,
      ]
    );
  }

  async getRecentEvents({ cameraId, roomId, limit = 50 } = {}) {
    if (!this.db) return [];
    let query = "SELECT * FROM camera_ai_events WHERE ";
    const params = [];
    if (cameraId) {
      params.push(cameraId);
      query += `camera_id = $${params.length}`;
    } else if (roomId) {
      params.push(roomId);
      query += `room_id = $${params.length}`;
    } else {
      query += "TRUE";
    }
    params.push(limit);
    query += ` ORDER BY timestamp DESC LIMIT $${params.length}`;

    const { rows } = await this.db.query(query, params);
    return rows.map((r) => ({
      id: r.id,
      cameraId: r.camera_id,
      roomId: r.room_id,
      type: r.type,
      timestamp: r.timestamp,
      peopleCount: r.people_count,
      confidence: Number(r.confidence || 1),
      description: r.description,
      metadata: r.metadata || {},
    }));
  }
}
