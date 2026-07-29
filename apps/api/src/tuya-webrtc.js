import crypto from "node:crypto";
import mqtt from "mqtt";

const mqttUrl = (url) => String(url || "").replace(/^ssl:\/\//, "mqtts://");
const topicFor = (template, motoId, deviceId) => String(template || "")
  .replaceAll("{moto_id}", motoId)
  .replaceAll("moto_id", motoId)
  .replaceAll("{device_id}", deviceId)
  .replaceAll("device_id", deviceId);

export class TuyaWebRTCManager {
  constructor({ tuya }) {
    this.tuya = tuya;
    this.hubs = new Map();
    this.sessions = new Map();
  }

  async startSession({ deviceId, socket }) {
    const [device, config] = await Promise.all([
      this.tuya.deviceInfo(deviceId),
      this.tuya.webrtcConfigs(deviceId),
    ]);
    if (!config?.supports_webrtc) {
      throw Object.assign(new Error("Device does not support WebRTC"), { code: "TUYA_WEBRTC_UNSUPPORTED" });
    }
    if (!device?.uid || !config?.moto_id || !config?.auth) {
      throw Object.assign(new Error("Tuya returned incomplete WebRTC configuration"), { code: "TUYA_WEBRTC_CONFIG_INVALID" });
    }

    const hub = await this.ensureHub(device.uid);
    const sessionId = crypto.randomBytes(16).toString("hex");
    this.sessions.set(sessionId, {
      sessionId,
      socket,
      deviceId,
      motoId: config.moto_id,
      auth: config.auth,
      hub,
      publishTopic: topicFor(hub.sinkTopic, config.moto_id, deviceId),
    });

    const rawIce = config?.p2p_config?.ices || [];
    const iceServers = rawIce
      .map((entry) => ({
        urls: entry.urls || entry.url,
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.credential ? { credential: entry.credential } : {}),
      }))
      .filter((entry) => entry.urls);
    return { sessionId, iceServers };
  }

  async ensureHub(uid) {
    const existing = this.hubs.get(uid);
    if (existing && existing.client.connected && existing.expiresAt > Date.now() + 60_000) return existing;
    if (existing) existing.client.end(true);

    const config = await this.tuya.mqttConfig(uid);
    const sourceTopic = config?.source_topic?.ipc;
    const sinkTopic = config?.sink_topic?.ipc;
    if (!config?.url || !config?.client_id || !sourceTopic || !sinkTopic) {
      throw Object.assign(new Error("Tuya returned incomplete MQTT configuration"), { code: "TUYA_MQTT_CONFIG_INVALID" });
    }

    const client = mqtt.connect(mqttUrl(config.url), {
      clientId: config.client_id,
      username: config.username,
      password: config.password,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 2_000,
      rejectUnauthorized: true,
    });
    const hub = {
      client,
      uid,
      sourceTopic,
      sinkTopic,
      from: sourceTopic.split("/")[3] || config.client_id,
      expiresAt: Date.now() + Number(config.expire_time || 7200) * 1_000,
    };

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Object.assign(new Error("Tuya MQTT connection timed out"), { code: "TUYA_MQTT_TIMEOUT" })), 12_000);
      client.once("connect", () => {
        client.subscribe(sourceTopic, { qos: 1 }, (error) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        });
      });
      client.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    }).catch((error) => {
      client.end(true);
      throw error;
    });

    client.on("message", (_topic, payload) => this.receive(payload));
    client.on("error", (error) => console.error("Tuya WebRTC MQTT error", error.message));
    this.hubs.set(uid, hub);
    return hub;
  }

  receive(payload) {
    try {
      const frame = JSON.parse(payload.toString("utf8"));
      if (Number(frame?.protocol) !== 302) return;
      const session = this.sessions.get(frame?.data?.header?.sessionid);
      if (!session || !session.socket.connected) return;
      const type = frame?.data?.header?.type;
      if (type === "answer") {
        session.socket.emit("signal", { sessionId: session.sessionId, type, payload: frame?.data?.msg?.sdp || "" });
      } else if (type === "candidate") {
        const candidate = String(frame?.data?.msg?.candidate || "").replace(/^a=/, "").replace(/\r\n$/, "");
        session.socket.emit("signal", { sessionId: session.sessionId, type, payload: candidate });
      } else if (type === "disconnect") {
        session.socket.emit("signal", { sessionId: session.sessionId, type, payload: "" });
        this.sessions.delete(session.sessionId);
      }
    } catch (error) {
      console.error("Invalid Tuya WebRTC message", error.message);
    }
  }

  async signal({ sessionId, socket, type, payload }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.socket.id !== socket.id) {
      throw Object.assign(new Error("WebRTC session not found"), { code: "WEBRTC_SESSION_NOT_FOUND" });
    }
    const message = type === "offer"
      ? { mode: "webrtc", sdp: payload, stream_type: 1, auth: session.auth }
      : type === "candidate"
        ? { mode: "webrtc", candidate: payload }
        : { mode: "webrtc" };
    const frame = {
      protocol: 302,
      pv: "2.2",
      t: Math.floor(Date.now() / 1_000),
      data: {
        header: {
          type,
          from: session.hub.from,
          to: session.deviceId,
          sub_dev_id: "",
          sessionid: session.sessionId,
          moto_id: session.motoId,
        },
        msg: message,
      },
    };
    await new Promise((resolve, reject) => {
      session.hub.client.publish(session.publishTopic, JSON.stringify(frame), { qos: 1 }, (error) => error ? reject(error) : resolve());
    });
    if (type === "disconnect") this.sessions.delete(sessionId);
  }

  async closeSocket(socket) {
    const owned = [...this.sessions.values()].filter((session) => session.socket.id === socket.id);
    await Promise.allSettled(owned.map((session) => this.signal({
      sessionId: session.sessionId,
      socket,
      type: "disconnect",
      payload: "",
    })));
  }
}
