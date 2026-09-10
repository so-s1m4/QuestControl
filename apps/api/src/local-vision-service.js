export class LocalVisionService {
  constructor({ baseUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8088", internalSecret = "" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.internalSecret = internalSecret;
  }

  _headers(extra = {}) {
    const headers = { ...extra };
    if (this.internalSecret) {
      headers["X-Internal-Secret"] = this.internalSecret;
    }
    return headers;
  }

  async isHealthy() {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return data?.status === "ok";
    } catch {
      return false;
    }
  }

  async detect({ cameraId, imageBuffer, conf = 0.85 }) {
    if (!imageBuffer) {
      return { cameraId, timestamp: new Date().toISOString(), peopleCount: 0, people: [] };
    }

    try {
      const resp = await fetch(`${this.baseUrl}/detect`, {
        method: "POST",
        headers: this._headers({
          "Content-Type": "image/jpeg",
          "X-Camera-Id": String(cameraId || ""),
        }),
        body: imageBuffer,
        signal: AbortSignal.timeout(4000),
      });

      if (!resp.ok) {
        console.warn("AI service detection returned HTTP", resp.status);
        return {
          cameraId,
          timestamp: new Date().toISOString(),
          status: "MODEL_UNAVAILABLE",
          peopleCount: 0,
          people: [],
          error: `AI service returned HTTP ${resp.status}`,
        };
      }

      const result = await resp.json();
      return {
        cameraId: result.cameraId || cameraId,
        timestamp: result.timestamp || new Date().toISOString(),
        status: result.status || "READY",
        error: result.error || null,
        peopleCount: Number(result.peopleCount || 0),
        people: Array.isArray(result.people) ? result.people : [],
      };
    } catch (error) {
      console.warn("AI service detect error:", error.message);
      return { cameraId, timestamp: new Date().toISOString(), status: "MODEL_UNAVAILABLE", peopleCount: 0, people: [], error: error.message };
    }
  }

  async detectPeople(param1, imageBuffer, conf = 0.85) {
    if (typeof param1 === "object" && param1 !== null && !Buffer.isBuffer(param1)) {
      return this.detect(param1);
    }
    return this.detect({ cameraId: param1, imageBuffer, conf });
  }

  async detectHeadsets({ cameraId, imageBuffer, conf = 0.4, testHeadsets = null }) {
    try {
      const headers = this._headers({
        "Content-Type": "application/json",
        "X-Camera-Id": String(cameraId || ""),
      });
      if (testHeadsets && Array.isArray(testHeadsets)) {
        headers["X-Test-Headset-Bboxes"] = JSON.stringify(testHeadsets);
      }

      const payload = {
        cameraId,
        conf,
        image: imageBuffer ? imageBuffer.toString("base64") : "",
      };
      if (testHeadsets) {
        payload.testHeadsets = testHeadsets;
      }

      const resp = await fetch(`${this.baseUrl}/detect/headsets`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        return {
          cameraId,
          timestamp: new Date().toISOString(),
          status: "MODEL_UNAVAILABLE",
          modelStatus: "MODEL_UNAVAILABLE",
          headsetCount: 0,
          headsets: [],
          error: `AI service returned HTTP ${resp.status}`,
        };
      }

      const result = await resp.json();
      const status = result.status || "READY";
      return {
        cameraId: result.cameraId || cameraId,
        timestamp: result.timestamp || new Date().toISOString(),
        status,
        modelStatus: result.modelStatus || status,
        error: result.error || null,
        headsetCount: Number(result.headsetCount || 0),
        headsets: Array.isArray(result.headsets) ? result.headsets : [],
      };
    } catch (error) {
      console.warn("AI service detectHeadsets error:", error.message);
      return {
        cameraId,
        timestamp: new Date().toISOString(),
        status: "MODEL_UNAVAILABLE",
        modelStatus: "MODEL_UNAVAILABLE",
        headsetCount: 0,
        headsets: [],
        error: error.message,
      };
    }
  }

  async annotateHeadsets({
    imageBuffer,
    headsets = [],
    zones = [],
    notOnBaseCount = 0,
    onChargingBaseCount = 0,
    cameraName = "Камера",
    preset = "default",
    timestamp = new Date().toISOString(),
  } = {}) {
    if (!imageBuffer) return null;
    try {
      const resp = await fetch(`${this.baseUrl}/annotate/headsets`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          image: imageBuffer.toString("base64"),
          headsets,
          zones,
          notOnBaseCount,
          onChargingBaseCount,
          cameraName,
          preset,
          timestamp,
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!resp.ok) {
        return imageBuffer;
      }
      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch {
      return imageBuffer;
    }
  }

  async setCameraMoving(cameraId, moving, preset = "") {
    if (!cameraId) return false;
    try {
      const resp = await fetch(`${this.baseUrl}/worker/moving`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ cameraId, moving: Boolean(moving), preset }),
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async analyze({ cameraId, frames = [], question = "Determine what happened during these frames.", manual = false, yoloContext = null }) {
    try {
      const framesBase64 = frames.map((frame) => {
        if (typeof frame === "string") return frame;
        if (frame?.buffer) return frame.buffer.toString("base64");
        if (Buffer.isBuffer(frame)) return frame.toString("base64");
        return "";
      }).filter(Boolean);

      const payload = {
        cameraId,
        frames: framesBase64,
        question,
        manual: Boolean(manual),
        yoloContext,
      };

      const resp = await fetch(`${this.baseUrl}/analyze`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.warn("AI service analyze returned HTTP", resp.status, errText);
        return this.fallbackAnalysis(question, yoloContext?.peopleCount || 0);
      }

      const data = await resp.json();
      return {
        people: Number(data.people ?? yoloContext?.peopleCount ?? 0),
        activity: String(data.activity || "monitoring"),
        doorState: String(data.doorState || "unknown"),
        unusual: Boolean(data.unusual),
        confidence: Number(data.confidence ?? 0.85),
        description: String(data.description || "Анализ сцены завершён."),
      };
    } catch (error) {
      console.warn("AI service analyze error:", error.message);
      return this.fallbackAnalysis(question, yoloContext?.peopleCount || 0);
    }
  }

  fallbackAnalysis(question, peopleCount = 0) {
    const qLower = String(question || "").toLowerCase();
    let description = peopleCount > 0
      ? `В комнате зафиксировано людей: ${peopleCount}.`
      : "В комнате никого нет.";
    if (qLower.includes("остал") || qLower.includes("кто")) {
      description = peopleCount > 0 ? `Да, в комнате сейчас ${peopleCount} чел.` : "Нет, комната пуста.";
    }
    return {
      people: peopleCount,
      activity: peopleCount > 0 ? "players present" : "room empty",
      doorState: "closed",
      unusual: false,
      confidence: 0.8,
      description,
      fallback: true,
    };
  }

  async syncWorkers(cameras) {
    try {
      const resp = await fetch(`${this.baseUrl}/worker/sync`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ cameras }),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch (err) {
      console.warn("Failed to sync cameras with AI stream worker:", err.message);
      return false;
    }
  }

  async getWorkerStatus() {
    try {
      const resp = await fetch(`${this.baseUrl}/worker/status`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) return {};
      return await resp.json();
    } catch {
      return {};
    }
  }

  async getLatestFrame(cameraId) {
    if (!cameraId) return null;
    try {
      const resp = await fetch(`${this.baseUrl}/cameras/${cameraId}/frames?seconds=5&limit=1`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      // The worker returns its circular buffer in chronological order. Pick
      // the last item: using index 0 made a capture wait on an old frame even
      // while newer frames were already available after PTZ settling.
      const latest = Array.isArray(data?.frames) ? data.frames.at(-1) : null;
      const b64 = typeof latest === "string" ? latest : latest?.base64;
      if (!b64) return null;
      let frameTs = null;
      if (typeof latest?.timestamp === "number") {
        frameTs = new Date(latest.timestamp * 1000).toISOString();
      } else if (latest?.timestamp) {
        frameTs = new Date(latest.timestamp).toISOString();
      }
      return {
        timestamp: frameTs,
        buffer: Buffer.from(b64, "base64"),
        mimeType: "image/jpeg",
      };
    } catch {
      return null;
    }
  }

  async getRecentClip(cameraId, count = 10) {
    if (!cameraId) return null;
    try {
      const resp = await fetch(`${this.baseUrl}/cameras/${cameraId}/clip?count=${encodeURIComponent(count)}`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(6000),
      });
      if (!resp.ok) return null;
      const arrayBuffer = await resp.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) return null;
      return Buffer.from(arrayBuffer);
    } catch {
      return null;
    }
  }

  async getPipelineStatus() {
    try {
      const resp = await fetch(`${this.baseUrl}/pipeline/status`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { modelStatus: "DATASET_REQUIRED", error: `AI service HTTP ${resp.status}` };
      return await resp.json();
    } catch (err) {
      return { modelStatus: "DATASET_REQUIRED", error: err.message };
    }
  }

  async getPipelineJobStatus() {
    try {
      const resp = await fetch(`${this.baseUrl}/pipeline/job-status`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { status: "UNKNOWN", error: `AI service HTTP ${resp.status}` };
      return await resp.json();
    } catch (err) {
      return { status: "UNKNOWN", error: err.message };
    }
  }

  async getVerificationQueue(status = "all") {
    try {
      const resp = await fetch(`${this.baseUrl}/pipeline/queue?status=${encodeURIComponent(status)}`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return { items: [], count: 0 };
      return await resp.json();
    } catch {
      return { items: [], count: 0 };
    }
  }

  async getSampleImage(sampleId) {
    if (!sampleId) return null;
    try {
      const resp = await fetch(`${this.baseUrl}/pipeline/samples/${encodeURIComponent(sampleId)}/image`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      const ab = await resp.arrayBuffer();
      return Buffer.from(ab);
    } catch {
      return null;
    }
  }

  async getSampleMetadata(sampleId) {
    if (!sampleId) return null;
    try {
      const resp = await fetch(`${this.baseUrl}/pipeline/samples/${encodeURIComponent(sampleId)}/meta`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async collectPtzFrame({
    cameraId,
    roomId,
    preset = "default",
    imageBuffer,
    timestamp = null,
    captureSessionId = null,
    initialBboxes = null,
    autoEnqueue = true,
  }) {
    const payload = {
      cameraId,
      roomId,
      preset,
      image: imageBuffer ? imageBuffer.toString("base64") : "",
      timestamp,
      captureSessionId,
      initialBboxes,
      autoEnqueue,
    };
    const resp = await fetch(`${this.baseUrl}/pipeline/collect`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.message || err.error || "COLLECT_FAILED");
    }
    return await resp.json();
  }

  async verifySample({
    sampleId,
    operatorId,
    approved = true,
    correctedBboxes = null,
    negativeConfirmed = false,
    notes = "",
  }) {
    const payload = {
      sampleId,
      operatorId,
      approved,
      correctedBboxes,
      negativeConfirmed,
      notes,
    };
    const resp = await fetch(`${this.baseUrl}/pipeline/verify`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.message || err.error || "VERIFY_FAILED");
    }
    return await resp.json();
  }

  async exportDatasetSplits({ version = "v1.0.0" } = {}) {
    const resp = await fetch(`${this.baseUrl}/pipeline/export`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ version }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.message || err.error || "EXPORT_FAILED");
    }
    return await resp.json();
  }

  async trainHeadsetModel({ epochs = 10, batchSize = 8, imgSize = 640, operatorId = "system" } = {}) {
    const resp = await fetch(`${this.baseUrl}/pipeline/train`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ epochs, batchSize, imgSize, operatorId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.message || err.error || "TRAIN_FAILED");
    }
    return await resp.json();
  }

  async activateCandidateModel({ candidate = null, version = "v1.0.0", operatorId = "system" } = {}) {
    const payload = { version, operatorId };
    if (candidate) payload.candidate = candidate;
    const resp = await fetch(`${this.baseUrl}/pipeline/activate`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.message || err.error || "ACTIVATION_FAILED");
    }
    return await resp.json();
  }

  async rollbackModel({ operatorId = "system" } = {}) {
    const resp = await fetch(`${this.baseUrl}/pipeline/rollback`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ operatorId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.message || err.error || "ROLLBACK_FAILED");
    }
    return await resp.json();
  }

  async setCameraMoving(cameraId, isMoving, preset = "") {
    try {
      await fetch(`${this.baseUrl}/worker/moving`, {
        method: "POST",
        headers: this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ cameraId, moving: Boolean(isMoving), preset }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {}
  }

  async detectActivity({
    cameraId,
    roomId = null,
    presetName = "default",
    timestamp = null,
    imageBuffer = null,
    isMoving = false,
    syntheticPoses = null,
    syntheticPeople = null,
  }) {
    try {
      const payload = {
        cameraId,
        roomId,
        presetName,
        timestamp: timestamp ? (typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime() / 1000) : Date.now() / 1000,
        isMoving: Boolean(isMoving),
      };
      if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
        payload.image = imageBuffer.toString("base64");
      }
      if (syntheticPoses) {
        payload.syntheticPoses = syntheticPoses;
      }
      if (syntheticPeople) {
        payload.syntheticPeople = syntheticPeople;
      }

      const resp = await fetch(`${this.baseUrl}/detect/activity`, {
        method: "POST",
        headers: this._headers({
          "Content-Type": "application/json",
          "X-Camera-Id": String(cameraId || ""),
        }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        return {
          status: "POSE_MODEL_UNAVAILABLE",
          cameraId,
          events: [],
          error: `AI service returned HTTP ${resp.status}`,
        };
      }

      return await resp.json();
    } catch (err) {
      return {
        status: "POSE_MODEL_UNAVAILABLE",
        cameraId,
        events: [],
        error: err.message,
      };
    }
  }

  async getActivityHealth() {
    try {
      const resp = await fetch(`${this.baseUrl}/activity/health`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { poseEstimatorStatus: "POSE_MODEL_UNAVAILABLE", enabledPluginsCount: 0 };
      return await resp.json();
    } catch {
      return { poseEstimatorStatus: "POSE_MODEL_UNAVAILABLE", enabledPluginsCount: 0 };
    }
  }

  async getActivityPlugins() {
    try {
      const resp = await fetch(`${this.baseUrl}/activity/plugins`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return { plugins: [] };
      return await resp.json();
    } catch {
      return { plugins: [] };
    }
  }

  async setActivityPluginEnabled(actionType, enabled) {
    const resp = await fetch(`${this.baseUrl}/activity/plugins/${encodeURIComponent(actionType)}/enable`, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: Boolean(enabled) }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      throw new Error(`Failed to set plugin enabled: HTTP ${resp.status}`);
    }
    return await resp.json();
  }
}
