import crypto from "node:crypto";

/**
 * Geometric helper: ray-casting point-in-polygon test.
 * @param {{ x: number, y: number }} point
 * @param {Array<{ x: number, y: number } | [number, number]>} polygon
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  const { x, y } = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p1 = polygon[i];
    const p2 = polygon[j];
    const xi = p1.x !== undefined ? p1.x : p1[0] ?? 0;
    const yi = p1.y !== undefined ? p1.y : p1[1] ?? 0;
    const xj = p2.x !== undefined ? p2.x : p2[0] ?? 0;
    const yj = p2.y !== undefined ? p2.y : p2[1] ?? 0;

    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Checks if a point falls within a configured zone (polygon or bounding box).
 * @param {{ x: number, y: number }} point
 * @param {object} zone
 * @returns {boolean}
 */
export function isInsideZone(point, zone) {
  if (Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
    return pointInPolygon(point, zone.polygon);
  }
  const zx = Number(zone.x ?? 0);
  const zy = Number(zone.y ?? 0);
  const zw = Number(zone.width ?? 0.1);
  const zh = Number(zone.height ?? 0.1);
  return point.x >= zx && point.x <= zx + zw && point.y >= zy && point.y <= zy + zh;
}

/**
 * Computes the center (cx, cy) of a normalized bounding box.
 * @param {{ x: number, y: number, width: number, height: number }} bbox
 * @returns {{ x: number, y: number }}
 */
export function getBboxCenter(bbox) {
  const bx = Number(bbox?.x ?? 0);
  const by = Number(bbox?.y ?? 0);
  const bw = Number(bbox?.width ?? 0);
  const bh = Number(bbox?.height ?? 0);
  return { x: bx + bw / 2, y: by + bh / 2 };
}

/**
 * Returns true only when a detected headset is positioned at the head of a
 * detected person.  A headset held at waist/chest level deliberately does not
 * match: it must still be treated as unattended when it is outside its base.
 */
export function isHeadsetWornByPerson(headset, people = []) {
  const headsetBox = headset?.bbox;
  if (!headsetBox || !Array.isArray(people)) return false;

  const center = getBboxCenter(headsetBox);
  return people.some((person) => {
    const box = person?.bbox;
    if (!box) return false;

    const x = Number(box.x ?? 0);
    const y = Number(box.y ?? 0);
    const width = Number(box.width ?? 0);
    const height = Number(box.height ?? 0);
    if (width <= 0 || height <= 0) return false;

    // A little horizontal slack covers a turned head. Vertically accept just
    // the upper part of the person box, not a controller/headset held below.
    return (
      center.x >= x - width * 0.12 &&
      center.x <= x + width * 1.12 &&
      center.y >= y - height * 0.15 &&
      center.y <= y + height * 0.42
    );
  });
}

export class HeadsetTrackingEngine {
  constructor({
    db,
    io,
    visionController,
    visionService,
    frameProvider,
    onNotification,
    confidenceThreshold = 0.65,
    debounceFrames = 3,
    notificationCooldownMs = 60_000,
  } = {}) {
    this.db = db;
    this.io = io;
    this.visionController = visionController || null;
    this.visionService = visionService || null;
    this.frameProvider = frameProvider || null;
    this.onNotification = onNotification || null;
    this.confidenceThreshold = confidenceThreshold;
    this.debounceFrames = debounceFrames;
    this.notificationCooldownMs = notificationCooldownMs;

    /** @type {Map<string, Array<any>>} cameraId -> zones list */
    this.cameraZones = new Map();
    /** @type {Map<string, any>} cameraId -> state */
    this.states = new Map();
    /** @type {Map<string, { consecutiveCount: number, candidateStatus: string, lastConfirmedStatus: string }>} zoneDebounce */
    this.zoneDebounce = new Map();
    /** @type {Map<string, number>} key -> timestamp */
    this.lastNotificationTimes = new Map();
    /** @type {Map<string, { signature: string, notOnBaseCount: number, missingFromBaseCount: number, notOnBaseHeadsets: Array<string>, timestamp: number }>} key -> last notified state */
    this.lastNotifiedState = new Map();
    /** @type {Map<string, number>} roomId -> expectedHeadsetCount */
    this.roomExpectedHeadsets = new Map();
    /** @type {Map<string, boolean>} cameraId -> isMoving */
    this.cameraMoving = new Map();
    /** @type {Map<string, string>} cameraId -> current preset */
    this.currentPresets = new Map();
    /** @type {Map<string, string>} cameraId -> locationId */
    this.cameraLocations = new Map();
    /** @type {Map<string, string>} cameraId -> roomId */
    this.cameraRooms = new Map();
    /** @type {Map<string, string>} roomId -> last confirmed room status */
    this.roomLastConfirmedStatus = new Map();
    /** @type {Map<string, string>} roomId -> signature */
    this.roomLastNotifiedSignature = new Map();
  }

  async loadStatesFromDb() {
    if (!this.db) return;
    try {
      const zonesRes = await this.db.query(
        "SELECT * FROM camera_headset_zones WHERE enabled = true ORDER BY created_at ASC"
      );
      for (const row of zonesRes.rows) {
        this.addZoneToCache(row);
      }

      const statesRes = await this.db.query("SELECT * FROM camera_headset_states");
      for (const row of statesRes.rows) {
        const chargingBaseCount = Number(row.charging_base_count || 0);
        const outsideZoneCount = Number(row.outside_zone_count || 0);
        let notOnBaseHeadsets = [];
        if (Array.isArray(row.not_on_base_headsets)) {
          notOnBaseHeadsets = row.not_on_base_headsets;
        } else if (typeof row.not_on_base_headsets === "string") {
          try {
            notOnBaseHeadsets = JSON.parse(row.not_on_base_headsets || "[]");
          } catch {
            notOnBaseHeadsets = [];
          }
        }
        const notOnBaseCount = Number(
          row.not_on_base_count !== undefined && row.not_on_base_count !== null
            ? row.not_on_base_count
            : notOnBaseHeadsets.length + outsideZoneCount
        );

        const expectedHeadsetCount = row.expected_headset_count !== null && row.expected_headset_count !== undefined
          ? Number(row.expected_headset_count)
          : null;
        const missingFromBaseCount = Number(row.missing_from_base_count || 0);
        const unlocatedCount = Number(row.unlocated_count || 0);
        let storageStatus = "NOT_CONFIGURED";
        if (expectedHeadsetCount !== null && expectedHeadsetCount > 0) {
          storageStatus = (chargingBaseCount === expectedHeadsetCount && notOnBaseCount === 0 && unlocatedCount === 0)
            ? "ALL_ON_BASE"
            : "NOT_ALL_ON_BASE";
        }

        this.states.set(row.camera_id, {
          cameraId: row.camera_id,
          currentPreset: row.current_preset || "default",
          chargingBaseCount,
          onChargingBaseCount: chargingBaseCount,
          outsideZoneCount,
          notOnBaseCount,
          notOnBaseHeadsets,
          expectedHeadsetCount,
          missingFromBaseCount,
          unlocatedCount,
          storageStatus,
          totalDetected: Number(row.total_detected || 0),
          assignedZonesState: row.assigned_zones_state || {},
          emptyAssignedZones: row.empty_assigned_zones || [],
          notVisibleZones: row.not_visible_zones || [],
          confidence: Number(row.confidence || 1.0),
          modelStatus: row.model_status || "READY",
          status: row.model_status || "READY",
          lastEventType: row.last_event_type,
          updatedAt: row.updated_at,
        });
        this.currentPresets.set(row.camera_id, row.current_preset || "default");
      }

      const roomsRes = await this.db.query("SELECT id, expected_headset_count FROM rooms");
      for (const r of roomsRes.rows) {
        if (r.expected_headset_count !== null && r.expected_headset_count !== undefined) {
          this.roomExpectedHeadsets.set(r.id, Number(r.expected_headset_count));
        }
      }

      const camsRes = await this.db.query(
        "SELECT c.id, c.room_id, COALESCE(c.location_id, r.location_id) AS effective_location_id FROM cameras c LEFT JOIN rooms r ON r.id = c.room_id"
      );
      for (const cam of camsRes.rows) {
        if (cam.effective_location_id) {
          this.cameraLocations.set(cam.id, cam.effective_location_id);
        }
        if (cam.room_id) {
          this.cameraRooms.set(cam.id, cam.room_id);
        }
      }
      // Restore last confirmed room status and notification signature across API restarts
      try {
        const eventsRes = await this.db.query(`
          SELECT DISTINCT ON (room_id)
            room_id,
            event_type,
            payload,
            timestamp
          FROM camera_headset_events
          WHERE room_id IS NOT NULL AND event_type IN ('HEADSET_NOT_ON_BASE', 'HEADSET_ALL_ON_BASE')
          ORDER BY room_id, timestamp DESC
        `);
        for (const ev of eventsRes.rows) {
          const rId = String(ev.room_id);
          const evTs = ev.timestamp ? new Date(ev.timestamp).getTime() : Date.now();
          let payload = ev.payload;
          if (typeof payload === "string") {
            try {
              payload = JSON.parse(payload);
            } catch {
              payload = {};
            }
          }
          if (ev.event_type === "HEADSET_NOT_ON_BASE") {
            this.roomLastConfirmedStatus.set(rId, "NOT_ALL_ON_BASE");
            const p = payload || {};
            const sig =
              p.signature ||
              `${rId}:${p.notOnBaseCount || 0}:${p.missingFromBaseCount || 0}:${(p.notOnBaseHeadsets || []).sort().join(",")}`;
            this.roomLastNotifiedSignature.set(rId, sig);
            this.lastNotificationTimes.set(`HEADSET_NOT_ON_BASE:room:${rId}`, evTs);
          } else if (ev.event_type === "HEADSET_ALL_ON_BASE") {
            this.roomLastConfirmedStatus.set(rId, "ALL_ON_BASE");
            this.roomLastNotifiedSignature.delete(rId);
            this.lastNotificationTimes.delete(`HEADSET_NOT_ON_BASE:room:${rId}`);
          }
        }
      } catch (evErr) {
        console.warn("HeadsetTrackingEngine: could not restore room events on startup:", evErr.message);
      }

      console.info(
        `HeadsetTrackingEngine: loaded ${zonesRes.rows.length} zones and ${statesRes.rows.length} states from database.`
      );
    } catch (err) {
      console.error("HeadsetTrackingEngine: failed to load from database:", err.message);
    }
  }

  setCameraRoom(cameraId, roomId) {
    if (!cameraId) return;
    const cid = String(cameraId);
    if (roomId) {
      this.cameraRooms.set(cid, String(roomId));
    } else {
      this.cameraRooms.delete(cid);
    }
    const zones = this.cameraZones.get(cid);
    if (zones) {
      for (const z of zones) {
        z.room_id = roomId ? String(roomId) : null;
        if (!roomId && z.is_canonical_base) {
          z.is_canonical_base = false;
        }
      }
    }
  }

  setRoomExpectedHeadsets(roomId, count) {
    if (!roomId) return;
    if (count === null || count === undefined) {
      this.roomExpectedHeadsets.delete(String(roomId));
    } else {
      this.roomExpectedHeadsets.set(String(roomId), Number(count));
    }
  }

  getRoomExpectedHeadsets(roomId) {
    if (!roomId) return null;
    const count = this.roomExpectedHeadsets.get(String(roomId));
    return (count !== undefined && count !== null) ? Number(count) : null;
  }

  addZoneToCache(zone) {
    const cid = String(zone.camera_id);
    if (!this.cameraZones.has(cid)) {
      this.cameraZones.set(cid, []);
    }
    const list = this.cameraZones.get(cid);
    const normalized = {
      ...zone,
      base_station_id: zone.base_station_id || zone.baseStationId || "default",
      is_canonical_base: Boolean(zone.is_canonical_base ?? zone.isCanonicalBase ?? false),
      expected_headset_count:
        zone.expected_headset_count !== undefined && zone.expected_headset_count !== null
          ? Number(zone.expected_headset_count)
          : null,
    };
    const idx = list.findIndex((z) => z.id === zone.id);
    if (idx >= 0) {
      list[idx] = normalized;
    } else {
      list.push(normalized);
    }
  }

  removeZoneFromCache(zoneId, cameraId) {
    const cid = String(cameraId);
    const list = this.cameraZones.get(cid);
    if (list) {
      this.cameraZones.set(
        cid,
        list.filter((z) => z.id !== zoneId)
      );
    }
  }

  getZones(cameraId, preset = null) {
    const list = this.cameraZones.get(String(cameraId)) || [];
    if (!preset) return list;
    return list.filter((z) => (z.preset_name || "default") === preset);
  }

  setCameraMoving(cameraId, isMoving, preset = "") {
    const cid = String(cameraId);
    this.cameraMoving.set(cid, Boolean(isMoving));
    if (preset) {
      this.currentPresets.set(cid, preset);
    }
  }

  getState(cameraId) {
    const cid = String(cameraId);
    const s = this.states.get(cid);
    const effRoomId = this.cameraRooms.get(cid) || null;
    const expectedHeadsetCount = (s && s.expectedHeadsetCount !== undefined && s.expectedHeadsetCount !== null)
      ? s.expectedHeadsetCount
      : (effRoomId ? this.getRoomExpectedHeadsets(effRoomId) : null);
    const onChargingBaseCount = s ? (s.onChargingBaseCount ?? s.chargingBaseCount ?? 0) : 0;
    const notOnBaseCount = s ? (s.notOnBaseCount ?? 0) : 0;

    let missingFromBaseCount = 0;
    let unlocatedCount = 0;
    let storageStatus = "NOT_CONFIGURED";
    const physicalMisplacedCount = s ? (Number(s.notOnBaseHeadsets?.length || 0) + Number(s.outsideZoneCount || 0)) : 0;
    if (expectedHeadsetCount !== null && expectedHeadsetCount !== undefined && expectedHeadsetCount > 0) {
      missingFromBaseCount = Math.max(0, expectedHeadsetCount - onChargingBaseCount);
      unlocatedCount = Math.max(0, missingFromBaseCount - physicalMisplacedCount);
      storageStatus = (onChargingBaseCount === expectedHeadsetCount && notOnBaseCount === 0 && unlocatedCount === 0 && missingFromBaseCount === 0)
        ? "ALL_ON_BASE"
        : "NOT_ALL_ON_BASE";
    }

    if (s) {
      return {
        ...s,
        expectedHeadsetCount,
        missingFromBaseCount: s.missingFromBaseCount ?? missingFromBaseCount,
        unlocatedCount: s.unlocatedCount ?? unlocatedCount,
        storageStatus: s.storageStatus ?? storageStatus,
      };
    }
    return {
      cameraId: cid,
      currentPreset: this.currentPresets.get(cid) || "default",
      chargingBaseCount: 0,
      onChargingBaseCount: 0,
      outsideZoneCount: 0,
      notOnBaseCount: 0,
      notOnBaseHeadsets: [],
      expectedHeadsetCount,
      missingFromBaseCount,
      unlocatedCount,
      storageStatus,
      totalDetected: 0,
      assignedZonesState: {},
      emptyAssignedZones: [],
      notVisibleZones: [],
      confidence: 1.0,
      modelStatus: "READY",
      status: "READY",
      lastEventType: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async processDetections({
    cameraId,
    preset = null,
    detectedHeadsets = [],
    people = [],
    status = "READY",
    modelStatus = "READY",
    roomId = null,
    locationId = null,
    cameraName = "Камера",
    expectedHeadsetCount = null,
    imageBuffer = null,
    suppressNotification = false,
  }) {
    const cid = String(cameraId);
    // A headset being worn is not a misplaced headset. Keep it out of zone
    // accounting and subtract it from the expected stored inventory below.
    const wornHeadsets = detectedHeadsets.filter((headset) => isHeadsetWornByPerson(headset, people));
    const unattendedHeadsets = detectedHeadsets.filter((headset) => !isHeadsetWornByPerson(headset, people));
    const wornHeadsetCount = wornHeadsets.length;
    detectedHeadsets = unattendedHeadsets;

    // Fail-safe: if model is unavailable, freeze state mutations, do not mark zones EMPTY
    if (status === "MODEL_UNAVAILABLE" || modelStatus === "MODEL_UNAVAILABLE") {
      const prevState = this.getState(cid) || {};
      const effLocationId = locationId || this.cameraLocations.get(cid) || null;
      const updatedState = {
        ...prevState,
        cameraId: cid,
        currentPreset: preset || this.currentPresets.get(cid) || "default",
        onChargingBaseCount: prevState.onChargingBaseCount ?? prevState.chargingBaseCount ?? 0,
        chargingBaseCount: prevState.chargingBaseCount ?? 0,
        outsideZoneCount: prevState.outsideZoneCount ?? 0,
        notOnBaseCount: prevState.notOnBaseCount ?? 0,
        notOnBaseHeadsets: Array.isArray(prevState.notOnBaseHeadsets) ? prevState.notOnBaseHeadsets : [],
        expectedHeadsetCount: prevState.expectedHeadsetCount ?? null,
        missingFromBaseCount: prevState.missingFromBaseCount ?? 0,
        unlocatedCount: prevState.unlocatedCount ?? 0,
        storageStatus: prevState.storageStatus ?? "NOT_CONFIGURED",
        modelStatus: "MODEL_UNAVAILABLE",
        status: "MODEL_UNAVAILABLE",
        updatedAt: new Date().toISOString(),
      };
      this.states.set(cid, updatedState);

      if (this.db) {
        try {
          await this.db.query(
            `INSERT INTO camera_headset_states (camera_id, current_preset, model_status, updated_at)
             VALUES ($1, $2, 'MODEL_UNAVAILABLE', now())
             ON CONFLICT (camera_id) DO UPDATE SET
               current_preset = EXCLUDED.current_preset,
               model_status = 'MODEL_UNAVAILABLE',
               updated_at = now()`,
            [cid, updatedState.currentPreset]
          );
        } catch (dbErr) {
          console.error("HeadsetTrackingEngine: failed to persist MODEL_UNAVAILABLE state:", dbErr.message);
        }
      }

      if (effLocationId) {
        this.emitScoped(`location:${effLocationId}`, "camera:headset:state", updatedState);
      }
      this.emitScoped(`camera:${cid}`, "camera:headset:state", updatedState);

      return updatedState;
    }

    // Rule 6: Movement Stabilization
    // Detection does not change state while the camera is actively moving or settling
    if (this.cameraMoving.get(cid)) {
      return this.getState(cid);
    }

    const currentPreset = preset || this.currentPresets.get(cid) || "default";
    this.currentPresets.set(cid, currentPreset);

    const effLocationId = locationId || this.cameraLocations.get(cid) || null;
    const effRoomId = roomId || this.cameraRooms.get(cid) || null;
    if (effRoomId) this.cameraRooms.set(cid, effRoomId);
    if (effLocationId) this.cameraLocations.set(cid, effLocationId);

    const prevState = this.getState(cid);

    const allZones = this.cameraZones.get(cid) || [];
    const activeZones = allZones.filter(
      (z) => (z.preset_name || "default") === currentPreset && z.enabled !== false
    );
    const inactiveZones = allZones.filter(
      (z) => (z.preset_name || "default") !== currentPreset && z.enabled !== false
    );

    const chargingBases = activeZones.filter((z) => z.zone_type === "CHARGING_BASE");
    const workZones = activeZones.filter((z) => z.zone_type === "WORK_ZONE");

    let baseConfiguredExpected = 0;
    let hasBaseConfiguredExpected = false;
    for (const b of chargingBases) {
      if (b.expected_headset_count !== null && b.expected_headset_count !== undefined) {
        baseConfiguredExpected += Number(b.expected_headset_count);
        hasBaseConfiguredExpected = true;
      }
    }

    let resolvedExpectedCount = null;
    if (expectedHeadsetCount !== null && expectedHeadsetCount !== undefined) {
      resolvedExpectedCount = Number(expectedHeadsetCount);
    } else if (hasBaseConfiguredExpected) {
      resolvedExpectedCount = baseConfiguredExpected;
    } else if (effRoomId) {
      // Check if the room has multiple cameras or multiple physical base stations
      let isMultiBaseOrMultiCamera = false;
      const roomCamIds = [];
      for (const [cId, rId] of this.cameraRooms.entries()) {
        if (rId === effRoomId) roomCamIds.push(cId);
      }
      if (roomCamIds.length > 1) {
        isMultiBaseOrMultiCamera = true;
      } else {
        const roomBases = new Set();
        for (const camId of (roomCamIds.length ? roomCamIds : [cid])) {
          const zonesForCam = this.cameraZones.get(camId) || [];
          for (const z of zonesForCam) {
            if (z.zone_type === "CHARGING_BASE") {
              roomBases.add(z.base_station_id || "default");
            }
          }
        }
        if (roomBases.size > 1) {
          isMultiBaseOrMultiCamera = true;
        }
      }

      if (!isMultiBaseOrMultiCamera) {
        resolvedExpectedCount = this.getRoomExpectedHeadsets(effRoomId);
      }
    }

    // `resolvedExpectedCount` is the physical inventory. For the storage
    // check, headsets currently worn by people are legitimate absences from a
    // charging base and must never trigger the "not on base" Telegram alert.
    const expectedStoredCount = resolvedExpectedCount !== null
      ? Math.max(0, resolvedExpectedCount - wornHeadsetCount)
      : null;

    const matchedHeadsetIndices = new Set();
    const assignedZonesState = {};
    const eventsToPublish = [];
    let chargingBaseCount = 0;
    let outsideZoneCount = 0;
    const emptyAssignedZones = [];
    const workZoneHeadsetsNotOnBase = [];
    const workZoneCandidates = [];

    // Rule 5: Off-angle / Inactive zones must report NOT_VISIBLE, NEVER false EMPTY
    for (const z of inactiveZones) {
      assignedZonesState[z.id] = {
        zoneId: z.id,
        name: z.name,
        preset: z.preset_name,
        type: z.zone_type,
        headsetId: z.headset_id || null,
        status: "NOT_VISIBLE",
        confidence: 1.0,
        bbox: null,
      };
    }

    // Step 1: Detect headsets in CHARGING_BASE zones separately per zone
    // Rule 2: Working floor zones are NEVER considered charging stations. Separate zone logic.
    const baseZoneCounts = new Map();
    for (const base of chargingBases) {
      baseZoneCounts.set(base.id, 0);
    }

    for (let i = 0; i < detectedHeadsets.length; i++) {
      const h = detectedHeadsets[i];
      const center = getBboxCenter(h.bbox);
      for (const base of chargingBases) {
        if (isInsideZone(center, base)) {
          matchedHeadsetIndices.add(i);
          chargingBaseCount++;
          baseZoneCounts.set(base.id, (baseZoneCounts.get(base.id) || 0) + 1);
          break;
        }
      }
    }
    const onChargingBaseCount = chargingBaseCount;

    for (const base of chargingBases) {
      const bCount = baseZoneCounts.get(base.id) || 0;
      assignedZonesState[base.id] = {
        zoneId: base.id,
        name: base.name,
        preset: currentPreset,
        type: "CHARGING_BASE",
        baseStationId: base.base_station_id || base.baseStationId || "default",
        isCanonicalBase: Boolean(base.is_canonical_base ?? base.isCanonicalBase ?? false),
        headsetCount: bCount,
        status: bCount > 0 ? "OCCUPIED" : "EMPTY",
        confidence: 1.0,
      };
    }

    if (chargingBaseCount > 0 && chargingBaseCount !== prevState.chargingBaseCount) {
      eventsToPublish.push({
        id: crypto.randomUUID(),
        cameraId: cid,
        roomId: effRoomId,
        presetName: currentPreset,
        type: "HEADSET_IN_CHARGING_BASE",
        headsetId: null,
        zoneId: chargingBases[0]?.id || null,
        description: `В зарядной базе обнаружено шлемов: ${chargingBaseCount}`,
        payload: { chargingBaseCount, onChargingBaseCount },
        timestamp: new Date().toISOString(),
      });
    }

    // Step 2: Detect headsets in WORK_ZONEs
    // Rule 1: Visual anonymity - identity H1, H2 is determined STRICTLY by assigned work zone
    for (const wz of workZones) {
      const debounceKey = `${cid}:${wz.id}`;
      let matchedIndex = -1;
      let matchedCandidate = null;

      for (let i = 0; i < detectedHeadsets.length; i++) {
        if (matchedHeadsetIndices.has(i)) continue;
        const h = detectedHeadsets[i];
        const center = getBboxCenter(h.bbox);
        if (isInsideZone(center, wz)) {
          matchedIndex = i;
          matchedCandidate = h;
          break;
        }
      }

      const prevZoneStatus =
        prevState?.assignedZonesState?.[wz.id]?.status || "EMPTY";

      if (matchedCandidate) {
        matchedHeadsetIndices.add(matchedIndex);
        const conf = Number(matchedCandidate.confidence ?? 1.0);

        // Rule 7: Confidence < 0.65 or occlusion sets status UNKNOWN, suppresses immediate alert
        if (conf < this.confidenceThreshold || matchedCandidate.occluded) {
          this.zoneDebounce.delete(debounceKey);
          assignedZonesState[wz.id] = {
            zoneId: wz.id,
            name: wz.name,
            preset: currentPreset,
            type: "WORK_ZONE",
            headsetId: wz.headset_id || null,
            status: "UNKNOWN",
            confidence: conf,
            bbox: matchedCandidate.bbox || null,
          };
        } else {
          workZoneCandidates.push(wz.headset_id || wz.name);
          // Rule 10: 3-frame debounce before confirming occupancy
          const deb = this.zoneDebounce.get(debounceKey) || {
            consecutiveCount: 0,
            candidateStatus: "OCCUPIED",
            lastConfirmedStatus: prevZoneStatus === "NOT_VISIBLE" ? "EMPTY" : prevZoneStatus,
          };

          if (deb.candidateStatus === "OCCUPIED") {
            deb.consecutiveCount++;
          } else {
            deb.candidateStatus = "OCCUPIED";
            deb.consecutiveCount = 1;
          }

          let confirmedStatus = deb.lastConfirmedStatus;
          if (deb.consecutiveCount >= this.debounceFrames && deb.lastConfirmedStatus !== "OCCUPIED") {
            confirmedStatus = "OCCUPIED";
            deb.lastConfirmedStatus = "OCCUPIED";
            eventsToPublish.push({
              id: crypto.randomUUID(),
              cameraId: cid,
              roomId: effRoomId,
              presetName: currentPreset,
              type: "HEADSET_ZONE_OCCUPIED",
              headsetId: wz.headset_id || null,
              zoneId: wz.id,
              description: `Шлем ${wz.headset_id || wz.name} зафиксирован в рабочей зоне`,
              payload: { headsetId: wz.headset_id, zoneName: wz.name },
              timestamp: new Date().toISOString(),
            });
          }

          this.zoneDebounce.set(debounceKey, deb);

          // Floor work zones are NOT charging base; identify headset as not on base
          if (confirmedStatus === "OCCUPIED") {
            workZoneHeadsetsNotOnBase.push(wz.headset_id || wz.name);
          }

          assignedZonesState[wz.id] = {
            zoneId: wz.id,
            name: wz.name,
            preset: currentPreset,
            type: "WORK_ZONE",
            headsetId: wz.headset_id || null,
            status: confirmedStatus,
            confidence: conf,
            bbox: matchedCandidate.bbox || null,
          };
        }
      } else {
        // No headset detected inside this work zone: evaluate towards EMPTY with 3-frame debounce
        const deb = this.zoneDebounce.get(debounceKey) || {
          consecutiveCount: 0,
          candidateStatus: "EMPTY",
          lastConfirmedStatus: prevZoneStatus === "NOT_VISIBLE" ? "EMPTY" : prevZoneStatus,
        };

        if (deb.candidateStatus === "EMPTY") {
          deb.consecutiveCount++;
        } else {
          deb.candidateStatus = "EMPTY";
          deb.consecutiveCount = 1;
        }

        let confirmedStatus = deb.lastConfirmedStatus;
        if (deb.consecutiveCount >= this.debounceFrames && deb.lastConfirmedStatus !== "EMPTY") {
          confirmedStatus = "EMPTY";
          deb.lastConfirmedStatus = "EMPTY";

          eventsToPublish.push({
            id: crypto.randomUUID(),
            cameraId: cid,
            roomId: effRoomId,
            presetName: currentPreset,
            type: "HEADSET_ZONE_EMPTY",
            headsetId: wz.headset_id || null,
            zoneId: wz.id,
            description: `Рабочая зона ${wz.headset_id || wz.name} свободна`,
            payload: { headsetId: wz.headset_id, zoneName: wz.name },
            timestamp: new Date().toISOString(),
          });
        }

        this.zoneDebounce.set(debounceKey, deb);

        if (confirmedStatus === "EMPTY") {
          emptyAssignedZones.push(wz.headset_id || wz.name);
        }

        assignedZonesState[wz.id] = {
          zoneId: wz.id,
          name: wz.name,
          preset: currentPreset,
          type: "WORK_ZONE",
          headsetId: wz.headset_id || null,
          status: confirmedStatus,
          confidence: 1.0,
          bbox: null,
        };
      }
    }

    // Step 3: Outside Zones Check
    // Rule 3: Anonymized outside-zone counter. Never assign H1/H2 to headsets outside zones!
    for (let i = 0; i < detectedHeadsets.length; i++) {
      if (!matchedHeadsetIndices.has(i)) {
        outsideZoneCount++;
      }
    }

    if (outsideZoneCount > 0) {
      eventsToPublish.push({
        id: crypto.randomUUID(),
        cameraId: cid,
        roomId: effRoomId,
        presetName: currentPreset,
        type: "HEADSET_OUTSIDE_ZONE",
        headsetId: null,
        zoneId: null,
        description: `VR-шлем вне зоны! Обнаружено шлемов вне зон: ${outsideZoneCount}`,
        payload: { outsideZoneCount, preset: currentPreset },
        timestamp: new Date().toISOString(),
      });
    }

    // Step 4: Storage Base Status & Debounce
    // CHARGING_BASE is the ONLY normal storage location.
    // Headsets in WORK_ZONE floor squares or outside zones count as NOT ON BASE.
    const notOnBaseHeadsets = workZoneHeadsetsNotOnBase;
    const physicalMisplacedCount = notOnBaseHeadsets.length + outsideZoneCount;
    const candidateMisplacedCount = workZoneCandidates.length + outsideZoneCount;

    let missingFromBaseCount = 0;
    let unlocatedCount = 0;
    let notOnBaseCount = physicalMisplacedCount;
    let countConflict = false;

    if (expectedStoredCount !== null && expectedStoredCount > 0) {
      missingFromBaseCount = Math.max(0, expectedStoredCount - onChargingBaseCount);
      unlocatedCount = Math.max(0, missingFromBaseCount - physicalMisplacedCount);
      notOnBaseCount = missingFromBaseCount;
      if (physicalMisplacedCount > notOnBaseCount) {
        countConflict = true;
      }
    }
    const candidateNotOnBaseCount = (expectedStoredCount !== null && expectedStoredCount > 0)
      ? missingFromBaseCount
      : candidateMisplacedCount;

    let currentBaseCandidate = "NOT_CONFIGURED";
    if (expectedStoredCount !== null && expectedStoredCount > 0) {
      if (
        onChargingBaseCount === expectedStoredCount &&
        notOnBaseCount === 0 &&
        unlocatedCount === 0 &&
        missingFromBaseCount === 0 &&
        !countConflict &&
        workZoneCandidates.length === 0
      ) {
        currentBaseCandidate = "ALL_ON_BASE";
      } else {
        currentBaseCandidate = "NOT_ALL_ON_BASE";
      }
    } else {
      if (notOnBaseCount > 0 || candidateNotOnBaseCount > 0) {
        currentBaseCandidate = "NOT_ALL_ON_BASE";
      } else {
        currentBaseCandidate = "NOT_CONFIGURED";
      }
    }

    const baseDebounceKey = `${cid}:base_status`;
    const prevBaseConfirmed = prevState?.storageStatus || ((prevState?.notOnBaseCount || 0) > 0 ? "NOT_ALL_ON_BASE" : "NOT_CONFIGURED");

    const baseDeb = this.zoneDebounce.get(baseDebounceKey) || {
      consecutiveCount: 0,
      candidateStatus: currentBaseCandidate,
      lastConfirmedStatus: prevBaseConfirmed,
    };

    if (baseDeb.candidateStatus === currentBaseCandidate) {
      baseDeb.consecutiveCount++;
    } else {
      baseDeb.candidateStatus = currentBaseCandidate;
      baseDeb.consecutiveCount = 1;
    }

    const prevBaseConfirmedStatus = baseDeb.lastConfirmedStatus;
    if (baseDeb.consecutiveCount >= this.debounceFrames) {
      baseDeb.lastConfirmedStatus = currentBaseCandidate;
    }
    this.zoneDebounce.set(baseDebounceKey, baseDeb);

    const storageStatus = baseDeb.lastConfirmedStatus;

    // After debounceFrames stable frames send alert: «⚠️ Не все VR-шлемы на базе»
    if (
      currentBaseCandidate === "NOT_ALL_ON_BASE" &&
      baseDeb.consecutiveCount >= this.debounceFrames &&
      (notOnBaseCount > 0 || missingFromBaseCount > 0)
    ) {
      if (
        baseDeb.consecutiveCount === this.debounceFrames ||
        notOnBaseCount !== prevState?.notOnBaseCount ||
        missingFromBaseCount !== prevState?.missingFromBaseCount
      ) {
        eventsToPublish.push({
          id: crypto.randomUUID(),
          cameraId: cid,
          roomId: effRoomId,
          presetName: currentPreset,
          type: "HEADSET_NOT_ON_BASE",
          headsetId: null,
          zoneId: null,
          description: `Не все VR-шлемы на базе! Всего не на базе: ${notOnBaseCount}, отсутствует: ${missingFromBaseCount}`,
          payload: {
            notOnBaseCount,
            notOnBaseHeadsets,
            outsideZoneCount,
            onChargingBaseCount,
            expectedHeadsetCount: resolvedExpectedCount,
            wornHeadsetCount,
            missingFromBaseCount,
            unlocatedCount,
            countConflict,
            preset: currentPreset,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Anti-spam check: send notification ONLY on initial confirmed transition OR on changed counts/sets after cooldown
      const signature = `${notOnBaseCount}:${missingFromBaseCount}:${[...notOnBaseHeadsets].sort().join(",")}`;
      const lastNotif = this.lastNotifiedState.get(cid);
      const setsChanged = !lastNotif || lastNotif.signature !== signature;
      const isInitialTransition =
        prevBaseConfirmedStatus !== "NOT_ALL_ON_BASE" && baseDeb.consecutiveCount === this.debounceFrames;

      const cooldownKey = `HEADSET_NOT_ON_BASE:${cid}:all`;
      const lastTime = this.lastNotificationTimes.get(cooldownKey) || 0;
      const cooldownElapsed = Date.now() - lastTime >= this.notificationCooldownMs;

      if (!suppressNotification && (isInitialTransition || (setsChanged && cooldownElapsed))) {
        this.lastNotificationTimes.set(cooldownKey, Date.now());
        this.lastNotifiedState.set(cid, {
          signature,
          notOnBaseCount,
          missingFromBaseCount,
          notOnBaseHeadsets: [...notOnBaseHeadsets],
          timestamp: Date.now(),
        });

        if (this.onNotification) {
          this.onNotification("HEADSET_NOT_ON_BASE", {
            cameraId: cid,
            cameraName,
            roomId: effRoomId,
            locationId: effLocationId,
            preset: currentPreset,
            notOnBaseCount,
            notOnBaseHeadsets,
            outsideZoneCount,
            onChargingBaseCount,
            expectedHeadsetCount: resolvedExpectedCount,
            wornHeadsetCount,
            missingFromBaseCount,
            unlocatedCount,
            countConflict,
            storageStatus: "NOT_ALL_ON_BASE",
            detectedHeadsets,
            imageBuffer,
            zones: activeZones,
            time: new Date().toLocaleTimeString("ru-RU"),
            text: `⚠️ Шлем обнаружен не на базе и не на человеке. Всего: ${notOnBaseCount} (в квадратах: ${notOnBaseHeadsets.join(", ") || "—"}, вне зон: ${outsideZoneCount}, не локализовано: ${unlocatedCount}), на базе: ${onChargingBaseCount}/${expectedStoredCount ?? "—"}, на людях: ${wornHeadsetCount}`,
          });
        }
      }
    }

    // After return of all headsets to charging table, send single recovery message: «✅ Все VR-шлемы на базе (CHARGING_BASE)»
    // Do not claim that *all* headsets returned to the base while one is
    // currently worn. It is a valid non-alert condition, but not a recovery.
    if (currentBaseCandidate === "ALL_ON_BASE" && wornHeadsetCount === 0 && baseDeb.consecutiveCount >= this.debounceFrames) {
      const wasViolated =
        (prevState?.notOnBaseCount || 0) > 0 ||
        (prevState?.outsideZoneCount || 0) > 0 ||
        (prevState?.missingFromBaseCount || 0) > 0 ||
        prevBaseConfirmedStatus === "NOT_ALL_ON_BASE" ||
        prevState?.storageStatus === "NOT_ALL_ON_BASE";

      if (wasViolated && baseDeb.consecutiveCount === this.debounceFrames) {
        const cooldownKey = `HEADSET_NOT_ON_BASE:${cid}:all`;
        this.lastNotificationTimes.delete(cooldownKey);
        this.lastNotifiedState.delete(cid);

        eventsToPublish.push({
          id: crypto.randomUUID(),
          cameraId: cid,
          roomId: effRoomId,
          presetName: currentPreset,
          type: "HEADSET_ALL_ON_BASE",
          headsetId: null,
          zoneId: null,
          description: "Все VR-шлемы на базе (CHARGING_BASE)",
          payload: {
            onChargingBaseCount,
            expectedHeadsetCount: resolvedExpectedCount,
            preset: currentPreset,
          },
          timestamp: new Date().toISOString(),
        });

        if (!suppressNotification && this.onNotification) {
          this.onNotification("HEADSET_ALL_ON_BASE", {
            cameraId: cid,
            cameraName,
            roomId: effRoomId,
            locationId: effLocationId,
            preset: currentPreset,
            onChargingBaseCount,
            expectedHeadsetCount: resolvedExpectedCount,
            missingFromBaseCount: 0,
            unlocatedCount: 0,
            storageStatus: "ALL_ON_BASE",
            detectedHeadsets,
            imageBuffer,
            zones: activeZones,
            time: new Date().toLocaleTimeString("ru-RU"),
            text: `✅ Все VR-шлемы на базе (CHARGING_BASE: ${onChargingBaseCount}/${resolvedExpectedCount}). Камера: ${cameraName}`,
          });
        }
      }
    }

    // Step 5: All Assigned Verification
    if (
      workZones.length > 0 &&
      emptyAssignedZones.length === 0 &&
      outsideZoneCount === 0
    ) {
      const wasViolated =
        (prevState?.emptyAssignedZones?.length || 0) > 0 ||
        (prevState?.outsideZoneCount || 0) > 0;

      if (wasViolated) {
        eventsToPublish.push({
          id: crypto.randomUUID(),
          cameraId: cid,
          roomId: effRoomId,
          presetName: currentPreset,
          type: "HEADSET_ALL_ASSIGNED",
          headsetId: null,
          zoneId: null,
          description: "Все VR-шлемы находятся в ожидаемых местах",
          payload: { totalWorkZones: workZones.length },
          timestamp: new Date().toISOString(),
        });
      }
    }

    const nextState = {
      cameraId: cid,
      currentPreset,
      chargingBaseCount,
      onChargingBaseCount,
      outsideZoneCount,
      notOnBaseCount,
      notOnBaseHeadsets,
      countConflict,
      expectedHeadsetCount: resolvedExpectedCount,
      wornHeadsetCount,
      missingFromBaseCount,
      unlocatedCount,
      storageStatus,
      totalDetected: detectedHeadsets.length,
      assignedZonesState,
      emptyAssignedZones,
      notVisibleZones: inactiveZones.map((z) => ({
        zoneId: z.id,
        name: z.name,
        preset: z.preset_name,
        headsetId: z.headset_id || null,
      })),
      confidence: 1.0,
      modelStatus: "READY",
      status: "READY",
      lastEventType:
        eventsToPublish.length > 0
          ? eventsToPublish[eventsToPublish.length - 1].type
          : prevState?.lastEventType || null,
      updatedAt: new Date().toISOString(),
    };

    this.states.set(cid, nextState);

    // Scoped Socket.IO emissions
    if (effLocationId) {
      this.emitScoped(`location:${effLocationId}`, "camera:headset:state", nextState);
    }
    this.emitScoped(`camera:${cid}`, "camera:headset:state", nextState);

    for (const ev of eventsToPublish) {
      if (effLocationId) {
        this.emitScoped(`location:${effLocationId}`, "camera:headset:event", ev);
      }
      this.emitScoped(`camera:${cid}`, "camera:headset:event", ev);
      this.persistEvent(ev).catch(() => {});
    }

    this.persistState(nextState).catch(() => {});

    return nextState;
  }

  checkAndSendNotification(type, data) {
    const key = `${type}:${data.cameraId}:${data.headsetId || "all"}`;
    const now = Date.now();
    const lastTime = this.lastNotificationTimes.get(key) || 0;
    if (now - lastTime < this.notificationCooldownMs) {
      return;
    }
    this.lastNotificationTimes.set(key, now);
    if (this.onNotification) {
      this.onNotification(type, data);
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

  async persistState(state) {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO camera_headset_states(
         camera_id, current_preset, charging_base_count, outside_zone_count,
         not_on_base_count, not_on_base_headsets,
         expected_headset_count, missing_from_base_count, unlocated_count,
         total_detected, assigned_zones_state, empty_assigned_zones, not_visible_zones,
         confidence, model_status, last_event_type, updated_at
       ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (camera_id) DO UPDATE SET
         current_preset = EXCLUDED.current_preset,
         charging_base_count = EXCLUDED.charging_base_count,
         outside_zone_count = EXCLUDED.outside_zone_count,
         not_on_base_count = EXCLUDED.not_on_base_count,
         not_on_base_headsets = EXCLUDED.not_on_base_headsets,
         expected_headset_count = EXCLUDED.expected_headset_count,
         missing_from_base_count = EXCLUDED.missing_from_base_count,
         unlocated_count = EXCLUDED.unlocated_count,
         total_detected = EXCLUDED.total_detected,
         assigned_zones_state = EXCLUDED.assigned_zones_state,
         empty_assigned_zones = EXCLUDED.empty_assigned_zones,
         not_visible_zones = EXCLUDED.not_visible_zones,
         confidence = EXCLUDED.confidence,
         model_status = EXCLUDED.model_status,
         last_event_type = EXCLUDED.last_event_type,
         updated_at = EXCLUDED.updated_at`,
      [
        state.cameraId,
        state.currentPreset,
        state.chargingBaseCount ?? state.onChargingBaseCount ?? 0,
        state.outsideZoneCount ?? 0,
        state.notOnBaseCount ?? 0,
        JSON.stringify(state.notOnBaseHeadsets || []),
        state.expectedHeadsetCount ?? null,
        state.missingFromBaseCount ?? 0,
        state.unlocatedCount ?? 0,
        state.totalDetected,
        JSON.stringify(state.assignedZonesState || {}),
        JSON.stringify(state.emptyAssignedZones || []),
        JSON.stringify(state.notVisibleZones || []),
        state.confidence || 1.0,
        state.modelStatus || "READY",
        state.lastEventType || null,
        state.updatedAt,
      ]
    );
  }

  async persistEvent(ev) {
    if (!this.db) return;
    await this.db.query(
      `INSERT INTO camera_headset_events(
         id, camera_id, room_id, preset_name, event_type, headset_id, zone_id, payload, timestamp
       ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ev.id,
        ev.cameraId,
        ev.roomId || null,
        ev.presetName || null,
        ev.type,
        ev.headsetId || null,
        ev.zoneId || null,
        JSON.stringify(ev.payload || {}),
        ev.timestamp,
      ]
    );
  }

  /**
   * Aggregates and deduplicates VR headset states across all cameras in a room.
   */
  async getRoomHeadsetState(roomId) {
    const expectedHeadsetCount = this.getRoomExpectedHeadsets(roomId) ?? null;
    if (!this.db) {
      return {
        roomId,
        headsets: {},
        chargingBaseCount: 0,
        onChargingBaseCount: 0,
        outsideZoneCount: 0,
        notOnBaseCount: 0,
        notOnBaseHeadsets: [],
        expectedHeadsetCount,
        missingFromBaseCount: expectedHeadsetCount ? expectedHeadsetCount : 0,
        unlocatedCount: expectedHeadsetCount ? expectedHeadsetCount : 0,
        storageStatus: expectedHeadsetCount ? "NOT_ALL_ON_BASE" : "NOT_CONFIGURED",
        timestamp: new Date().toISOString(),
      };
    }

    const { rows: cameras } = await this.db.query(
      "SELECT id, name FROM cameras WHERE room_id = $1 AND headset_tracking_enabled = true",
      [roomId]
    );

    if (!cameras || cameras.length === 0) {
      return {
        roomId,
        headsets: {},
        chargingBaseCount: 0,
        onChargingBaseCount: 0,
        outsideZoneCount: 0,
        notOnBaseCount: 0,
        notOnBaseHeadsets: [],
        countConflict: false,
        expectedHeadsetCount,
        missingFromBaseCount: expectedHeadsetCount ? expectedHeadsetCount : 0,
        unlocatedCount: expectedHeadsetCount ? expectedHeadsetCount : 0,
        storageStatus: "NOT_CONFIGURED",
        timestamp: new Date().toISOString(),
      };
    }

    const aggregatedHeadsets = {};
    const notOnBaseHeadsetsSet = new Set();
    let maxOutside = 0;

    // Deduplicate physical charging bases across cameras
    const baseStationCounts = new Map();

    for (const cam of cameras) {
      const state = this.getState(cam.id);
      maxOutside = Math.max(maxOutside, Number(state.outsideZoneCount || 0));
      if (Array.isArray(state.notOnBaseHeadsets)) {
        for (const h of state.notOnBaseHeadsets) {
          notOnBaseHeadsetsSet.add(h);
        }
      }

      const zones = this.getZones(cam.id, state.currentPreset);
      const chargingBases = zones.filter((z) => z.zone_type === "CHARGING_BASE");

      if (chargingBases.length > 0) {
        for (const bz of chargingBases) {
          const baseId = bz.base_station_id || bz.baseStationId || "default";
          const isCanonical = Boolean(bz.is_canonical_base ?? bz.isCanonicalBase ?? false);
          const zoneEntry = state.assignedZonesState?.[bz.id];
          const bzCount = zoneEntry?.headsetCount !== undefined
            ? Number(zoneEntry.headsetCount)
            : (chargingBases.length === 1 ? Number(state.onChargingBaseCount ?? state.chargingBaseCount ?? 0) : 0);

          const existing = baseStationCounts.get(baseId) || { canonical: null, maxCount: 0 };
          if (isCanonical) {
            existing.canonical = bzCount;
          }
          existing.maxCount = Math.max(existing.maxCount, bzCount);
          baseStationCounts.set(baseId, existing);
        }
      } else {
        const camBaseCount = Number(state.onChargingBaseCount ?? state.chargingBaseCount ?? 0);
        if (camBaseCount > 0) {
          const existing = baseStationCounts.get("default") || { canonical: null, maxCount: 0 };
          existing.maxCount = Math.max(existing.maxCount, camBaseCount);
          baseStationCounts.set("default", existing);
        }
      }

      const zoneEntries = Object.values(state.assignedZonesState || {});
      for (const entry of zoneEntries) {
        if (!entry.headsetId) continue;
        const hid = entry.headsetId;
        const currentAgg = aggregatedHeadsets[hid];

        if (!currentAgg) {
          aggregatedHeadsets[hid] = {
            headsetId: hid,
            status: entry.status,
            zoneName: entry.name,
            cameraId: cam.id,
            cameraName: cam.name,
            confidence: entry.confidence,
          };
        } else {
          // Rule 8: Deduplication priority: OCCUPIED > UNKNOWN > EMPTY > NOT_VISIBLE
          if (entry.status === "OCCUPIED") {
            aggregatedHeadsets[hid] = {
              headsetId: hid,
              status: "OCCUPIED",
              zoneName: entry.name,
              cameraId: cam.id,
              cameraName: cam.name,
              confidence: entry.confidence,
            };
          } else if (entry.status === "UNKNOWN" && currentAgg.status !== "OCCUPIED") {
            aggregatedHeadsets[hid].status = "UNKNOWN";
          } else if (
            entry.status === "EMPTY" &&
            currentAgg.status === "NOT_VISIBLE"
          ) {
            aggregatedHeadsets[hid] = {
              headsetId: hid,
              status: "EMPTY",
              zoneName: entry.name,
              cameraId: cam.id,
              cameraName: cam.name,
              confidence: entry.confidence,
            };
          }
        }
      }
    }

    let totalChargingBase = 0;
    if (baseStationCounts.size > 0) {
      for (const [, info] of baseStationCounts) {
        totalChargingBase += info.canonical !== null ? info.canonical : info.maxCount;
      }
    }

    const notOnBaseHeadsets = Array.from(notOnBaseHeadsetsSet);
    const physicalMisplacedCount = notOnBaseHeadsets.length + maxOutside;

    let missingFromBaseCount = 0;
    let unlocatedCount = 0;
    let notOnBaseCount = physicalMisplacedCount;
    let countConflict = false;
    let storageStatus = "NOT_CONFIGURED";
    if (expectedHeadsetCount !== null && expectedHeadsetCount !== undefined && expectedHeadsetCount > 0) {
      missingFromBaseCount = Math.max(0, expectedHeadsetCount - totalChargingBase);
      unlocatedCount = Math.max(0, missingFromBaseCount - physicalMisplacedCount);
      notOnBaseCount = missingFromBaseCount;
      if (physicalMisplacedCount > notOnBaseCount) {
        countConflict = true;
      }
      storageStatus = (totalChargingBase === expectedHeadsetCount && missingFromBaseCount === 0 && physicalMisplacedCount === 0)
        ? "ALL_ON_BASE"
        : "NOT_ALL_ON_BASE";
    }

    return {
      roomId,
      headsets: aggregatedHeadsets,
      chargingBaseCount: totalChargingBase,
      onChargingBaseCount: totalChargingBase,
      outsideZoneCount: maxOutside,
      notOnBaseHeadsets,
      notOnBaseCount,
      countConflict,
      expectedHeadsetCount,
      missingFromBaseCount,
      unlocatedCount,
      storageStatus,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sweeps all configured presets for all room cameras, evaluates headset state at each preset,
   * deduplicates observations directly across presets and cameras, guarantees returning each camera
   * to its initial preset, and picks the exact problematic preset observation frame for alerts.
   */
  async inspectRoomHeadsets(roomId, options = {}) {
    const cameraVisionController = options.cameraVisionController || this.visionController;
    const visionService = options.visionService || this.visionService;
    const frameProvider = options.frameProvider || this.frameProvider;

    if (!this.db) throw new Error("Database required for inspection");

    // Sweep only cameras with headset_tracking_enabled = true (strict: no fallback to disabled cameras)
    const { rows: cameras } = await this.db.query(
      "SELECT * FROM cameras WHERE room_id = $1 AND headset_tracking_enabled = true ORDER BY (provider = 'TUYA') DESC, created_at ASC",
      [roomId]
    );

    if (!cameras || cameras.length === 0) {
      return {
        roomId,
        summary: "В комнате не найдена активная камера с поддержкой VR контроля (headset_tracking_enabled = true).",
        headsets: {},
        observations: [],
        storageStatus: "NOT_CONFIGURED",
        expectedHeadsetCount: this.getRoomExpectedHeadsets(roomId) ?? null,
        chargingBaseCount: 0,
        onChargingBaseCount: 0,
        outsideZoneCount: 0,
        notOnBaseCount: 0,
        notOnBaseHeadsets: [],
        missingFromBaseCount: 0,
        unlocatedCount: 0,
        inspectedAt: new Date().toISOString(),
      };
    }

    // Check operator manual PTZ lockout for ALL cameras before moving any
    for (const cam of cameras) {
      if (cameraVisionController?.isManualPtzLocked && cameraVisionController.isManualPtzLocked(cam.id)) {
        const err = new Error(`Камера ${cam.name || cam.id} заблокирована ручным управлением оператора (15 сек)`);
        err.code = "MANUAL_PTZ_ACTIVE";
        throw err;
      }
    }

    // Remember initial preset for each camera to guarantee returning in finally
    const initialPresets = new Map();
    for (const cam of cameras) {
      const initP = cameraVisionController?.getCurrentPreset
        ? cameraVisionController.getCurrentPreset(cam.id)
        : this.currentPresets.get(cam.id) || "Center";
      initialPresets.set(cam.id, initP);
    }

    const allObservations = [];

    try {
      for (const camera of cameras) {
        if (cameraVisionController?.isManualPtzLocked && cameraVisionController.isManualPtzLocked(camera.id)) {
          const err = new Error(`Камера ${camera.name || camera.id} заблокирована ручным управлением оператора (15 сек)`);
          err.code = "MANUAL_PTZ_ACTIVE";
          throw err;
        }

        const presets = (cameraVisionController?.getPresets
          ? await cameraVisionController.getPresets(camera.id)
          : []) || [];
        const inspectionPresets = presets.length > 0 ? presets.slice(0, 5) : [{ name: "default" }];

        for (const p of inspectionPresets) {
          const presetName = p.name;
          if (cameraVisionController?.isManualPtzLocked && cameraVisionController.isManualPtzLocked(camera.id)) {
            const err = new Error(`Камера ${camera.name || camera.id} заблокирована ручным управлением оператора (15 сек)`);
            err.code = "MANUAL_PTZ_ACTIVE";
            throw err;
          }

          let moveSucceeded = true;
          try {
            if (cameraVisionController?.lookAtPreset) {
              await cameraVisionController.lookAtPreset(camera.id, presetName);
            }
          } catch (mErr) {
            moveSucceeded = false;
            console.warn(`Inspect camera ${camera.id} preset ${presetName} movement error:`, mErr.message);
          }

          if (!moveSucceeded) {
            allObservations.push({
              cameraId: camera.id,
              cameraName: camera.name,
              preset: presetName,
              status: "PRESET_UNAVAILABLE",
              imageBuffer: null,
              detectedCount: 0,
              chargingBaseCount: 0,
              onChargingBaseCount: 0,
              outsideZoneCount: 0,
              notOnBaseCount: 0,
              notOnBaseHeadsets: [],
              assignedZones: {},
              detectedHeadsets: [],
              zones: this.getZones(camera.id, presetName),
              timestamp: new Date().toISOString(),
              error: "PRESET_UNAVAILABLE",
            });
            continue;
          }

          const settleDelay = cameraVisionController?.settleDelayMs ?? 1200;
          if (settleDelay > 0) {
            await new Promise((r) => setTimeout(r, settleDelay));
          }

          // Cutoff timestamp strictly after movement and settleDelay
          const cutoffTime = Date.now();

          // Fresh post-PTZ frame verification: poll getLatestFrame with check timestamp > cutoffTime
          // Strictly reject frames captured during movement or missing timestamps
          const pollTimeoutMs = settleDelay <= 10 ? 50 : Math.max(1500, settleDelay + 500);
          const pollStart = Date.now();
          let freshFrame = null;

          while (Date.now() - pollStart < pollTimeoutMs) {
            if (!frameProvider && !visionService) break;

            let frameItem = frameProvider?.getLatestFrame ? frameProvider.getLatestFrame(camera.id) : null;
            if (!frameItem?.buffer && visionService?.getLatestFrame) {
              frameItem = await visionService.getLatestFrame(camera.id);
              if (frameItem?.buffer && frameProvider?.pushFrame) {
                frameProvider.pushFrame(camera.id, frameItem.buffer, frameItem.mimeType || "image/jpeg", frameItem.timestamp);
              }
            }

            if (frameItem?.buffer) {
              const fTime = typeof frameItem.timestamp === "number"
                ? frameItem.timestamp
                : (frameItem.timestamp ? new Date(frameItem.timestamp).getTime() : NaN);

              // Require valid timestamp and strictly > cutoffTime
              if (frameItem.timestamp && !isNaN(fTime) && fTime > cutoffTime) {
                freshFrame = frameItem;
                break;
              }
            }

            await new Promise((r) => setTimeout(r, settleDelay <= 10 ? 10 : 100));
          }

          const activeZones = this.getZones(camera.id, presetName);

          if (!freshFrame?.buffer) {
            // Stale or missing frame timed out: flag observation as FRAME_UNAVAILABLE
            // Do NOT mutate state, do NOT trigger false alarms
            allObservations.push({
              cameraId: camera.id,
              cameraName: camera.name,
              preset: presetName,
              status: "FRAME_UNAVAILABLE",
              imageBuffer: null,
              detectedCount: 0,
              chargingBaseCount: 0,
              onChargingBaseCount: 0,
              outsideZoneCount: 0,
              notOnBaseCount: 0,
              notOnBaseHeadsets: [],
              assignedZones: {},
              detectedHeadsets: [],
              zones: activeZones,
              timestamp: new Date().toISOString(),
            });
            continue;
          }

          let detectedHeadsets = [];
          let detStatus = "READY";
          if (visionService?.detectHeadsets) {
            const detRes = await visionService.detectHeadsets({
              cameraId: camera.id,
              imageBuffer: freshFrame.buffer,
            });
            if (detRes?.status === "MODEL_UNAVAILABLE") {
              detStatus = "MODEL_UNAVAILABLE";
            }
            detectedHeadsets = Array.isArray(detRes?.headsets) ? detRes.headsets : [];
          }

          const stateAtPreset = await this.processDetections({
            cameraId: camera.id,
            preset: presetName,
            detectedHeadsets,
            status: detStatus,
            modelStatus: detStatus,
            roomId,
            locationId: camera.location_id,
            cameraName: camera.name,
            imageBuffer: freshFrame.buffer,
            suppressNotification: true,
          });

          if (detStatus === "MODEL_UNAVAILABLE") {
            throw new Error("MODEL_UNAVAILABLE: VR headset model weights missing or failed to load");
          }

          allObservations.push({
            cameraId: camera.id,
            cameraName: camera.name,
            preset: presetName,
            status: "READY",
            detectedCount: detectedHeadsets.length,
            chargingBaseCount: stateAtPreset.chargingBaseCount,
            onChargingBaseCount: stateAtPreset.onChargingBaseCount,
            outsideZoneCount: stateAtPreset.outsideZoneCount,
            notOnBaseCount: stateAtPreset.notOnBaseCount,
            notOnBaseHeadsets: stateAtPreset.notOnBaseHeadsets,
            assignedZones: stateAtPreset.assignedZonesState,
            detectedHeadsets,
            zones: activeZones,
            imageBuffer: freshFrame.buffer,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } finally {
      // Guarantee each camera is returned to its initial preset
      for (const cam of cameras) {
        const initP = initialPresets.get(cam.id);
        if (initP && cameraVisionController?.lookAtPreset) {
          try {
            await cameraVisionController.lookAtPreset(cam.id, initP);
          } catch (rErr) {
            console.warn(`Failed returning camera ${cam.id} to initial preset ${initP}:`, rErr.message);
          }
        }
      }
    }

    // 1. Gather all required canonical base stations for the room
    const canonicalBaseMap = new Map();
    const physicalBaseIds = new Set();
    for (const cam of cameras) {
      const allCamZones = this.cameraZones.get(String(cam.id)) || [];
      for (const z of allCamZones) {
        if (z.zone_type === "CHARGING_BASE") {
          const baseId = z.base_station_id || z.baseStationId || "default";
          physicalBaseIds.add(baseId);
          if (z.is_canonical_base || z.isCanonicalBase) {
            canonicalBaseMap.set(baseId, {
              baseId,
              cameraId: cam.id,
              cameraName: cam.name,
              presetName: z.preset_name || "default",
              zoneId: z.id,
            });
          }
        }
      }
    }
    if (this.db) {
      try {
        const { rows: dbBases } = await this.db.query(
          `SELECT z.base_station_id, z.camera_id, z.preset_name, z.id, z.is_canonical_base, c.name as camera_name
           FROM camera_headset_zones z
           JOIN cameras c ON c.id = z.camera_id
           WHERE (z.room_id = $1 OR c.room_id = $1)
             AND z.zone_type = 'CHARGING_BASE'
             AND z.enabled = true`,
          [roomId]
        );
        for (const row of dbBases) {
          const baseId = row.base_station_id || "default";
          physicalBaseIds.add(baseId);
          if (row.is_canonical_base && !canonicalBaseMap.has(baseId)) {
            canonicalBaseMap.set(baseId, {
              baseId,
              cameraId: row.camera_id,
              cameraName: row.camera_name,
              presetName: row.preset_name || "default",
              zoneId: row.id,
            });
          }
        }
      } catch {
        // Fall back to memory zones if DB query fails or mock DB
      }
    }

    // Identify any physical bases that lack a canonical CHARGING_BASE zone.
    // Strictly forbid arbitrary fallback: non-canonical zones are NEVER treated as canonical!
    const missingCanonicalBases = Array.from(physicalBaseIds).filter(
      (bId) => !canonicalBaseMap.has(bId)
    );

    const validObservations = allObservations.filter(
      (o) => o.status !== "FRAME_UNAVAILABLE" && o.status !== "PRESET_UNAVAILABLE"
    );
    const expectedHeadsetCount = this.getRoomExpectedHeadsets(roomId) ?? null;

    // 2. Track which canonical base stations were observed in valid observations
    const observedBaseIds = new Set();
    for (const obs of validObservations) {
      const baseZones = (obs.zones || []).filter((z) => z.zone_type === "CHARGING_BASE");
      for (const bz of baseZones) {
        const baseId = bz.base_station_id || bz.baseStationId || "default";
        const isCanonical = Boolean(bz.is_canonical_base ?? bz.isCanonicalBase ?? false);
        const reqInfo = canonicalBaseMap.get(baseId);
        if (isCanonical || !reqInfo || reqInfo.zoneId === bz.id || reqInfo.cameraId === obs.cameraId) {
          observedBaseIds.add(baseId);
        }
      }
    }

    const failedPresets = allObservations
      .filter((o) => o.status === "FRAME_UNAVAILABLE" || o.status === "PRESET_UNAVAILABLE")
      .map((o) => ({
        cameraId: o.cameraId,
        cameraName: o.cameraName,
        preset: o.preset,
        reason: o.status,
      }));

    const failedCameras = Array.from(new Set(failedPresets.map((f) => f.cameraId))).map((cid) => {
      const f = failedPresets.find((p) => p.cameraId === cid);
      return { cameraId: cid, cameraName: f?.cameraName };
    });

    const requiredCanonicalBases = Array.from(canonicalBaseMap.keys());
    const failedBases = requiredCanonicalBases.filter((bId) => !observedBaseIds.has(bId));

    let coverage = "COMPLETE";
    if (validObservations.length === 0) {
      coverage = "FAILED";
    } else if (expectedHeadsetCount === null || expectedHeadsetCount === undefined || expectedHeadsetCount <= 0) {
      // Without expectedHeadsetCount, never report COMPLETE
      coverage = "NOT_CONFIGURED";
    } else if (canonicalBaseMap.size === 0 || missingCanonicalBases.length > 0) {
      // Missing canonical base for physical base is invalid configuration, never report COMPLETE
      coverage = "CONFIGURATION_INVALID";
    } else if (failedBases.length > 0 || failedPresets.length > 0) {
      coverage = "PARTIAL";
    }

    if (coverage === "FAILED") {
      const firstCam = cameras[0];
      const hasPresetUnavailable = allObservations.some((o) => o.status === "PRESET_UNAVAILABLE");
      return {
        roomId,
        cameraId: firstCam?.id,
        cameraName: firstCam?.name,
        initialPreset: firstCam ? (initialPresets.get(firstCam.id) || "Center") : "Center",
        summary: hasPresetUnavailable
          ? "Осмотр VR-шлемов не удался: ошибка позиционирования PTZ-камер (PRESET_UNAVAILABLE)."
          : "Осмотр VR-шлемов не удался: свежие кадры с камер недоступны (FRAME_UNAVAILABLE).",
        headsets: {},
        observations: allObservations,
        storageStatus: hasPresetUnavailable ? "PRESET_UNAVAILABLE" : "FRAME_UNAVAILABLE",
        coverage: "FAILED",
        failedCameras,
        failedPresets,
        failedBases,
        expectedHeadsetCount,
        chargingBaseCount: 0,
        onChargingBaseCount: 0,
        outsideZoneCount: 0,
        notOnBaseCount: 0,
        notOnBaseHeadsets: [],
        countConflict: false,
        missingFromBaseCount: 0,
        unlocatedCount: 0,
        inspectedAt: new Date().toISOString(),
      };
    }

    // Direct aggregation across entire inspection (all valid observations, presets, cameras)
    const aggregatedHeadsets = {};
    const notOnBaseHeadsetsSet = new Set();
    for (const obs of validObservations) {
      const zoneEntries = Object.values(obs.assignedZones || {});
      for (const entry of zoneEntries) {
        if (!entry.headsetId) continue;
        const hid = entry.headsetId;
        const currentAgg = aggregatedHeadsets[hid];
        if (!currentAgg) {
          aggregatedHeadsets[hid] = {
            headsetId: hid,
            status: entry.status,
            zoneName: entry.name,
            cameraId: obs.cameraId,
            cameraName: obs.cameraName,
            confidence: entry.confidence,
          };
        } else {
          if (entry.status === "OCCUPIED") {
            aggregatedHeadsets[hid] = {
              headsetId: hid,
              status: "OCCUPIED",
              zoneName: entry.name,
              cameraId: obs.cameraId,
              cameraName: obs.cameraName,
              confidence: entry.confidence,
            };
          } else if (entry.status === "UNKNOWN" && currentAgg.status !== "OCCUPIED") {
            aggregatedHeadsets[hid].status = "UNKNOWN";
          } else if (entry.status === "EMPTY" && currentAgg.status === "NOT_VISIBLE") {
            aggregatedHeadsets[hid] = {
              headsetId: hid,
              status: "EMPTY",
              zoneName: entry.name,
              cameraId: obs.cameraId,
              cameraName: obs.cameraName,
              confidence: entry.confidence,
            };
          }
        }
      }
    }

    for (const [hid, info] of Object.entries(aggregatedHeadsets)) {
      if (info.status === "OCCUPIED") {
        notOnBaseHeadsetsSet.add(hid);
      }
    }
    const notOnBaseHeadsets = Array.from(notOnBaseHeadsetsSet);

    // Deduplicate physical charging bases across observations and cameras
    const baseStationCounts = new Map();
    for (const obs of validObservations) {
      const baseZones = (obs.zones || []).filter((z) => z.zone_type === "CHARGING_BASE");
      if (baseZones.length > 0) {
        for (const bz of baseZones) {
          const baseId = bz.base_station_id || bz.baseStationId || "default";
          const isCanonical = Boolean(bz.is_canonical_base ?? bz.isCanonicalBase ?? false);
          const zoneEntry = obs.assignedZones?.[bz.id];
          const bzCount = zoneEntry?.headsetCount !== undefined
            ? Number(zoneEntry.headsetCount)
            : (baseZones.length === 1 ? Number(obs.onChargingBaseCount ?? obs.chargingBaseCount ?? 0) : 0);

          const existing = baseStationCounts.get(baseId) || { canonical: null, maxCount: 0 };
          if (isCanonical) {
            existing.canonical = Math.max(existing.canonical ?? 0, bzCount);
          }
          existing.maxCount = Math.max(existing.maxCount, bzCount);
          baseStationCounts.set(baseId, existing);
        }
      } else {
        const countInObs = Number(obs.onChargingBaseCount ?? obs.chargingBaseCount ?? 0);
        if (countInObs > 0) {
          const existing = baseStationCounts.get("default") || { canonical: null, maxCount: 0 };
          existing.maxCount = Math.max(existing.maxCount, countInObs);
          baseStationCounts.set("default", existing);
        }
      }
    }

    let totalChargingBase = 0;
    if (baseStationCounts.size > 0) {
      for (const [, info] of baseStationCounts) {
        totalChargingBase += info.canonical !== null ? info.canonical : info.maxCount;
      }
    }

    const totalOutside = validObservations.length > 0
      ? Math.max(0, ...validObservations.map((o) => o.outsideZoneCount || 0))
      : 0;

    const physicalMisplacedCount = notOnBaseHeadsets.length + totalOutside;
    let missingFromBaseCount = 0;
    let unlocatedCount = 0;
    let notOnBaseCount = physicalMisplacedCount;
    let countConflict = false;
    let storageStatus = "NOT_CONFIGURED";
    if (expectedHeadsetCount !== null && expectedHeadsetCount !== undefined && expectedHeadsetCount > 0) {
      missingFromBaseCount = Math.max(0, expectedHeadsetCount - totalChargingBase);
      unlocatedCount = Math.max(0, missingFromBaseCount - physicalMisplacedCount);
      notOnBaseCount = missingFromBaseCount;
      if (physicalMisplacedCount > notOnBaseCount) {
        countConflict = true;
      }
      storageStatus = (totalChargingBase === expectedHeadsetCount && missingFromBaseCount === 0 && physicalMisplacedCount === 0)
        ? "ALL_ON_BASE"
        : "NOT_ALL_ON_BASE";
    }

    // Select the specific observation where the violation occurred
    // If violation is missing/unlocated headsets from base, alert photo MUST be taken from
    // the canonical CHARGING_BASE observation of the base station, not an arbitrary floor preset,
    // and only from a fresh post-PTZ frame.
    let problemObs = null;
    if (physicalMisplacedCount > 0) {
      problemObs = validObservations.find(
        (o) =>
          o.imageBuffer &&
          (o.outsideZoneCount > 0 || (Array.isArray(o.notOnBaseHeadsets) && o.notOnBaseHeadsets.length > 0))
      );
    }

    if (!problemObs && (missingFromBaseCount > 0 || unlocatedCount > 0)) {
      problemObs =
        validObservations.find(
          (o) =>
            o.imageBuffer &&
            (o.zones || []).some((z) => z.zone_type === "CHARGING_BASE" && (z.is_canonical_base || z.isCanonicalBase))
        ) ||
        validObservations.find(
          (o) =>
            o.imageBuffer &&
            (o.zones || []).some((z) => z.zone_type === "CHARGING_BASE")
        );
    }

    if (!problemObs) {
      problemObs = validObservations.find((o) => o.imageBuffer) || validObservations[0] || null;
    }

    const alertCam = cameras.find((c) => c.id === problemObs?.cameraId) || cameras[0];
    const alertPreset = problemObs?.preset || initialPresets.get(alertCam.id) || "Center";

    // If coverage is PARTIAL, do NOT mutate roomLastConfirmedStatus, do NOT send notifications,
    // and return storageStatus = "INSPECTION_INCOMPLETE"
    if (coverage === "PARTIAL") {
      return {
        roomId,
        cameraId: alertCam.id,
        cameraName: alertCam.name,
        initialPreset: initialPresets.get(alertCam.id) || "Center",
        observations: allObservations,
        headsets: aggregatedHeadsets,
        chargingBaseCount: totalChargingBase,
        onChargingBaseCount: totalChargingBase,
        outsideZoneCount: totalOutside,
        notOnBaseHeadsets,
        notOnBaseCount,
        countConflict,
        expectedHeadsetCount,
        missingFromBaseCount,
        unlocatedCount,
        storageStatus: "INSPECTION_INCOMPLETE",
        coverage: "PARTIAL",
        failedCameras,
        failedPresets,
        failedBases,
        summary: `Осмотр VR-шлемов не полон (coverage: PARTIAL): не все ракурсы или базы успешно осмотрены (недоступно баз: ${failedBases.join(", ") || "—"}, сбоев пресетов: ${failedPresets.length}). Статус комнаты сохранён, тревога не отправлена.`,
        inspectedAt: new Date().toISOString(),
      };
    }

    // If coverage is CONFIGURATION_INVALID, do NOT mutate roomLastConfirmedStatus, do NOT send notifications,
    // and return storageStatus = "CONFIGURATION_INVALID"
    if (coverage === "CONFIGURATION_INVALID") {
      return {
        roomId,
        cameraId: alertCam.id,
        cameraName: alertCam.name,
        initialPreset: initialPresets.get(alertCam.id) || "Center",
        observations: allObservations,
        headsets: aggregatedHeadsets,
        chargingBaseCount: totalChargingBase,
        onChargingBaseCount: totalChargingBase,
        outsideZoneCount: totalOutside,
        notOnBaseHeadsets,
        notOnBaseCount,
        countConflict,
        expectedHeadsetCount,
        missingFromBaseCount,
        unlocatedCount,
        storageStatus: "CONFIGURATION_INVALID",
        coverage: "CONFIGURATION_INVALID",
        failedCameras,
        failedPresets,
        failedBases: missingCanonicalBases,
        summary: `Некорректная конфигурация (CONFIGURATION_INVALID): для каждой физической базы требуется каноническая зона CHARGING_BASE (is_canonical_base: true). Отсутствуют канонические зоны: ${missingCanonicalBases.join(", ") || "базы не настроены"}. Осмотр не может быть признан COMPLETE.`,
        inspectedAt: new Date().toISOString(),
      };
    }

    const prevRoomStatus = this.roomLastConfirmedStatus.get(roomId) || "NOT_CONFIGURED";

    if (storageStatus === "NOT_ALL_ON_BASE" || notOnBaseCount > 0) {
      const signature = `${roomId}:${notOnBaseCount}:${missingFromBaseCount}:${[...notOnBaseHeadsets].sort().join(",")}`;
      const lastSignature = this.roomLastNotifiedSignature.get(roomId);
      const isInitialTransition = prevRoomStatus !== "NOT_ALL_ON_BASE";
      const signatureChanged = signature !== lastSignature;

      const cooldownKey = `HEADSET_NOT_ON_BASE:room:${roomId}`;
      const lastTime = this.lastNotificationTimes.get(cooldownKey) || 0;
      const cooldownElapsed = Date.now() - lastTime >= this.notificationCooldownMs;

      if (isInitialTransition || (signatureChanged && cooldownElapsed)) {
        this.lastNotificationTimes.set(cooldownKey, Date.now());
        this.roomLastNotifiedSignature.set(roomId, signature);
        this.roomLastConfirmedStatus.set(roomId, "NOT_ALL_ON_BASE");

        const evId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
        this.persistEvent({
          id: evId,
          cameraId: alertCam.id,
          roomId,
          presetName: alertPreset,
          type: "HEADSET_NOT_ON_BASE",
          headsetId: null,
          zoneId: null,
          payload: {
            signature,
            storageStatus: "NOT_ALL_ON_BASE",
            notOnBaseCount,
            missingFromBaseCount,
            unlocatedCount,
            notOnBaseHeadsets,
            outsideZoneCount: totalOutside,
            onChargingBaseCount: totalChargingBase,
            expectedHeadsetCount,
          },
          timestamp: new Date().toISOString(),
        }).catch(() => {});

        this.checkAndSendNotification("HEADSET_NOT_ON_BASE", {
          cameraId: alertCam.id,
          cameraName: alertCam.name,
          roomId,
          locationId: alertCam.location_id,
          preset: alertPreset,
          notOnBaseCount,
          notOnBaseHeadsets,
          outsideZoneCount: totalOutside,
          onChargingBaseCount: totalChargingBase,
          expectedHeadsetCount,
          missingFromBaseCount,
          unlocatedCount,
          countConflict,
          storageStatus: "NOT_ALL_ON_BASE",
          imageBuffer: problemObs?.imageBuffer || null,
          detectedHeadsets: problemObs?.detectedHeadsets || [],
          zones: problemObs?.zones || [],
          time: new Date().toLocaleTimeString("ru-RU"),
          text: `⚠️ Не все VR-шлемы на базе (PTZ-осмотр). Всего не на базе: ${notOnBaseCount} (в квадратах: ${notOnBaseHeadsets.join(", ") || "—"}, вне зон: ${totalOutside}, не локализовано: ${unlocatedCount}), на базе: ${totalChargingBase}/${expectedHeadsetCount ?? "—"}`,
        });
      }
    } else if (storageStatus === "ALL_ON_BASE") {
      // Prevent sending ALL_ON_BASE repeatedly after cooldown when no violation occurred.
      // Track roomLastConfirmedStatus and notify ALL_ON_BASE ONLY on confirmed transition from NOT_ALL_ON_BASE.
      if (prevRoomStatus === "NOT_ALL_ON_BASE") {
        this.roomLastConfirmedStatus.set(roomId, "ALL_ON_BASE");
        this.roomLastNotifiedSignature.delete(roomId);
        this.lastNotificationTimes.delete(`HEADSET_NOT_ON_BASE:room:${roomId}`);

        const evId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
        this.persistEvent({
          id: evId,
          cameraId: alertCam.id,
          roomId,
          presetName: alertPreset,
          type: "HEADSET_ALL_ON_BASE",
          headsetId: null,
          zoneId: null,
          payload: {
            signature: "",
            storageStatus: "ALL_ON_BASE",
            onChargingBaseCount: totalChargingBase,
            expectedHeadsetCount,
          },
          timestamp: new Date().toISOString(),
        }).catch(() => {});

        this.checkAndSendNotification("HEADSET_ALL_ON_BASE", {
          cameraId: alertCam.id,
          cameraName: alertCam.name,
          roomId,
          locationId: alertCam.location_id,
          preset: alertPreset,
          onChargingBaseCount: totalChargingBase,
          expectedHeadsetCount,
          missingFromBaseCount: 0,
          unlocatedCount: 0,
          countConflict: false,
          storageStatus: "ALL_ON_BASE",
          imageBuffer: problemObs?.imageBuffer || null,
          detectedHeadsets: problemObs?.detectedHeadsets || [],
          zones: problemObs?.zones || [],
          time: new Date().toLocaleTimeString("ru-RU"),
          text: `✅ Все VR-шлемы на базе (CHARGING_BASE: ${totalChargingBase}/${expectedHeadsetCount}). Камера: ${alertCam.name}`,
        });
      } else {
        this.roomLastConfirmedStatus.set(roomId, "ALL_ON_BASE");
      }
    }

    return {
      roomId,
      cameraId: alertCam.id,
      cameraName: alertCam.name,
      initialPreset: initialPresets.get(alertCam.id) || "Center",
      observations: allObservations,
      headsets: aggregatedHeadsets,
      chargingBaseCount: totalChargingBase,
      onChargingBaseCount: totalChargingBase,
      outsideZoneCount: totalOutside,
      notOnBaseHeadsets,
      notOnBaseCount,
      countConflict,
      expectedHeadsetCount,
      missingFromBaseCount,
      unlocatedCount,
      storageStatus,
      coverage,
      failedCameras: [],
      failedPresets: [],
      failedBases: [],
      summary: (coverage === "NOT_CONFIGURED")
        ? `Осмотр завершён (NOT_CONFIGURED: не указано ожидаемое количество VR-шлемов, осмотр не COMPLETE): на базе ${totalChargingBase}/—, не на базе ${notOnBaseCount} (в квадратах: ${notOnBaseHeadsets.join(", ") || "—"}, вне зон: ${totalOutside}).`
        : `Осмотр VR-шлемов завершён: на базе ${totalChargingBase}/${expectedHeadsetCount ?? "—"}, не на базе ${notOnBaseCount} (в квадратах: ${notOnBaseHeadsets.join(", ") || "—"}, вне зон: ${totalOutside}, не локализовано: ${unlocatedCount}).`,
      inspectedAt: new Date().toISOString(),
    };
  }
}
