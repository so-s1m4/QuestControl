import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

const md5 = (value) => crypto.createHash("md5").update(value).digest("hex");

function decryptPayload(encrypted, accessKey) {
  const decipher = crypto.createDecipheriv(
    "aes-128-ecb",
    Buffer.from(accessKey.slice(8, 24), "utf8"),
    null
  );
  decipher.setAutoPadding(true);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

export class TuyaMessageConsumer extends EventEmitter {
  constructor({ accessId, accessKey, url = "wss://mqe.tuyaeu.com:8285/", logger = console }) {
    super();
    this.accessId = accessId;
    this.accessKey = accessKey;
    this.url = url.endsWith("/") ? url : `${url}/`;
    this.logger = logger;
    this.retryDelay = 1_000;
    this.closed = false;
  }

  get configured() {
    return Boolean(this.accessId && this.accessKey && this.url);
  }

  start() {
    if (!this.configured || this.closed) return;
    this.connect();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pingTimer);
    this.socket?.close();
  }

  connect() {
    const password = md5(`${this.accessId}${md5(this.accessKey)}`).slice(8, 24);
    const topic = `ws/v2/consumer/persistent/${this.accessId}/out/event/${this.accessId}-sub`;
    const query = "subscriptionType=Failover&ackTimeoutMillis=30000";
    const socket = new WebSocket(`${this.url}${topic}?${query}`, {
      headers: { username: this.accessId, password },
    });
    this.socket = socket;
    socket.on("open", () => {
      this.retryDelay = 1_000;
      this.logger.info("Tuya message service connected");
      this.keepAlive();
    });
    socket.on("ping", () => {
      this.keepAlive();
      socket.pong(this.accessId);
    });
    socket.on("pong", () => this.keepAlive());
    socket.on("message", (raw) => {
      this.keepAlive();
      try {
        const envelope = JSON.parse(raw.toString());
        const wrapper = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
        wrapper.data = decryptPayload(wrapper.data, this.accessKey);
        this.emit("message", { ...envelope, payload: wrapper });
        socket.send(JSON.stringify({ messageId: envelope.messageId }));
      } catch (error) {
        this.logger.error("Tuya message parse failed", error.message);
      }
    });
    socket.on("error", (error) => this.logger.warn("Tuya message service unavailable", error.message));
    socket.on("close", () => {
      clearTimeout(this.pingTimer);
      if (this.closed) return;
      const delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }

  keepAlive() {
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.ping(this.accessId);
    }, 30_000);
  }
}
