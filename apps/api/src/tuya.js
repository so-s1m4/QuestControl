import crypto from "node:crypto";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function createTuyaHeaders({ clientId, clientSecret, method, path, body = "", accessToken = "", timestamp = Date.now(), nonce = crypto.randomUUID() }) {
  const contentHash = sha256(body);
  const stringToSign = `${method.toUpperCase()}\n${contentHash}\n\n${path}`;
  const signPayload = `${clientId}${accessToken}${timestamp}${nonce}${stringToSign}`;
  const sign = crypto.createHmac("sha256", clientSecret).update(signPayload).digest("hex").toUpperCase();
  return {
    client_id: clientId,
    sign,
    sign_method: "HMAC-SHA256",
    t: String(timestamp),
    nonce,
    ...(accessToken ? { access_token: accessToken } : {}),
  };
}

export class TuyaCloud {
  constructor({ baseUrl, clientId, clientSecret, redis }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redis = redis;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async request(method, path, body, accessToken = "") {
    const serialized = body === undefined ? "" : JSON.stringify(body);
    const headers = createTuyaHeaders({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      method,
      path,
      body: serialized,
      accessToken,
    });
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...headers, ...(serialized ? { "content-type": "application/json" } : {}) },
      body: serialized || undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success) {
      const error = new Error(payload?.msg || `Tuya HTTP ${response.status}`);
      error.code = payload?.code || "TUYA_REQUEST_FAILED";
      throw error;
    }
    return payload.result;
  }

  async accessToken() {
    if (!this.configured) throw Object.assign(new Error("Tuya credentials are not configured"), { code: "TUYA_NOT_CONFIGURED" });
    const cacheKey = `tuya:token:${sha256(this.clientId).slice(0, 16)}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;
    const result = await this.request("GET", "/v1.0/token?grant_type=1");
    const ttl = Math.max(60, Number(result.expire_time || 7200) - 120);
    await this.redis.setex(cacheKey, ttl, result.access_token);
    return result.access_token;
  }

  async allocateHls(deviceId) {
    const token = await this.accessToken();
    const path = `/v1.0/devices/${encodeURIComponent(deviceId)}/stream/actions/allocate`;
    const result = await this.request("POST", path, { type: "HLS" }, token);
    if (!result?.url) throw Object.assign(new Error("Tuya returned no stream URL"), { code: "TUYA_STREAM_UNAVAILABLE" });
    return result.url;
  }

  async listProjectDevices() {
    const token = await this.accessToken();
    const result = await this.request("GET", "/v2.0/cloud/thing/device?page_size=20", undefined, token);
    return Array.isArray(result) ? result : (result?.list || result?.devices || []);
  }
}
