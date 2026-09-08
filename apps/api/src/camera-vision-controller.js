export class CameraVisionController {
  constructor({ tuya, db, frameProvider, visionService, eventEngine, settleDelayMs = 1200 } = {}) {
    this.tuya = tuya;
    this.db = db;
    this.frameProvider = frameProvider;
    this.visionService = visionService;
    this.eventEngine = eventEngine;
    this.settleDelayMs = settleDelayMs;

    this.defaultPresets = ["Entrance", "Center", "Puzzle Area", "Exit", "Corner"];
    /** @type {Map<string, number>} */
    this.lastTrackingTimes = new Map();
    /** @type {Map<string, boolean>} */
    this.trackingEnabled = new Map();
    /** @type {Map<string, number>} */
    this.manualPtzLockUntil = new Map();
  }

  recordManualPtz(cameraId, lockoutDurationMs = 15_000) {
    this.manualPtzLockUntil.set(cameraId, Date.now() + lockoutDurationMs);
  }

  async getCamera(cameraId) {
    const { rows } = await this.db.query(
      `SELECT c.*, COALESCE(c.location_id, r.location_id) AS effective_location_id, r.name AS room_name
       FROM cameras c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.id = $1`,
      [cameraId]
    );
    return rows[0] || null;
  }

  async sendPtz(camera, direction, durationMs = 0) {
    if (!camera || camera.provider !== "TUYA" || !camera.external_id) {
      throw new Error("PTZ not supported on this camera");
    }
    if (!this.tuya.configured) {
      throw new Error("Tuya integration not configured");
    }

    await this.tuya.ptz(camera.external_id, direction);

    if (durationMs > 0 && direction !== "STOP") {
      setTimeout(async () => {
        try {
          await this.tuya.ptz(camera.external_id, "STOP");
        } catch {}
      }, durationMs);
    }
  }

  async lookLeft(cameraId, durationMs = 300) {
    const camera = await this.getCamera(cameraId);
    return this.sendPtz(camera, "LEFT", durationMs);
  }

  async lookRight(cameraId, durationMs = 300) {
    const camera = await this.getCamera(cameraId);
    return this.sendPtz(camera, "RIGHT", durationMs);
  }

  async lookUp(cameraId, durationMs = 300) {
    const camera = await this.getCamera(cameraId);
    return this.sendPtz(camera, "UP", durationMs);
  }

  async lookDown(cameraId, durationMs = 300) {
    const camera = await this.getCamera(cameraId);
    return this.sendPtz(camera, "DOWN", durationMs);
  }

  async stop(cameraId) {
    const camera = await this.getCamera(cameraId);
    return this.sendPtz(camera, "STOP", 0);
  }

  async getPresets(cameraId) {
    const { rows } = await this.db.query(
      "SELECT id, name, ptz_preset, description FROM camera_presets WHERE camera_id = $1 ORDER BY created_at",
      [cameraId]
    );
    if (rows.length > 0) return rows;

    return this.defaultPresets.map((name) => ({
      name,
      ptz_preset: name.toLowerCase().replace(/\s+/g, "_"),
      description: `Preset ${name}`,
    }));
  }

  async lookAtPreset(cameraId, presetName) {
    const camera = await this.getCamera(cameraId);
    if (!camera) throw new Error("Camera not found");

    // Check calibrated preset in database
    const { rows } = await this.db.query(
      "SELECT ptz_preset FROM camera_presets WHERE camera_id = $1 AND name = $2",
      [cameraId, presetName]
    );

    if (rows[0]?.ptz_preset) {
      const val = String(rows[0].ptz_preset).trim();
      if (val.startsWith("{") && val.endsWith("}")) {
        try {
          const parsed = JSON.parse(val);
          if (parsed.direction) {
            await this.sendPtz(camera, parsed.direction, parsed.durationMs || 600);
            return { preset: presetName, status: "completed", mode: "calibrated" };
          }
          if (Array.isArray(parsed.steps)) {
            for (const step of parsed.steps) {
              await this.sendPtz(camera, step.direction, step.durationMs || 400);
              await new Promise((r) => setTimeout(r, (step.durationMs || 400) + 100));
            }
            return { preset: presetName, status: "completed", mode: "calibrated_steps" };
          }
        } catch {}
      }
      if (/^[0-9A-Za-z_-]{1,10}$/.test(val)) {
        try {
          await this.tuya.sendCommands(camera.external_id, [{ code: "ptz_preset", value: val }]);
          return { preset: presetName, status: "completed", mode: "device_preset" };
        } catch {}
      }
    }

    // Standard calibrated directional fallback
    const normalized = String(presetName || "").toLowerCase().trim();
    if (normalized.includes("left") || normalized.includes("entrance")) {
      await this.sendPtz(camera, "LEFT", 700);
    } else if (normalized.includes("right") || normalized.includes("exit")) {
      await this.sendPtz(camera, "RIGHT", 700);
    } else if (normalized.includes("puzzle") || normalized.includes("corner")) {
      await this.sendPtz(camera, "DOWN", 400);
    } else {
      await this.sendPtz(camera, "UP", 300);
    }
    return { preset: presetName, status: "completed", mode: "fallback_direction" };
  }

  async inspectRoom(roomId) {
    // 1. Get room camera
    const { rows } = await this.db.query(
      "SELECT * FROM cameras WHERE room_id = $1 ORDER BY (provider = 'TUYA') DESC LIMIT 1",
      [roomId]
    );
    const camera = rows[0];
    if (!camera) {
      return {
        roomId,
        occupied: false,
        estimatedPeople: 0,
        observations: [],
        summary: "В комнате не настроена камера наблюдения.",
      };
    }

    // 2. Get presets
    const presets = await this.getPresets(camera.id);
    const inspectionPresets = presets.slice(0, 4); // Inspect up to 4 angles
    const observations = [];

    for (const preset of inspectionPresets) {
      try {
        await this.lookAtPreset(camera.id, preset.name);
        // Settle delay
        if (this.settleDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.settleDelayMs));
        }
      } catch (err) {
        console.warn(`Preset ${preset.name} movement error:`, err.message);
      }

      try {
        let frameItem = this.frameProvider?.getLatestFrame(camera.id);
        if (!frameItem?.buffer && this.visionService?.getLatestFrame) {
          frameItem = await this.visionService.getLatestFrame(camera.id);
          if (frameItem?.buffer && this.frameProvider) {
            this.frameProvider.pushFrame(camera.id, frameItem.buffer);
          }
        }
        let count = 0;
        let detection = null;
        if (frameItem?.buffer && this.visionService) {
          detection = await this.visionService.detect({
            cameraId: camera.id,
            imageBuffer: frameItem.buffer,
          });
          count = Number(detection?.peopleCount || 0);
        }

        observations.push({
          preset: preset.name,
          peopleCount: count,
          timestamp: new Date().toISOString(),
          people: detection?.people || [],
        });
      } catch (err) {
        console.warn(`Preset ${preset.name} inspection error:`, err.message);
      }
    }

    // Return camera to center
    try {
      await this.lookAtPreset(camera.id, "Center");
    } catch {}

    // Deduplicate: take maximum detected across any single preset to avoid double-counting
    const maxPeople = observations.length > 0
      ? Math.max(...observations.map((o) => o.peopleCount))
      : 0;

    let summary = maxPeople > 0
      ? `Осмотр завершён: в комнате обнаружено ориентировочно ${maxPeople} человек(а).`
      : "Осмотр завершён: комната полностью свободна, людей не обнаружено.";

    return {
      roomId,
      cameraId: camera.id,
      cameraName: camera.name,
      occupied: maxPeople > 0,
      estimatedPeople: maxPeople,
      observations,
      summary,
      inspectedAt: new Date().toISOString(),
    };
  }

  async processAutoTracking(cameraId, people) {
    if (!this.trackingEnabled.get(cameraId)) return;
    if (!people || people.length === 0) return;

    // Manual operator lockout priority (operator control always overrides AI)
    const lockUntil = this.manualPtzLockUntil.get(cameraId) || 0;
    if (Date.now() < lockUntil) return;

    const now = Date.now();
    const lastTime = this.lastTrackingTimes.get(cameraId) || 0;
    if (now - lastTime < 500) return; // Cooldown 500ms

    // Compute group center
    let sumX = 0;
    for (const p of people) {
      sumX += (p.bbox?.x ?? 0.5) + (p.bbox?.width ?? 0) / 2;
    }
    const centerX = sumX / people.length;

    // Dead zone: 0.35 .. 0.65
    if (centerX < 0.35) {
      this.lastTrackingTimes.set(cameraId, now);
      await this.lookLeft(cameraId, 250);
    } else if (centerX > 0.65) {
      this.lastTrackingTimes.set(cameraId, now);
      await this.lookRight(cameraId, 250);
    }
  }

  setTracking(cameraId, enabled) {
    this.trackingEnabled.set(cameraId, Boolean(enabled));
  }

  isTracking(cameraId) {
    return Boolean(this.trackingEnabled.get(cameraId));
  }
}
