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

  async detect({ cameraId, imageBuffer, conf = 0.25 }) {
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
        return { cameraId, timestamp: new Date().toISOString(), peopleCount: 0, people: [] };
      }

      const result = await resp.json();
      return {
        cameraId: result.cameraId || cameraId,
        timestamp: result.timestamp || new Date().toISOString(),
        peopleCount: Number(result.peopleCount || 0),
        people: Array.isArray(result.people) ? result.people : [],
      };
    } catch (error) {
      console.warn("AI service detect error:", error.message);
      return { cameraId, timestamp: new Date().toISOString(), peopleCount: 0, people: [], error: error.message };
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
      const first = Array.isArray(data?.frames) ? data.frames[0] : null;
      const b64 = typeof first === "string" ? first : first?.base64;
      if (!b64) return null;
      return {
        timestamp: typeof first?.timestamp === "number"
          ? new Date(first.timestamp * 1000).toISOString()
          : (first?.timestamp || new Date().toISOString()),
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
}


