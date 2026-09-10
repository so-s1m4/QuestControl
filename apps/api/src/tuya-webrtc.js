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

  async startSession({ deviceId, socket, streamType = 1, purpose = "browser" }) {
    // A Tuya camera may accept only one useful P2P media path at a time.  The
    // operator's live player is the foreground path, so it must never compete
    // with the background AI worker for that limited camera-side resource.
    if (purpose === "browser") {
      await this.closeAiSessionsForDevice(deviceId);
    } else if (purpose === "ai" && this.hasBrowserSession(deviceId)) {
      throw Object.assign(new Error("Camera is being viewed in the browser"), { code: "TUYA_WEBRTC_IN_USE" });
    }

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
      purpose: purpose === "ai" ? "ai" : "browser",
      // Tuya's default (1) is a sub-stream. Server-side vision needs the
      // camera's main stream when it is explicitly requested, while browser
      // playback keeps its existing default.
      streamType: Number.isInteger(Number(streamType)) && Number(streamType) > 0 ? Number(streamType) : 1,
      hub,
      publishTopic: topicFor(hub.sinkTopic, config.moto_id, deviceId),
    });
    console.info("Tuya WebRTC session started",deviceId,sessionId.slice(0,8));

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

  hasBrowserSession(deviceId) {
    return [...this.sessions.values()].some((session) =>
      session.deviceId === deviceId && session.purpose === "browser"
    );
  }

  async closeAiSessionsForDevice(deviceId) {
    const sessions = [...this.sessions.values()].filter((session) =>
      session.deviceId === deviceId && session.purpose === "ai"
    );
    if (!sessions.length) return;

    console.info("Tuya WebRTC giving browser priority", deviceId, sessions.length);
    await Promise.allSettled(sessions.map(async (session) => {
      try {
        await this.signal({
          sessionId: session.sessionId,
          socket: session.socket,
          type: "disconnect",
          payload: "",
        });
      } finally {
        // The internal worker has no Socket.IO connection to receive a
        // disconnect itself.  Mirror it locally so its bridge can release the
        // associated bookkeeping immediately.
        session.socket.emit?.("signal", {
          sessionId: session.sessionId,
          type: "disconnect",
          payload: "",
        });
      }
    }));
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
      if(type==="answer"||type==="candidate"||type==="disconnect")console.info("Tuya WebRTC camera signal",session.deviceId,type,session.sessionId.slice(0,8));
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
    // Browser APIs expose the raw RTCIceCandidate value (`candidate:…`), but
    // Tuya's MQTT 302 protocol requires its SDP-line form (`a=candidate:…`).
    // Preserve an already-prefixed payload and normalize the browser form.
    if (type === "candidate") {
      payload = String(payload || "").replace(/\r?\n$/, "");
      if (!payload) return;
      if (!payload.startsWith("a=")) payload = `a=${payload}`;
    }
    const message = type === "offer"
      ? { mode: "webrtc", sdp: payload, stream_type: session.streamType, auth: session.auth }
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
    if(type==="offer"||type==="disconnect")console.info("Tuya WebRTC client signal",session.deviceId,type,sessionId.slice(0,8));
    if(type==="candidate")console.info("Tuya WebRTC client candidate",session.deviceId,sessionId.slice(0,8),payload.startsWith("a=candidate:")?"sdp-line":"invalid-format");
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
