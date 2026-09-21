import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import pg from "pg";
import Redis from "ioredis";
import { Server } from "socket.io";
import WebSocket, { WebSocketServer } from "ws";
import { SocksProxyAgent } from "socks-proxy-agent";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { TelegramBot, escapeTelegramHtml, renderTelegramTemplate } from "./telegram.js";
import { TuyaCloud } from "./tuya.js";
import { TuyaMessageConsumer } from "./tuya-messages.js";
import { TuyaWebRTCManager } from "./tuya-webrtc.js";
import { CameraFrameProvider } from "./camera-frame-provider.js";
import { LocalVisionService } from "./local-vision-service.js";
import { CameraEventEngine } from "./camera-event-engine.js";
import { HeadsetTrackingEngine } from "./headset-tracking-engine.js";
import { ActivityIntelligenceEngine } from "./activity-intelligence-engine.js";
import { CameraVisionController } from "./camera-vision-controller.js";
import { CameraAIAgent } from "./camera-ai-agent.js";
import { runMigrations } from "./migrator.js";
import { startAiWorkerSyncSupervisor } from "./ai-worker-supervisor.js";
import {
  checkinTokenMatches,
  createCheckinToken,
  createExtraGuestAuthorization,
  isCheckinToken,
  readCheckinToken,
  readExtraGuestAuthorization,
} from "./checkin-links.js";

const DEV_SECRET_FALLBACK = "development-internal-ai-secret-key-32chars-min";

const env = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  PSEUDONYMIZATION_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string(),
  TRUST_PROXY: z.coerce.number().default(1),
  TUYA_BASE_URL: z.string().url().default("https://openapi.tuyaeu.com"),
  TUYA_CLIENT_ID: z.string().optional(),
  TUYA_CLIENT_SECRET: z.string().optional(),
  TUYA_MESSAGE_URL: z.string().url().default("wss://mqe.tuyaeu.com:8285/"),
  TUYA_BRIDGE_ACCOUNT_1_API_URL: z.string().url().optional(),
  TUYA_BRIDGE_ACCOUNT_1_RTSP_URL: z.string().url().optional(),
  TUYA_BRIDGE_ACCOUNT_2_API_URL: z.string().url().optional(),
  TUYA_BRIDGE_ACCOUNT_2_RTSP_URL: z.string().url().optional(),
  TUYA_BRIDGE_ACCOUNT_2_ENABLED: z.enum(["true","false"]).default("false").transform(value=>value==="true"),
  GO2RTC_BASE_URL: z.string().url().default("http://127.0.0.1:1984"),
  AI_SERVICE_URL: z.string().url().default("http://127.0.0.1:8088"),
  TIME_TO_GROW_BASE_URL: z.string().url().default("https://api.time-to-grow.com"),
  TIME_TO_GROW_CLUB_ID: z.string().optional(),
  TIME_TO_GROW_VIENNA_CLUB_ID: z.string().default("01js42s5vwvwrx3fme9zvgdj1v"),
  TIME_TO_GROW_JWT: z.string().optional(),
  TIME_TO_GROW_EMAIL: z.union([z.string().email(), z.literal("")]).optional(),
  TIME_TO_GROW_PASSWORD: z.string().optional(),
  VR_SANKT_POELTEN_PANEL_URL: z.string().url().default("http://172.23.0.1:30000"),
  VR_SANKT_POELTEN_DEVICE_URL: z.string().url().default("http://172.23.0.1:6101"),
  VR_SANKT_POELTEN_SOCKS_URL: z.string().url().default("socks5h://172.23.0.1:1080"),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{30,}$/).optional(),
  TELEGRAM_BOT_USERNAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/).optional(),
  DOCUMENT_RUNNER_URL: z.string().url().default("http://document-runner:8080"),
  INTERNAL_API_SECRET: z
    .string()
    .min(16)
    .refine((val) => val !== "internal-ai-service-secret" || process.env.NODE_ENV !== "production", {
      message: "INTERNAL_API_SECRET cannot be the default insecure value in production",
    })
    .refine((val) => val !== DEV_SECRET_FALLBACK || process.env.NODE_ENV !== "production", {
      message: "INTERNAL_API_SECRET cannot use development fallback in production",
    })
    .default(() => {
      if (process.env.NODE_ENV === "production") {
        throw new Error("INTERNAL_API_SECRET must be explicitly set in production");
      }
      return DEV_SECRET_FALLBACK;
    }),
}).parse(process.env);

const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const tuya = new TuyaCloud({
  baseUrl: env.TUYA_BASE_URL,
  clientId: env.TUYA_CLIENT_ID,
  clientSecret: env.TUYA_CLIENT_SECRET,
  redis,
});
const tuyaMessages = new TuyaMessageConsumer({
  accessId: env.TUYA_CLIENT_ID,
  accessKey: env.TUYA_CLIENT_SECRET,
  url: env.TUYA_MESSAGE_URL,
});
const tuyaWebRTC = new TuyaWebRTCManager({ tuya });
const app = express();
let telegramBot;
const isOwner = (req) => req.user?.role === "OWNER";
const canConfigureCameras = (req) => ["OWNER","ADMIN"].includes(req.user?.role);
async function locationAllowed(req, locationId) {
  if (isOwner(req)) return true;
  return Boolean((await db.query("SELECT 1 FROM user_locations WHERE user_id=$1 AND location_id=$2", [req.user.sub, locationId])).rowCount);
}
async function cameraAllowed(req, cameraId) {
  if (isOwner(req)) return true;
  if(req.user?.role==="CAMERA_GUEST") {
    if(!req.user.shareId || !Array.isArray(req.user.cameraIds) || !req.user.cameraIds.includes(cameraId)) return false;
    return Boolean((await db.query("SELECT 1 FROM camera_shares WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",[req.user.shareId])).rowCount);
  }
  if (req.user?.role === "CAMERA_VIEWER") {
    return Boolean((await db.query("SELECT 1 FROM user_cameras WHERE user_id=$1 AND camera_id=$2", [req.user.sub,cameraId])).rowCount);
  }
  const camera=(await db.query("SELECT COALESCE(c.location_id,r.location_id) location_id FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1",[cameraId])).rows[0];
  return Boolean(camera?.location_id && await locationAllowed(req,camera.location_id));
}
app.set("trust proxy", env.TRUST_PROXY);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.CORS_ORIGIN.split(","), credentials: true }));
app.use(express.json({ limit: "9mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false, skip:req=>req.path.startsWith("/vr/sankt-poelten/proxy/") }));

const server = http.createServer(app);
const vrVncServer = new WebSocketServer({ noServer:true });
const io = new Server(server, { path: "/socket.io", cors: { origin: env.CORS_ORIGIN.split(","), credentials: true }, maxHttpBufferSize: 1e6 });
const cameraFrameProvider = new CameraFrameProvider();
const localVisionService = new LocalVisionService({ baseUrl: env.AI_SERVICE_URL, internalSecret: env.INTERNAL_API_SECRET });
async function syncAiWorkersSafe() {
  try {
    const { rows } = await db.query(
      `SELECT c.*, COALESCE(c.location_id, r.location_id) AS location_id,
        capture.id AS capture_session_id,
        COALESCE(capture.auto_capture_enabled, false) AS auto_capture_enabled,
        COALESCE(capture.capture_interval_sec, 12) AS capture_interval_sec,
        COALESCE((
          SELECT jsonb_object_agg(s.action_type, jsonb_build_object('enabled', s.enabled, 'config', s.config))
          FROM activity_settings s WHERE s.room_id = c.room_id
        ), '{}'::jsonb) AS activity_settings
       FROM cameras c
       LEFT JOIN rooms r ON r.id = c.room_id
       LEFT JOIN LATERAL (
         SELECT id, auto_capture_enabled, capture_interval_sec
         FROM ai_capture_sessions
         WHERE camera_id=c.id AND room_id=c.room_id AND status='ACTIVE'
         ORDER BY created_at DESC LIMIT 1
       ) capture ON true
       WHERE c.ai_enabled = true`
    );
    await localVisionService.syncWorkers(rows);
  } catch (err) {
    console.warn("AI worker sync warning:", err.message);
  }
}
const cameraEventEngine = new CameraEventEngine({
  db,
  io,
  // Camera transport retries must not repeatedly notify the operator while a
  // Tuya stream is reconnecting. The first sustained outage is still sent.
  cameraOfflineNotificationCooldownMs: 30 * 60 * 1000,
  onNotification: async (type, data) => {
    try {
      let photoBuffer = null;
      let clipBuffer = null;

      if (data?.cameraId) {
        if (type === "UNUSUAL_ACTIVITY") {
          clipBuffer = await localVisionService.getRecentClip(data.cameraId, 10).catch(() => null);
        }
        const frame = cameraFrameProvider.getLatestFrame(data.cameraId) ||
          await localVisionService.getLatestFrame(data.cameraId).catch(() => null);
        if (frame?.buffer) {
          photoBuffer = frame.buffer;
        }
      }

      if (type === "ROOM_EMPTY") {
        await sendTelegramImportantLog("roomEmpty", "Комната освободилась", [
          ["Камера", data.cameraId],
          ["Комната", data.roomId || "—"],
          ["Статус", "Все игроки вышли"],
        ], { photoBuffer });
      } else if (type === "UNUSUAL_ACTIVITY") {
        await sendTelegramImportantLog("unusualActivity", "Необычная активность в квесте", [
          ["Камера", data.cameraId],
          ["Событие", data.description || "Аномалия"],
        ], { photoBuffer, clipBuffer });
      } else if (type === "CAMERA_OFFLINE") {
        await sendTelegramImportantLog("cameraOffline", "Потерян видеопоток камеры", [
          ["Камера", data.cameraId],
          ["Статус", "OFFLINE (последний кадр)"],
        ], { photoBuffer });
      }
    } catch (err) {
      console.error("Failed to send Telegram AI notification:", err.message);
    }
  },
});
const headsetTrackingEngine = new HeadsetTrackingEngine({
  db,
  io,
  onNotification: async (type, data) => {
    try {
      let photoBuffer = null;
      if (data?.imageBuffer || data?.frameBuffer) {
        const rawBuffer = data.imageBuffer || data.frameBuffer;
        const zones = data.zones || (data.cameraId ? headsetTrackingEngine.getZones(data.cameraId, data.preset) : []);
        photoBuffer = await localVisionService.annotateHeadsets({
          imageBuffer: rawBuffer,
          headsets: data.detectedHeadsets || [],
          zones,
          notOnBaseCount: data.notOnBaseCount ?? 0,
          onChargingBaseCount: data.onChargingBaseCount ?? 0,
          cameraName: data.cameraName || "Камера",
          preset: data.preset || "default",
          timestamp: data.time || new Date().toLocaleTimeString("ru-RU"),
        }).catch(() => rawBuffer);
      } else if (data?.cameraId) {
        const frame = cameraFrameProvider.getLatestFrame(data.cameraId) ||
          await localVisionService.getLatestFrame(data.cameraId).catch(() => null);
        if (frame?.buffer) {
          const rawBuffer = frame.buffer;
          const zones = headsetTrackingEngine.getZones(data.cameraId, data.preset);
          photoBuffer = await localVisionService.annotateHeadsets({
            imageBuffer: rawBuffer,
            headsets: data.detectedHeadsets || [],
            zones,
            notOnBaseCount: data.notOnBaseCount ?? 0,
            onChargingBaseCount: data.onChargingBaseCount ?? 0,
            cameraName: data.cameraName || "Камера",
            preset: data.preset || "default",
            timestamp: data.time || new Date().toLocaleTimeString("ru-RU"),
          }).catch(() => rawBuffer);
        }
      }

      if (type === "HEADSET_NOT_ON_BASE") {
        await sendTelegramImportantLog("headsetNotOnBase", "⚠️ VR-шлем не на базе и не на человеке", [
          ["Ожидается шлемов", data.expectedHeadsetCount ? String(data.expectedHeadsetCount) : "—"],
          ["Всего не на базе", String(data.notOnBaseCount ?? 0)],
          ["На людях", String(data.wornHeadsetCount ?? 0)],
          ["В рабочих квадратах", Array.isArray(data.notOnBaseHeadsets) && data.notOnBaseHeadsets.length ? data.notOnBaseHeadsets.join(", ") : "—"],
          ["Вне зон", String(data.outsideZoneCount ?? 0)],
          ["На зарядной базе", String(data.onChargingBaseCount ?? 0)],
          ["Отсутствует на базе", String(data.missingFromBaseCount ?? 0)],
          ["Не локализовано", String(data.unlocatedCount ?? 0)],
          ["Камера", data.cameraName || data.cameraId],
          ["Ракурс", data.preset || "—"],
          ["Время", data.time || new Date().toLocaleTimeString("ru-RU")],
        ], { photoBuffer });
      } else if (type === "HEADSET_ALL_ON_BASE") {
        await sendTelegramImportantLog("headsetAllOnBase", "✅ Все VR-шлемы на базе (CHARGING_BASE)", [
          ["Камера", data.cameraName || data.cameraId],
          ["Ожидалось шлемов", data.expectedHeadsetCount ? String(data.expectedHeadsetCount) : "—"],
          ["На зарядной базе", String(data.onChargingBaseCount ?? 0)],
          ["Ракурс", data.preset || "—"],
          ["Время", data.time || new Date().toLocaleTimeString("ru-RU")],
        ]);
      }
    } catch (err) {
      console.error("Failed to send Telegram VR notification:", err.message);
    }
  },
});
const activityIntelligenceEngine = new ActivityIntelligenceEngine({
  db,
  io,
  visionService: localVisionService,
  telegramBot,
  sendTelegramAlertFn: sendTelegramImportantLog,
});
const cameraVisionController = new CameraVisionController({
  tuya,
  db,
  frameProvider: cameraFrameProvider,
  visionService: localVisionService,
  eventEngine: cameraEventEngine,
  headsetEngine: headsetTrackingEngine,
  activityEngine: activityIntelligenceEngine,
});
const cameraAIAgent = new CameraAIAgent({
  db,
  eventEngine: cameraEventEngine,
  frameProvider: cameraFrameProvider,
  visionService: localVisionService,
  visionController: cameraVisionController,
});
const key = (v) => new TextEncoder().encode(v);
const settingsKey=crypto.createHash("sha256").update(env.JWT_ACCESS_SECRET,"utf8").digest();
function encryptSetting(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",settingsKey,iv);
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
}
function decryptSetting(value){
  if(!value)return null;
  const buffer=Buffer.from(value),iv=buffer.subarray(0,12),tag=buffer.subarray(12,28),encrypted=buffer.subarray(28);
  const decipher=crypto.createDecipheriv("aes-256-gcm",settingsKey,iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString("utf8"));
}
const normalizeEmail = (email) => email.trim().normalize("NFKC").toLowerCase();
const identityToken = (email) => crypto
  .createHmac("sha256", env.PSEUDONYMIZATION_SECRET)
  .update(normalizeEmail(email), "utf8")
  .digest();
const requestId = (req, res, next) => { req.requestId = req.get("x-request-id") || crypto.randomUUID(); res.set("x-request-id", req.requestId); next(); };
app.use(requestId);

async function sign(user, secret, ttl) {
  return new SignJWT({ role: user.role, permissions: user.permissions, ...(user.cameraIds?{cameraIds:user.cameraIds}:{}), ...(user.shareId?{shareId:user.shareId}:{}) }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime(ttl).sign(key(secret));
}
async function auth(req, res, next) {
  try {
    const token = req.get("authorization")?.replace(/^Bearer /, "");
    if (!token) throw new Error("missing token");
    req.user = (await jwtVerify(token, key(env.JWT_ACCESS_SECRET))).payload;
    next();
  } catch { res.status(401).json({ error: "UNAUTHORIZED", requestId: req.requestId }); }
}
const permit = (permission) => (req, res, next) => {
  const p = req.user?.permissions || [];
  if (p.includes("*") || p.includes(permission) || p.includes(`${permission.split(":")[0]}:*`)) return next();
  res.status(403).json({ error: "FORBIDDEN", requestId: req.requestId });
};
async function audit(req, action, entityType, entityId, beforeState, afterState) {
  const actorUserId=req.user?.role==="CAMERA_GUEST"?null:req.user?.sub||null;
  await db.query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,ip,user_agent,request_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [actorUserId, action, entityType, entityId, req.ip, req.get?.("user-agent"), req.requestId||crypto.randomUUID(), beforeState || null, afterState || null]);
}

const defaultTelegramSettings = {
  newBooking: `<b>🆕 Новая бронь</b>\n\n👤 <b>{{customerName}}</b>\n📅 {{date}} · {{time}}\n📍 {{location}} · {{room}}\n🎮 {{productName}} · {{players}} чел.\n\nПроверьте детали в QuestControl.`,
  dayBefore: `<b>📣 Завтра бронь</b>\n\n👤 <b>{{customerName}}</b>\n📅 {{date}} · {{time}}\n📍 {{location}} · {{room}}\n🎮 {{productName}} · {{players}} чел.\n\nПожалуйста, подтвердите бронь.`,
  twoHours: `<b>⚠️ Бронь ещё не подтверждена</b>\n\nДо начала осталось <b>2 часа или меньше</b>.\n👤 <b>{{customerName}}</b>\n🕐 {{time}} · {{location}} · {{room}}\n🎮 {{productName}}\n\nНажмите кнопку, когда всё подтверждено.`,
  shiftToday: `<b>☀️ Твоя смена сегодня</b>\n\n🕐 <b>{{shiftTime}}</b>\n📍 {{location}}\n🧩 {{responsibility}}\n\nХорошей смены!`,
};
const telegramSettingsInput = z.object({
  newBooking: z.string().trim().min(1).max(3500),
  dayBefore: z.string().trim().min(1).max(3500),
  twoHours: z.string().trim().min(1).max(3500),
  shiftToday: z.string().trim().min(1).max(3500),
});
let telegramSettingsCache = null;
async function telegramSettings() {
  if (telegramSettingsCache) return telegramSettingsCache;
  const row = (await db.query("SELECT encrypted_value FROM app_settings WHERE key='telegram_notifications'")).rows[0];
  try { telegramSettingsCache = { ...defaultTelegramSettings, ...(decryptSetting(row?.encrypted_value) || {}) }; }
  catch { telegramSettingsCache = { ...defaultTelegramSettings }; }
  return telegramSettingsCache;
}
const telegramImportantLogEvents = [
  "sessionRecorded",
  "sessionStarted",
  "sessionFinished",
  "sessionCancelled",
  "bookingConfirmed",
  "checkinCompleted",
  "roomEmpty",
  "unusualActivity",
  "cameraOffline",
  "headsetNotOnBase",
  "headsetAllOnBase",
];
const defaultWebhookSettings = {
  enabled: false,
  url: "",
  secret: "",
  events: Object.fromEntries(telegramImportantLogEvents.map(event => [event, true])),
};
let webhookSettingsCache = null;
async function webhookSettings() {
  if (webhookSettingsCache) return webhookSettingsCache;
  const row = (await db.query("SELECT encrypted_value FROM app_settings WHERE key='outbound_webhook'")).rows[0];
  try {
    const saved = decryptSetting(row?.encrypted_value) || {};
    webhookSettingsCache = { ...defaultWebhookSettings, ...saved, events: { ...defaultWebhookSettings.events, ...(saved.events || {}) } };
  } catch { webhookSettingsCache = structuredClone(defaultWebhookSettings); }
  return webhookSettingsCache;
}
async function sendOutboundWebhook(event, title, rows = []) {
  const settings = await webhookSettings();
  if (!settings.enabled || !settings.url || !settings.secret || !settings.events[event]) return;
  const payload = {
    event,
    title,
    occurredAt: new Date().toISOString(),
    data: Object.fromEntries(rows.filter(([, value]) => value !== null && value !== undefined && value !== "")),
  };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", settings.secret).update(body).digest("hex");
  try {
    const response = await fetch(settings.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "QuestControl-Webhooks/1.0", "x-questcontrol-event": event, "x-questcontrol-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) console.error("Outbound webhook failed", { event, status: response.status });
  } catch (error) { console.error("Outbound webhook failed", { event, error: error.message }); }
}
const defaultTelegramImportantLogSettings = {
  recipientUserId: null,
  events: {
    sessionRecorded: true,
    sessionStarted: false,
    sessionFinished: true,
    sessionCancelled: true,
    bookingConfirmed: true,
    checkinCompleted: true,
    roomEmpty: true,
    unusualActivity: true,
    cameraOffline: true,
    headsetNotOnBase: true,
    headsetAllOnBase: true,
  },
};
const telegramImportantLogSettingsInput = z.object({
  recipientUserId: z.string().uuid().nullable(),
  events: z.object(Object.fromEntries(telegramImportantLogEvents.map(event => [event, z.boolean()]))),
});
let telegramImportantLogSettingsCache = null;
async function telegramImportantLogSettings() {
  if (telegramImportantLogSettingsCache) return telegramImportantLogSettingsCache;
  const row = (await db.query("SELECT encrypted_value FROM app_settings WHERE key='telegram_important_logs'")).rows[0];
  try {
    const saved = decryptSetting(row?.encrypted_value) || {};
    telegramImportantLogSettingsCache = { ...defaultTelegramImportantLogSettings, ...saved, events: { ...defaultTelegramImportantLogSettings.events, ...(saved.events || {}) } };
  } catch { telegramImportantLogSettingsCache = structuredClone(defaultTelegramImportantLogSettings); }
  return telegramImportantLogSettingsCache;
}
async function sendTelegramImportantLog(event, title, rows = [], { photoBuffer = null, clipBuffer = null } = {}) {
  void sendOutboundWebhook(event, title, rows);
  if (!telegramBot?.enabled) return;
  const settings = await telegramImportantLogSettings();
  if (!settings.recipientUserId || !settings.events[event]) return;
  const recipient = (await db.query(`SELECT tc.chat_id FROM telegram_connections tc
    JOIN users u ON u.id=tc.user_id AND u.is_active=true WHERE tc.user_id=$1`, [settings.recipientUserId])).rows[0];
  if (!recipient) return;
  const details = rows.filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `${escapeTelegramHtml(label)}: <b>${escapeTelegramHtml(value)}</b>`).join("\n");
  const caption = `<b>🔔 ${escapeTelegramHtml(title)}</b>${details ? `\n\n${details}` : ""}`;

  try {
    if (clipBuffer) {
      await telegramBot.sendAnimation(recipient.chat_id, clipBuffer, caption);
    } else if (photoBuffer) {
      await telegramBot.sendPhoto(recipient.chat_id, photoBuffer, caption);
    } else {
      await telegramBot.sendMessage(recipient.chat_id, caption);
    }
  } catch (error) {
    console.error("Telegram important log notification failed", { event, userId: settings.recipientUserId, error: error.message });
  }
}
async function telegramUserCanAccessLocation(userId, role, locationId) {
  if (role === "OWNER") return true;
  return Boolean((await db.query("SELECT 1 FROM user_locations WHERE user_id=$1 AND location_id=$2", [userId, locationId])).rowCount);
}
async function telegramRecipients(locationId) {
  return (await db.query(`
    SELECT tc.user_id,tc.chat_id
    FROM telegram_connections tc
    JOIN users u ON u.id=tc.user_id AND u.is_active=true
    JOIN roles role ON role.id=u.role_id
    WHERE role.name='OWNER' OR EXISTS(
      SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id AND ul.location_id=$1
    )
  `, [locationId])).rows;
}
function telegramDateTime(value, timezone) {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(value));
  const item = type => parts.find(part => part.type === type)?.value || "";
  return { date: `${item("day")} ${item("month")} ${item("year")}`, time: `${item("hour")}:${item("minute")}` };
}
function telegramLocalClock(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const item = type => parts.find(part => part.type === type)?.value || "";
  return { date: `${item("year")}-${item("month")}-${item("day")}`, hour: Number(item("hour")), minute: Number(item("minute")) };
}
function telegramDateKey(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const item = type => parts.find(part => part.type === type)?.value || "";
  return `${item("year")}-${item("month")}-${item("day")}`;
}
function telegramBookingValues(booking) {
  const dateTime = telegramDateTime(booking.starts_at, booking.timezone);
  return { customerName: booking.customer_name, date: dateTime.date, time: dateTime.time, location: booking.location_name, room: booking.room_name, productName: booking.product_name || "Квест", players: booking.players };
}
async function telegramBookingById(bookingId) {
  return (await db.query(`SELECT b.*,r.name room_name,r.location_id,l.name location_name,l.timezone
    FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN locations l ON l.id=r.location_id WHERE b.id=$1`, [bookingId])).rows[0] || null;
}
async function sendTelegramBookingNotification(booking, templateName, keyPrefix) {
  const settings = await telegramSettings();
  const recipients = await telegramRecipients(booking.location_id);
  const text = renderTelegramTemplate(settings[templateName], telegramBookingValues(booking));
  const replyMarkup = booking.confirmed ? undefined : { inline_keyboard: [[{ text: "✅ Подтвердить бронь", callback_data: `confirm:${booking.id}` }]] };
  for (const recipient of recipients) {
    const keyName = `${keyPrefix}:${booking.id}`;
    const alreadySent = await db.query("SELECT 1 FROM telegram_notification_log WHERE user_id=$1 AND notification_key=$2", [recipient.user_id, keyName]);
    if (alreadySent.rowCount) continue;
    try {
      await telegramBot.sendMessage(recipient.chat_id, text, replyMarkup);
      await db.query("INSERT INTO telegram_notification_log(user_id,notification_key) VALUES($1,$2) ON CONFLICT DO NOTHING", [recipient.user_id, keyName]);
    } catch (error) { console.error("Telegram booking notification failed", { bookingId: booking.id, userId: recipient.user_id, error: error.message }); }
  }
}
async function sendCameraMediaToTelegram(chatId, camera, isClip) {
  const state = cameraEventEngine.getState(camera.id);
  const peopleCount = state?.peopleCount ?? 0;
  const occupied = state?.occupied ? "Да" : "Нет";
  const timeStr = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const roomTitle = camera.room_name || camera.name || "Камера";

  if (isClip) {
    const clipBuffer = await localVisionService.getRecentClip(camera.id, 10).catch(() => null);
    if (clipBuffer) {
      const caption = `<b>🎬 Клип: ${escapeTelegramHtml(roomTitle)}</b>\nЛокация: ${escapeTelegramHtml(camera.location_name || "—")}\nЛюдей: <b>${peopleCount}</b> | Занято: <b>${occupied}</b>\nВремя: <code>${timeStr}</code>`;
      await telegramBot.sendAnimation(chatId, clipBuffer, caption);
      return true;
    }
  }

  const frame = cameraFrameProvider.getLatestFrame(camera.id) ||
    await localVisionService.getLatestFrame(camera.id).catch(() => null);

  if (frame?.buffer) {
    const caption = `<b>📸 Снимок: ${escapeTelegramHtml(roomTitle)}</b>\nЛокация: ${escapeTelegramHtml(camera.location_name || "—")}\nЛюдей: <b>${peopleCount}</b> | Занято: <b>${occupied}</b>\nВремя: <code>${timeStr}</code>`;
    await telegramBot.sendPhoto(chatId, frame.buffer, caption);
    return true;
  }

  await telegramBot.sendMessage(
    chatId,
    `Камера в «<b>${escapeTelegramHtml(roomTitle)}</b>» подключена, но кадры ещё не поступили в буфер. Повторите запрос через несколько секунд.`
  );
  return true;
}

async function telegramHandleAiCommand(connection, message, text) {
  const clipMatch = text.match(/(?:(?:пришли|покажи|дай|сделай|отправь)\s+)?(?:клип|видео|gif|animation|clip)(?:\s+(?:из|с|в|от|комнаты))?\s+([a-zA-Zа-яА-Я0-9_\s-]+)/i) ||
    text.match(/^\/clip(?:\s+([a-zA-Zа-яА-Я0-9_\s-]+))?/i);

  const photoMatch = text.match(/(?:(?:пришли|покажи|дай|сделай|отправь)\s+)?(?:снимок|фото|кадр|snapshot|photo|pic)(?:\s+(?:из|с|в|от|комнаты))?\s+([a-zA-Zа-яА-Я0-9_\s-]+)/i) ||
    text.match(/^\/(?:photo|snapshot)(?:\s+([a-zA-Zа-яА-Я0-9_\s-]+))?/i);

  const statusMatch = text.match(/(?:что\s+(?:в|с)|статус|состояние)\s+(?:комнат[еы]\s+)?([a-zA-Zа-яА-Я0-9_\s-]+)/i) ||
    text.match(/^\/status(?:\s+([a-zA-Zа-яА-Я0-9_\s-]+))?/i);

  if (!clipMatch && !photoMatch && !statusMatch) {
    return false;
  }

  const isClip = Boolean(clipMatch);
  const roomQuery = (clipMatch?.[1] || photoMatch?.[1] || statusMatch?.[1] || "").trim();

  if (!roomQuery) {
    await telegramBot.sendMessage(
      message.chat.id,
      "Укажите название комнаты, например:\n• <i>Пришли снимок из Krampus</i>\n• <i>Клип из Krampus</i>\n• <code>/photo Krampus</code>"
    );
    return true;
  }

  const { rows: rooms } = await db.query(
    `SELECT r.*, l.name as location_name
     FROM rooms r
     JOIN locations l ON l.id = r.location_id
     WHERE lower(r.name) = lower($1) OR lower(r.name) LIKE lower($2)
     ORDER BY (lower(r.name) = lower($1)) DESC, r.name ASC
     LIMIT 5`,
    [roomQuery, `%${roomQuery}%`]
  );

  let targetCamera = null;

  if (rooms.length > 0) {
    const room = rooms[0];
    if (!(await telegramUserCanAccessLocation(connection.user_id, connection.role, room.location_id))) {
      await telegramBot.sendMessage(message.chat.id, "У вас нет доступа к локации этой комнаты.");
      return true;
    }

    const { rows: cams } = await db.query(
      `SELECT * FROM cameras WHERE room_id = $1 ORDER BY ai_enabled DESC, created_at ASC LIMIT 1`,
      [room.id]
    );

    if (!cams.length) {
      await telegramBot.sendMessage(
        message.chat.id,
        `В комнате «<b>${escapeTelegramHtml(room.name)}</b>» нет подключенных камер.`
      );
      return true;
    }

    targetCamera = cams[0];
    targetCamera.room_name = room.name;
    targetCamera.location_name = room.location_name;
  } else {
    const { rows: cams } = await db.query(
      `SELECT c.*, COALESCE(c.location_id, r.location_id) as location_id, r.name as room_name, l.name as location_name
       FROM cameras c
       LEFT JOIN rooms r ON r.id = c.room_id
       LEFT JOIN locations l ON l.id = COALESCE(c.location_id, r.location_id)
       WHERE lower(c.name) = lower($1) OR lower(c.name) LIKE lower($2)
       LIMIT 5`,
      [roomQuery, `%${roomQuery}%`]
    );

    if (cams.length > 0) {
      const cam = cams[0];
      if (!(await telegramUserCanAccessLocation(connection.user_id, connection.role, cam.location_id))) {
        await telegramBot.sendMessage(message.chat.id, "У вас нет доступа к этой локации.");
        return true;
      }
      targetCamera = cam;
    }
  }

  if (!targetCamera) {
    const { rows: allRooms } = await db.query(
      `SELECT r.name, l.name as location_name, r.location_id FROM rooms r JOIN locations l ON l.id=r.location_id ORDER BY l.name, r.name`
    );
    const accessible = [];
    for (const r of allRooms) {
      if (await telegramUserCanAccessLocation(connection.user_id, connection.role, r.location_id)) {
        accessible.push(`• ${escapeTelegramHtml(r.name)} (${escapeTelegramHtml(r.location_name)})`);
      }
    }
    await telegramBot.sendMessage(
      message.chat.id,
      `Комната «<b>${escapeTelegramHtml(roomQuery)}</b>» не найдена.\n\n<b>Доступные комнаты:</b>\n${accessible.slice(0, 10).join("\n") || "Нет доступных комнат"}`
    );
    return true;
  }

  return await sendCameraMediaToTelegram(message.chat.id, targetCamera, isClip);
}

async function telegramHandleMessage(message) {
  const text = String(message.text || "").trim();
  const startCode = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{20,120}))?$/)?.[1];
  if (!startCode) {
    const connection = (await db.query(
      `SELECT tc.user_id,u.display_name,role.name role FROM telegram_connections tc JOIN users u ON u.id=tc.user_id JOIN roles role ON role.id=u.role_id WHERE (tc.telegram_user_id=$1 OR tc.chat_id=$2) AND u.is_active=true`,
      [message.from.id, message.chat.id]
    )).rows[0];

    if (connection) {
      const handled = await telegramHandleAiCommand(connection, message, text);
      if (handled) return;
    }

    if (/^\/(help|start)/.test(text)) {
      const extraHelp = connection ? "\n\n<b>AI Видеонаблюдение:</b>\n• «<i>Пришли снимок из Krampus</i>» или <code>/photo Krampus</code>\n• «<i>Клип из Krampus</i>» или <code>/clip Krampus</code>\n• «<i>Статус Krampus</i>»" : "";
      await telegramBot.sendMessage(message.chat.id, `<b>QuestControl</b>\n\nОткройте в панели раздел «Telegram» и нажмите «Подключить». Там появится персональная ссылка для привязки аккаунта.${extraHelp}`);
      return;
    }
    return;
  }
  if (message.chat?.type !== "private") return telegramBot.sendMessage(message.chat.id, "Для защиты данных привяжите аккаунт в личном чате с ботом.");
  const codeHash = crypto.createHash("sha256").update(startCode).digest("hex");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const link = (await client.query("DELETE FROM telegram_link_codes WHERE code_hash=$1 AND expires_at>now() RETURNING user_id", [codeHash])).rows[0];
    if (!link) { await client.query("ROLLBACK"); return telegramBot.sendMessage(message.chat.id, "Эта ссылка уже использована или истекла. Создайте новую в панели QuestControl."); }
    await client.query("DELETE FROM telegram_connections WHERE (telegram_user_id=$1 OR chat_id=$2) AND user_id<>$3", [message.from.id, message.chat.id, link.user_id]);
    await client.query(`INSERT INTO telegram_connections(user_id,telegram_user_id,chat_id,username,first_name,linked_at,last_seen_at)
      VALUES($1,$2,$3,$4,$5,now(),now())
      ON CONFLICT(user_id) DO UPDATE SET telegram_user_id=excluded.telegram_user_id,chat_id=excluded.chat_id,username=excluded.username,first_name=excluded.first_name,linked_at=now(),last_seen_at=now()`, [link.user_id, message.from.id, message.chat.id, message.from.username || null, message.from.first_name || null]);
    await client.query("COMMIT");
    await telegramBot.sendMessage(message.chat.id, "<b>✅ Telegram подключён</b>\n\nТеперь сюда будут приходить брони, напоминания и сообщения о ваших сменах.");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function telegramHandleConfirmation(query) {
  const bookingId = String(query.data || "").match(/^confirm:([0-9a-f-]{36})$/i)?.[1];
  if (!bookingId || !query.message?.chat?.id) return telegramBot.answerCallbackQuery(query.id, "Кнопка больше не действует.");
  const connection = (await db.query(`SELECT tc.user_id,role.name role FROM telegram_connections tc JOIN users u ON u.id=tc.user_id JOIN roles role ON role.id=u.role_id WHERE tc.telegram_user_id=$1 AND tc.chat_id=$2 AND u.is_active=true`, [query.from.id, query.message.chat.id])).rows[0];
  if (!connection) return telegramBot.answerCallbackQuery(query.id, "Сначала подключите этот Telegram в панели.");
  const booking = (await db.query("SELECT b.id,b.confirmed,b.starts_at,b.customer_name,r.location_id,r.name room_name,l.name location_name FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN locations l ON l.id=r.location_id WHERE b.id=$1", [bookingId])).rows[0];
  if (!booking || !(await telegramUserCanAccessLocation(connection.user_id, connection.role, booking.location_id))) return telegramBot.answerCallbackQuery(query.id, "Нет доступа к этой брони.");
  if (new Date(booking.starts_at) <= new Date()) return telegramBot.answerCallbackQuery(query.id, "Эта бронь уже началась.");
  if (booking.confirmed) return telegramBot.answerCallbackQuery(query.id, "Бронь уже подтверждена.");
  await db.query("UPDATE bookings SET confirmed=true WHERE id=$1", [booking.id]);
  await db.query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,request_id,before_state,after_state) VALUES($1,'booking.confirmation.update','booking',$2,$3,$4,$5)", [connection.user_id, booking.id, crypto.randomUUID(), { confirmed: false, source: "telegram" }, { confirmed: true, source: "telegram" }]);
  void sendTelegramImportantLog("bookingConfirmed", "Бронь подтверждена", [["Клиент", booking.customer_name], ["Локация", booking.location_name], ["Комната", booking.room_name], ["Источник", "Telegram"]]);
  await telegramBot.answerCallbackQuery(query.id, "Бронь подтверждена ✅");
  await telegramBot.clearInlineKeyboard(query.message.chat.id, query.message.message_id).catch(error => console.error("Telegram confirmation button cleanup failed", error.message));
}
async function telegramHandleUpdate(update) {
  try {
    if (update.message) await telegramHandleMessage(update.message);
    if (update.callback_query) await telegramHandleConfirmation(update.callback_query);
  } catch (error) {
    console.error("Telegram update processing failed", error.message);
    if (update.callback_query?.id) await telegramBot.answerCallbackQuery(update.callback_query.id, "Не удалось подтвердить бронь. Попробуйте ещё раз.").catch(()=>{});
  }
}
async function telegramNotificationsOnce() {
  if (!telegramBot?.enabled) return;
  const rows = (await db.query(`SELECT b.*,r.name room_name,r.location_id,l.name location_name,l.timezone
    FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN locations l ON l.id=r.location_id
    WHERE b.starts_at>now() AND b.ends_at>now()`)).rows;
  const now=Date.now();
  for (const booking of rows) {
    const startsAt=new Date(booking.starts_at).getTime();
    if (!booking.confirmed && startsAt <= now + 24 * 60 * 60 * 1000) await sendTelegramBookingNotification(booking, "dayBefore", "booking:day-before");
    if (!booking.confirmed && startsAt <= now + 2 * 60 * 60 * 1000) await sendTelegramBookingNotification(booking, "twoHours", "booking:two-hours");
  }
  const shifts = (await db.query(`SELECT w.*,u.display_name,l.name location_name,l.timezone,tc.chat_id
    FROM work_shifts w JOIN users u ON u.id=w.user_id AND u.is_active=true JOIN locations l ON l.id=w.location_id JOIN telegram_connections tc ON tc.user_id=u.id
    WHERE w.ends_at>now()`)).rows;
  const settings = await telegramSettings();
  for (const shift of shifts) {
    const local = telegramLocalClock(shift.timezone);
    const shiftDate = telegramDateKey(shift.starts_at, shift.timezone);
    if (local.hour < 9 || shiftDate !== local.date) continue;
    const start = telegramDateTime(shift.starts_at, shift.timezone).time;
    const end = telegramDateTime(shift.ends_at, shift.timezone).time;
    const notificationKey = `shift:today:${shift.id}:${local.date}`;
    if ((await db.query("SELECT 1 FROM telegram_notification_log WHERE user_id=$1 AND notification_key=$2", [shift.user_id, notificationKey])).rowCount) continue;
    try {
      await telegramBot.sendMessage(shift.chat_id, renderTelegramTemplate(settings.shiftToday, { shiftTime: `${start}–${end}`, location: shift.location_name, responsibility: shift.responsibility }));
      await db.query("INSERT INTO telegram_notification_log(user_id,notification_key) VALUES($1,$2) ON CONFLICT DO NOTHING", [shift.user_id, notificationKey]);
    } catch (error) { console.error("Telegram shift notification failed", { shiftId: shift.id, userId: shift.user_id, error: error.message }); }
  }
}

async function recordCheckinFailure(req, bookingId, details) {
  try {
    await audit(req,"checkin.participant.submit.failed","external_booking",bookingId||null,null,details);
  } catch (error) {
    console.error("Could not record check-in failure",{requestId:req.requestId,error:error?.message});
  }
}

app.get("/health/live", (_, res) => res.json({ status: "ok", service: "quest-control-api" }));
app.get("/health/ready", async (_, res) => {
  try { await Promise.all([db.query("SELECT 1"), redis.ping()]); res.json({ status: "ready", postgres: "ok", redis: "ok" }); }
  catch (error) { res.status(503).json({ status: "not-ready", error: error.message }); }
});

async function agentDownloadAuth(req,res,next) {
  const agentId=req.get("x-agent-id");
  const token=req.get("authorization")?.replace(/^Bearer /,"");
  if(!agentId||!token) return res.status(401).json({error:"AGENT_UNAUTHORIZED"});
  const expected=await redis.get(`agent-token:${agentId}`);
  const actual=crypto.createHash("sha256").update(token).digest("hex");
  if(!expected||expected.length!==actual.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(actual))) return res.status(401).json({error:"AGENT_UNAUTHORIZED"});
  req.agentId=agentId;
  next();
}
const roomAgentArchive=path.resolve(process.env.ROOM_AGENT_RELEASE_PATH||"/app/releases/room-agent.tar.gz");
function roomAgentRelease() {
  const packageInfo=JSON.parse(fs.readFileSync(process.env.ROOM_AGENT_PACKAGE_PATH||"/app/releases/room-agent-package.json","utf8"));
  const sha256=crypto.createHash("sha256").update(fs.readFileSync(roomAgentArchive)).digest("hex");
  return {version:packageInfo.version,channel:"stable",sha256,downloadUrl:"/api/agent-updates/room-agent/download"};
}
app.get("/agent-updates/room-agent/latest",agentDownloadAuth,(req,res)=>{
  if(req.query.channel&&req.query.channel!=="stable") return res.status(404).json({error:"UPDATE_CHANNEL_NOT_FOUND"});
  res.json(roomAgentRelease());
});
app.get("/agent-updates/room-agent/download",agentDownloadAuth,(_,res)=>res.sendFile(roomAgentArchive));

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
app.post("/auth/login", rateLimit({ windowMs: 15 * 60_000, limit: 10 }), async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const { rows } = await db.query("SELECT u.*,r.name role,r.permissions FROM users u JOIN roles r ON r.id=u.role_id WHERE lower(u.email)=lower($1) AND u.is_active=true", [parsed.data.email]);
  const user = rows[0];
  if (!user || !(await argon2.verify(user.password_hash, parsed.data.password))) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  const accessToken = await sign(user, env.JWT_ACCESS_SECRET, "15m");
  const refreshToken = await sign(user, env.JWT_REFRESH_SECRET, "7d");
  await db.query("UPDATE users SET refresh_token_hash=$1 WHERE id=$2", [await argon2.hash(refreshToken), user.id]);
  res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
});

app.post("/auth/refresh", async (req, res) => {
  try {
    const { payload } = await jwtVerify(req.body.refreshToken, key(env.JWT_REFRESH_SECRET));
    const { rows } = await db.query("SELECT u.*,r.name role,r.permissions FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 AND u.is_active=true", [payload.sub]);
    const user = rows[0];
    if (!user || !user.refresh_token_hash || !(await argon2.verify(user.refresh_token_hash, req.body.refreshToken))) throw new Error();
    res.json({ accessToken: await sign(user, env.JWT_ACCESS_SECRET, "15m") });
  } catch { res.status(401).json({ error: "INVALID_REFRESH_TOKEN" }); }
});

app.patch("/auth/password", auth, async (req,res) => {
  const input=z.object({currentPassword:z.string().min(1).max(200),newPassword:z.string().min(12).max(200)}).parse(req.body);
  const user=(await db.query("SELECT id,password_hash FROM users WHERE id=$1 AND is_active=true",[req.user.sub])).rows[0];
  if(!user || !(await argon2.verify(user.password_hash,input.currentPassword))) return res.status(400).json({error:"CURRENT_PASSWORD_INVALID"});
  await db.query("UPDATE users SET password_hash=$1,refresh_token_hash=NULL WHERE id=$2",[await argon2.hash(input.newPassword),req.user.sub]);
  await audit(req,"user.password.change","user",req.user.sub,null,{changed:true});
  res.status(204).end();
});

const shareTokenHash=token=>crypto.createHash("sha256").update(token).digest("hex");
app.post("/camera-shares",auth,permit("cameras:manage"),async(req,res)=>{
  const input=z.object({cameraIds:z.array(z.string().uuid()).min(1).max(24),expiresInHours:z.number().int().min(1).max(168).default(24)}).parse(req.body);
  const cameraIds=[...new Set(input.cameraIds)];
  for(const cameraId of cameraIds) if(!(await cameraAllowed(req,cameraId))) return res.status(403).json({error:"CAMERA_FORBIDDEN"});
  const token=crypto.randomBytes(32).toString("base64url");
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const share=(await client.query("INSERT INTO camera_shares(token_hash,created_by,expires_at) VALUES($1,$2,now()+($3||' hours')::interval) RETURNING id,expires_at",[shareTokenHash(token),req.user.sub,input.expiresInHours])).rows[0];
    for(const cameraId of cameraIds) await client.query("INSERT INTO camera_share_cameras(share_id,camera_id) VALUES($1,$2)",[share.id,cameraId]);
    await client.query("COMMIT");
    await audit(req,"camera.share.create","camera_share",share.id,null,{cameraIds,expiresAt:share.expires_at});
    res.status(201).json({id:share.id,token,expiresAt:share.expires_at,cameraIds});
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
});
app.get("/camera-shares",auth,permit("cameras:manage"),async(req,res)=>{
  const {rows}=await db.query(`SELECT s.id,s.expires_at,s.revoked_at,s.created_at,s.created_by,
    COALESCE(u.display_name,u.email,'Администратор') creator_name,
    COALESCE(array_agg(c.name ORDER BY c.name) FILTER(WHERE c.id IS NOT NULL),'{}') camera_names,
    COUNT(c.id)::int camera_count,
    (s.revoked_at IS NULL AND s.expires_at>now()) active
    FROM camera_shares s
    LEFT JOIN users u ON u.id=s.created_by
    LEFT JOIN camera_share_cameras sc ON sc.share_id=s.id
    LEFT JOIN cameras c ON c.id=sc.camera_id
    GROUP BY s.id,u.display_name,u.email ORDER BY s.created_at DESC LIMIT 200`);
  res.json(rows);
});
app.delete("/camera-shares/:id",auth,permit("cameras:manage"),async(req,res)=>{
  const share=(await db.query("UPDATE camera_shares SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id",[req.params.id])).rows[0];
  if(!share)return res.status(404).json({error:"SHARE_NOT_FOUND"});
  await audit(req,"camera.share.revoke","camera_share",share.id,null,{revoked:true});res.status(204).end();
});
app.post("/camera-shares/:token/access",rateLimit({windowMs:60_000,limit:30}),async(req,res)=>{
  const share=(await db.query(`SELECT s.id,s.expires_at,array_agg(sc.camera_id::text) camera_ids FROM camera_shares s
    JOIN camera_share_cameras sc ON sc.share_id=s.id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() GROUP BY s.id`,[shareTokenHash(req.params.token)])).rows[0];
  if(!share)return res.status(404).json({error:"SHARE_UNAVAILABLE"});
  const guest={id:`share:${share.id}`,role:"CAMERA_GUEST",permissions:["cameras:read"],cameraIds:share.camera_ids,shareId:share.id};
  res.json({accessToken:await sign(guest,env.JWT_ACCESS_SECRET,"15m"),expiresAt:share.expires_at});
});

app.get("/users", auth, permit("users:manage"), async (_, res) => {
  const { rows } = await db.query(`
    SELECT u.id,u.email,u.display_name,u.is_active,u.created_at,r.name AS role,
           COALESCE(array_agg(DISTINCT ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL),'{}') AS location_ids,
           COALESCE(array_agg(DISTINCT uc.camera_id) FILTER (WHERE uc.camera_id IS NOT NULL),'{}') AS camera_ids
    FROM users u
    JOIN roles r ON r.id=u.role_id
    LEFT JOIN user_locations ul ON ul.user_id=u.id
    LEFT JOIN user_cameras uc ON uc.user_id=u.id
    WHERE u.deleted_at IS NULL
    GROUP BY u.id,r.name
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

const userInput = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(["OWNER", "ADMIN", "OPERATOR", "TECHNICIAN", "CAMERA_VIEWER"]),
  locationIds: z.array(z.string().uuid()).default([]),
  cameraIds: z.array(z.string().uuid()).default([]),
});

app.post("/users", auth, permit("users:manage"), async (req, res) => {
  const parsed = userInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
  const input = parsed.data;
  if ((await db.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [input.email])).rowCount) {
    return res.status(409).json({ error: "EMAIL_EXISTS" });
  }
  const role = (await db.query("SELECT id FROM roles WHERE name=$1", [input.role])).rows[0];
  if (!role) return res.status(400).json({ error: "INVALID_ROLE" });
  const client = await db.connect();
  let rows;
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query(
      `INSERT INTO users(email,password_hash,display_name,role_id)
       VALUES($1,$2,$3,$4)
       RETURNING id,email,display_name,is_active,created_at`,
      [input.email, await argon2.hash(input.password), input.displayName, role.id]
    ));
    for (const locationId of input.locationIds) {
      await client.query("INSERT INTO user_locations(user_id,location_id) VALUES($1,$2)", [rows[0].id, locationId]);
    }
    for (const cameraId of input.cameraIds) {
      await client.query("INSERT INTO user_cameras(user_id,camera_id) SELECT $1,id FROM cameras WHERE id=$2", [rows[0].id,cameraId]);
    }
    if(input.role==="CAMERA_VIEWER") await client.query(`
      INSERT INTO user_locations(user_id,location_id)
      SELECT DISTINCT $1,COALESCE(c.location_id,r.location_id) FROM user_cameras uc
      JOIN cameras c ON c.id=uc.camera_id LEFT JOIN rooms r ON r.id=c.room_id
      WHERE uc.user_id=$1 AND COALESCE(c.location_id,r.location_id) IS NOT NULL
      ON CONFLICT DO NOTHING`,[rows[0].id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  const user = { ...rows[0], role: input.role };
  await audit(req, "user.create", "user", user.id, null, user);
  res.status(201).json(user);
});

app.put("/users/:id/cameras", auth, permit("users:manage"), async (req,res) => {
  const {cameraIds}=z.object({cameraIds:z.array(z.string().uuid())}).parse(req.body);
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const target=(await client.query("SELECT u.id,r.name role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1",[req.params.id])).rows[0];
    if(!target){await client.query("ROLLBACK");return res.status(404).json({error:"USER_NOT_FOUND"});}
    if(target.role!=="CAMERA_VIEWER"){await client.query("ROLLBACK");return res.status(409).json({error:"CAMERA_VIEWER_REQUIRED"});}
    await client.query("DELETE FROM user_cameras WHERE user_id=$1",[req.params.id]);
    for(const cameraId of [...new Set(cameraIds)]) await client.query("INSERT INTO user_cameras(user_id,camera_id) SELECT $1,id FROM cameras WHERE id=$2",[req.params.id,cameraId]);
    await client.query("DELETE FROM user_locations WHERE user_id=$1",[req.params.id]);
    await client.query(`INSERT INTO user_locations(user_id,location_id)
      SELECT DISTINCT $1,COALESCE(c.location_id,r.location_id) FROM user_cameras uc
      JOIN cameras c ON c.id=uc.camera_id LEFT JOIN rooms r ON r.id=c.room_id
      WHERE uc.user_id=$1 AND COALESCE(c.location_id,r.location_id) IS NOT NULL`,[req.params.id]);
    await client.query("COMMIT");
    await audit(req,"user.cameras.update","user",req.params.id,null,{cameraIds});
    res.json({cameraIds});
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
});

app.put("/users/:id/locations", auth, permit("users:manage"), async (req, res) => {
  const { locationIds } = z.object({ locationIds:z.array(z.string().uuid()) }).parse(req.body);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!(await client.query("SELECT 1 FROM users WHERE id=$1", [req.params.id])).rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"USER_NOT_FOUND" });
    }
    await client.query("DELETE FROM user_locations WHERE user_id=$1", [req.params.id]);
    for (const locationId of locationIds) await client.query("INSERT INTO user_locations(user_id,location_id) VALUES($1,$2)", [req.params.id,locationId]);
    await client.query("COMMIT");
    await audit(req,"user.locations.update","user",req.params.id,null,{locationIds});
    res.json({ locationIds });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

app.patch("/users/:id/status", auth, permit("users:manage"), async (req, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  if (req.params.id === req.user.sub && !parsed.data.isActive) {
    return res.status(409).json({ error: "CANNOT_DISABLE_SELF" });
  }
  const before = (await db.query("SELECT id,email,display_name,is_active FROM users WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const { rows } = await db.query(
    "UPDATE users SET is_active=$1,refresh_token_hash=CASE WHEN $1 THEN refresh_token_hash ELSE NULL END WHERE id=$2 RETURNING id,email,display_name,is_active",
    [parsed.data.isActive, req.params.id]
  );
  await audit(req, parsed.data.isActive ? "user.enable" : "user.disable", "user", req.params.id, before, rows[0]);
  res.json(rows[0]);
});

app.patch("/users/:id", auth, async (req,res) => {
  if(!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  const parsed=z.object({
    displayName:z.string().trim().min(2).max(120),
    role:z.enum(["OWNER","ADMIN","OPERATOR","TECHNICIAN","CAMERA_VIEWER"]),
    newPassword:z.string().min(12).max(200).optional(),
    isActive:z.boolean(),
    locationIds:z.array(z.string().uuid())
  }).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:"INVALID_INPUT",details:parsed.error.flatten()});
  const input=parsed.data;
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const before=(await client.query("SELECT u.id,u.email,u.display_name,r.name role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 FOR UPDATE",[req.params.id])).rows[0];
    if(!before){await client.query("ROLLBACK");return res.status(404).json({error:"USER_NOT_FOUND"});}
    if(before.role==="OWNER"&&(input.role!=="OWNER"||!input.isActive)){
      const owners=await client.query("SELECT count(*)::int count FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='OWNER' AND u.is_active=true");
      if(owners.rows[0].count<=1){await client.query("ROLLBACK");return res.status(409).json({error:"LAST_OWNER"});}
    }
    const role=(await client.query("SELECT id FROM roles WHERE name=$1",[input.role])).rows[0];
    if(!role){await client.query("ROLLBACK");return res.status(400).json({error:"INVALID_ROLE"});}
    if(req.params.id===req.user.sub&&!input.isActive){await client.query("ROLLBACK");return res.status(409).json({error:"CANNOT_DISABLE_SELF"});}
    const passwordHash=input.newPassword?await argon2.hash(input.newPassword):null;
    const updated=(await client.query(`UPDATE users SET display_name=$1,role_id=$2,is_active=$3,
      password_hash=COALESCE($4,password_hash),refresh_token_hash=CASE WHEN $4 IS NULL THEN refresh_token_hash ELSE NULL END
      WHERE id=$5 RETURNING id,email,display_name,is_active,created_at`,[input.displayName,role.id,input.isActive,passwordHash,req.params.id])).rows[0];
    await client.query("DELETE FROM user_locations WHERE user_id=$1",[req.params.id]);
    for(const locationId of [...new Set(input.locationIds)]) await client.query("INSERT INTO user_locations(user_id,location_id) SELECT $1,id FROM locations WHERE id=$2",[req.params.id,locationId]);
    await client.query("COMMIT");
    const result={...updated,role:input.role};
    await audit(req,"user.update","user",req.params.id,before,{...result,passwordChanged:Boolean(input.newPassword)});
    res.json(result);
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
});

app.delete("/users/:id",auth,async(req,res)=>{
  if(!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  if(req.params.id===req.user.sub) return res.status(409).json({error:"CANNOT_DELETE_SELF"});
  const target=(await db.query("SELECT u.id,u.email,u.display_name,r.name role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 AND u.deleted_at IS NULL",[req.params.id])).rows[0];
  if(!target) return res.status(404).json({error:"USER_NOT_FOUND"});
  if(target.role==="OWNER"){
    const owners=await db.query("SELECT count(*)::int count FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='OWNER' AND u.is_active=true AND u.deleted_at IS NULL");
    if(owners.rows[0].count<=1) return res.status(409).json({error:"LAST_OWNER"});
  }
  await db.query("UPDATE users SET is_active=false,deleted_at=now(),refresh_token_hash=NULL WHERE id=$1",[req.params.id]);
  await audit(req,"user.delete","user",req.params.id,target,{deleted:true});
  res.status(204).end();
});

app.patch("/users/:id/password", auth, permit("users:manage"), async (req,res) => {
  const { newPassword }=z.object({newPassword:z.string().min(12).max(200)}).parse(req.body);
  if(req.params.id===req.user.sub) return res.status(409).json({error:"USE_SELF_PASSWORD_CHANGE"});
  const target=(await db.query("SELECT u.id,u.email,r.name AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1",[req.params.id])).rows[0];
  if(!target) return res.status(404).json({error:"USER_NOT_FOUND"});
  const rank={TECHNICIAN:1,OPERATOR:1,ADMIN:2,OWNER:3};
  if((rank[req.user.role]||0)<=(rank[target.role]||0)) return res.status(403).json({error:"NOT_SUBORDINATE"});
  await db.query("UPDATE users SET password_hash=$1,refresh_token_hash=NULL WHERE id=$2",[await argon2.hash(newPassword),target.id]);
  await audit(req,"user.password.reset","user",target.id,null,{resetBy:req.user.sub});
  res.status(204).end();
});

async function dashboardExternalBookings(locations,localBookings) {
  const localExternalIds=new Set(localBookings.map(booking=>booking.external_id).filter(Boolean).map(String));
  const batches=await Promise.allSettled(locations.map(async location=>{
    const bookings=await fetchTimeToGrowBookings(location.external_id,location.today);
    const ids=bookings.map(booking=>booking.id);
    const confirmations=ids.length ? (await db.query(
      "SELECT external_booking_id,confirmed FROM external_booking_confirmations WHERE club_id=$1 AND external_booking_id=ANY($2::text[])",
      [location.external_id,ids]
    )).rows : [];
    const confirmedById=new Map(confirmations.map(row=>[row.external_booking_id,row.confirmed]));
    return bookings
      .filter(booking=>!localExternalIds.has(String(booking.id)))
      .map(booking=>({
        id:`ttg:${booking.id}`,
        external_id:booking.id,
        external_source:"TIME_TO_GROW",
        customer_name:booking.owner?.name||booking.owner?.email||"Бронь",
        room_name:booking.product?.effective_name||location.name,
        players:Number(booking.size)||0,
        starts_at:`${booking.start.date}T${booking.start.time}`,
        ends_at:`${booking.start.date}T${booking.end?.time||booking.start.time}`,
        confirmed:confirmedById.get(booking.id)||false,
      }));
  }));
  for(const batch of batches){
    if(batch.status==="rejected") console.error("dashboard external bookings",batch.reason);
  }
  return batches.flatMap(batch=>batch.status==="fulfilled"?batch.value:[]);
}

app.get("/dashboard", auth, async (req, res) => {
  const scope = isOwner(req) ? { clause:"TRUE", values:[] } : { clause:"r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)", values:[req.user.sub] };
  const locationScope=isOwner(req)?{clause:"TRUE",values:[]}:{clause:"l.id IN (SELECT location_id FROM user_locations WHERE user_id=$1)",values:[req.user.sub]};
  const [rooms, bookings, devices, myShifts, statistics, recentDays,externalLocations] = await Promise.all([
    db.query(`SELECT r.*,l.name location_name,
      COALESCE((SELECT d.status FROM devices d WHERE d.room_id=r.id ORDER BY d.last_seen DESC NULLS LAST LIMIT 1),r.status) live_status
      FROM rooms r JOIN locations l ON l.id=r.location_id WHERE ${scope.clause} ORDER BY r.name`,scope.values),
    db.query(`SELECT b.*,r.name room_name FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN locations l ON l.id=r.location_id
      WHERE (b.starts_at AT TIME ZONE l.timezone)::date=(now() AT TIME ZONE l.timezone)::date
      AND ${scope.clause} ORDER BY starts_at`,scope.values),
    db.query(`SELECT d.status,count(*)::int total FROM devices d JOIN rooms r ON r.id=d.room_id WHERE ${scope.clause} GROUP BY d.status`,scope.values),
    db.query(`SELECT w.id,w.starts_at,w.ends_at,w.responsibility,l.name location_name
      FROM work_shifts w JOIN locations l ON l.id=w.location_id
      WHERE w.user_id=$1 AND (w.starts_at AT TIME ZONE l.timezone)::date=(now() AT TIME ZONE l.timezone)::date
      ORDER BY w.starts_at`,[req.user.sub]),
    db.query(`WITH scoped_bookings AS (
      SELECT b.* FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE ${scope.clause}
    ) SELECT
      count(*) FILTER (WHERE b.starts_at>=current_date-interval '29 days' AND b.starts_at<current_date+interval '1 day')::int bookings_30d,
      COALESCE(sum(b.players) FILTER (WHERE b.starts_at>=current_date-interval '29 days' AND b.starts_at<current_date+interval '1 day'),0)::int customers_30d,
      COALESCE(sum(b.amount_cents) FILTER (WHERE b.starts_at>=current_date-interval '29 days' AND b.starts_at<current_date+interval '1 day'),0)::bigint revenue_cents_30d,
      count(*) FILTER (WHERE b.starts_at>=current_date AND b.starts_at<current_date+interval '7 days')::int upcoming_7d,
      (SELECT count(*)::int FROM sessions s JOIN scoped_bookings sb ON sb.id=s.booking_id
        WHERE s.started_at>=current_date-interval '29 days' AND s.started_at<current_date+interval '1 day') sessions_30d
      FROM scoped_bookings b`,scope.values),
    db.query(`SELECT day::date,
      count(b.id) FILTER (WHERE ${scope.clause})::int bookings
      FROM generate_series(current_date-interval '6 days',current_date,interval '1 day') AS days(day)
      LEFT JOIN bookings b ON b.starts_at::date=day::date
      LEFT JOIN rooms r ON r.id=b.room_id
      GROUP BY day ORDER BY day`,scope.values),
    db.query(`SELECT l.id,l.name,l.timezone,l.external_id,
      to_char(now() AT TIME ZONE l.timezone,'YYYY-MM-DD') today
      FROM locations l WHERE l.external_id IS NOT NULL AND ${locationScope.clause}`,
      locationScope.values)
  ]);
  const externalBookings=await dashboardExternalBookings(externalLocations.rows,bookings.rows);
  const dashboardBookings=[...bookings.rows,...externalBookings]
    .sort((left,right)=>new Date(left.starts_at)-new Date(right.starts_at));
  res.json({ rooms:rooms.rows, bookings:dashboardBookings, deviceSummary:devices.rows, myShifts:myShifts.rows,
    statistics:statistics.rows[0], recentDays:recentDays.rows });
});

app.get("/bookings", auth, permit("bookings:read"), async (req, res) => {
  const scoped = isOwner(req) ? { clause:"TRUE", values:[] } : { clause:"r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)", values:[req.user.sub] };
  const { rows } = await db.query(`
    SELECT b.*,r.name room_name,s.id session_id,s.status session_status
    FROM bookings b
    JOIN rooms r ON r.id=b.room_id
    LEFT JOIN sessions s ON s.booking_id=b.id
    WHERE ${scoped.clause} AND b.external_source IS NULL
    ORDER BY b.starts_at DESC LIMIT 250
  `,scoped.values);
  res.json(rows);
});

app.patch("/bookings/:id/confirmation", auth, permit("bookings:read"), async (req,res) => {
  const parsed=z.object({confirmed:z.boolean()}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:"INVALID_INPUT"});
  const booking=(await db.query(`SELECT b.id,b.confirmed,b.customer_name,r.location_id,r.name room_name,l.name location_name FROM bookings b JOIN rooms r ON r.id=b.room_id JOIN locations l ON l.id=r.location_id WHERE b.id=$1`,[req.params.id])).rows[0];
  if(!booking) return res.status(404).json({error:"BOOKING_NOT_FOUND"});
  if(!(await locationAllowed(req,booking.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const updated=(await db.query("UPDATE bookings SET confirmed=$1 WHERE id=$2 RETURNING id,confirmed",[parsed.data.confirmed,booking.id])).rows[0];
  await audit(req,"booking.confirmation.update","booking",booking.id,{confirmed:booking.confirmed},updated);
  if(updated.confirmed&&!booking.confirmed) void sendTelegramImportantLog("bookingConfirmed", "Бронь подтверждена", [["Клиент", booking.customer_name], ["Локация", booking.location_name], ["Комната", booking.room_name]]);
  res.json(updated);
});

app.get("/work-schedules",auth,async(req,res)=>{
  const parsed=z.object({from:z.string().date(),to:z.string().date()}).safeParse(req.query);
  if(!parsed.success || parsed.data.from>parsed.data.to) return res.status(400).json({error:"INVALID_DATE_RANGE"});
  const scope=isOwner(req)?{clause:"TRUE",values:[parsed.data.from,parsed.data.to]}:{clause:"w.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$3)",values:[parsed.data.from,parsed.data.to,req.user.sub]};
  const {rows}=await db.query(`SELECT w.*,u.display_name user_name,l.name location_name FROM work_shifts w JOIN users u ON u.id=w.user_id JOIN locations l ON l.id=w.location_id WHERE w.starts_at < ($2::date + interval '1 day') AND w.ends_at >= $1::date AND ${scope.clause} ORDER BY w.starts_at,u.display_name`,scope.values);
  res.json(rows);
});

const canUseWorkTime = req => ["OWNER","ADMIN","OPERATOR"].includes(req.user?.role);
const requireWorkTime = (req,res,next) => canUseWorkTime(req) ? next() : res.status(403).json({error:"WORK_TIME_FORBIDDEN"});
const requireScheduleManager = (req,res,next) => req.user?.role === "OPERATOR" ? res.status(403).json({error:"SCHEDULE_EDIT_FORBIDDEN"}) : next();
async function canRecordWorkTimeFor(req,userId,locationId) {
  if (isOwner(req)) return true;
  if (req.user?.role === "OPERATOR") return userId === req.user.sub;
  if (req.user?.role !== "ADMIN") return false;
  return Boolean((await db.query("SELECT 1 FROM user_locations WHERE user_id=$1 AND location_id=$2",[userId,locationId])).rowCount);
}

app.get("/work-time-options",auth,requireWorkTime,async(req,res)=>{
  const locations=isOwner(req)
    ? (await db.query("SELECT id,name FROM locations ORDER BY name")).rows
    : (await db.query("SELECT l.id,l.name FROM locations l JOIN user_locations ul ON ul.location_id=l.id WHERE ul.user_id=$1 ORDER BY l.name",[req.user.sub])).rows;
  const users=isOwner(req)
    ? (await db.query(`SELECT u.id,u.display_name,u.is_active,COALESCE(array_agg(ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL),'{}') location_ids
        FROM users u LEFT JOIN user_locations ul ON ul.user_id=u.id WHERE u.is_active=true AND u.deleted_at IS NULL GROUP BY u.id ORDER BY u.display_name`)).rows
    : req.user?.role === "OPERATOR"
      ? (await db.query(`SELECT u.id,u.display_name,u.is_active,COALESCE(array_agg(ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL),'{}') location_ids
          FROM users u LEFT JOIN user_locations ul ON ul.user_id=u.id WHERE u.id=$1 AND u.is_active=true GROUP BY u.id`,[req.user.sub])).rows
      : (await db.query(`SELECT u.id,u.display_name,u.is_active,COALESCE(array_agg(ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL),'{}') location_ids
          FROM users u LEFT JOIN user_locations ul ON ul.user_id=u.id
          WHERE u.is_active=true AND u.deleted_at IS NULL AND EXISTS(
            SELECT 1 FROM user_locations target_location
            WHERE target_location.user_id=u.id AND target_location.location_id IN (
              SELECT location_id FROM user_locations WHERE user_id=$1
            )
          ) GROUP BY u.id ORDER BY u.display_name`,[req.user.sub])).rows;
  res.json({users,locations});
});

app.post("/work-schedules",auth,permit("users:manage"),requireScheduleManager,async(req,res)=>{
  const parsed=z.object({userId:z.string().uuid(),locationId:z.string().uuid(),startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),responsibility:z.string().trim().min(1).max(300)}).safeParse(req.body);
  if(!parsed.success || new Date(parsed.data?.endsAt||0)<=new Date(parsed.data?.startsAt||0)) return res.status(400).json({error:"INVALID_INPUT"});
  const input=parsed.data;
  if(!(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active=true",[input.userId])).rowCount) return res.status(404).json({error:"USER_NOT_FOUND"});
  const overlap=(await db.query("SELECT 1 FROM work_shifts WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2",[input.userId,input.startsAt,input.endsAt])).rowCount;
  if(overlap) return res.status(409).json({error:"SHIFT_OVERLAP"});
  const shift=(await db.query("INSERT INTO work_shifts(user_id,location_id,starts_at,ends_at,responsibility,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[input.userId,input.locationId,input.startsAt,input.endsAt,input.responsibility,req.user.sub])).rows[0];
  await audit(req,"work_shift.create","work_shift",shift.id,null,shift);
  res.status(201).json(shift);
});

app.patch("/work-schedules/:id",auth,permit("users:manage"),requireScheduleManager,async(req,res)=>{
  const parsed=z.object({userId:z.string().uuid(),locationId:z.string().uuid(),startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),responsibility:z.string().trim().min(1).max(300)}).safeParse(req.body);
  if(!parsed.success || new Date(parsed.data?.endsAt||0)<=new Date(parsed.data?.startsAt||0)) return res.status(400).json({error:"INVALID_INPUT"});
  const input=parsed.data;
  const existing=(await db.query("SELECT w.*,l.name location_name FROM work_shifts w JOIN locations l ON l.id=w.location_id WHERE w.id=$1",[req.params.id])).rows[0];
  if(!existing) return res.status(404).json({error:"SHIFT_NOT_FOUND"});
  if(!(await locationAllowed(req,existing.location_id)) || !(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active=true",[input.userId])).rowCount) return res.status(404).json({error:"USER_NOT_FOUND"});
  const overlap=(await db.query("SELECT 1 FROM work_shifts WHERE user_id=$1 AND id<>$4 AND starts_at<$3 AND ends_at>$2",[input.userId,input.startsAt,input.endsAt,existing.id])).rowCount;
  if(overlap) return res.status(409).json({error:"SHIFT_OVERLAP"});
  const updated=(await db.query("UPDATE work_shifts SET user_id=$1,location_id=$2,starts_at=$3,ends_at=$4,responsibility=$5 WHERE id=$6 RETURNING *",[input.userId,input.locationId,input.startsAt,input.endsAt,input.responsibility,existing.id])).rows[0];
  await audit(req,"work_shift.update","work_shift",updated.id,existing,updated);
  res.json(updated);
});

app.patch("/work-schedules/:id/series",auth,permit("users:manage"),requireScheduleManager,async(req,res)=>{
  const parsed=z.object({userId:z.string().uuid(),locationId:z.string().uuid(),startsAt:z.string().datetime({offset:true}),endsAt:z.string().datetime({offset:true}),responsibility:z.string().trim().min(1).max(300),from:z.string().date(),to:z.string().date(),sourceWeekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7)}).safeParse(req.body);
  if(!parsed.success || parsed.data.from>parsed.data.to || new Date(parsed.data?.endsAt||0)<=new Date(parsed.data?.startsAt||0)) return res.status(400).json({error:"INVALID_INPUT"});
  const input=parsed.data;
  const first=new Date(`${input.from}T00:00:00Z`),last=new Date(`${input.to}T00:00:00Z`);
  if((last-first)/86_400_000>366) return res.status(400).json({error:"DATE_RANGE_TOO_LONG"});
  const existing=(await db.query("SELECT w.*,l.timezone FROM work_shifts w JOIN locations l ON l.id=w.location_id WHERE w.id=$1",[req.params.id])).rows[0];
  if(!existing) return res.status(404).json({error:"SHIFT_NOT_FOUND"});
  if(!(await locationAllowed(req,existing.location_id)) || !(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active=true",[input.userId])).rowCount) return res.status(404).json({error:"USER_NOT_FOUND"});
  const targetLocation=(await db.query("SELECT timezone FROM locations WHERE id=$1",[input.locationId])).rows[0];
  if(!targetLocation) return res.status(404).json({error:"LOCATION_NOT_FOUND"});
  const candidates=(await db.query(`SELECT w.id,(w.starts_at AT TIME ZONE $2)::date AS work_date
    FROM work_shifts w
    WHERE w.user_id=$1 AND w.location_id=$3 AND w.responsibility=$4
      AND (w.starts_at AT TIME ZONE $2)::time=(($5::timestamptz AT TIME ZONE $2)::time)
      AND (w.ends_at AT TIME ZONE $2)::time=(($6::timestamptz AT TIME ZONE $2)::time)
      AND EXTRACT(ISODOW FROM w.starts_at AT TIME ZONE $2)=ANY($9::int[])
      AND (w.starts_at AT TIME ZONE $2)::date BETWEEN $7::date AND $8::date
    ORDER BY (w.starts_at AT TIME ZONE $2)::date,w.id`,[existing.user_id,existing.timezone,existing.location_id,existing.responsibility,existing.starts_at,existing.ends_at,input.from,input.to,input.sourceWeekdays])).rows;
  if(!candidates.length) return res.status(404).json({error:"SHIFT_SERIES_NOT_FOUND"});
  const newTimes=(await db.query("SELECT ($1::timestamptz AT TIME ZONE $3)::time AS start_time,($2::timestamptz AT TIME ZONE $3)::time AS end_time",[input.startsAt,input.endsAt,targetLocation.timezone])).rows[0];
  const startTime=newTimes.start_time,endTime=newTimes.end_time;
  const dates=[];
  for(let date=first;date<=last;date=new Date(date.getTime()+86_400_000)){
    const weekday=date.getUTCDay()===0?7:date.getUTCDay();
    if(input.weekdays.includes(weekday)) dates.push(date.toISOString().slice(0,10));
  }
  const bounds=[];
  for(const date of dates){
    const value=(await db.query(`SELECT (($1::date+$2::time) AT TIME ZONE $4) starts_at,
      (($1::date+$3::time+CASE WHEN $3::time<=$2::time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE $4) ends_at`,[date,startTime,endTime,targetLocation.timezone])).rows[0];
    bounds.push(value);
  }
  const targetIds=candidates.map(row=>row.id);
  for(const bound of bounds){
    const overlap=(await db.query("SELECT 1 FROM work_shifts WHERE user_id=$1 AND id<>ALL($2::uuid[]) AND starts_at<$4 AND ends_at>$3",[input.userId,targetIds,bound.starts_at,bound.ends_at])).rowCount;
    if(overlap) return res.status(409).json({error:"SHIFT_OVERLAP"});
  }
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const reused=Math.min(candidates.length,bounds.length);
    for(let index=0;index<reused;index++) await client.query("UPDATE work_shifts SET user_id=$1,location_id=$2,starts_at=$3,ends_at=$4,responsibility=$5 WHERE id=$6",[input.userId,input.locationId,bounds[index].starts_at,bounds[index].ends_at,input.responsibility,candidates[index].id]);
    if(candidates.length>reused) await client.query("DELETE FROM work_shifts WHERE id=ANY($1::uuid[])",[candidates.slice(reused).map(row=>row.id)]);
    for(const bound of bounds.slice(reused)) await client.query("INSERT INTO work_shifts(user_id,location_id,starts_at,ends_at,responsibility,created_by) VALUES($1,$2,$3,$4,$5,$6)",[input.userId,input.locationId,bound.starts_at,bound.ends_at,input.responsibility,req.user.sub]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release();}
  const updated=Math.min(candidates.length,bounds.length),created=Math.max(0,bounds.length-candidates.length),removed=Math.max(0,candidates.length-bounds.length);
  await audit(req,"work_shift.series.update",existing.id,{...existing,count:candidates.length},{...input,updated,created,removed,shiftIds:targetIds});
  res.json({updated,created,removed});
});

app.post("/work-schedules/recurring",auth,permit("users:manage"),requireScheduleManager,async(req,res)=>{
  const parsed=z.object({
    userId:z.string().uuid(),locationId:z.string().uuid(),from:z.string().date(),to:z.string().date(),
    weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startsAt:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),endsAt:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    responsibility:z.string().trim().min(1).max(300),
  }).safeParse(req.body);
  if(!parsed.success || parsed.data.from>parsed.data.to || parsed.data.endsAt<=parsed.data.startsAt) return res.status(400).json({error:"INVALID_INPUT"});
  const input=parsed.data;
  const first=new Date(`${input.from}T00:00:00Z`),last=new Date(`${input.to}T00:00:00Z`);
  if((last-first)/86_400_000>366) return res.status(400).json({error:"DATE_RANGE_TOO_LONG"});
  if(!(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active=true",[input.userId])).rowCount) return res.status(404).json({error:"USER_NOT_FOUND"});
  const dates=[];
  for(let date=first;date<=last;date=new Date(date.getTime()+86_400_000)) {
    const weekday=date.getUTCDay()===0?7:date.getUTCDay();
    if(input.weekdays.includes(weekday)) dates.push(date.toISOString().slice(0,10));
  }
  const client=await db.connect();let created=0,skipped=0;
  try{
    await client.query("BEGIN");
    for(const date of dates){
      const bounds=(await client.query(`SELECT (($1::date+$2::time) AT TIME ZONE timezone) starts_at,(($1::date+$3::time) AT TIME ZONE timezone) ends_at FROM locations WHERE id=$4`,[date,input.startsAt,input.endsAt,input.locationId])).rows[0];
      if(!bounds) { await client.query("ROLLBACK"); return res.status(404).json({error:"LOCATION_NOT_FOUND"}); }
      const overlap=(await client.query("SELECT 1 FROM work_shifts WHERE user_id=$1 AND starts_at<$3 AND ends_at>$2",[input.userId,bounds.starts_at,bounds.ends_at])).rowCount;
      if(overlap){skipped++;continue;}
      await client.query("INSERT INTO work_shifts(user_id,location_id,starts_at,ends_at,responsibility,created_by) VALUES($1,$2,$3,$4,$5,$6)",[input.userId,input.locationId,bounds.starts_at,bounds.ends_at,input.responsibility,req.user.sub]);
      created++;
    }
    await client.query("COMMIT");
    await audit(req,"work_shift.recurring.create","work_shift",null,null,{...input,created,skipped});
    res.status(201).json({created,skipped});
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
});

app.get("/work-time-entries",auth,requireWorkTime,async(req,res)=>{
  const parsed=z.object({from:z.string().date(),to:z.string().date()}).safeParse(req.query);
  if(!parsed.success || parsed.data.from>parsed.data.to) return res.status(400).json({error:"INVALID_DATE_RANGE"});
  const scope=isOwner(req)?{clause:"TRUE",values:[parsed.data.from,parsed.data.to]}:{clause:"e.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$3)",values:[parsed.data.from,parsed.data.to,req.user.sub]};
  const {rows}=await db.query(`SELECT e.*,u.display_name user_name,l.name location_name,
    COALESCE(b.customer_name,e.booking_snapshot->>'customerName') customer_name,
    COALESCE(b.product_name,e.booking_snapshot->>'productName') product_name,
    COALESCE(b.starts_at,(e.booking_snapshot->>'startsAt')::timestamptz) booking_starts_at,
    COALESCE(r.name,e.booking_snapshot->>'roomName') room_name,
    COALESCE(e.booking_id::text,e.booking_snapshot->>'reference') booking_id
    FROM work_time_entries e JOIN users u ON u.id=e.user_id JOIN locations l ON l.id=e.location_id
    LEFT JOIN bookings b ON b.id=e.booking_id LEFT JOIN rooms r ON r.id=b.room_id
    WHERE e.arrived_at<($2::date+interval '1 day') AND e.left_at>=$1::date AND ${scope.clause}
    ORDER BY e.arrived_at DESC`,scope.values);
  res.json(rows);
});

app.get("/work-time-bookings",auth,requireWorkTime,async(req,res)=>{
  const parsed=z.object({from:z.string().date(),to:z.string().date(),locationId:z.string().uuid().optional()}).safeParse(req.query);
  if(!parsed.success || parsed.data.from>parsed.data.to) return res.status(400).json({error:"INVALID_DATE_RANGE"});
  const values=[parsed.data.from,parsed.data.to],conditions=["b.starts_at<($2::date+interval '1 day')","b.ends_at>=$1::date","NOT EXISTS (SELECT 1 FROM work_time_entries e WHERE e.booking_id=b.id)"];
  if(parsed.data.locationId){values.push(parsed.data.locationId);conditions.push(`r.location_id=$${values.length}`);}
  if(!isOwner(req)){values.push(req.user.sub);conditions.push(`r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$${values.length})`);}
  // `external_id` lets us recognise an imported Time to Grow booking as the
  // same reservation as the live Time to Grow result (their primary IDs differ).
  const {rows}=await db.query(`SELECT b.id::text,b.external_id,b.customer_name,b.product_name,b.starts_at,b.ends_at,r.name room_name,r.location_id FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE ${conditions.join(" AND ")} ORDER BY b.starts_at`,values);
  if(!parsed.data.locationId) return res.json(rows);
  const location=(await db.query("SELECT id,external_id,timezone FROM locations WHERE id=$1",[parsed.data.locationId])).rows[0];
  if(!location?.external_id) return res.json(rows);
  try {
    // Do not offer a visit again after anyone has already logged work against
    // it. Entries may refer to a local imported booking or to a Time to Grow
    // snapshot, so collect both reference forms.
    const usedRows=(await db.query(`
      SELECT b.external_id::text AS external_id, NULL::text AS snapshot_reference
      FROM work_time_entries e JOIN bookings b ON b.id=e.booking_id
      WHERE e.location_id=$1 AND b.external_id IS NOT NULL
      UNION
      SELECT NULL::text AS external_id, e.booking_snapshot->>'reference' AS snapshot_reference
      FROM work_time_entries e
      WHERE e.location_id=$1 AND e.booking_snapshot ? 'reference'
    `,[location.id])).rows;
    const usedExternalIds=new Set(usedRows.flatMap(row=>[row.external_id,row.snapshot_reference]).filter(Boolean).map(String));
    const dates=[];for(let date=new Date(`${parsed.data.from}T00:00:00Z`),last=new Date(`${parsed.data.to}T00:00:00Z`);date<=last;date=new Date(date.getTime()+86400000))dates.push(date.toISOString().slice(0,10));
    const batches=await Promise.all(dates.map(date=>fetchTimeToGrowBookings(location.external_id,date)));
    const externalById=new Map();
    for(const booking of batches.flat()){
      // Some upstream filters include an overlap buffer. A multi-day request
      // can therefore return the exact same booking more than once.
      if(externalById.has(booking.id)) continue;
      const times=(await db.query(`SELECT (($1::date+$2::time) AT TIME ZONE $4) starts_at,
        (($1::date+$3::time+CASE WHEN $3::time<$2::time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE $4) ends_at`,[booking.start.date,booking.start.time.slice(0,5),booking.end.time.slice(0,5),location.timezone])).rows[0];
      externalById.set(booking.id,{id:`ttg:${booking.id}`,customer_name:booking.owner?.name||booking.owner?.email||"Бронь",product_name:booking.product.effective_name,starts_at:times.starts_at,ends_at:times.ends_at,room_name:booking.product.effective_name,location_id:location.id});
    }
    const external=[...externalById.values()];
    const localExternalIds=new Set(rows.map(row=>row.external_id).filter(Boolean).map(String));
    res.json([...rows,...external.filter(row=>{
      const externalId=row.id.slice(4);
      return !localExternalIds.has(externalId)
        && !usedExternalIds.has(externalId)
        && !usedExternalIds.has(row.id);
    })].sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at)));
  } catch(error) {
    console.error("work time external bookings",error);
    res.json(rows);
  }
});

app.post("/work-time-entries",auth,requireWorkTime,async(req,res)=>{
  const parsed=z.object({userId:z.string().uuid(),locationId:z.string().uuid(),bookingId:z.string().max(80).nullable().default(null),bookingSnapshot:z.object({reference:z.string().max(80),customerName:z.string().max(200),productName:z.string().max(300).nullable(),startsAt:z.string().datetime({offset:true}),roomName:z.string().max(300)}).nullable().default(null),arrivedAt:z.string().datetime({offset:true}),leftAt:z.string().datetime({offset:true}),note:z.string().trim().max(300).nullable().default(null)}).safeParse(req.body);
  if(!parsed.success || new Date(parsed.data?.leftAt||0)<=new Date(parsed.data?.arrivedAt||0)) return res.status(400).json({error:"INVALID_INPUT"});
  const input=parsed.data;
  if(!(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active=true",[input.userId])).rowCount) return res.status(404).json({error:"USER_NOT_FOUND"});
  if(!(await canRecordWorkTimeFor(req,input.userId,input.locationId))) return res.status(403).json({error:"WORK_TIME_USER_FORBIDDEN"});
  const localBookingId=input.bookingId&&!input.bookingId.startsWith("ttg:")?input.bookingId:null;
  if(localBookingId && !z.string().uuid().safeParse(localBookingId).success) return res.status(400).json({error:"INVALID_BOOKING"});
  if(localBookingId && !(await db.query("SELECT 1 FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.id=$1 AND r.location_id=$2",[localBookingId,input.locationId])).rowCount) return res.status(400).json({error:"BOOKING_LOCATION_MISMATCH"});
  if(input.bookingId?.startsWith("ttg:")&&!input.bookingSnapshot) return res.status(400).json({error:"BOOKING_SNAPSHOT_REQUIRED"});
  const entry=(await db.query("INSERT INTO work_time_entries(user_id,location_id,booking_id,booking_snapshot,arrived_at,left_at,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[input.userId,input.locationId,localBookingId,input.bookingSnapshot,input.arrivedAt,input.leftAt,input.note,req.user.sub])).rows[0];
  await audit(req,"work_time_entry.create","work_time_entry",entry.id,null,entry);
  res.status(201).json(entry);
});

app.delete("/work-time-entries/:id",auth,requireWorkTime,async(req,res)=>{
  const entry=(await db.query("SELECT * FROM work_time_entries WHERE id=$1",[req.params.id])).rows[0];
  if(!entry) return res.status(404).json({error:"TIME_ENTRY_NOT_FOUND"});
  if(!(await locationAllowed(req,entry.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(req.user?.role==="OPERATOR" && entry.user_id!==req.user.sub) return res.status(403).json({error:"WORK_TIME_ENTRY_FORBIDDEN"});
  await db.query("DELETE FROM work_time_entries WHERE id=$1",[entry.id]);
  await audit(req,"work_time_entry.delete","work_time_entry",entry.id,entry,null);
  res.status(204).end();
});

const documentInputFields=["employee","period","max_hours","work_entries","report_rows","locations"];
const requireDocumentManager=(req,res,next)=>["OWNER","ADMIN"].includes(req.user?.role)
  ? next() : res.status(403).json({error:"DOCUMENTS_FORBIDDEN"});
const documentOutputFormats=["docx","pdf"];
const documentCategories=["REPORT","LICENSE","EMPLOYEE","OTHER"];
const documentLibraryInput=z.object({
  name:z.string().trim().min(1).max(180),category:z.enum(documentCategories),locationId:z.string().uuid().nullable().default(null),
  employeeId:z.string().uuid().nullable().default(null),fileName:z.string().trim().min(1).max(220),contentType:z.string().trim().min(1).max(180),dataBase64:z.string().min(8).max(16_500_000),
});
const documentLibraryScope=(req, alias="d")=>req.user?.role==="OWNER"
  ? {clause:"TRUE",values:[]}
  : {clause:`${alias}.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)`,values:[req.user.sub]};
async function documentLibraryLocationAllowed(req, locationId) {
  if(req.user?.role==="OWNER") return true;
  return Boolean(locationId && (await db.query("SELECT 1 FROM user_locations WHERE user_id=$1 AND location_id=$2",[req.user.sub,locationId])).rowCount);
}
const documentScriptInput=z.object({
  name:z.string().trim().min(1).max(120),
  fileName:z.string().trim().min(1).max(180).regex(/\.py$/i),
  sourceCode:z.string().min(1).max(300_000),
  inputFields:z.array(z.enum(documentInputFields)).min(1).max(documentInputFields.length),
});

app.get("/documents/my-signature",auth,async(req,res)=>{
  const row=(await db.query("SELECT content_type,image_data,updated_at FROM user_signatures WHERE user_id=$1",[req.user.sub])).rows[0];
  if(!row)return res.json({signature:null});
  res.json({signature:{contentType:row.content_type,dataBase64:Buffer.from(row.image_data).toString("base64"),updatedAt:row.updated_at}});
});
app.put("/documents/my-signature",auth,async(req,res)=>{
  const input=z.object({contentType:z.enum(["image/png","image/jpeg"]),dataBase64:z.string().min(20).max(4_200_000)}).safeParse(req.body);
  if(!input.success)return res.status(400).json({error:"INVALID_SIGNATURE"});
  const image=Buffer.from(input.data.dataBase64,"base64");
  if(!image.length||image.length>3_000_000)return res.status(400).json({error:"SIGNATURE_TOO_LARGE"});
  const isPng=image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isJpeg=image.subarray(0,3).equals(Buffer.from([255,216,255]));
  if((input.data.contentType==="image/png"&&!isPng)||(input.data.contentType==="image/jpeg"&&!isJpeg))return res.status(400).json({error:"SIGNATURE_TYPE_MISMATCH"});
  await db.query(`INSERT INTO user_signatures(user_id,content_type,image_data,updated_at) VALUES($1,$2,$3,now())
    ON CONFLICT(user_id) DO UPDATE SET content_type=excluded.content_type,image_data=excluded.image_data,updated_at=now()`,[req.user.sub,input.data.contentType,image]);
  await audit(req,"user.signature.update","user_signature",req.user.sub,null,{contentType:input.data.contentType,size:image.length});
  res.status(204).end();
});
app.delete("/documents/my-signature",auth,async(req,res)=>{
  await db.query("DELETE FROM user_signatures WHERE user_id=$1",[req.user.sub]);
  await audit(req,"user.signature.delete","user_signature",req.user.sub,null,null);
  res.status(204).end();
});

app.get("/documents/library",auth,requireDocumentManager,async(req,res)=>{
  const scope=documentLibraryScope(req);
  const {rows}=await db.query(`SELECT d.id,d.name,d.category,d.source,d.file_name,d.content_type,octet_length(d.file_data) size_bytes,d.location_id,d.employee_id,d.created_at,d.updated_at,
    l.name location_name,u.display_name employee_name,creator.display_name created_by_name
    FROM document_library_files d LEFT JOIN locations l ON l.id=d.location_id LEFT JOIN users u ON u.id=d.employee_id LEFT JOIN users creator ON creator.id=d.created_by
    WHERE ${scope.clause} ORDER BY l.name NULLS LAST,d.created_at DESC`,scope.values);
  res.json(rows);
});
app.post("/documents/library",auth,requireDocumentManager,async(req,res)=>{
  const parsed=documentLibraryInput.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"INVALID_LIBRARY_DOCUMENT"});
  const input=parsed.data;
  if(req.user.role==="ADMIN"&&!input.locationId)return res.status(400).json({error:"LOCATION_REQUIRED"});
  if(!(await documentLibraryLocationAllowed(req,input.locationId)))return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(input.employeeId && !(await db.query("SELECT 1 FROM users WHERE id=$1 AND is_active=true",[input.employeeId])).rowCount)return res.status(404).json({error:"USER_NOT_FOUND"});
  const data=Buffer.from(input.dataBase64,"base64");if(!data.length||data.length>12_000_000)return res.status(400).json({error:"INVALID_LIBRARY_DOCUMENT"});
  const row=(await db.query(`INSERT INTO document_library_files(name,category,file_name,content_type,file_data,location_id,employee_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,category,file_name,created_at`,[input.name,input.category,input.fileName,input.contentType,data,input.locationId,input.employeeId,req.user.sub])).rows[0];
  await audit(req,"document_library.create","document_library_file",row.id,null,{name:row.name,category:row.category,locationId:input.locationId,employeeId:input.employeeId,size:data.length});res.status(201).json(row);
});
app.get("/documents/library/:id/download",auth,requireDocumentManager,async(req,res)=>{
  const scope=documentLibraryScope(req);
  const row=(await db.query(`SELECT d.file_name,d.content_type,d.file_data FROM document_library_files d WHERE d.id=$${scope.values.length+1} AND ${scope.clause}`,[...scope.values,req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"LIBRARY_DOCUMENT_NOT_FOUND"});res.type(row.content_type).attachment(row.file_name).send(row.file_data);
});
app.delete("/documents/library/:id",auth,requireDocumentManager,async(req,res)=>{
  const scope=documentLibraryScope(req);
  const row=(await db.query(`DELETE FROM document_library_files d WHERE d.id=$${scope.values.length+1} AND ${scope.clause} RETURNING d.id,d.name`,[...scope.values,req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"LIBRARY_DOCUMENT_NOT_FOUND"});await audit(req,"document_library.delete","document_library_file",row.id,row,null);res.status(204).end();
});

app.get("/documents/templates",auth,requireDocumentManager,async(_req,res)=>{
  const {rows}=await db.query(`SELECT t.id,t.name,t.file_name,t.content_type,octet_length(t.template_data) size_bytes,t.created_at,t.updated_at,u.display_name created_by_name
    FROM document_templates t LEFT JOIN users u ON u.id=t.created_by ORDER BY t.updated_at DESC`);
  res.json(rows);
});
app.post("/documents/templates",auth,requireDocumentManager,async(req,res)=>{
  const input=z.object({name:z.string().trim().min(1).max(120),fileName:z.string().trim().min(1).max(180).regex(/\.docx$/i),dataBase64:z.string().min(100).max(12_000_000)}).safeParse(req.body);
  if(!input.success)return res.status(400).json({error:"INVALID_TEMPLATE"});
  const data=Buffer.from(input.data.dataBase64,"base64");
  if(data.length<100||data.length>8_000_000||data.subarray(0,2).toString()!=="PK")return res.status(400).json({error:"INVALID_DOCX"});
  const row=(await db.query("INSERT INTO document_templates(name,file_name,template_data,created_by) VALUES($1,$2,$3,$4) RETURNING id,name,file_name,created_at,updated_at",[input.data.name,input.data.fileName,data,req.user.sub])).rows[0];
  await audit(req,"document_template.create","document_template",row.id,null,{name:row.name,fileName:row.file_name,size:data.length});
  res.status(201).json(row);
});
app.get("/documents/templates/:id/download",auth,requireDocumentManager,async(req,res)=>{
  const row=(await db.query("SELECT file_name,content_type,template_data FROM document_templates WHERE id=$1",[req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"TEMPLATE_NOT_FOUND"});
  res.type(row.content_type).attachment(row.file_name).send(row.template_data);
});
app.delete("/documents/templates/:id",auth,requireDocumentManager,async(req,res)=>{
  const row=(await db.query("DELETE FROM document_templates WHERE id=$1 RETURNING id,name,file_name",[req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"TEMPLATE_NOT_FOUND"});
  await audit(req,"document_template.delete","document_template",row.id,row,null);res.status(204).end();
});

app.get("/documents/scripts",auth,requireDocumentManager,async(_req,res)=>{
  const {rows}=await db.query(`SELECT s.id,s.name,s.file_name,s.input_fields,s.created_at,s.updated_at,u.display_name created_by_name
    FROM document_scripts s LEFT JOIN users u ON u.id=s.created_by ORDER BY s.updated_at DESC`);
  res.json(rows);
});
app.get("/documents/scripts/:id",auth,requireDocumentManager,async(req,res)=>{
  const row=(await db.query("SELECT id,name,file_name,source_code,input_fields,created_at,updated_at FROM document_scripts WHERE id=$1",[req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"SCRIPT_NOT_FOUND"});res.json(row);
});
app.post("/documents/scripts",auth,requireDocumentManager,async(req,res)=>{
  const parsed=documentScriptInput.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"INVALID_SCRIPT"});
  const input={...parsed.data,inputFields:[...new Set(parsed.data.inputFields)]};
  const row=(await db.query("INSERT INTO document_scripts(name,file_name,source_code,input_fields,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,file_name,input_fields,created_at,updated_at",[input.name,input.fileName,input.sourceCode,JSON.stringify(input.inputFields),req.user.sub])).rows[0];
  await audit(req,"document_script.create","document_script",row.id,null,{name:row.name,fileName:row.file_name,inputFields:row.input_fields});res.status(201).json(row);
});
app.put("/documents/scripts/:id",auth,requireDocumentManager,async(req,res)=>{
  const parsed=documentScriptInput.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:"INVALID_SCRIPT"});
  const input={...parsed.data,inputFields:[...new Set(parsed.data.inputFields)]};
  const row=(await db.query("UPDATE document_scripts SET name=$1,file_name=$2,source_code=$3,input_fields=$4,updated_at=now() WHERE id=$5 RETURNING id,name,file_name,input_fields,created_at,updated_at",[input.name,input.fileName,input.sourceCode,JSON.stringify(input.inputFields),req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"SCRIPT_NOT_FOUND"});await audit(req,"document_script.update","document_script",row.id,null,{name:row.name,inputFields:row.input_fields});res.json(row);
});
app.delete("/documents/scripts/:id",auth,requireDocumentManager,async(req,res)=>{
  const row=(await db.query("DELETE FROM document_scripts WHERE id=$1 RETURNING id,name",[req.params.id])).rows[0];
  if(!row)return res.status(404).json({error:"SCRIPT_NOT_FOUND"});await audit(req,"document_script.delete","document_script",row.id,row,null);res.status(204).end();
});

const documentDate=z.preprocess((value)=>{
  const text=String(value??"").trim();
  const match=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  return match?`${match[3]}-${match[2]}-${match[1]}`:text;
},z.string().date());
const documentGenerationInput=z.object({userId:z.string().uuid(),from:documentDate,to:documentDate,maxHours:z.coerce.number().min(.25).max(744),outputFormat:z.enum(documentOutputFormats).default("docx"),saveToLibrary:z.boolean().default(false),libraryName:z.preprocess(value=>String(value??"").trim()||undefined,z.string().min(1).max(180).optional()),libraryCategory:z.enum(documentCategories).default("REPORT"),libraryLocationId:z.preprocess(value=>value===""||value==null?null:value,z.string().uuid().nullable().default(null))});
async function documentContext(req,input){
  const employee=(await db.query("SELECT id,display_name,email FROM users WHERE id=$1 AND is_active=true",[input.userId])).rows[0];
  if(!employee){const error=new Error("USER_NOT_FOUND");error.status=404;throw error;}
  if(req.user.role==="ADMIN"){
    const sharedLocation=(await db.query(`SELECT 1 FROM user_locations target
      WHERE target.user_id=$1 AND EXISTS(SELECT 1 FROM user_locations admin WHERE admin.user_id=$2 AND admin.location_id=target.location_id)`,[employee.id,req.user.sub])).rowCount;
    if(!sharedLocation){const error=new Error("DOCUMENT_USER_FORBIDDEN");error.status=403;throw error;}
  }
  const locationScope=req.user.role==="OWNER"?"TRUE":"e.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$4)";
  const entryValues=req.user.role==="OWNER"?[input.userId,input.from,input.to]:[input.userId,input.from,input.to,req.user.sub];
  const entries=(await db.query(`SELECT e.id,e.arrived_at,e.left_at,e.note,l.id location_id,l.name location_name,
      COALESCE(b.id::text,e.booking_snapshot->>'reference') booking_id,COALESCE(b.customer_name,e.booking_snapshot->>'customerName','Без брони') booking_customer,
      COALESCE(b.product_name,e.booking_snapshot->>'productName') booking_product,COALESCE(r.name,e.booking_snapshot->>'roomName') room_name
    FROM work_time_entries e JOIN locations l ON l.id=e.location_id LEFT JOIN bookings b ON b.id=e.booking_id LEFT JOIN rooms r ON r.id=b.room_id
    WHERE e.user_id=$1 AND e.arrived_at<($3::date+interval '1 day') AND e.left_at>=$2::date AND ${locationScope} ORDER BY e.arrived_at`,entryValues)).rows.map(row=>({...row,hours:Number(((new Date(row.left_at)-new Date(row.arrived_at))/3_600_000).toFixed(2))}));
  let total=0;const reportRows=[];for(const entry of entries){if(total+entry.hours>input.maxHours)continue;reportRows.push(entry);total+=entry.hours;}
  const signature=(await db.query("SELECT content_type,image_data FROM user_signatures WHERE user_id=$1",[employee.id])).rows[0];
  const locationIds=[...new Set(entries.map(entry=>entry.location_id))];
  const locationRows=(await db.query("SELECT id,name,timezone FROM locations WHERE id=ANY($1::uuid[])",[locationIds])).rows;
  const all={employee:{id:employee.id,name:employee.display_name,email:employee.email},period:{from:input.from,to:input.to},max_hours:input.maxHours,work_entries:entries,report_rows:reportRows,locations:locationRows};
  const employeeFullName=employee.display_name.trim().replace(/\s+/g," ");
  const [employeeFirstName="",...employeeLastNameParts]=employeeFullName.split(" ");
  const defaults={
    // employee_name remains the backwards-compatible field used by the
    // supplied template. It is always the person's full name, not an e-mail.
    employee_name:employeeFullName,
    employee_full_name:employeeFullName,
    employee_first_name:employeeFirstName,
    employee_last_name:employeeLastNameParts.join(" "),
    month:new Intl.DateTimeFormat("de-AT",{month:"long"}).format(new Date(`${input.from}T12:00:00Z`)),
    year:input.from.slice(0,4),
    current_date:new Intl.DateTimeFormat("de-AT",{timeZone:"Europe/Vienna",day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date()),
    employee_signature_date:new Intl.DateTimeFormat("de-AT",{timeZone:"Europe/Vienna",day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date()),
    employer_signature_date:new Intl.DateTimeFormat("de-AT",{timeZone:"Europe/Vienna",day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date()),
    employee_signature:signature?{_type:"image",content_type:signature.content_type,data_base64:Buffer.from(signature.image_data).toString("base64")}:"",
    employer_signature:""
  };
  return {all,defaults};
}
app.post("/documents/scripts/:id/input-preview",auth,requireDocumentManager,async(req,res)=>{
  const parsed=documentGenerationInput.safeParse(req.body);
  if(!parsed.success||parsed.data.from>parsed.data.to)return res.status(400).json({error:"INVALID_REPORT_RANGE"});
  const script=(await db.query("SELECT input_fields FROM document_scripts WHERE id=$1",[req.params.id])).rows[0];if(!script)return res.status(404).json({error:"SCRIPT_NOT_FOUND"});
  const {all}=await documentContext(req,parsed.data);
  res.json(Object.fromEntries(script.input_fields.map(field=>[field,all[field]])));
});
app.post("/documents/generate",auth,requireDocumentManager,async(req,res)=>{
  const parsed=documentGenerationInput.extend({templateId:z.string().uuid(),scriptId:z.string().uuid()}).safeParse(req.body);
  if(!parsed.success||parsed.data.from>parsed.data.to)return res.status(400).json({error:"INVALID_REPORT_RANGE"});
  const [template,script]=await Promise.all([
    db.query("SELECT file_name,template_data FROM document_templates WHERE id=$1",[parsed.data.templateId]),
    db.query("SELECT name,source_code,input_fields FROM document_scripts WHERE id=$1",[parsed.data.scriptId]),
  ]);
  if(!template.rows[0])return res.status(404).json({error:"TEMPLATE_NOT_FOUND"});if(!script.rows[0])return res.status(404).json({error:"SCRIPT_NOT_FOUND"});
  const {all,defaults}=await documentContext(req,parsed.data);
  const context=Object.fromEntries(script.rows[0].input_fields.map(field=>[field,all[field]]));
  let runner;
  try { runner=await fetch(`${env.DOCUMENT_RUNNER_URL}/generate`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sourceCode:script.rows[0].source_code,context,defaults,outputFormat:parsed.data.outputFormat,templateDataBase64:Buffer.from(template.rows[0].template_data).toString("base64")}),signal:AbortSignal.timeout(25_000)}); }
  catch { return res.status(503).json({error:"DOCUMENT_RUNNER_UNAVAILABLE"}); }
  const result=await runner.json().catch(()=>null);
  if(!runner.ok||!result?.documentBase64)return res.status(422).json({error:result?.error||"DOCUMENT_GENERATION_FAILED",message:result?.message||"Не удалось сформировать документ"});
  const document=Buffer.from(result.documentBase64,"base64");
  if(!document.length||document.length>12_000_000)return res.status(422).json({error:"DOCUMENT_GENERATION_FAILED"});
  const extension=parsed.data.outputFormat==="pdf"?"pdf":"docx";
  const contentType=parsed.data.outputFormat==="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const fileName=`${template.rows[0].file_name.replace(/\.docx$/i,"")}-${parsed.data.from}.${extension}`;
  if(parsed.data.saveToLibrary){
    if(req.user.role==="ADMIN"&&!parsed.data.libraryLocationId)return res.status(400).json({error:"LOCATION_REQUIRED"});
    if(!(await documentLibraryLocationAllowed(req,parsed.data.libraryLocationId)))return res.status(403).json({error:"LOCATION_FORBIDDEN"});
    await db.query(`INSERT INTO document_library_files(name,category,source,file_name,content_type,file_data,location_id,employee_id,created_by)
      VALUES($1,$2,'GENERATED',$3,$4,$5,$6,$7,$8)`,[parsed.data.libraryName||`Отчёт ${defaults.employee_name} ${parsed.data.from}`,parsed.data.libraryCategory,fileName,contentType,document,parsed.data.libraryLocationId,parsed.data.userId,req.user.sub]);
  }
  await audit(req,"document.generate","document_template",parsed.data.templateId,null,{scriptId:parsed.data.scriptId,userId:parsed.data.userId,from:parsed.data.from,to:parsed.data.to,maxHours:parsed.data.maxHours,outputFormat:parsed.data.outputFormat,savedToLibrary:parsed.data.saveToLibrary});
  res.type(contentType).attachment(fileName).send(document);
});

app.delete("/work-schedules/:id",auth,permit("users:manage"),requireScheduleManager,async(req,res)=>{
  const shift=(await db.query("SELECT * FROM work_shifts WHERE id=$1",[req.params.id])).rows[0];
  if(!shift) return res.status(404).json({error:"SHIFT_NOT_FOUND"});
  if(!(await locationAllowed(req,shift.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  await db.query("DELETE FROM work_shifts WHERE id=$1",[shift.id]);
  await audit(req,"work_shift.delete","work_shift",shift.id,shift,null);
  res.status(204).end();
});

app.post("/bookings/:id/participants", auth, permit("bookings:manage"), async (req, res) => {
  if (!env.PSEUDONYMIZATION_SECRET) return res.status(503).json({ error:"PSEUDONYMIZATION_NOT_CONFIGURED" });
  const input = z.object({
    participants: z.array(z.object({
      email: z.string().email().max(320).nullable().default(null),
      role: z.enum(["OWNER","PLAYER"]).default("PLAYER"),
      category: z.string().trim().min(1).max(64).nullable().default(null),
      ageBand: z.enum(["CHILD","TEEN","ADULT","UNKNOWN"]).default("UNKNOWN"),
    })).min(1).max(100),
  }).parse(req.body);
  const booking = (await db.query(`
    SELECT b.id,r.location_id
    FROM bookings b JOIN rooms r ON r.id=b.room_id
    WHERE b.id=$1
  `,[req.params.id])).rows[0];
  if (!booking) return res.status(404).json({ error:"BOOKING_NOT_FOUND" });
  if (!(await locationAllowed(req,booking.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let linked = 0;
    for (const participant of input.participants) {
      const token = participant.email ? identityToken(participant.email) : crypto.randomBytes(32);
      const identityType = participant.email ? "EMAIL_HMAC" : "BOOKING_RANDOM";
      const person = (await client.query(`
        INSERT INTO people(identity_token,identity_type,token_version)
        VALUES($1,$2,1)
        ON CONFLICT(token_version,identity_token)
        DO UPDATE SET last_seen_at=now()
        RETURNING id
      `,[token,identityType])).rows[0];
      await client.query(`
        INSERT INTO booking_participants(
          booking_id,person_id,participant_role,category_at_booking,age_band_at_booking
        ) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(booking_id,person_id) DO UPDATE SET
          participant_role=excluded.participant_role,
          category_at_booking=excluded.category_at_booking,
          age_band_at_booking=excluded.age_band_at_booking
      `,[booking.id,person.id,participant.role,participant.category,participant.ageBand]);
      linked += 1;
    }
    await client.query("COMMIT");
    await audit(req,"booking.participants.link","booking",booking.id,null,{ linked });
    res.status(201).json({ linked });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

let timeToGrowJwt = env.TIME_TO_GROW_JWT;
let timeToGrowAccessToken = null;
const defaultTimeToGrowConfig={
  baseUrl:env.TIME_TO_GROW_BASE_URL,email:env.TIME_TO_GROW_EMAIL||"",password:env.TIME_TO_GROW_PASSWORD||"",jwt:env.TIME_TO_GROW_JWT||"",
  defaultClubId:env.TIME_TO_GROW_CLUB_ID||"",viennaClubId:env.TIME_TO_GROW_VIENNA_CLUB_ID||"",
  paths:{login:"/api/auth/login",clubs:"/api/admin/clubs",bookings:"/api/admin/clubs/{clubId}/bookings",calendar:"/api/admin/clubs/{clubId}/visits/calendar",appVisits:"/api/v1/app/clubs/{clubId}/visits",appClub:"/api/v1/app/clubs/{clubId}",appBookingMembers:"/api/v1/app/clubs/{clubId}/booking-members"},
};
let timeToGrowConfigCache=null;
async function timeToGrowConfig(force=false){
  if(!force&&timeToGrowConfigCache&&Date.now()-timeToGrowConfigCache.at<60_000)return timeToGrowConfigCache.value;
  const row=(await db.query("SELECT encrypted_value FROM app_settings WHERE key='time_to_grow'")).rows[0];
  let saved={};try{saved=decryptSetting(row?.encrypted_value)||{};}catch(error){console.error("Unable to decrypt Time to Grow settings",error);}
  const value={...defaultTimeToGrowConfig,...saved,paths:{...defaultTimeToGrowConfig.paths,...saved.paths}};
  timeToGrowConfigCache={at:Date.now(),value};return value;
}
const timeToGrowPath=(template,clubId)=>template.replaceAll("{clubId}",encodeURIComponent(clubId||""));
async function refreshTimeToGrowSession() {
  const config=await timeToGrowConfig();
  if (!config.email || !config.password) {
    const error = new Error("Time to Grow credentials are not configured");
    error.code = "TIME_TO_GROW_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(`${config.baseUrl}${config.paths.login}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error("Time to Grow login failed");
    error.code = "TIME_TO_GROW_LOGIN_FAILED";
    error.upstreamStatus = response.status;
    throw error;
  }
  const payload = await response.json().catch(() => null);
  const setCookie = response.headers.get("set-cookie") || "";
  const jwt = setCookie.match(/(?:^|[,;\s])jwt=([^;,\s]+)/)?.[1] || null;
  const accessToken = typeof payload?.data?.access_token === "string" ? payload.data.access_token : null;
  if (!jwt && !accessToken) {
    const error = new Error("Time to Grow login response has no usable credentials");
    error.code = "TIME_TO_GROW_INVALID_LOGIN_RESPONSE";
    throw error;
  }
  if (jwt) timeToGrowJwt = jwt;
  if (accessToken) timeToGrowAccessToken = accessToken;
  return { jwt, accessToken };
}

async function timeToGrowLogin(force = false) {
  const config=await timeToGrowConfig();
  if(!force&&!timeToGrowJwt&&config.jwt)timeToGrowJwt=config.jwt;
  if (timeToGrowJwt && !force) return timeToGrowJwt;
  await refreshTimeToGrowSession();
  if (!timeToGrowJwt) {
    const error = new Error("Time to Grow login response has no JWT cookie");
    error.code = "TIME_TO_GROW_INVALID_LOGIN_RESPONSE";
    throw error;
  }
  return timeToGrowJwt;
}

async function timeToGrowAppLogin(force = false) {
  if (timeToGrowAccessToken && !force) return timeToGrowAccessToken;
  await refreshTimeToGrowSession();
  if (!timeToGrowAccessToken) {
    const error = new Error("Time to Grow login response has no app access token");
    error.code = "TIME_TO_GROW_INVALID_LOGIN_RESPONSE";
    throw error;
  }
  return timeToGrowAccessToken;
}

async function timeToGrowFetch(path) {
  const config=await timeToGrowConfig();
  let jwt = await timeToGrowLogin();
  let response = await fetch(`${config.baseUrl}${path}`, {
    headers: { accept: "application/json", cookie: `jwt=${jwt}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 && config.email && config.password) {
    jwt = await timeToGrowLogin(true);
    response = await fetch(`${config.baseUrl}${path}`, {
      headers: { accept: "application/json", cookie: `jwt=${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
  }
  return response;
}

async function timeToGrowAppFetch(path, init = {}) {
  const config=await timeToGrowConfig();
  let accessToken = await timeToGrowAppLogin();
  const request = (token) => fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  let response = await request(accessToken);
  if (response.status === 401 && config.email && config.password) {
    accessToken = await timeToGrowAppLogin(true);
    response = await request(accessToken);
  }
  return response;
}

const timeToGrowId = z.string().regex(/^[a-z0-9]{26}$/);
const CHECKIN_MAX_TOTAL_GUESTS = 10_000;
const isValidCheckinBirthday = (value, now = new Date()) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day]=value.split("-").map(Number);
  const birthday=new Date(Date.UTC(year,month-1,day));
  if(birthday.getUTCFullYear()!==year||birthday.getUTCMonth()!==month-1||birthday.getUTCDate()!==day) return false;
  const latest=new Date(Date.UTC(now.getUTCFullYear()-10,now.getUTCMonth(),now.getUTCDate()));
  return birthday<=latest;
};
const checkinParticipantInput = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(30).default(""),
  birthday: z.string().refine(isValidCheckinBirthday,{message:"Participant must be at least 10 years old"}),
  gender: z.enum(["male", "female", "non-binary"]),
  allowMarketingMaterials: z.boolean().default(false),
  acceptWaiver: z.literal(true),
  acceptPrivacyPolicy: z.literal(true),
  participantNumber: z.coerce.number().int().min(1).max(CHECKIN_MAX_TOTAL_GUESTS).optional(),
  totalGuests: z.coerce.number().int().min(1).max(CHECKIN_MAX_TOTAL_GUESTS).optional(),
  extraAuthorization: z.string().max(300).optional().default(""),
});

const timeToGrowAppVisitsPath = async (clubId, filtering) => {
  const config=await timeToGrowConfig();
  const query = new URLSearchParams({ filtering: JSON.stringify(filtering) });
  if (filtering.upcoming) query.set("pagination", JSON.stringify({ page: 1, size: 30 }));
  return `${timeToGrowPath(config.paths.appVisits,clubId)}?${query}`;
};

const timeToGrowDataRows = (payload) => Array.isArray(payload?.data)
  ? payload.data
  : (payload?.data && typeof payload.data === "object" ? [payload.data] : []);

const firstText = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim() || null;
const firstNumber = (...values) => {
  for(const value of values){const parsed=Number(value);if(Number.isFinite(parsed)&&parsed>=0)return parsed;}
  return null;
};
function timeToGrowBookingPricing(booking){
  const order=booking.order||{},discount=booking.discount||{},promotion=booking.promotion||{},coupon=booking.coupon||{};
  const paid=firstNumber(order.total_amount,order.total,booking.total_amount,booking.total,0)||0;
  const players=Math.max(1,Number(booking.size)||0);
  const promoCode=firstText(order.promo_code,order.promocode,order.promotion_code,order.coupon_code,booking.promo_code,booking.promocode,booking.promotion_code,booking.coupon_code,discount.code,promotion.code,coupon.code)||"";
  const discountReason=firstText(order.discount_reason,order.discount_name,order.promotion_name,booking.discount_reason,discount.reason,discount.name,promotion.name,coupon.name)||"";
  const reportedDiscount=firstNumber(order.discount_amount,order.discount_total,order.discount,order.promo_discount_amount,order.promocode_discount_amount,booking.discount_amount,booking.discount_total,discount.amount,discount.value,0)||0;
  // A time tariff is already baked into the final unit price. Only export a
  // discount when Time to Grow explicitly identifies a promo/manual discount.
  const hasExplicitDiscount=Boolean(promoCode||discountReason);
  const discountAmount=hasExplicitDiscount?reportedDiscount:0;
  const gross=paid+discountAmount;
  const rawPrice=discountAmount>0
    ? gross/players
    : firstNumber(order.price_per_person,order.unit_price,booking.price_per_person,booking.unit_price,booking.product?.price_per_person,booking.product?.price);
  return {
    pricePerPerson:rawPrice??gross/players,
    discountAmount,
    discountReason:discountReason||(promoCode?`Promocode ${promoCode}`:""),
    promoCode,
    total:paid,
  };
}
const firstCount = (...values) => {
  const count = values.map(Number).find(value => Number.isInteger(value) && value > 0);
  return count || null;
};
const visitDate = (visit) => {
  const explicit = firstText(visit.start_datetime, visit.start?.date);
  if (explicit && /^\d{4}-\d{2}-\d{2}/.test(explicit)) return explicit.slice(0, 10);
  const raw = Number(visit.timestamp);
  const milliseconds = Number.isFinite(raw) ? (raw < 10_000_000_000 ? raw * 1000 : raw) : NaN;
  if (!Number.isFinite(milliseconds)) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone:"Europe/Vienna", year:"numeric", month:"2-digit", day:"2-digit",
  }).formatToParts(new Date(milliseconds));
  const value = Object.fromEntries(parts.map(part => [part.type,part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};
const visitTime = (visit) => {
  const explicit = firstText(visit.start?.time, visit.start_time, visit.time);
  if (explicit) return explicit.slice(0, 5);
  const raw = Number(visit.timestamp);
  const milliseconds = Number.isFinite(raw) ? (raw < 10_000_000_000 ? raw * 1000 : raw) : NaN;
  if (Number.isFinite(milliseconds)) {
    return new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(milliseconds));
  }
  return "—";
};
const visitLabel = (visit) => firstText(
  visit.product_name,
  visit.product?.effective_name,
  visit.product?.name,
  visit.booking?.product?.effective_name,
  visit.resource?.name,
) || "Escapers";
const visitCustomer = (visit) => firstText(
  visit.name,
  visit.customer?.name,
  visit.owner?.name,
  [visit.customer?.first_name, visit.customer?.last_name].filter(Boolean).join(" "),
  [visit.owner?.first_name, visit.owner?.last_name].filter(Boolean).join(" "),
) || "Reservierung";
const checkinDocumentTranslations = (value) => Object.fromEntries(["de","en"].flatMap(language => {
  const raw = value?.[language];
  if (typeof raw !== "string") return [];
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? [[language,url.toString()]] : [];
  } catch {
    return [];
  }
}));

const configuredCheckinLocations = async () => {
  const config=await timeToGrowConfig();
  return [{location:"st-poelten",clubId:config.defaultClubId},{location:"vienna",clubId:config.viennaClubId}].filter(item=>item.clubId);
};

async function resolveCheckinToken(token) {
  if (!isCheckinToken(token)) return null;
  const signed = readCheckinToken(token,env.JWT_ACCESS_SECRET);
  if (signed) {
    const response = await timeToGrowAppFetch(await timeToGrowAppVisitsPath(signed.clubId,{ upcoming:true }));
    if (!response.ok) {
      const error = new Error("Time to Grow visits request failed");
      error.code = "TIME_TO_GROW_REQUEST_FAILED";
      throw error;
    }
    const visits = timeToGrowDataRows(await response.json());
    const visit = visits.find(item => String(item?.booking_id || item?.booking?.id || "") === signed.bookingId);
    if (!visit) return null;
    const config=await timeToGrowConfig();
    const viennaClubIds = new Set([config.viennaClubId].filter(Boolean));
    return { location:viennaClubIds.has(signed.clubId) ? "vienna" : "st-poelten",clubId:signed.clubId,visit };
  }
  const results = await Promise.all((await configuredCheckinLocations()).map(async ({ location,clubId }) => {
    const response = await timeToGrowAppFetch(await timeToGrowAppVisitsPath(clubId, { upcoming:true }));
    if (!response.ok) {
      const error = new Error("Time to Grow visits request failed");
      error.code = "TIME_TO_GROW_REQUEST_FAILED";
      throw error;
    }
    const visits = timeToGrowDataRows(await response.json());
    const visit = visits.find(item => {
      const bookingId = String(item?.booking_id || item?.booking?.id || "");
      return timeToGrowId.safeParse(bookingId).success
        && checkinTokenMatches(token, env.JWT_ACCESS_SECRET, clubId, bookingId);
    });
    return visit ? { location,clubId,visit } : null;
  }));
  return results.find(Boolean) || null;
}

async function checkinReservationFromToken(token) {
  const resolved = await resolveCheckinToken(token);
  if (!resolved) return null;
  const { location,clubId,visit } = resolved;
  const visitId = String(visit.id || "");
  const bookingId = String(visit.booking_id || visit.booking?.id || "");
  if (!timeToGrowId.safeParse(visitId).success || !timeToGrowId.safeParse(bookingId).success) return null;
  const date = visitDate(visit);
  const [bookings,clubResponse] = await Promise.all([
    date ? fetchTimeToGrowBookings(clubId,date) : [],
    timeToGrowConfig().then(config=>timeToGrowAppFetch(timeToGrowPath(config.paths.appClub,clubId))),
  ]);
  if (!clubResponse.ok) {
    const error = new Error("Time to Grow club request failed");
    error.code = "TIME_TO_GROW_REQUEST_FAILED";
    throw error;
  }
  const club = (await clubResponse.json().catch(() => null))?.data;
  const documents = {
    waiver:checkinDocumentTranslations(club?.documents?.info_url_translations),
    privacy:checkinDocumentTranslations(club?.documents?.privacy_url_translations),
  };
  const booking = bookings.find(item => item.id === bookingId);
  const guests = booking?.size ?? firstCount(
    visit.size, visit.guests, visit.players_count, visit.booking_size,
    visit.number_of_players, visit.booking?.size, visit.booking?.players_count,
  );
  if (!Number.isInteger(guests) || guests < 1) {
    const error = new Error("Time to Grow booking size is unavailable");
    error.code = "TIME_TO_GROW_BOOKING_SIZE_UNAVAILABLE";
    throw error;
  }
  return {
    location,
    clubId,
    visit,
    booking,
    documents,
    reservation:{ visitId,bookingId,time:visitTime(visit),room:visitLabel(visit),name:visitCustomer(visit),guests },
  };
}

const checkinGuestLimit = (token,reservation,extraAuthorization) => {
  const grant = readExtraGuestAuthorization(extraAuthorization,env.JWT_ACCESS_SECRET,token);
  return Math.max(reservation.guests,grant?.maxGuests || 0);
};

app.get("/reception/checkin/:token", rateLimit({ windowMs: 60_000, limit: 60 }), async (req, res) => {
  try {
    const resolved = await checkinReservationFromToken(req.params.token);
    res.set("cache-control", "no-store");
    if (!resolved) return res.status(404).json({ error:"CHECKIN_LINK_INVALID" });
    const extraAuthorization=z.string().max(300).optional().catch(undefined).parse(req.query.extraAuthorization);
    const maxGuests=checkinGuestLimit(req.params.token,resolved.reservation,extraAuthorization);
    res.json({ location:resolved.location, data:{...resolved.reservation,maxGuests}, documents:resolved.documents });
  } catch (error) {
    const status = error?.code === "TIME_TO_GROW_NOT_CONFIGURED" ? 503 : 502;
    const code = error?.name === "TimeoutError" ? "TIME_TO_GROW_TIMEOUT" : (error?.code || "TIME_TO_GROW_INVALID_RESPONSE");
    res.status(status).json({ error:code });
  }
});

app.post("/reception/checkin/:token/extra-guests", auth, rateLimit({ windowMs: 60_000, limit: 15 }), async (req,res) => {
  const parsed=z.object({totalGuests:z.coerce.number().int().min(1).max(CHECKIN_MAX_TOTAL_GUESTS)}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:"INVALID_INPUT"});
  try {
    const resolved=await checkinReservationFromToken(req.params.token);
    if(!resolved) return res.status(404).json({error:"CHECKIN_LINK_INVALID"});
    if(!isOwner(req)) {
      const allowed=await db.query(`
        SELECT 1 FROM user_locations ul
        JOIN locations l ON l.id=ul.location_id
        WHERE ul.user_id=$1 AND l.external_id=$2
      `,[req.user.sub,resolved.clubId]);
      if(!allowed.rowCount) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
    }
    if(parsed.data.totalGuests<=resolved.reservation.guests) {
      return res.status(400).json({error:"EXTRA_GUEST_LIMIT_INVALID"});
    }
    const extraAuthorization=createExtraGuestAuthorization(
      env.JWT_ACCESS_SECRET,
      req.params.token,
      parsed.data.totalGuests,
    );
    await audit(req,"checkin.extra_guests.authorize","booking",null,null,{
      clubId:resolved.clubId,
      bookingId:resolved.reservation.bookingId,
      bookedGuests:resolved.reservation.guests,
      totalGuests:parsed.data.totalGuests,
    });
    res.json({extraAuthorization,maxGuests:parsed.data.totalGuests});
  } catch(error) {
    const status=error?.code==="TIME_TO_GROW_NOT_CONFIGURED"?503:502;
    const code=error?.name==="TimeoutError"?"TIME_TO_GROW_TIMEOUT":(error?.code||"TIME_TO_GROW_INVALID_RESPONSE");
    res.status(status).json({error:code});
  }
});

app.post("/reception/checkin/:token/participants", rateLimit({ windowMs: 60_000, limit: 20 }), async (req, res) => {
  const parsed = checkinParticipantInput.safeParse(req.body);
  const signedToken=readCheckinToken(req.params.token,env.JWT_ACCESS_SECRET);
  if (!parsed.success) {
    await recordCheckinFailure(req,signedToken?.bookingId,{
      code:"INVALID_INPUT",
      fields:[...new Set(parsed.error.issues.map(issue=>String(issue.path[0]||"form")))],
    });
    return res.status(400).json({ error: "INVALID_INPUT" });
  }
  const input = parsed.data;
  let submissionKey=null;
  try {
    const resolved = await checkinReservationFromToken(req.params.token);
    if (!resolved) {
      await recordCheckinFailure(req,signedToken?.bookingId,{code:"CHECKIN_LINK_INVALID",participantNumber:input.participantNumber||null});
      return res.status(404).json({ error:"CHECKIN_LINK_INVALID" });
    }
    const { clubId,reservation } = resolved;
    const guestLimit=checkinGuestLimit(req.params.token,reservation,input.extraAuthorization);
    const participantNumber=input.participantNumber || (resolved.booking?.players?.length || 0)+1;
    const totalGuests=input.totalGuests || reservation.guests;
    if(totalGuests>guestLimit || participantNumber>totalGuests) {
      await recordCheckinFailure(req,reservation.bookingId,{code:"EXTRA_GUEST_AUTHORIZATION_REQUIRED",participantNumber,totalGuests,clubId});
      return res.status(403).json({error:"EXTRA_GUEST_AUTHORIZATION_REQUIRED"});
    }
    const tokenHash=crypto.createHash("sha256").update(req.params.token,"utf8").digest("hex");
    // Participant numbers belong to a browser session: every phone that opens
    // the QR code starts at participant 1.  Deduplicating by that number made
    // simultaneous self check-ins from different devices block each other.
    // Claim the submitted form instead, so a retry of the same person remains
    // idempotent without treating other guests as duplicates.
    const submissionFingerprint=crypto.createHash("sha256").update(JSON.stringify([
      input.firstName.trim().toLocaleLowerCase("en"),
      input.lastName.trim().toLocaleLowerCase("en"),
      input.email.trim().toLocaleLowerCase("en"),
      input.phone.trim(),
      input.birthday,
      input.gender,
    ])).digest("hex");
    submissionKey=`checkin-submission:v2:${tokenHash}:${submissionFingerprint}`;
    const claimed=await redis.set(submissionKey,req.requestId,"EX",48*60*60,"NX");
    if(claimed!=="OK") {
      await recordCheckinFailure(req,reservation.bookingId,{code:"CHECKIN_PARTICIPANT_ALREADY_SUBMITTED",participantNumber,totalGuests,clubId});
      return res.status(409).json({error:"CHECKIN_PARTICIPANT_ALREADY_SUBMITTED"});
    }

    const config=await timeToGrowConfig();
    const response = await timeToGrowAppFetch(
      timeToGrowPath(config.paths.appBookingMembers,clubId),
      {
        method: "POST",
        body: JSON.stringify({
          booking_id: reservation.bookingId,
          first_name: input.firstName,
          last_name: input.lastName,
          email: input.email,
          phone: input.phone,
          birthday: input.birthday,
          gender: input.gender,
          allow_marketing_materials: input.allowMarketingMaterials,
          accept_waiver: input.acceptWaiver,
          accept_privacy_policy: input.acceptPrivacyPolicy,
        }),
      },
    );
    if (!response.ok) {
      await redis.del(submissionKey);
      const status = response.status === 409 || response.status === 422 ? response.status : 502;
      await recordCheckinFailure(req,reservation.bookingId,{code:"TIME_TO_GROW_SUBMISSION_FAILED",participantNumber,totalGuests,clubId,upstreamStatus:response.status});
      return res.status(status).json({ error: "TIME_TO_GROW_SUBMISSION_FAILED" });
    }
    const payload = await response.json().catch(() => null);
    void sendTelegramImportantLog("checkinCompleted", "Гость прошёл check-in", [
      ["Гость", `${input.firstName} ${input.lastName}`.trim()],
      ["Бронь", reservation.name],
      ["Локация", resolved.location],
      ["Время", reservation.time],
      ["Прогресс", `${participantNumber}/${totalGuests}`],
    ]);
    res.status(201).json({ success: true, participantId: payload?.data?.id || null });
  } catch (error) {
    if(submissionKey) await redis.del(submissionKey).catch(()=>{});
    const status = error?.code === "TIME_TO_GROW_NOT_CONFIGURED" ? 503 : 502;
    const code = error?.name === "TimeoutError" ? "TIME_TO_GROW_TIMEOUT" : (error?.code || "TIME_TO_GROW_INVALID_RESPONSE");
    await recordCheckinFailure(req,signedToken?.bookingId,{code,participantNumber:input.participantNumber||null,totalGuests:input.totalGuests||null,upstreamStatus:error?.upstreamStatus||null});
    res.status(status).json({ error: code });
  }
});

async function fetchTimeToGrowBookings(clubId,date) {
  const config=await timeToGrowConfig();
  const query = new URLSearchParams({
    filtering: JSON.stringify({ status:"reserved",start_date:date,view_mode:"bookings" }),
    pagination: JSON.stringify({ page:1,size:100 }),
    sorting: JSON.stringify([{ name:"smart",direction:"desc" }]),
  });
  const response = await timeToGrowFetch(`${timeToGrowPath(config.paths.bookings,clubId)}?${query}`);
  if (!response.ok) {
    const error=new Error("Time to Grow booking request failed");
    error.code="TIME_TO_GROW_REQUEST_FAILED";
    error.upstreamStatus=response.status;
    throw error;
  }
  const payload=await response.json();
  return z.array(z.object({
    id:z.string(),
    start:z.object({date:z.string(),time:z.string()}),
    end:z.object({time:z.string()}),
    status:z.object({id:z.string(),name:z.string()}),
    owner:z.object({email:z.string().nullable().optional()}).passthrough(),
    product:z.object({effective_name:z.string()}),
    size:z.number().int().nonnegative(),
    order:z.object({total_amount:z.number().nonnegative(),payment_status:z.string()}).passthrough(),
    players:z.array(z.object({
      email:z.string().nullable().optional(),
      birthday:z.string().nullable().optional(),
    }).passthrough()).optional(),
  }).passthrough()).parse(payload.data);
}

function ageBandAtBooking(birthday,bookingDate) {
  if (!birthday) return "UNKNOWN";
  const born=new Date(`${birthday}T00:00:00Z`);
  const played=new Date(`${bookingDate}T00:00:00Z`);
  if (Number.isNaN(born.getTime()) || Number.isNaN(played.getTime()) || born>played) return "UNKNOWN";
  let age=played.getUTCFullYear()-born.getUTCFullYear();
  if (played.getUTCMonth()<born.getUTCMonth() || (played.getUTCMonth()===born.getUTCMonth() && played.getUTCDate()<born.getUTCDate())) age-=1;
  return age<13 ? "CHILD" : age<18 ? "TEEN" : "ADULT";
}

function classifyTimeToGrowProduct(productName) {
  const normalized=productName.trim().toLowerCase();
  if (/krampus/.test(normalized)) return {zoneName:"Krampus House",gameName:"Krampus House",requiresGameSelection:false};
  if (/gambling jack/.test(normalized)) return {zoneName:"Gambling Jack",gameName:"Gambling Jack",requiresGameSelection:false};
  if (/donau piraten|danube pirates/.test(normalized)) return {zoneName:"Donau Piraten",gameName:productName.trim(),requiresGameSelection:false};
  if (["color cube","call of cube","treasure island","star wars"].includes(normalized)) {
    return {zoneName:"QuestBoxes",gameName:productName.trim(),requiresGameSelection:false};
  }
  if (
    /^(friend|friends|friendle|couple|family)( day)? pass$/.test(normalized) ||
    /^(general( vr)?( day)? (ticket|pass)|kinder ?(pass|party|geburtstag)|any vr game)$/.test(normalized)
  ) {
    return {zoneName:"VR",gameName:null,requiresGameSelection:true};
  }
  return {zoneName:"VR",gameName:productName.trim(),requiresGameSelection:false};
}

async function importTimeToGrowBooking(client,location,externalBooking,createSession) {
  const productName=externalBooking.product.effective_name.trim();
  const classification=classifyTimeToGrowProduct(productName);
  let room=(await client.query(
    "SELECT id FROM rooms WHERE location_id=$1 AND lower(name)=lower($2) ORDER BY id LIMIT 1",
    [location.id,classification.zoneName]
  )).rows[0];
  if (!room && /krampus/i.test(classification.zoneName)) {
    room=(await client.query(
      "SELECT id FROM rooms WHERE location_id=$1 AND name ~* 'krampus' ORDER BY id LIMIT 1",
      [location.id]
    )).rows[0];
  }
  if (!room) {
    room=(await client.query(
      "INSERT INTO rooms(location_id,name,kind,capacity,status) VALUES($1,$2,$3,$4,'OFFLINE') RETURNING id",
      [location.id,classification.zoneName,classification.zoneName==="VR"?"VR":"REAL",Math.max(1,externalBooking.size)]
    )).rows[0];
  }
  const game=classification.gameName ? (await client.query(`
    INSERT INTO games(room_id,name) VALUES($1,$2)
    ON CONFLICT(room_id,lower(name)) DO UPDATE SET is_active=true
    RETURNING id,name
  `,[room.id,classification.gameName])).rows[0] : null;
  const existingBooking=(await client.query("SELECT id FROM bookings WHERE external_source='TIME_TO_GROW' AND external_id=$1",[externalBooking.id])).rows[0];
  const booking=(await client.query(`
    INSERT INTO bookings(
      room_id,customer_name,customer_phone,starts_at,ends_at,players,amount_cents,
      currency,payment_status,external_source,external_id,product_name,game_id
    ) VALUES(
      $1,'Time to Grow',NULL,
      ($2::date+$3::time) AT TIME ZONE $4,
      ($2::date+$5::time) AT TIME ZONE $4,
      $6,$7,'EUR',$8,'TIME_TO_GROW',$9,$10,$11
    )
    ON CONFLICT(external_source,external_id) WHERE external_source IS NOT NULL AND external_id IS NOT NULL
    DO UPDATE SET room_id=excluded.room_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
      players=excluded.players,amount_cents=excluded.amount_cents,payment_status=excluded.payment_status,
      product_name=excluded.product_name,game_id=excluded.game_id
    RETURNING *
  `,[room.id,externalBooking.start.date,externalBooking.start.time,location.timezone,
      externalBooking.end.time,externalBooking.size,Math.round(externalBooking.order.total_amount*100),
      externalBooking.order.payment_status,externalBooking.id,productName,game?.id||null])).rows[0];

  await client.query("DELETE FROM booking_participants WHERE booking_id=$1",[booking.id]);
  const sourcePlayers=[...(externalBooking.players||[])].slice(0,externalBooking.size);
  if (!sourcePlayers.length && externalBooking.size>0 && externalBooking.owner.email) {
    sourcePlayers.push({email:externalBooking.owner.email,birthday:null});
  }
  while (sourcePlayers.length<externalBooking.size) sourcePlayers.push({email:null,birthday:null});
  const bookingTokens=new Set();
  for (const player of sourcePlayers) {
    let token=player.email ? identityToken(player.email) : crypto.randomBytes(32);
    let identityType=player.email ? "EMAIL_HMAC" : "BOOKING_RANDOM";
    const tokenKey=token.toString("hex");
    if (bookingTokens.has(tokenKey)) {
      token=crypto.randomBytes(32);
      identityType="BOOKING_RANDOM";
    }
    bookingTokens.add(token.toString("hex"));
    const person=(await client.query(`
      INSERT INTO people(identity_token,identity_type,token_version) VALUES($1,$2,1)
      ON CONFLICT(token_version,identity_token) DO UPDATE SET last_seen_at=now()
      RETURNING id
    `,[token,identityType])).rows[0];
    const ageBand=ageBandAtBooking(player.birthday,externalBooking.start.date);
    await client.query(`
      INSERT INTO booking_participants(booking_id,person_id,participant_role,category_at_booking,age_band_at_booking)
      VALUES($1,$2,'PLAYER',$3,$3) ON CONFLICT(booking_id,person_id) DO UPDATE SET
      category_at_booking=excluded.category_at_booking,age_band_at_booking=excluded.age_band_at_booking
    `,[booking.id,person.id,ageBand]);
  }
  let session=null;
  if (createSession) {
    session=(await client.query("SELECT * FROM sessions WHERE booking_id=$1 ORDER BY started_at LIMIT 1",[booking.id])).rows[0];
    if (!session) {
      session=(await client.query(`
        INSERT INTO sessions(booking_id,room_id,game_id,status,started_at,ended_at,remaining_seconds)
        VALUES($1,$2,$3,'FINISHED',$4,$5,0) RETURNING *
      `,[booking.id,room.id,booking.game_id,booking.starts_at,booking.ends_at])).rows[0];
    }
    await client.query("DELETE FROM session_participants WHERE session_id=$1",[session.id]);
    await client.query(`
      INSERT INTO session_participants(session_id,person_id,participant_role,category_at_play,age_band_at_play)
      SELECT $1,person_id,participant_role,category_at_booking,age_band_at_booking
      FROM booking_participants WHERE booking_id=$2
      ON CONFLICT(session_id,person_id) DO NOTHING
    `,[session.id,booking.id]);
  }
  return {booking,session,game,classification,isNew:!existingBooking};
}

app.get("/time-to-grow/clubs", auth, permit("bookings:read"), async (_, res) => {
  try {
    const config=await timeToGrowConfig();
    const response = await timeToGrowFetch(config.paths.clubs);
    if (!response.ok) {
      return res.status(502).json({ error: "TIME_TO_GROW_REQUEST_FAILED", upstreamStatus: response.status });
    }
    const payload = await response.json();
    const clubs = z.array(z.object({
      id: z.string(),
      name: z.string(),
      timezone: z.string(),
      address: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    }).passthrough()).parse(payload.data);
    for (const club of clubs) {
      await db.query(
        `INSERT INTO locations(external_id,name,timezone,address) VALUES($1,$2,$3,$4)
         ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET name=excluded.name,timezone=excluded.timezone,address=excluded.address`,
        [club.id,club.name,club.timezone,club.address || null]
      );
    }
    const allowedExternalIds = isOwner(_)
      ? null
      : new Set((await db.query("SELECT l.external_id FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=$1", [_.user.sub])).rows.map(row=>row.external_id));
    const visibleClubs = allowedExternalIds ? clubs.filter(club=>allowedExternalIds.has(club.id)) : clubs;
    res.json({
      data: visibleClubs.map(club => ({
        id: club.id,
        name: club.name,
        timezone: club.timezone,
        address: club.address || null,
        phone: club.phone || null,
        email: club.email || null,
      })),
      defaultClubId: visibleClubs.some(club=>club.id===config.defaultClubId) ? config.defaultClubId : visibleClubs[0]?.id || null,
    });
  } catch (error) {
    if (error?.code === "TIME_TO_GROW_NOT_CONFIGURED") return res.status(503).json({ error: error.code });
    const code = error?.name === "TimeoutError" ? "TIME_TO_GROW_TIMEOUT" : (error?.code || "TIME_TO_GROW_INVALID_RESPONSE");
    res.status(502).json({ error: code, upstreamStatus: error?.upstreamStatus });
  }
});

app.get("/time-to-grow/bookings", auth, permit("bookings:read"), async (req, res) => {
  const config=await timeToGrowConfig();
  if (!timeToGrowJwt && !config.jwt && (!config.email || !config.password)) {
    return res.status(503).json({ error: "TIME_TO_GROW_NOT_CONFIGURED" });
  }
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    clubId: z.string().regex(/^[a-z0-9]{26}$/).optional(),
  }).refine(value=>Boolean(value.date||(value.from&&value.to)),{message:"Date or range required"}).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DATE" });
  const clubId = parsed.data.clubId || config.defaultClubId;
  if (!clubId) return res.status(400).json({ error: "CLUB_REQUIRED" });
  if (!isOwner(req)) {
    const allowed = await db.query("SELECT 1 FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=$1 AND l.external_id=$2", [req.user.sub,clubId]);
    if (!allowed.rowCount) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  }

  const dateFilter=parsed.data.date
    ? {start_date:parsed.data.date,view_mode:"bookings"}
    : {month_with_buffer:parsed.data.from};
  const query = new URLSearchParams({
    filtering: JSON.stringify({ status: "reserved", ...dateFilter }),
    pagination: JSON.stringify({ page: 1, size: parsed.data.date ? 100 : 1000 }),
  });
  if(parsed.data.date) query.set("sorting",JSON.stringify([{name:"smart",direction:"desc"}]));

  try {
    const requestPath=timeToGrowPath(parsed.data.date?config.paths.bookings:config.paths.calendar,clubId);
    const response = await timeToGrowFetch(`${requestPath}?${query}`);
    if (!response.ok) {
      return res.status(502).json({ error: "TIME_TO_GROW_REQUEST_FAILED", upstreamStatus: response.status });
    }
    const payload = await response.json();
    const sourceBookings=Array.isArray(payload?.data)?payload.data:[];
    const normalizedBookings=parsed.data.date?sourceBookings:sourceBookings
      .filter(booking=>booking?.id&&booking?.start?.date&&booking?.start?.time)
      .map(booking=>({
        ...booking,
        end:{...booking.end,time:firstText(booking.end?.time,booking.start?.time)||booking.start.time},
        status:{...booking.status,id:firstText(booking.status?.id,"reserved")||"reserved",name:firstText(booking.status?.name,"Reserved")||"Reserved"},
        owner:{...booking.owner,name:firstText(booking.owner?.name,booking.customer?.name,"Бронь")||"Бронь"},
        product:{...booking.product,effective_name:firstText(booking.product?.effective_name,booking.product_name,"Бронь")||"Бронь"},
        size:Number.isInteger(Number(booking.size))&&Number(booking.size)>=0?Number(booking.size):0,
        order:{...booking.order,total_amount:Number(booking.order?.total_amount)||0,payment_status:firstText(booking.order?.payment_status,"unknown")||"unknown",payment_status_display:firstText(booking.order?.payment_status_display,"—")||"—"},
        players:[],
      }));
    const bookings = z.array(z.object({
      id: z.string(),
      start: z.object({ date: z.string(), time: z.string() }),
      end: z.object({ time: z.string() }),
      status: z.object({ id: z.string(), name: z.string() }),
      owner: z.object({
        name: z.string(),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      }),
      product: z.object({ effective_name: z.string() }),
      size: z.number().int().nonnegative(),
      order: z.object({
        total_amount: z.number().nonnegative(),
        payment_status: z.string(),
        payment_status_display: z.string(),
      }),
      check_in_status: z.object({
        total: z.number().int().nonnegative(),
        checked_in: z.number().int().nonnegative(),
      }).optional(),
      players: z.array(z.object({
        id: z.string(),
        first_name: z.string(),
        last_name: z.string(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        birthday: z.string().nullable().optional(),
        accept_waiver: z.boolean().optional(),
      }).passthrough()).optional(),
    }).passthrough()).parse(normalizedBookings);

    const playerAgeAtBooking = (birthday, bookingDate) => {
      if (!birthday) return { age: null, birthdayDaysAgo: null };
      const born = new Date(`${birthday}T00:00:00Z`);
      const booking = new Date(`${bookingDate}T00:00:00Z`);
      if (Number.isNaN(born.getTime()) || Number.isNaN(booking.getTime()) || born > booking) {
        return { age: null, birthdayDaysAgo: null };
      }
      const birthdayThisYear = new Date(Date.UTC(
        booking.getUTCFullYear(),
        born.getUTCMonth(),
        born.getUTCDate(),
      ));
      const lastBirthday = birthdayThisYear > booking
        ? new Date(Date.UTC(booking.getUTCFullYear() - 1, born.getUTCMonth(), born.getUTCDate()))
        : birthdayThisYear;
      const birthdayDaysAgo = Math.floor((booking.getTime() - lastBirthday.getTime()) / 86_400_000);
      return {
        age: lastBirthday.getUTCFullYear() - born.getUTCFullYear(),
        birthdayDaysAgo: birthdayDaysAgo < 7 ? birthdayDaysAgo : null,
      };
    };

    const importedRows=bookings.length ? (await db.query(`
      SELECT b.external_id,b.id local_booking_id,b.game_id,
             g.name selected_game_name,s.id session_id,s.status session_status
      FROM bookings b
      LEFT JOIN games g ON g.id=b.game_id
      LEFT JOIN LATERAL (
        SELECT id,status FROM sessions
        WHERE booking_id=b.id
        ORDER BY started_at DESC NULLS LAST,id DESC
        LIMIT 1
      ) s ON TRUE
      WHERE b.external_source='TIME_TO_GROW' AND b.external_id=ANY($1::text[])
    `,[bookings.map(booking=>booking.id)])).rows : [];
    const importedById=new Map(importedRows.map(row=>[row.external_id,row]));
    const confirmationRows=bookings.length ? (await db.query(
      "SELECT external_booking_id,confirmed FROM external_booking_confirmations WHERE club_id=$1 AND external_booking_id=ANY($2::text[])",
      [clubId,bookings.map(booking=>booking.id)]
    )).rows : [];
    const confirmationsById=new Map(confirmationRows.map(row=>[row.external_booking_id,row.confirmed]));
    const checkinFailureRows=bookings.length ? (await db.query(`
      SELECT entity_id,request_id,after_state,created_at
      FROM audit_logs
      WHERE action='checkin.participant.submit.failed'
        AND entity_type='external_booking'
        AND entity_id=ANY($1::text[])
        AND created_at>now()-interval '14 days'
      ORDER BY created_at DESC
    `,[bookings.map(booking=>booking.id)])).rows : [];
    const checkinFailuresByBooking=new Map();
    for(const row of checkinFailureRows) {
      const current=checkinFailuresByBooking.get(row.entity_id)||[];
      if(current.length<10) current.push({
        code:row.after_state?.code||"UNKNOWN",
        participantNumber:row.after_state?.participantNumber||null,
        fields:Array.isArray(row.after_state?.fields)?row.after_state.fields:[],
        upstreamStatus:row.after_state?.upstreamStatus||null,
        requestId:row.request_id,
        createdAt:row.created_at,
      });
      checkinFailuresByBooking.set(row.entity_id,current);
    }

    res.json({
      data: bookings.map(booking => ({
        zoneName: classifyTimeToGrowProduct(booking.product.effective_name).zoneName,
        suggestedGameName: classifyTimeToGrowProduct(booking.product.effective_name).gameName,
        requiresGameSelection: classifyTimeToGrowProduct(booking.product.effective_name).requiresGameSelection,
        gameId: importedById.get(booking.id)?.game_id || null,
        selectedGameName: importedById.get(booking.id)?.selected_game_name || null,
        localBookingId: importedById.get(booking.id)?.local_booking_id || null,
        sessionId: importedById.get(booking.id)?.session_id || null,
        sessionStatus: importedById.get(booking.id)?.session_status || null,
        confirmed: confirmationsById.get(booking.id) || false,
        id: booking.id,
        date: booking.start.date,
        startsAt: booking.start.time,
        endsAt: booking.end.time,
        status: booking.status.id,
        statusDisplay: booking.status.name,
        customerName: booking.owner.name,
        customerPhone: booking.owner.phone || null,
        customerEmail: booking.owner.email || null,
        productName: booking.product.effective_name,
        players: booking.size,
        amountCents: Math.round(booking.order.total_amount * 100),
        pricing: timeToGrowBookingPricing(booking),
        currency: "EUR",
        paymentStatus: booking.order.payment_status,
        paymentStatusDisplay: booking.order.payment_status_display,
        checkedIn: booking.check_in_status?.checked_in ?? 0,
        checkInTotal: booking.check_in_status?.total ?? booking.size,
        checkInPath: `/reception/checkin/${createCheckinToken(env.JWT_ACCESS_SECRET,clubId,booking.id)}`,
        checkInErrors: checkinFailuresByBooking.get(booking.id)||[],
        checkedInPlayers: (booking.players || []).map(player => {
          const age = playerAgeAtBooking(player.birthday, booking.start.date);
          return {
            id: player.id,
            name: `${player.first_name} ${player.last_name}`.trim(),
            email: player.email || null,
            phone: player.phone || null,
            age: age.age,
            birthdayDaysAgo: age.birthdayDaysAgo,
            waiverAccepted: player.accept_waiver ?? false,
          };
        }),
      })),
      pagination: payload.pagination || null,
    });
  } catch (error) {
    if (error?.code === "TIME_TO_GROW_NOT_CONFIGURED") return res.status(503).json({ error: error.code });
    const code = error?.name === "TimeoutError" ? "TIME_TO_GROW_TIMEOUT" : (error?.code || "TIME_TO_GROW_INVALID_RESPONSE");
    res.status(502).json({ error: code, upstreamStatus: error?.upstreamStatus });
  }
});

app.patch("/time-to-grow/bookings/:id/confirmation",auth,permit("bookings:read"),async(req,res)=>{
  const parsed=z.object({clubId:z.string().regex(/^[a-z0-9]{26}$/),confirmed:z.boolean()}).safeParse(req.body);
  if(!parsed.success) return res.status(400).json({error:"INVALID_INPUT"});
  const {clubId,confirmed}=parsed.data;
  if(!isOwner(req)) {
    const allowed=await db.query("SELECT 1 FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=$1 AND l.external_id=$2",[req.user.sub,clubId]);
    if(!allowed.rowCount) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  }
  const before=(await db.query("SELECT confirmed FROM external_booking_confirmations WHERE club_id=$1 AND external_booking_id=$2",[clubId,req.params.id])).rows[0];
  const result=(await db.query(`INSERT INTO external_booking_confirmations(club_id,external_booking_id,confirmed,updated_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(club_id,external_booking_id) DO UPDATE SET confirmed=excluded.confirmed,updated_by=excluded.updated_by,updated_at=now()
    RETURNING external_booking_id AS id,confirmed`,[clubId,req.params.id,confirmed,req.user.sub])).rows[0];
  await audit(req,"booking.confirmation.update","external_booking",req.params.id,before||{confirmed:false},result);
  if(result.confirmed&&!before?.confirmed) {
    const location=(await db.query("SELECT name FROM locations WHERE external_id=$1",[clubId])).rows[0];
    void sendTelegramImportantLog("bookingConfirmed", "Бронь подтверждена", [["Локация", location?.name], ["Бронь", req.params.id], ["Источник", "Time to Grow"]]);
  }
  res.json(result);
});

app.post("/time-to-grow/import", auth, permit("bookings:read"), async (req,res) => {
  if (!env.PSEUDONYMIZATION_SECRET) return res.status(503).json({error:"PSEUDONYMIZATION_NOT_CONFIGURED"});
  const input=z.object({
    clubId:z.string().regex(/^[a-z0-9]{26}$/),
    dates:z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(366),
    bookingId:z.string().optional(),
    createSessions:z.boolean().default(true),
  }).parse(req.body);
  if (input.dates.length>1 && !["OWNER","ADMIN"].includes(req.user?.role)) {
    return res.status(403).json({error:"BULK_IMPORT_FORBIDDEN"});
  }
  const location=(await db.query("SELECT id,timezone FROM locations WHERE external_id=$1",[input.clubId])).rows[0];
  if (!location) return res.status(404).json({error:"LOCATION_NOT_SYNCED"});
  if (!(await locationAllowed(req,location.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const externalBookings=[];
  const failedDates=[];
  for (const date of [...new Set(input.dates)]) {
    try {
      const rows=await fetchTimeToGrowBookings(input.clubId,date);
      externalBookings.push(...rows.filter(row=>!input.bookingId || row.id===input.bookingId));
    } catch (error) {
      failedDates.push({date,error:error.code||"TIME_TO_GROW_REQUEST_FAILED"});
    }
  }
  if (input.bookingId && !externalBookings.length) {
    return res.status(failedDates.length ? 502 : 404).json({
      error:failedDates.length ? "TIME_TO_GROW_REQUEST_FAILED" : "EXTERNAL_BOOKING_NOT_FOUND",
      failedDates,
    });
  }
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const imported=[];
    const failedBookings=[];
    for (const externalBooking of externalBookings) {
      await client.query("SAVEPOINT import_booking");
      try {
        const result=await importTimeToGrowBooking(client,location,externalBooking,input.createSessions);
        imported.push({
          bookingId:result.booking.id,
          sessionId:result.session?.id||null,
          gameId:result.booking.game_id||null,
          zoneName:result.classification.zoneName,
          externalId:externalBooking.id,
          isNew:result.isNew,
        });
        await client.query("RELEASE SAVEPOINT import_booking");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT import_booking");
        failedBookings.push({externalId:externalBooking.id,error:error.code||"IMPORT_FAILED"});
      }
    }
    await client.query("COMMIT");
    await audit(req,"time_to_grow.import","booking",null,null,{
      dates:input.dates,imported:imported.length,failedDates:failedDates.length,
      failedBookings:failedBookings.length,createSessions:input.createSessions
    });
    void Promise.all(imported.filter(item=>item.isNew).map(async item=>{
      const booking=await telegramBookingById(item.bookingId);
      if(booking&&!booking.confirmed) await sendTelegramBookingNotification(booking,"newBooking","booking:new");
    })).catch(error=>console.error("Telegram new booking notification failed",error.message));
    res.status(201).json({
      imported:imported.length,
      items:imported,
      failedDates,
      failedBookings,
    });
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/sessions", auth, permit("sessions:read"), async (req, res) => {
  if (!["OWNER","ADMIN","OPERATOR"].includes(req.user?.role)) return res.status(403).json({ error:"SESSIONS_HISTORY_FORBIDDEN" });
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const input = z.object({
    locationId:z.string().uuid().optional(),
    from:date.optional(),
    to:date.optional(),
  }).parse(req.query);
  if (input.from && input.to && input.from > input.to) return res.status(400).json({ error:"INVALID_DATE_RANGE" });
  if (input.locationId && !(await locationAllowed(req,input.locationId))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const values = isOwner(req) ? [] : [req.user.sub];
  const scopeClause = isOwner(req)
    ? "TRUE"
    : "r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)";
  let locationClause = "TRUE";
  if (input.locationId) {
    values.push(input.locationId);
    locationClause = `r.location_id=$${values.length}`;
  }
  let dateClause = "TRUE";
  if (input.from) {
    values.push(input.from);
    dateClause = `s.started_at >= $${values.length}::date`;
  }
  if (input.to) {
    values.push(input.to);
    dateClause += ` AND s.started_at < ($${values.length}::date + interval '1 day')`;
  }
  const { rows } = await db.query(`
    SELECT s.*,r.name room_name,r.location_id,l.name location_name,g.name game_name,
           COALESCE(s.manual_player_count,count(sp.person_id)::int) player_count,
           count(sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_player_count,
           count(sp.person_id) FILTER (WHERE p.identity_type='BOOKING_RANDOM')::int anonymous_player_count,
           CASE WHEN s.started_at IS NULL THEN NULL
             ELSE extract(epoch FROM (COALESCE(s.ended_at,now())-s.started_at))::int
           END elapsed_seconds
    FROM sessions s
    JOIN rooms r ON r.id=s.room_id
    JOIN locations l ON l.id=r.location_id
    LEFT JOIN games g ON g.id=s.game_id
    LEFT JOIN session_participants sp ON sp.session_id=s.id
    LEFT JOIN people p ON p.id=sp.person_id
    WHERE ${scopeClause} AND ${locationClause} AND ${dateClause}
    GROUP BY s.id,r.id,r.name,r.location_id,l.name,g.name
    ORDER BY COALESCE(s.started_at,now()) DESC LIMIT 250
  `,values);
  res.json(rows);
});

app.post("/sessions", auth, permit("sessions:create"), async (req, res) => {
  if (!Object.hasOwn(req.body || {},"bookingId")) {
    if (!["OWNER","ADMIN","OPERATOR"].includes(req.user?.role)) return res.status(403).json({ error:"SESSION_CREATE_FORBIDDEN" });
    const input=z.object({
      roomId:z.string().uuid(),
      gameId:z.string().uuid().nullable().default(null),
      status:z.enum(["RUNNING","PAUSED","FINISHED","CANCELLED"]),
      startedAt:z.string().datetime({offset:true}),
      endedAt:z.string().datetime({offset:true}).nullable().default(null),
      remainingSeconds:z.number().int().min(0).max(14400).nullable().default(null),
    }).refine(value=>!value.endedAt || new Date(value.endedAt)>=new Date(value.startedAt),{
      message:"endedAt must not precede startedAt",
      path:["endedAt"],
    }).refine(value=>value.status!=="FINISHED" || Boolean(value.endedAt),{
      message:"endedAt is required for a finished session",
      path:["endedAt"],
    }).parse(req.body);
    const room=(await db.query("SELECT id,location_id FROM rooms WHERE id=$1",[input.roomId])).rows[0];
    if (!room) return res.status(404).json({ error:"ROOM_NOT_FOUND" });
    if (!(await locationAllowed(req,room.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
    if ((await db.query("SELECT 1 FROM sessions WHERE room_id=$1 AND status NOT IN ('FINISHED','CANCELLED') LIMIT 1",[input.roomId])).rowCount) {
      return res.status(409).json({ error:"SESSION_EXISTS" });
    }
    if (input.gameId && !(await db.query("SELECT 1 FROM games WHERE id=$1 AND room_id=$2",[input.gameId,input.roomId])).rowCount) {
      return res.status(400).json({error:"GAME_NOT_IN_ZONE"});
    }
    const { rows }=await db.query(`
      INSERT INTO sessions(room_id,game_id,status,started_at,ended_at,remaining_seconds)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *
    `,[input.roomId,input.gameId,input.status,input.startedAt,input.endedAt,input.remainingSeconds]);
    await audit(req,"session.create","session",rows[0].id,null,rows[0]);
    if(rows[0].status==="RUNNING") void sendTelegramImportantLog("sessionStarted", "Сессия начата", [["Сессия", rows[0].id]]);
    if(rows[0].status==="FINISHED") void sendTelegramImportantLog("sessionRecorded", "Сессия записана", [["Сессия", rows[0].id]]);
    return res.status(201).json(rows[0]);
  }
  const input = z.object({
    bookingId:z.string().uuid(),
    gameId:z.string().uuid().nullable().optional(),
    durationSeconds:z.number().int().min(300).max(14400).default(3600),
  }).parse(req.body);
  const booking = (await db.query("SELECT * FROM bookings WHERE id=$1", [input.bookingId])).rows[0];
  if (!booking) return res.status(404).json({ error:"BOOKING_NOT_FOUND" });
  const bookingRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[booking.room_id])).rows[0];
  if (!bookingRoom || !(await locationAllowed(req,bookingRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const gameId=Object.hasOwn(input,"gameId") ? input.gameId : booking.game_id;
  if (gameId && !(await db.query("SELECT 1 FROM games WHERE id=$1 AND room_id=$2 AND is_active=true",[gameId,booking.room_id])).rowCount) {
    return res.status(400).json({ error:"GAME_NOT_IN_ZONE" });
  }
  const roomName=(await db.query("SELECT name FROM rooms WHERE id=$1",[booking.room_id])).rows[0]?.name;
  if (roomName?.toLowerCase()==="vr" && !gameId) return res.status(400).json({ error:"GAME_REQUIRED" });
  if ((await db.query("SELECT 1 FROM sessions WHERE booking_id=$1 AND status NOT IN ('FINISHED','CANCELLED')", [booking.id])).rowCount) {
    return res.status(409).json({ error:"SESSION_EXISTS" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "INSERT INTO sessions(booking_id,room_id,game_id,status,started_at,remaining_seconds) VALUES($1,$2,$3,'RUNNING',now(),$4) RETURNING *",
      [booking.id,booking.room_id,gameId,input.durationSeconds]
    );
    await client.query(`
      INSERT INTO session_participants(
        session_id,person_id,participant_role,category_at_play,age_band_at_play
      )
      SELECT $1,person_id,participant_role,category_at_booking,age_band_at_booking
      FROM booking_participants
      WHERE booking_id=$2
      ON CONFLICT(session_id,person_id) DO NOTHING
    `,[rows[0].id,booking.id]);
    await client.query("COMMIT");
    await audit(req,"session.start","session",rows[0].id,null,rows[0]);
    void sendTelegramImportantLog("sessionStarted", "Сессия начата", [["Сессия", rows[0].id]]);
    res.status(201).json(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/time-to-grow/session-record-options",auth,permit("sessions:create"),async(req,res)=>{
  const input=z.object({clubId:z.string().regex(/^[a-z0-9]{26}$/),gameId:z.string().uuid().optional()}).parse(req.query);
  const location=(await db.query("SELECT id FROM locations WHERE external_id=$1",[input.clubId])).rows[0];
  if(!location) return res.status(404).json({error:"LOCATION_NOT_SYNCED"});
  if(!(await locationAllowed(req,location.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`SELECT id,name,category,unit,quantity,game_id,
    (game_id=$2::uuid) recommended FROM inventory_items
    WHERE location_id=$1 AND is_active=true AND lower(category) LIKE '%магнит%'
    ORDER BY (game_id=$2::uuid) DESC NULLS LAST,quantity DESC,lower(name)`,[location.id,input.gameId||null]);
  res.json(rows);
});

async function googleSheetsConfig(clubId){
  const row=(await db.query("SELECT encrypted_value FROM app_settings WHERE key=$1",[`google_sheets:${clubId}`])).rows[0];
  try{return decryptSetting(row?.encrypted_value);}catch(error){console.error("Unable to decrypt Google Sheets settings",error);return null;}
}
async function sendSessionToGoogleSheets(clubId,payload){
  const config=await googleSheetsConfig(clubId);
  if(!config?.url||!config?.secret)return {configured:false};
  const response=await fetch(config.url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...payload,secret:config.secret}),redirect:"follow",signal:AbortSignal.timeout(30000)});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result?.ok)throw new Error(`GOOGLE_SHEETS_SYNC_FAILED:${response.status}:${result?.error||"INVALID_RESPONSE"}`);
  if(payload.type==="session.recorded"&&(
    result.sessionId!==payload.sessionId||
    result.bookingId!==payload.bookingId||
    !String(result.qcId||"").includes(`session:${payload.sessionId}`)||
    !String(result.qcId||"").includes(`booking:${payload.bookingId}`)
  ))throw Object.assign(new Error("GOOGLE_SHEETS_IDENTIFIER_MISSING"),{code:"GOOGLE_SHEETS_IDENTIFIER_MISSING"});
  return {configured:true,...result};
}
async function syncStoredSessionToGoogleSheets(sessionId){
  const session=(await db.query("SELECT sheet_sync_payload FROM sessions WHERE id=$1",[sessionId])).rows[0];
  const stored=session?.sheet_sync_payload;
  if(!stored?.clubId||!stored?.payload)throw Object.assign(new Error("SHEET_SYNC_DATA_MISSING"),{code:"SHEET_SYNC_DATA_MISSING"});
  await db.query("UPDATE sessions SET sheet_sync_status='PENDING',sheet_sync_error=NULL WHERE id=$1",[sessionId]);
  try{
    const result=await sendSessionToGoogleSheets(stored.clubId,stored.payload);
    const status=result.configured&&result.ok?"SYNCED":"FAILED";
    await db.query("UPDATE sessions SET sheet_sync_status=$2,sheet_sync_error=$3,sheet_synced_at=CASE WHEN $2='SYNCED' THEN now() ELSE sheet_synced_at END WHERE id=$1",[sessionId,status,result.configured?"INVALID_RESPONSE":"NOT_CONFIGURED"]);
    return {...result,status};
  }catch(error){
    await db.query("UPDATE sessions SET sheet_sync_status='FAILED',sheet_sync_error=$2 WHERE id=$1",[sessionId,String(error.message||error).slice(0,500)]);
    throw error;
  }
}

app.get("/settings/google-sheets",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const {clubId}=z.object({clubId:z.string().regex(/^[a-z0-9]{26}$/)}).parse(req.query);
  const config=await googleSheetsConfig(clubId);
  res.json({configured:Boolean(config?.url&&config?.secret),url:config?.url||""});
});

app.put("/settings/google-sheets",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=z.object({clubId:z.string().regex(/^[a-z0-9]{26}$/),url:z.string().url().refine(value=>value.startsWith("https://script.google.com/macros/s/")&&value.endsWith("/exec")),secret:z.string().max(256).optional().default("")}).parse(req.body);
  const current=await googleSheetsConfig(input.clubId);
  const secret=input.secret||current?.secret;
  if(!secret)return res.status(400).json({error:"GOOGLE_SHEETS_SECRET_REQUIRED"});
  const settingKey=`google_sheets:${input.clubId}`;
  await db.query(`INSERT INTO app_settings(key,encrypted_value,updated_by,updated_at) VALUES($1,$2,$3,now())
    ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_by=excluded.updated_by,updated_at=now()`,[settingKey,encryptSetting({url:input.url,secret}),req.user.sub]);
  await audit(req,"settings.google_sheets.update","app_setting",settingKey,null,{url:input.url,clubId:input.clubId});
  res.json({configured:true,url:input.url});
});

app.post("/settings/google-sheets/test",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const {clubId}=z.object({clubId:z.string().regex(/^[a-z0-9]{26}$/)}).parse(req.body);
  try{const result=await sendSessionToGoogleSheets(clubId,{type:"connection.test"});res.json({ok:true,sheets:result.sheets||[]});}
  catch(error){res.status(error.message?.includes("NOT_CONFIGURED")?409:502).json({error:"GOOGLE_SHEETS_UNAVAILABLE"});}
});

const timeToGrowSettingsInput=z.object({
  baseUrl:z.string().url().refine(value=>value.startsWith("https://")),email:z.union([z.string().email(),z.literal("")]),password:z.string().max(500).optional(),jwt:z.string().max(4000).optional(),
  defaultClubId:z.string().max(100).default(""),viennaClubId:z.string().max(100).default(""),
  paths:z.object({login:z.string().startsWith("/"),clubs:z.string().startsWith("/"),bookings:z.string().startsWith("/"),calendar:z.string().startsWith("/"),appVisits:z.string().startsWith("/"),appClub:z.string().startsWith("/"),appBookingMembers:z.string().startsWith("/")}),
});
app.get("/settings/time-to-grow",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const config=await timeToGrowConfig(true);
  res.json({...config,password:"",jwt:"",hasPassword:Boolean(config.password),hasJwt:Boolean(config.jwt||timeToGrowJwt)});
});
app.put("/settings/time-to-grow",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=timeToGrowSettingsInput.parse(req.body),current=await timeToGrowConfig(true);
  const saved={...input,password:input.password||current.password,jwt:input.jwt||current.jwt};
  await db.query(`INSERT INTO app_settings(key,encrypted_value,updated_by,updated_at) VALUES('time_to_grow',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_by=excluded.updated_by,updated_at=now()`,[encryptSetting(saved),req.user.sub]);
  timeToGrowConfigCache=null;timeToGrowJwt=saved.jwt||null;timeToGrowAccessToken=null;
  await audit(req,"settings.time_to_grow.update","app_setting","time_to_grow",null,{baseUrl:saved.baseUrl,defaultClubId:saved.defaultClubId,viennaClubId:saved.viennaClubId,paths:saved.paths});
  res.json({ok:true});
});
app.post("/settings/time-to-grow/test",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  try{const config=await timeToGrowConfig(true);const response=await timeToGrowFetch(config.paths.clubs);if(!response.ok)return res.status(502).json({error:"UPSTREAM_ERROR",status:response.status});const payload=await response.json();res.json({ok:true,clubs:Array.isArray(payload?.data)?payload.data.length:0});}
  catch(error){res.status(502).json({error:error.code||"CONNECTION_FAILED"});}
});

app.get("/settings/telegram",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const settings=await telegramSettings();
  res.json({configured:Boolean(telegramBot?.enabled),botUsername:telegramBot?.username||env.TELEGRAM_BOT_USERNAME||"",...settings});
});
app.put("/settings/telegram",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=telegramSettingsInput.parse(req.body);
  await db.query(`INSERT INTO app_settings(key,encrypted_value,updated_by,updated_at) VALUES('telegram_notifications',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_by=excluded.updated_by,updated_at=now()`,[encryptSetting(input),req.user.sub]);
  telegramSettingsCache=input;
  await audit(req,"settings.telegram.update","app_setting","telegram_notifications",null,{templates:Object.keys(input)});
  res.json({ok:true});
});
app.get("/settings/telegram/recipients",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const {rows}=await db.query(`SELECT u.id,u.display_name,u.email,tc.username,tc.first_name,tc.linked_at
    FROM telegram_connections tc JOIN users u ON u.id=tc.user_id AND u.is_active=true
    ORDER BY lower(u.display_name),lower(u.email)`);
  res.json(rows);
});
app.get("/settings/telegram/important-logs",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  res.json(await telegramImportantLogSettings());
});
app.put("/settings/telegram/important-logs",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=telegramImportantLogSettingsInput.parse(req.body);
  if(input.recipientUserId && !(await db.query("SELECT 1 FROM telegram_connections tc JOIN users u ON u.id=tc.user_id AND u.is_active=true WHERE tc.user_id=$1",[input.recipientUserId])).rowCount) return res.status(400).json({error:"TELEGRAM_RECIPIENT_NOT_CONNECTED"});
  await db.query(`INSERT INTO app_settings(key,encrypted_value,updated_by,updated_at) VALUES('telegram_important_logs',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_by=excluded.updated_by,updated_at=now()`,[encryptSetting(input),req.user.sub]);
  telegramImportantLogSettingsCache=input;
  await audit(req,"settings.telegram.important_logs.update","app_setting","telegram_important_logs",null,{recipientUserId:input.recipientUserId,events:input.events});
  res.json(input);
});
const webhookSettingsInput = z.object({
  enabled: z.boolean().default(false),
  url: z.union([z.literal(""), z.string().url().refine(value => value.startsWith("https://"))]).default(""),
  secret: z.string().max(256).optional().default(""),
  events: z.object(Object.fromEntries(telegramImportantLogEvents.map(event => [event, z.boolean()]))),
});
app.get("/settings/webhook",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const settings=await webhookSettings();
  res.json({...settings,secret:"",hasSecret:Boolean(settings.secret),configured:Boolean(settings.url&&settings.secret)});
});
app.put("/settings/webhook",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=webhookSettingsInput.parse(req.body),current=await webhookSettings();
  const secret=input.secret||current.secret;
  if(input.enabled&&(!input.url||!secret))return res.status(400).json({error:"WEBHOOK_URL_AND_SECRET_REQUIRED"});
  const saved={...input,secret};
  await db.query(`INSERT INTO app_settings(key,encrypted_value,updated_by,updated_at) VALUES('outbound_webhook',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_by=excluded.updated_by,updated_at=now()`,[encryptSetting(saved),req.user.sub]);
  webhookSettingsCache=saved;
  await audit(req,"settings.webhook.update","app_setting","outbound_webhook",null,{enabled:saved.enabled,url:saved.url,events:saved.events});
  res.json({ok:true,configured:Boolean(saved.url&&saved.secret)});
});
app.post("/settings/webhook/test",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const settings=await webhookSettings();
  if(!settings.enabled||!settings.url||!settings.secret)return res.status(409).json({error:"WEBHOOK_NOT_CONFIGURED"});
  const payload={event:"connection.test",title:"QuestControl webhook test",occurredAt:new Date().toISOString(),data:{source:"QuestControl"}};
  const body=JSON.stringify(payload),signature=crypto.createHmac("sha256",settings.secret).update(body).digest("hex");
  try { const response=await fetch(settings.url,{method:"POST",headers:{"content-type":"application/json","user-agent":"QuestControl-Webhooks/1.0","x-questcontrol-event":"connection.test","x-questcontrol-signature":`sha256=${signature}`},body,signal:AbortSignal.timeout(12_000)}); if(!response.ok)return res.status(502).json({error:"WEBHOOK_UNAVAILABLE",status:response.status});res.json({ok:true,status:response.status}); }
  catch(error){res.status(502).json({error:"WEBHOOK_UNAVAILABLE"});}
});
app.get("/telegram/connection",auth,async(req,res)=>{
  const row=(await db.query("SELECT username,first_name,linked_at FROM telegram_connections WHERE user_id=$1",[req.user.sub])).rows[0];
  res.json({configured:Boolean(telegramBot?.enabled),botUsername:telegramBot?.username||env.TELEGRAM_BOT_USERNAME||"",connected:Boolean(row),connection:row||null});
});
app.post("/telegram/link-code",auth,async(req,res)=>{
  if(!telegramBot?.enabled || !(telegramBot.username||env.TELEGRAM_BOT_USERNAME)) return res.status(409).json({error:"TELEGRAM_NOT_CONFIGURED"});
  const code=crypto.randomBytes(32).toString("base64url");
  const codeHash=crypto.createHash("sha256").update(code).digest("hex");
  await db.query("DELETE FROM telegram_link_codes WHERE user_id=$1 OR expires_at<=now()",[req.user.sub]);
  await db.query("INSERT INTO telegram_link_codes(code_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[codeHash,req.user.sub]);
  const username=telegramBot.username||env.TELEGRAM_BOT_USERNAME;
  res.json({url:`https://t.me/${username}?start=${code}`,expiresAt:new Date(Date.now()+15*60_000).toISOString()});
});
app.delete("/telegram/connection",auth,async(req,res)=>{
  await db.query("DELETE FROM telegram_connections WHERE user_id=$1",[req.user.sub]);
  await audit(req,"telegram.connection.delete","telegram_connection",req.user.sub,null,{disconnected:true});
  res.status(204).end();
});

const bookingSourceInput=z.object({
  id:z.string().uuid().optional(),name:z.string().trim().min(1).max(100),enabled:z.boolean().default(true),locationExternalId:z.string().min(1).max(100),baseUrl:z.string().url().refine(value=>value.startsWith("https://")),
  bookingsPath:z.string().startsWith("/"),authType:z.enum(["NONE","BEARER","COOKIE","BASIC"]).default("NONE"),authName:z.string().max(100).default("Authorization"),secret:z.string().max(4000).optional(),username:z.string().max(300).optional(),
  dateParam:z.string().max(100).default("date"),fromParam:z.string().max(100).default("from"),toParam:z.string().max(100).default("to"),staticQuery:z.record(z.string(),z.string()).default({}),
  arrayPath:z.string().max(300).default("data"),mapping:z.object({id:z.string(),date:z.string(),startTime:z.string(),endTime:z.string(),customerName:z.string(),phone:z.string().default(""),email:z.string().default(""),productName:z.string(),players:z.string(),amount:z.string(),currency:z.string().default(""),status:z.string().default(""),paymentStatus:z.string().default("")}),
});
async function bookingSources(){const row=(await db.query("SELECT encrypted_value FROM app_settings WHERE key='booking_sources'")).rows[0];try{return decryptSetting(row?.encrypted_value)||[];}catch{return [];}}
async function saveBookingSources(sources,userId){await db.query(`INSERT INTO app_settings(key,encrypted_value,updated_by,updated_at) VALUES('booking_sources',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_by=excluded.updated_by,updated_at=now()`,[encryptSetting(sources),userId]);}
const publicBookingSource=source=>({...source,secret:"",username:source.username||"",hasSecret:Boolean(source.secret)});
const pathValue=(value,path)=>String(path||"").split(".").filter(Boolean).reduce((current,key)=>current==null?undefined:current[Array.isArray(current)&&/^\d+$/.test(key)?Number(key):key],value);
async function fetchBookingSource(source,query){
  const url=new URL(source.bookingsPath,source.baseUrl);for(const [key,value] of Object.entries(source.staticQuery||{}))url.searchParams.set(key,value);
  if(query.date&&source.dateParam)url.searchParams.set(source.dateParam,query.date);if(query.from&&source.fromParam)url.searchParams.set(source.fromParam,query.from);if(query.to&&source.toParam)url.searchParams.set(source.toParam,query.to);
  const headers={accept:"application/json"};if(source.authType==="BEARER"&&source.secret)headers[source.authName||"Authorization"]=`Bearer ${source.secret}`;if(source.authType==="COOKIE"&&source.secret)headers.cookie=`${source.authName||"token"}=${source.secret}`;if(source.authType==="BASIC")headers.authorization=`Basic ${Buffer.from(`${source.username||""}:${source.secret||""}`).toString("base64")}`;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});if(!response.ok){const error=new Error("BOOKING_SOURCE_FAILED");error.status=response.status;throw error;}
  const payload=await response.json(),rows=pathValue(payload,source.arrayPath);if(!Array.isArray(rows))throw new Error("BOOKING_SOURCE_ARRAY_NOT_FOUND");
  return rows.map(row=>Object.fromEntries(Object.entries(source.mapping).map(([field,path])=>[field,path?pathValue(row,path):null])));
}
app.get("/settings/booking-sources",auth,async(req,res)=>{if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});res.json((await bookingSources()).map(publicBookingSource));});
app.post("/settings/booking-sources",auth,async(req,res)=>{if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});const input=bookingSourceInput.parse(req.body),sources=await bookingSources();const source={...input,id:crypto.randomUUID()};sources.push(source);await saveBookingSources(sources,req.user.sub);res.status(201).json(publicBookingSource(source));});
app.put("/settings/booking-sources/:id",auth,async(req,res)=>{if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});const input=bookingSourceInput.parse({...req.body,id:req.params.id}),sources=await bookingSources(),index=sources.findIndex(item=>item.id===req.params.id);if(index<0)return res.status(404).json({error:"SOURCE_NOT_FOUND"});sources[index]={...input,secret:input.secret||sources[index].secret,username:input.username||sources[index].username};await saveBookingSources(sources,req.user.sub);res.json(publicBookingSource(sources[index]));});
app.delete("/settings/booking-sources/:id",auth,async(req,res)=>{if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});const sources=await bookingSources(),next=sources.filter(item=>item.id!==req.params.id);if(next.length===sources.length)return res.status(404).json({error:"SOURCE_NOT_FOUND"});await saveBookingSources(next,req.user.sub);res.status(204).end();});
app.post("/settings/booking-sources/:id/test",auth,async(req,res)=>{if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});const source=(await bookingSources()).find(item=>item.id===req.params.id);if(!source)return res.status(404).json({error:"SOURCE_NOT_FOUND"});try{const rows=await fetchBookingSource(source,{date:req.body?.date||new Date().toISOString().slice(0,10)});res.json({ok:true,count:rows.length,sample:rows.slice(0,3)});}catch(error){res.status(502).json({error:error.message,status:error.status});}});
app.get("/booking-sources",auth,permit("bookings:read"),async(req,res)=>{
  const sources=(await bookingSources()).filter(source=>source.enabled),visible=[];
  for(const source of sources){const location=(await db.query("SELECT id,name FROM locations WHERE external_id=$1",[source.locationExternalId])).rows[0];if(location&&await locationAllowed(req,location.id))visible.push({id:source.id,name:source.name,locationExternalId:source.locationExternalId,locationName:location.name});}
  res.json(visible);
});
app.get("/booking-sources/:id/bookings",auth,permit("bookings:read"),async(req,res)=>{
  const input=z.object({date:z.string().date().optional(),from:z.string().date().optional(),to:z.string().date().optional()}).refine(value=>value.date||(value.from&&value.to)).parse(req.query);
  const source=(await bookingSources()).find(item=>item.id===req.params.id&&item.enabled);if(!source)return res.status(404).json({error:"SOURCE_NOT_FOUND"});
  const location=(await db.query("SELECT id,name FROM locations WHERE external_id=$1",[source.locationExternalId])).rows[0];if(!location)return res.status(409).json({error:"SOURCE_LOCATION_NOT_FOUND"});if(!(await locationAllowed(req,location.id)))return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  try{const rows=await fetchBookingSource(source,input);res.json({data:rows.map(row=>({id:String(row.id||""),date:String(row.date||""),startsAt:String(row.startTime||"").slice(0,5),endsAt:String(row.endTime||"").slice(0,5),customerName:String(row.customerName||"Бронь"),customerPhone:row.phone?String(row.phone):null,customerEmail:row.email?String(row.email):null,productName:String(row.productName||"Бронь"),zoneName:location.name,players:Number(row.players)||0,amountCents:Math.round((Number(row.amount)||0)*100),currency:String(row.currency||"EUR"),status:String(row.status||"reserved"),statusDisplay:String(row.status||"Reserved"),paymentStatus:String(row.paymentStatus||"unknown"),paymentStatusDisplay:String(row.paymentStatus||"—"),checkedIn:0,checkInTotal:Number(row.players)||0,checkedInPlayers:[],checkInErrors:[],confirmed:false,sourceType:"GENERIC",sourceId:source.id,sourceName:source.name}))});}catch(error){res.status(502).json({error:error.message,status:error.status});}
});

app.post("/time-to-grow/sessions/record",auth,permit("sessions:create"),async(req,res)=>{
  const input=z.object({
    clubId:z.string().regex(/^[a-z0-9]{26}$/),date:z.string().date(),bookingId:z.string(),gameId:z.string().uuid(),
    startedAt:z.string().datetime({offset:true}),endedAt:z.string().datetime({offset:true}),playerCount:z.number().int().min(0).max(1000),
    deductions:z.array(z.object({itemId:z.string().uuid(),quantity:z.number().int().positive().max(1000)})).max(20)
  })
    .refine(value=>new Date(value.endedAt)>new Date(value.startedAt),{path:["endedAt"],message:"Invalid session time"})
    .refine(value=>new Date(value.endedAt)-new Date(value.startedAt)<=2*60*60_000,{path:["endedAt"],message:"Session recording interval cannot exceed 2 hours"})
    .parse(req.body);
  const location=(await db.query("SELECT id,name,timezone FROM locations WHERE external_id=$1",[input.clubId])).rows[0];
  if(!location) return res.status(404).json({error:"LOCATION_NOT_SYNCED"});
  if(!(await locationAllowed(req,location.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const externalBooking=(await fetchTimeToGrowBookings(input.clubId,input.date)).find(item=>item.id===input.bookingId);
  if(!externalBooking) return res.status(404).json({error:"EXTERNAL_BOOKING_NOT_FOUND"});
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const imported=await importTimeToGrowBooking(client,location,externalBooking,false);
    if(!(await client.query("SELECT 1 FROM games WHERE id=$1 AND room_id=$2 AND is_active=true",[input.gameId,imported.booking.room_id])).rowCount){await client.query("ROLLBACK");return res.status(400).json({error:"GAME_NOT_IN_ZONE"});}
    if((await client.query("SELECT 1 FROM sessions WHERE booking_id=$1",[imported.booking.id])).rowCount){await client.query("ROLLBACK");return res.status(409).json({error:"SESSION_ALREADY_RECORDED"});}
    const session=(await client.query(`INSERT INTO sessions(booking_id,room_id,game_id,status,started_at,ended_at,remaining_seconds,manual_player_count)
      VALUES($1,$2,$3,'FINISHED',$4,$5,0,$6) RETURNING *`,[imported.booking.id,imported.booking.room_id,input.gameId,input.startedAt,input.endedAt,input.playerCount])).rows[0];
    await client.query(`INSERT INTO session_participants(session_id,person_id,participant_role,category_at_play,age_band_at_play)
      SELECT $1,person_id,participant_role,category_at_booking,age_band_at_booking FROM booking_participants WHERE booking_id=$2 ON CONFLICT DO NOTHING`,[session.id,imported.booking.id]);
    for(const deduction of input.deductions){
      const item=(await client.query("SELECT * FROM inventory_items WHERE id=$1 AND location_id=$2 AND is_active=true FOR UPDATE",[deduction.itemId,location.id])).rows[0];
      if(!item||Number(item.quantity)<deduction.quantity){await client.query("ROLLBACK");return res.status(409).json({error:"INSUFFICIENT_STOCK",itemId:deduction.itemId});}
      const next=Number(item.quantity)-deduction.quantity;
      await client.query("UPDATE inventory_items SET quantity=$1,updated_by=$2,updated_at=now() WHERE id=$3",[next,req.user.sub,item.id]);
      await client.query("INSERT INTO inventory_movements(item_id,delta,quantity_after,reason,created_by) VALUES($1,$2,$3,$4,$5)",[item.id,-deduction.quantity,next,`Сессия ${session.id} · ${externalBooking.product.effective_name}`,req.user.sub]);
      await client.query("INSERT INTO session_inventory_deductions(session_id,item_id,quantity) VALUES($1,$2,$3)",[session.id,item.id,deduction.quantity]);
    }
    await client.query("COMMIT");
    await audit(req,"session.record","session",session.id,null,{...session,deductions:input.deductions});
    const [details,user]=await Promise.all([
      db.query("SELECT r.name room_name,g.name game_name FROM rooms r JOIN games g ON g.id=$2 WHERE r.id=$1",[imported.booking.room_id,input.gameId]),
      db.query("SELECT display_name FROM users WHERE id=$1",[req.user.sub]),
    ]);
    const durationMinutes=Math.round((new Date(input.endedAt)-new Date(input.startedAt))/60000);
    const bookingStartTime=String(externalBooking.start.time||"").slice(0,5);
    void sendTelegramImportantLog("sessionRecorded", "Сессия записана", [["Локация", location.name], ["Игра", externalBooking.product.effective_name], ["Время", bookingStartTime], ["Игроков", input.playerCount], ["Длительность", `${durationMinutes} мин.`]]);
    const pricing=timeToGrowBookingPricing(externalBooking);
    const sheetPayload={
      type:"session.recorded",sessionId:session.id,bookingId:input.bookingId,date:input.date,
      locationName:location.name,roomName:details.rows[0]?.room_name||"",game:details.rows[0]?.game_name||externalBooking.product.effective_name,
      startTime:bookingStartTime,durationMinutes,players:input.playerCount,total:pricing.total,onlineAmount:pricing.total,price:pricing.pricePerPerson,
      discountAmount:pricing.discountAmount,discountReason:pricing.discountReason,promoCode:pricing.promoCode,
      paymentStatus:externalBooking.order.payment_status||"",
      phone:externalBooking.owner?.phone||"",administrator:user.rows[0]?.display_name||"",comments:`QuestControl · ${input.bookingId}`,
    };
    await db.query("UPDATE sessions SET sheet_sync_status='PENDING',sheet_sync_payload=$2 WHERE id=$1",[session.id,JSON.stringify({clubId:input.clubId,payload:sheetPayload})]);
    let sheetSync={configured:false,status:"FAILED"};
    try{
      sheetSync=await syncStoredSessionToGoogleSheets(session.id);
    }catch(error){console.error("Google Sheets session sync failed",session.id,error);sheetSync={configured:true,ok:false,status:"FAILED",error:error.code||String(error.message||error),details:String(error.message||error)};}
    if(sheetSync.configured&&!sheetSync.ok)return res.status(502).json({
      ...session,sheetSync,error:sheetSync.error==="GOOGLE_SHEETS_IDENTIFIER_MISSING"?sheetSync.error:"GOOGLE_SHEETS_SYNC_FAILED",
      message:sheetSync.error==="GOOGLE_SHEETS_IDENTIFIER_MISSING"
        ?"Сессия сохранена, но Google Sheets не подтвердила QC_ID. Повторите синхронизацию в разделе «Сессии»."
        :"Сессия сохранена, но Google Sheets не приняла запись. Повторите синхронизацию в разделе «Сессии».",
      details:sheetSync.details||""
    });
    res.status(201).json({...session,sheetSync});
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
});

app.post("/sessions/:id/booking-record/rollback",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const client=await db.connect();let stored=null;
  try{
    await client.query("BEGIN");
    const session=(await client.query(`SELECT s.*,r.location_id FROM sessions s JOIN rooms r ON r.id=s.room_id WHERE s.id=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!session)return res.status(404).json({error:"SESSION_NOT_FOUND"});
    if(!session.booking_id)return res.status(409).json({error:"BOOKING_SESSION_REQUIRED"});
    if(!(await locationAllowed(req,session.location_id))){await client.query("ROLLBACK");return res.status(403).json({error:"LOCATION_FORBIDDEN"});}
    stored=session.sheet_sync_payload;
    let sheetRollback={skipped:true};
    // Roll back Sheets before removing the local session. The previous flow
    // discarded a Sheets failure after deleting the only retryable record.
    if(stored?.clubId&&stored?.payload){
      try{
        sheetRollback=await sendSessionToGoogleSheets(stored.clubId,{...stored.payload,type:"session.rolled_back",sessionId:session.id,bookingId:stored.payload.bookingId||session.booking_id});
        if(sheetRollback.removed===false||sheetRollback.deleted===false||sheetRollback.found===false)throw Object.assign(new Error("GOOGLE_SHEETS_ROW_NOT_FOUND"),{code:"GOOGLE_SHEETS_ROW_NOT_FOUND"});
      }catch(error){
        await client.query("ROLLBACK");
        console.error("Google Sheets rollback failed",session.id,error);
        return res.status(502).json({error:error.code||"GOOGLE_SHEETS_ROLLBACK_FAILED"});
      }
    }
    const deductions=(await client.query(`SELECT d.item_id,d.quantity AS deduction_quantity,i.name FROM session_inventory_deductions d JOIN inventory_items i ON i.id=d.item_id WHERE d.session_id=$1 FOR UPDATE`,[session.id])).rows;
    for(const deduction of deductions){
      const item=(await client.query("SELECT quantity FROM inventory_items WHERE id=$1 FOR UPDATE",[deduction.item_id])).rows[0];
      const restored=Number(item.quantity)+Number(deduction.deduction_quantity);
      await client.query("UPDATE inventory_items SET quantity=$1,updated_by=$2,updated_at=now() WHERE id=$3",[restored,req.user.sub,deduction.item_id]);
      await client.query("INSERT INTO inventory_movements(item_id,delta,quantity_after,reason,created_by) VALUES($1,$2,$3,$4,$5)",[deduction.item_id,deduction.deduction_quantity,restored,`Откат записи сессии ${session.id}`,req.user.sub]);
    }
    await client.query("DELETE FROM sessions WHERE id=$1",[session.id]);
    await client.query("COMMIT");
    await audit(req,"session.booking_record.rollback","session",req.params.id,session,{restoredMagnets:deductions.length,sheetRollback});
    void sendTelegramImportantLog("sessionCancelled", "Запись сессии отменена", [["Сессия", session.id], ["Возвращено позиций", deductions.length]]);
    res.json({ok:true,restoredMagnets:deductions.length,sheetRollback});
  }catch(error){try{await client.query("ROLLBACK");}catch(_){}throw error;}finally{client.release();}
});

app.post("/sessions/:id/google-sheets/retry",auth,async(req,res)=>{
  if(!isOwner(req))return res.status(403).json({error:"OWNER_REQUIRED"});
  const session=(await db.query(`SELECT s.id,r.location_id FROM sessions s JOIN rooms r ON r.id=s.room_id WHERE s.id=$1`,[req.params.id])).rows[0];
  if(!session)return res.status(404).json({error:"SESSION_NOT_FOUND"});
  if(!(await locationAllowed(req,session.location_id)))return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  try{const result=await syncStoredSessionToGoogleSheets(session.id);await audit(req,"session.google_sheets.retry","session",session.id,null,result);res.json(result);}
  catch(error){console.error("Google Sheets retry failed",session.id,error);res.status(error.code==="SHEET_SYNC_DATA_MISSING"?409:502).json({error:error.code||"GOOGLE_SHEETS_SYNC_FAILED"});}
});

app.patch("/sessions/:id", auth, permit("sessions:manage"), async (req, res) => {
  const before = (await db.query("SELECT * FROM sessions WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error:"SESSION_NOT_FOUND" });
  const sessionRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[before.room_id])).rows[0];
  if (!sessionRoom || !(await locationAllowed(req,sessionRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const actionInput=z.object({action:z.enum(["PAUSE","RESUME","FINISH"])}).safeParse(req.body);
  let rows;
  let auditAction;
  if (actionInput.success) {
    const action=actionInput.data.action;
    const status=action==="PAUSE"?"PAUSED":action==="RESUME"?"RUNNING":"FINISHED";
    rows=(await db.query(
      "UPDATE sessions SET status=$1,ended_at=CASE WHEN $1='FINISHED' THEN now() ELSE ended_at END WHERE id=$2 RETURNING *",
      [status,req.params.id]
    )).rows;
    auditAction=`session.${action.toLowerCase()}`;
  } else {
    if (!["OWNER","ADMIN","OPERATOR"].includes(req.user?.role)) return res.status(403).json({error:"SESSION_EDIT_FORBIDDEN"});
    const edit=z.object({
      startedAt:z.string().datetime({offset:true}).optional(),
      endedAt:z.string().datetime({offset:true}).nullable().optional(),
      roomId:z.string().uuid().optional(),
      gameId:z.string().uuid().nullable().optional(),
      status:z.enum(["RUNNING","PAUSED","FINISHED","CANCELLED"]).optional(),
    }).refine(value=>Object.keys(value).length>0).parse(req.body);
    if (edit.startedAt && edit.endedAt && new Date(edit.endedAt)<new Date(edit.startedAt)) {
      return res.status(400).json({error:"INVALID_SESSION_TIME"});
    }
    if (edit.roomId) {
      const targetRoom=(await db.query("SELECT location_id FROM rooms WHERE id=$1",[edit.roomId])).rows[0];
      if (!targetRoom) return res.status(404).json({error:"ROOM_NOT_FOUND"});
      if (!(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
    }
    const resultingRoomId=edit.roomId||before.room_id;
    if (edit.gameId && !(await db.query("SELECT 1 FROM games WHERE id=$1 AND room_id=$2 AND is_active=true",[edit.gameId,resultingRoomId])).rowCount) {
      return res.status(400).json({error:"GAME_NOT_IN_ZONE"});
    }
    rows=(await db.query(`
      UPDATE sessions SET
        started_at=COALESCE($1,started_at),
        ended_at=CASE WHEN $2::boolean THEN $3::timestamptz ELSE ended_at END,
        room_id=COALESCE($4,room_id),
        status=COALESCE($5,status),
        game_id=CASE WHEN $6::boolean THEN $7::uuid ELSE game_id END
      WHERE id=$8 RETURNING *
    `,[edit.startedAt||null,Object.hasOwn(edit,"endedAt"),edit.endedAt||null,edit.roomId||null,edit.status||null,
      Object.hasOwn(edit,"gameId"),edit.gameId||null,req.params.id])).rows;
    auditAction="session.edit";
  }
  await audit(req,auditAction,"session",req.params.id,before,rows[0]);
  if(rows[0].status==="FINISHED"&&before.status!=="FINISHED") void sendTelegramImportantLog("sessionFinished", "Сессия завершена", [["Сессия", rows[0].id]]);
  if(rows[0].status==="CANCELLED"&&before.status!=="CANCELLED") void sendTelegramImportantLog("sessionCancelled", "Сессия отменена", [["Сессия", rows[0].id]]);
  res.json(rows[0]);
});

app.delete("/sessions/:id", auth, permit("sessions:manage"), async (req,res) => {
  if (!isOwner(req)) return res.status(403).json({ error:"OWNER_REQUIRED" });
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const before=(await client.query("SELECT * FROM sessions WHERE id=$1 FOR UPDATE",[req.params.id])).rows[0];
    if (!before) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error:"SESSION_NOT_FOUND" });
    }
    await client.query("DELETE FROM sessions WHERE id=$1",[req.params.id]);
    await client.query("COMMIT");
    await audit(req,"session.delete","session",req.params.id,before,null);
    void sendTelegramImportantLog("sessionCancelled", "Сессия удалена", [["Сессия", before.id]]);
    res.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/statistics/players", auth, permit("sessions:read"), async (req, res) => {
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setUTCDate(monthAgo.getUTCDate() - 30);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const input = z.object({
    from: date.default(monthAgo.toISOString().slice(0,10)),
    to: date.default(today.toISOString().slice(0,10)),
    locationId: z.string().uuid().optional(),
  }).parse(req.query);
  if (input.from > input.to) return res.status(400).json({ error:"INVALID_DATE_RANGE" });
  if (input.locationId && !(await locationAllowed(req,input.locationId))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const values = isOwner(req) ? [input.from,input.to] : [input.from,input.to,req.user.sub];
  const scopeClause = isOwner(req)
    ? "TRUE"
    : "r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$3)";
  let locationClause = "TRUE";
  if (input.locationId) {
    values.push(input.locationId);
    locationClause = `r.location_id=$${values.length}`;
  }
  const scoped = { clause:`${scopeClause} AND ${locationClause}`, values };
  const base = `
    FROM session_participants sp
    JOIN people p ON p.id=sp.person_id
    JOIN sessions s ON s.id=sp.session_id
    JOIN rooms r ON r.id=s.room_id
    JOIN locations l ON l.id=r.location_id
    LEFT JOIN games g ON g.id=s.game_id
    LEFT JOIN bookings b ON b.id=s.booking_id
    WHERE s.started_at >= $1::date
      AND s.started_at < ($2::date + interval '1 day')
      AND ${scoped.clause}
  `;
  const [summary,crossLocation,categories,ageBands,zones,games,products,locations] = await Promise.all([
    db.query(`SELECT count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(*) FILTER (WHERE p.identity_type='BOOKING_RANDOM')::int anonymous_player_plays,count(DISTINCT s.id)::int sessions ${base}`,scoped.values),
    db.query(`SELECT count(*)::int cross_location_players FROM (SELECT sp.person_id ${base} AND p.identity_type='EMAIL_HMAC' GROUP BY sp.person_id HAVING count(DISTINCT r.location_id)>1) visitors`,scoped.values),
    db.query(`SELECT COALESCE(sp.category_at_play,'UNKNOWN') category,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players ${base} GROUP BY 1 ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT COALESCE(sp.age_band_at_play,'UNKNOWN') age_band,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players ${base} GROUP BY 1 ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT r.id room_id,r.name zone,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(DISTINCT s.id)::int sessions ${base} GROUP BY r.id,r.name ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT g.id game_id,COALESCE(g.name,'Не выбрана') game,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(DISTINCT s.id)::int sessions ${base} GROUP BY g.id,g.name ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT COALESCE(b.product_name,'Без продукта') product,count(*)::int player_plays,count(DISTINCT s.id)::int sessions ${base} GROUP BY b.product_name ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT l.id location_id,l.name location,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(DISTINCT s.id)::int sessions ${base} GROUP BY l.id,l.name ORDER BY player_plays DESC`,scoped.values),
  ]);
  res.json({
    period: input,
    summary: { ...summary.rows[0], ...crossLocation.rows[0] },
    byCategory: categories.rows,
    byAgeBand: ageBands.rows,
    byZone: zones.rows,
    byGame: games.rows,
    byProduct: products.rows,
    byLocation: locations.rows,
  });
});

app.post("/rooms", auth, permit("rooms:manage"), async (req, res) => {
  const input = z.object({ locationId:z.string().uuid(),name:z.string().trim().min(2).max(120),kind:z.enum(["REAL","VR"]),capacity:z.number().int().min(1).max(100) }).parse(req.body);
  if (!(await locationAllowed(req,input.locationId))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const { rows } = await db.query(
    "INSERT INTO rooms(location_id,name,kind,capacity,status) VALUES($1,$2,$3,$4,'OFFLINE') RETURNING *",
    [input.locationId,input.name,input.kind,input.capacity]
  );
  await audit(req,"room.create","room",rows[0].id,null,rows[0]);
  res.status(201).json(rows[0]);
});

app.patch("/rooms/:id", auth, permit("rooms:manage"), async (req,res) => {
  const input = z.object({
    locationId:z.string().uuid(),
    name:z.string().trim().min(2).max(120),
    kind:z.enum(["REAL","VR"]),
    capacity:z.number().int().min(1).max(100),
  }).parse(req.body);
  const before = (await db.query("SELECT * FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error:"ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req,before.location_id)) || !(await locationAllowed(req,input.locationId))) {
    return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  }
  const { rows } = await db.query(
    `UPDATE rooms SET location_id=$1,name=$2,kind=$3,capacity=$4
     WHERE id=$5 RETURNING *`,
    [input.locationId,input.name,input.kind,input.capacity,req.params.id]
  );
  await audit(req,"room.update","room",req.params.id,before,rows[0]);
  res.json(rows[0]);
});

app.delete("/rooms/:id", auth, permit("rooms:manage"), async (req,res) => {
  if (!isOwner(req)) return res.status(403).json({ error:"OWNER_REQUIRED" });
  const before=(await db.query("SELECT * FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error:"ROOM_NOT_FOUND" });
  const usage=(await db.query(`
    SELECT
      (SELECT count(*)::int FROM bookings WHERE room_id=$1) bookings,
      (SELECT count(*)::int FROM sessions WHERE room_id=$1) sessions,
      (SELECT count(*)::int FROM devices WHERE room_id=$1) devices,
      (SELECT count(*)::int FROM cameras WHERE room_id=$1) cameras,
      (SELECT count(*)::int FROM local_sites WHERE room_id=$1) local_sites
  `,[req.params.id])).rows[0];
  if (Object.values(usage).some(count=>count>0)) {
    return res.status(409).json({ error:"ROOM_IN_USE",usage });
  }
  await db.query("DELETE FROM rooms WHERE id=$1",[req.params.id]);
  await audit(req,"room.delete","room",req.params.id,before,null);
  res.status(204).end();
});

app.get("/cameras", auth, permit("cameras:read"), async (req, res) => {
  const scoped = isOwner(req) ? { clause:"TRUE", values:[] } : req.user.role==="CAMERA_VIEWER"
    ? {clause:"c.id IN (SELECT camera_id FROM user_cameras WHERE user_id=$1)",values:[req.user.sub]}
    : req.user.role==="CAMERA_GUEST" ? {clause:"c.id=ANY($1::uuid[]) AND EXISTS(SELECT 1 FROM camera_shares s WHERE s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now())",values:[req.user.cameraIds||[],req.user.shareId]}
    : { clause:"COALESCE(c.location_id,r.location_id) IN (SELECT location_id FROM user_locations WHERE user_id=$1)", values:[req.user.sub] };
  const { rows } = await db.query(`
    SELECT c.id,c.room_id,c.integration_id,c.name,c.provider,c.external_id,c.stream_key,c.status,
           c.config,c.plan_x,c.plan_y,COALESCE(c.location_id,r.location_id) AS location_id,r.name AS room_name
    FROM cameras c
    LEFT JOIN rooms r ON r.id=c.room_id
    WHERE (${scoped.clause}) AND c.archived_at IS NULL
    ORDER BY c.name
  `,scoped.values);
  res.json(rows);
});

const tuyaCameraCategories = new Set(["sp", "ipc", "camera", "wf_camera", "dghsxj"]);
const isTuyaCamera = (device) => {
  const category = String(device.category || device.categoryCode || "").toLowerCase();
  const description = `${device.name || ""} ${device.customName || ""} ${device.productName || ""}`.toLowerCase();
  return tuyaCameraCategories.has(category) || /(camera|камера|ipc|ptz|doorbell|door bell|video bell|дверн\w* звон)/i.test(description);
};

let tuyaCameraInventoryInFlight = null;

async function syncTuyaCameraInventory() {
  if (!tuya.configured) throw Object.assign(new Error("Tuya is not configured"), { code: "TUYA_NOT_CONFIGURED" });
  if (tuyaCameraInventoryInFlight) return tuyaCameraInventoryInFlight;

  tuyaCameraInventoryInFlight = (async () => {
    const devices = await tuya.listProjectDevices();
    const cameras = devices.filter(isTuyaCamera);
    const krampusRoomId = (await db.query(
      "SELECT id FROM rooms WHERE lower(replace(name,' ','_')) LIKE '%krampus%' ORDER BY id LIMIT 1"
    )).rows[0]?.id || null;
    let created = 0;
    let updated = 0;
    for (const device of cameras) {
      const externalId = String(device.id || device.deviceId || "");
      if (!externalId) continue;
      const name = String(device.customName || device.name || device.productName || `Tuya ${externalId.slice(-6)}`).slice(0, 120);
      const status = (device.isOnline ?? device.online) ? "ONLINE" : "OFFLINE";
      const autoRoomId = /(lsc|ptz)/i.test(name) ? krampusRoomId : null;
      const existing = await db.query(
        "SELECT id,name,status,room_id,config FROM cameras WHERE provider='TUYA' AND external_id=$1 LIMIT 1",
        [externalId]
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        const nextName = row.config?.customName ? row.name : name;
        const nextRoomId = row.room_id || autoRoomId;
        if (row.name !== nextName || row.status !== status || row.room_id !== nextRoomId) {
          await db.query("UPDATE cameras SET name=$1,status=$2,room_id=$3 WHERE id=$4", [nextName, status, nextRoomId, row.id]);
          updated += 1;
        }
      } else {
        // ai_enabled has a database default, but setting it explicitly makes
        // auto-discovered cameras immediately visible to the worker manager.
        await db.query(
          "INSERT INTO cameras(room_id,name,provider,external_id,status,config,ai_enabled) VALUES($1,$2,'TUYA',$3,$4,$5,true)",
          [autoRoomId, name, externalId, status, { category: device.category || null, productId: device.productId || null }]
        );
        created += 1;
      }
    }
    const result = { discovered: devices.length, cameras: cameras.length, created, updated };
    if (created > 0 || updated > 0) void syncAiWorkersSafe();
    return result;
  })();

  try {
    return await tuyaCameraInventoryInFlight;
  } finally {
    tuyaCameraInventoryInFlight = null;
  }
}

const tuyaBridgeAccounts = [
  { id:"account-1", enabled:true, apiUrl:env.TUYA_BRIDGE_ACCOUNT_1_API_URL, rtspUrl:env.TUYA_BRIDGE_ACCOUNT_1_RTSP_URL },
  { id:"account-2", enabled:env.TUYA_BRIDGE_ACCOUNT_2_ENABLED, apiUrl:env.TUYA_BRIDGE_ACCOUNT_2_API_URL, rtspUrl:env.TUYA_BRIDGE_ACCOUNT_2_RTSP_URL },
].filter(account => account.enabled && account.apiUrl && account.rtspUrl);

const bridgeStreamKey = (accountId, camera) => {
  const identity=camera.deviceId ? `${camera.frigateId || camera.deviceName || "camera"}_${camera.deviceId}`
    : camera.frigateId || camera.deviceName || "camera";
  const raw = `${accountId}_${identity}`
    .normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g,"_").replace(/^_+|_+$/g,"");
  return `tuya_bridge_${raw}`.slice(0,80);
};

async function bridgeJson(url, timeoutMs=8_000) {
  const response = await fetch(url, { signal:AbortSignal.timeout(timeoutMs), headers:{ accept:"application/json" } });
  if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
  return response.json();
}

async function registerGo2RtcStream(name, source) {
  const endpoint = new URL("/api/streams", env.GO2RTC_BASE_URL);
  endpoint.searchParams.set("name", name);
  endpoint.searchParams.set("src", source);
  const response = await fetch(endpoint, { method:"PATCH", signal:AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`go2rtc rejected ${name}: HTTP ${response.status}`);
}

async function syncTuyaBridgeInventory() {
  if (!tuyaBridgeAccounts.length) {
    throw Object.assign(new Error("Tuya LAN Bridge is not configured"), { code:"TUYA_BRIDGE_NOT_CONFIGURED" });
  }
  let discovered=0, created=0, updated=0;
  const accounts=[];
  for (const account of tuyaBridgeAccounts) {
    try {
      const state = await bridgeJson(new URL("/api/state", account.apiUrl));
      const cameras = Array.isArray(state.cameras) ? state.cameras : [];
      for (const camera of cameras) {
        const deviceId = String(camera.deviceId || camera.id || camera.frigateId || "");
        if (!deviceId) continue;
        const hdPath = camera.rtspHd ? new URL(camera.rtspHd).pathname
          : `${camera.rtspPath || `/${deviceId}`}/hd`.replace(/\/+/g,"/");
        const source = new URL(hdPath, account.rtspUrl).toString();
        const streamKey = bridgeStreamKey(account.id,camera);
        await registerGo2RtcStream(streamKey,source);
        const externalId = `bridge:${account.id}:${deviceId}`.slice(0,160);
        const name = String(camera.deviceName || camera.name || `Tuya Bridge ${deviceId.slice(-6)}`).slice(0,120);
        const status = state.loggedIn && (camera.online ?? camera.isOnline ?? true) ? "ONLINE" : "OFFLINE";
        const config = {
          source:"TUYA_LAN_BRIDGE", bridgeAccount:account.id, bridgeDeviceId:deviceId,
          bridgeApiUrl:account.apiUrl, rtspSource:source,
        };
        const existing = (await db.query(
          "SELECT id,name,status,stream_key,config FROM cameras WHERE provider='RTSP' AND external_id=$1 LIMIT 1",
          [externalId]
        )).rows[0];
        if (existing) {
          const nextName=existing.config?.customName ? existing.name : name;
          if (existing.name!==nextName || existing.status!==status || existing.stream_key!==streamKey) updated += 1;
          await db.query(
            "UPDATE cameras SET name=$1,status=$2,stream_key=$3,config=COALESCE(config,'{}'::jsonb)||$4::jsonb WHERE id=$5",
            [nextName,status,streamKey,JSON.stringify(config),existing.id]
          );
        } else {
          await db.query(
            `INSERT INTO cameras(name,provider,external_id,stream_key,status,config,ai_enabled)
             VALUES($1,'RTSP',$2,$3,$4,$5,true)`,
            [name,externalId,streamKey,status,JSON.stringify(config)]
          );
          created += 1;
        }
        discovered += 1;
      }
      accounts.push({ id:account.id, online:true, loggedIn:Boolean(state.loggedIn), cameras:cameras.length });
    } catch(error) {
      accounts.push({ id:account.id, online:false, error:error.message, cameras:0 });
    }
  }
  if (created || updated) void syncAiWorkersSafe();
  return { discovered,created,updated,accounts };
}

app.post("/cameras/sync/tuya", auth, permit("cameras:manage"), async (req, res) => {
  try {
    const result = await syncTuyaCameraInventory();
    await audit(req, "camera.sync", "integration", "tuya", null, result);
    res.json(result);
  } catch (error) {
    res.status(error.code === "TUYA_NOT_CONFIGURED" ? 503 : 502).json({ error: error.code || "TUYA_SYNC_FAILED", message: error.message });
  }
});

app.post("/cameras/sync/bridge", auth, permit("cameras:manage"), async (req,res) => {
  try {
    const result=await syncTuyaBridgeInventory();
    await audit(req,"camera.sync","integration","tuya-lan-bridge",null,result);
    res.json(result);
  } catch(error) {
    res.status(error.code==="TUYA_BRIDGE_NOT_CONFIGURED"?503:502).json({error:error.code||"TUYA_BRIDGE_SYNC_FAILED",message:error.message});
  }
});

const cameraInput = z.object({
  name: z.string().trim().min(2).max(120),
  roomId: z.string().uuid(),
  provider: z.enum(["RTSP", "ONVIF", "TUYA"]),
  streamKey: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/).nullable().optional(),
  externalId: z.string().trim().max(160).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.provider === "TUYA" && !value.externalId) {
    ctx.addIssue({ code: "custom", path: ["externalId"], message: "Tuya device ID is required" });
  }
  if (value.provider !== "TUYA" && !value.streamKey) {
    ctx.addIssue({ code: "custom", path: ["streamKey"], message: "go2rtc stream key is required" });
  }
});

app.post("/cameras", auth, permit("cameras:manage"), async (req, res) => {
  const input = cameraInput.parse(req.body);
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[input.roomId])).rows[0];
  if (!room || !(await locationAllowed(req,room.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const { rows } = await db.query(
    `INSERT INTO cameras(room_id,location_id,name,provider,external_id,stream_key,status)
     VALUES($1,$2,$3,$4,$5,$6,'OFFLINE') RETURNING *`,
    [input.roomId, room.location_id, input.name, input.provider, input.externalId || null, input.streamKey || null]
  );
  await audit(req, "camera.create", "camera", rows[0].id, null, rows[0]);
  void syncAiWorkersSafe();
  res.status(201).json(rows[0]);
});

app.patch("/cameras/:id", auth, permit("cameras:manage"), async (req, res) => {
  const input = cameraInput.parse(req.body);
  const before = (await db.query("SELECT * FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[input.roomId])).rows[0];
  if (!room || !(await locationAllowed(req,room.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const { rows } = await db.query(
    `UPDATE cameras SET room_id=$1,location_id=$2,name=$3,provider=$4,external_id=$5,stream_key=$6
     WHERE id=$7 RETURNING *`,
    [input.roomId, room.location_id, input.name, input.provider, input.externalId || null, input.streamKey || null, req.params.id]
  );
  await audit(req, "camera.update", "camera", rows[0].id, before, rows[0]);
  if (headsetTrackingEngine?.setCameraRoom) {
    headsetTrackingEngine.setCameraRoom(rows[0].id, rows[0].room_id);
  }
  void syncAiWorkersSafe();
  res.json(rows[0]);
});

app.patch("/cameras/:id/room", auth, permit("cameras:manage"), async (req,res) => {
  const { roomId } = z.object({ roomId:z.string().uuid() }).parse(req.body);
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[roomId])).rows[0];
  if (!room || !(await locationAllowed(req,room.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const { rows } = await db.query("UPDATE cameras SET room_id=$1,location_id=$2 WHERE id=$3 RETURNING *",[roomId,room.location_id,req.params.id]);
  if (!rows[0]) return res.status(404).json({ error:"CAMERA_NOT_FOUND" });
  await audit(req,"camera.room.assign","camera",req.params.id,null,{roomId});
  if (headsetTrackingEngine?.setCameraRoom) {
    headsetTrackingEngine.setCameraRoom(rows[0].id, rows[0].room_id);
  }
  res.json(rows[0]);
});

app.patch("/cameras/:id/name", auth, permit("cameras:manage"), async (req,res) => {
  const { name }=z.object({name:z.string().trim().min(2).max(120)}).parse(req.body);
  const before=(await db.query(
    `SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id
     FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1`,
    [req.params.id]
  )).rows[0];
  if(!before) return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if(!isOwner(req) && (!before.effective_location_id || !(await locationAllowed(req,before.effective_location_id)))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const { rows }=await db.query(
    `UPDATE cameras SET name=$1,config=COALESCE(config,'{}'::jsonb)||'{"customName":true}'::jsonb
     WHERE id=$2 RETURNING *`,
    [name,req.params.id]
  );
  await audit(req,"camera.name.update","camera",req.params.id,{name:before.name},{name});
  res.json(rows[0]);
});

app.get("/camera-settings", auth, async (req,res) => {
  if(!canConfigureCameras(req)) return res.status(403).json({error:"CAMERA_SETTINGS_FORBIDDEN"});
  const scoped=isOwner(req)
    ? {clause:"TRUE",values:[]}
    : {clause:"COALESCE(c.location_id,r.location_id) IS NULL OR COALESCE(c.location_id,r.location_id) IN (SELECT location_id FROM user_locations WHERE user_id=$1)",values:[req.user.sub]};
  const { rows }=await db.query(`
    SELECT c.id,c.name,c.provider,c.external_id,c.stream_key,c.status,c.config,c.ai_enabled,c.tracking_enabled,
           c.analysis_enabled,c.headset_tracking_enabled,c.location_id,c.room_id,c.plan_zone_id,
           l.name AS location_name,r.name AS room_name,z.name AS zone_name
    FROM cameras c
    LEFT JOIN locations l ON l.id=c.location_id
    LEFT JOIN rooms r ON r.id=c.room_id
    LEFT JOIN plan_zones z ON z.id=c.plan_zone_id
    WHERE (${scoped.clause}) AND c.archived_at IS NULL
    ORDER BY c.name
  `,scoped.values);
  res.json(rows);
});

app.patch("/cameras/:id/assignment", auth, async (req,res) => {
  if(!canConfigureCameras(req)) return res.status(403).json({error:"CAMERA_SETTINGS_FORBIDDEN"});
  const input=z.object({
    locationId:z.string().uuid().nullable(),
    zoneId:z.string().uuid().nullable(),
  }).parse(req.body);
  const before=(await db.query(
    "SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1",
    [req.params.id]
  )).rows[0];
  if(!before) return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if(!isOwner(req) && before.effective_location_id && !(await locationAllowed(req,before.effective_location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!isOwner(req) && !input.locationId) return res.status(403).json({error:"ADMIN_LOCATION_REQUIRED"});
  if(input.locationId && !(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  let roomId=null;
  if(input.zoneId){
    if(!input.locationId) return res.status(400).json({error:"ZONE_REQUIRES_LOCATION"});
    const zone=(await db.query("SELECT room_id FROM plan_zones WHERE id=$1 AND location_id=$2",[input.zoneId,input.locationId])).rows[0];
    if(!zone) return res.status(400).json({error:"ZONE_LOCATION_MISMATCH"});
    roomId=zone.room_id||null;
  }
  if(input.locationId && !(await db.query("SELECT 1 FROM locations WHERE id=$1",[input.locationId])).rowCount) return res.status(404).json({error:"LOCATION_NOT_FOUND"});
  const locationChanged=before.location_id!==input.locationId;
  const { rows }=await db.query(
    `UPDATE cameras SET location_id=$1,plan_zone_id=$2,room_id=$3,
     plan_x=CASE WHEN $4 THEN NULL ELSE plan_x END,plan_y=CASE WHEN $4 THEN NULL ELSE plan_y END
     WHERE id=$5 RETURNING *`,
    [input.locationId,input.zoneId,roomId,locationChanged,req.params.id]
  );
  await audit(req,"camera.assignment.update","camera",req.params.id,before,rows[0]);
  if (headsetTrackingEngine?.setCameraRoom) {
    headsetTrackingEngine.setCameraRoom(rows[0].id, rows[0].room_id);
  }
  res.json(rows[0]);
});

const planZoneInput = z.object({
  id:z.string().uuid().optional(),
  name:z.string().trim().min(1).max(120),
  type:z.enum(["GAME","VR","CORRIDOR","RECEPTION","LOCKERS","TECHNICAL","STORAGE","RESTROOM","OTHER"]),
  color:z.string().regex(/^#[0-9a-fA-F]{6}$/),
  x:z.number().min(0).max(100),y:z.number().min(0).max(100),
  width:z.number().min(2).max(100),height:z.number().min(2).max(100),
  roomId:z.string().uuid().nullable().optional(),
});
const locationPlanInput = z.object({
  backgroundImage:z.string().max(7_000_000).nullable().optional(),
  backgroundMode:z.enum(["CONTAIN","COVER","CUSTOM"]).default("CONTAIN"),
  backgroundScale:z.number().min(10).max(400).default(100),
  backgroundX:z.number().min(0).max(100).default(50),
  backgroundY:z.number().min(0).max(100).default(50),
  zones:z.array(planZoneInput).max(150),
  cameras:z.array(z.object({
    id:z.string().uuid(),x:z.number().min(0).max(100),y:z.number().min(0).max(100),
  })).max(250),
});

app.get("/locations/:id/plan", auth, permit("cameras:read"), async (req,res) => {
  if (!(await locationAllowed(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const plan=(await db.query("SELECT background_image,background_mode,background_scale,background_x,background_y FROM location_plans WHERE location_id=$1",[req.params.id])).rows[0];
  const zones=(await db.query("SELECT id,name,type,color,x,y,width,height,room_id FROM plan_zones WHERE location_id=$1 ORDER BY created_at,id",[req.params.id])).rows;
  res.json({
    backgroundImage:plan?.background_image||null,
    backgroundMode:plan?.background_mode||"CONTAIN",
    backgroundScale:Number(plan?.background_scale||100),
    backgroundX:Number(plan?.background_x||50),
    backgroundY:Number(plan?.background_y||50),
    zones
  });
});

app.put("/locations/:id/plan", auth, async (req,res) => {
  if (!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  if (!(await db.query("SELECT 1 FROM locations WHERE id=$1",[req.params.id])).rowCount) return res.status(404).json({error:"LOCATION_NOT_FOUND"});
  const input=locationPlanInput.parse(req.body);
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO location_plans(location_id,background_image,background_mode,background_scale,background_x,background_y,updated_by,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT(location_id) DO UPDATE SET background_image=excluded.background_image,background_mode=excluded.background_mode,
       background_scale=excluded.background_scale,background_x=excluded.background_x,background_y=excluded.background_y,
       updated_by=excluded.updated_by,updated_at=now()`,
      [req.params.id,input.backgroundImage||null,input.backgroundMode,input.backgroundScale,input.backgroundX,input.backgroundY,req.user.sub]
    );
    const keptZoneIds=[];
    for(const zone of input.zones){
      if(zone.roomId){
        const room=(await client.query("SELECT 1 FROM rooms WHERE id=$1 AND location_id=$2",[zone.roomId,req.params.id])).rows[0];
        if(!room) throw new Error("ZONE_ROOM_LOCATION_MISMATCH");
      }
      const savedZone=await client.query(
        `INSERT INTO plan_zones(id,location_id,room_id,name,type,color,x,y,width,height)
         VALUES(COALESCE($1,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id,name=excluded.name,type=excluded.type,color=excluded.color,
         x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height
         WHERE plan_zones.location_id=excluded.location_id RETURNING id`,
        [zone.id||null,req.params.id,zone.roomId||null,zone.name,zone.type,zone.color,zone.x,zone.y,Math.min(zone.width,100-zone.x),Math.min(zone.height,100-zone.y)]
      );
      if(!savedZone.rows[0]) throw new Error("ZONE_LOCATION_MISMATCH");
      keptZoneIds.push(savedZone.rows[0].id);
    }
    await client.query("DELETE FROM plan_zones WHERE location_id=$1 AND NOT(id=ANY($2::uuid[]))",[req.params.id,keptZoneIds]);
    for(const camera of input.cameras){
      const updated=await client.query(
        `UPDATE cameras SET location_id=$1,plan_x=$2,plan_y=$3
         WHERE id=$4 AND (location_id=$1 OR room_id IN (SELECT id FROM rooms WHERE location_id=$1) OR location_id IS NULL)
         RETURNING id`,
        [req.params.id,camera.x,camera.y,camera.id]
      );
      if(!updated.rowCount) throw new Error("CAMERA_LOCATION_MISMATCH");
    }
    await client.query("COMMIT");
    await audit(req,"location.plan.update","location",req.params.id,null,{zones:input.zones.length,cameras:input.cameras.length});
    res.json({saved:true});
  } catch(error) {
    await client.query("ROLLBACK");
    if(["ZONE_ROOM_LOCATION_MISMATCH","ZONE_LOCATION_MISMATCH","CAMERA_LOCATION_MISMATCH"].includes(error.message)) return res.status(400).json({error:error.message});
    throw error;
  } finally { client.release(); }
});

app.delete("/cameras/:id", auth, permit("cameras:manage"), async (req, res) => {
  const { rows } = await db.query(
    `UPDATE cameras SET archived_at=now(),status='OFFLINE',ai_enabled=false,tracking_enabled=false,
       analysis_enabled=false,headset_tracking_enabled=false
     WHERE id=$1 AND archived_at IS NULL RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  cameraVisionController.setTracking(req.params.id,false);
  await audit(req, "camera.archive", "camera", rows[0].id, null, { archivedAt:rows[0].archived_at });
  void syncAiWorkersSafe();
  res.status(204).end();
});

app.get("/cameras-archived", auth, async (req,res) => {
  if(!canConfigureCameras(req)) return res.status(403).json({error:"CAMERA_SETTINGS_FORBIDDEN"});
  const scoped=isOwner(req)
    ? {clause:"TRUE",values:[]}
    : {clause:"COALESCE(c.location_id,r.location_id) IS NULL OR COALESCE(c.location_id,r.location_id) IN (SELECT location_id FROM user_locations WHERE user_id=$1)",values:[req.user.sub]};
  const { rows }=await db.query(`
    SELECT c.id,c.name,c.provider,c.external_id,c.status,c.config,c.archived_at,
           COALESCE(c.location_id,r.location_id) AS location_id,l.name AS location_name,r.name AS room_name
    FROM cameras c
    LEFT JOIN rooms r ON r.id=c.room_id
    LEFT JOIN locations l ON l.id=COALESCE(c.location_id,r.location_id)
    WHERE (${scoped.clause}) AND c.archived_at IS NOT NULL
    ORDER BY c.archived_at DESC,c.name
  `,scoped.values);
  res.json(rows);
});

app.post("/cameras/:id/restore", auth, permit("cameras:manage"), async (req,res) => {
  const before=(await db.query(
    `SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id
     FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1 AND c.archived_at IS NOT NULL`,
    [req.params.id]
  )).rows[0];
  if(!before) return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if(!isOwner(req) && before.effective_location_id && !(await locationAllowed(req,before.effective_location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const { rows }=await db.query(
    "UPDATE cameras SET archived_at=NULL,status='OFFLINE' WHERE id=$1 RETURNING *",
    [req.params.id]
  );
  await audit(req,"camera.restore","camera",req.params.id,{archivedAt:before.archived_at},{archivedAt:null});
  void syncAiWorkersSafe();
  res.json(rows[0]);
});

for (const resource of ["integrations","local_sites","bookings","sessions"]) {
  app.get(`/${resource}`, auth, permit(`${resource}:read`), async (_, res) => res.json((await db.query(`SELECT * FROM ${resource} ORDER BY 1 DESC LIMIT 250`)).rows));
}

app.get("/locations", auth, permit("locations:read"), async (req,res) => {
  const { rows } = isOwner(req)
    ? await db.query("SELECT * FROM locations ORDER BY name")
    : await db.query("SELECT l.* FROM locations l JOIN user_locations ul ON ul.location_id=l.id WHERE ul.user_id=$1 ORDER BY l.name",[req.user.sub]);
  res.json(rows);
});

const inventoryItemInput = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(80),
  unit: z.string().trim().min(1).max(30),
  quantity: z.coerce.number().finite().min(0).max(1_000_000),
  minimumQuantity: z.coerce.number().finite().min(0).max(1_000_000),
  notes: z.string().trim().max(500).default(""),
  gameId:z.preprocess(value=>value===""?null:value,z.string().uuid().nullable()).default(null),
});

app.get("/inventory", auth, async (req,res) => {
  const input=z.object({locationId:z.string().uuid().optional()}).parse(req.query);
  if(input.locationId&&!(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`
    SELECT i.*,l.name AS location_name,
           (i.quantity<=i.minimum_quantity) AS low_stock
    FROM inventory_items i
    JOIN locations l ON l.id=i.location_id
    WHERE i.is_active=true
      AND ($1::uuid IS NULL OR i.location_id=$1)
      AND ($2::boolean OR EXISTS(
        SELECT 1 FROM user_locations ul WHERE ul.user_id=$3 AND ul.location_id=i.location_id
      ))
    ORDER BY (i.quantity<=i.minimum_quantity) DESC,l.name,lower(i.category),lower(i.name)
  `,[input.locationId||null,isOwner(req),req.user.sub]);
  res.json(rows);
});

app.get("/inventory-export", auth, async (req,res) => {
  const input=z.object({
    locationId:z.string().uuid().optional(),
    category:z.string().trim().min(1).max(80).optional(),
    search:z.string().trim().min(1).max(120).optional(),
  }).parse(req.query);
  if(input.locationId&&!(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows:items}=await db.query(`
    SELECT i.*,l.name AS location_name,
           i.quantity-COALESCE((SELECT sum(m.delta) FROM inventory_movements m WHERE m.item_id=i.id),0) AS initial_quantity,
           (i.quantity<=i.minimum_quantity) AS low_stock
    FROM inventory_items i
    JOIN locations l ON l.id=i.location_id
    WHERE i.is_active=true
      AND ($1::uuid IS NULL OR i.location_id=$1)
      AND ($2::boolean OR EXISTS(
        SELECT 1 FROM user_locations ul WHERE ul.user_id=$3 AND ul.location_id=i.location_id
      ))
      AND ($4::text IS NULL OR lower(i.category)=lower($4))
      AND ($5::text IS NULL OR lower(i.name) LIKE '%'||lower($5)||'%')
    ORDER BY l.name,lower(i.category),lower(i.name)
  `,[input.locationId||null,isOwner(req),req.user.sub,input.category||null,input.search||null]);
  const itemIds=items.map(item=>item.id);
  const {rows:movements}=itemIds.length ? await db.query(`
    SELECT m.id,m.item_id,m.delta,m.quantity_after,m.reason,m.operation_count,m.created_at,m.last_event_at,
           COALESCE(u.display_name,'Сотрудник') AS created_by_name
    FROM inventory_movements m
    LEFT JOIN users u ON u.id=m.created_by
    WHERE m.item_id=ANY($1::uuid[])
    ORDER BY m.item_id,m.created_at,m.id
  `,[itemIds]) : {rows:[]};
  const movementsByItem=new Map();
  for(const movement of movements) {
    const list=movementsByItem.get(movement.item_id)||[];
    list.push(movement);
    movementsByItem.set(movement.item_id,list);
  }
  res.set("cache-control","no-store").json({
    generatedAt:new Date().toISOString(),
    items:items.map(item=>({...item,movements:movementsByItem.get(item.id)||[]})),
  });
});

app.post("/inventory", auth, async (req,res) => {
  const input=inventoryItemInput.parse(req.body);
  if(!(await locationAllowed(req,input.locationId))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`
    INSERT INTO inventory_items(location_id,name,category,unit,quantity,minimum_quantity,notes,updated_by,game_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `,[input.locationId,input.name,input.category,input.unit,input.quantity,input.minimumQuantity,input.notes||null,req.user.sub,input.gameId]);
  await audit(req,"inventory.item.create","inventory_item",rows[0].id,null,rows[0]);
  res.status(201).json(rows[0]);
});

app.patch("/inventory/:id", auth, async (req,res) => {
  const input=z.object({minimumQuantity:z.coerce.number().finite().min(0).max(1_000_000).optional(),gameId:z.string().uuid().nullable().optional()}).refine(value=>Object.keys(value).length>0).parse(req.body);
  const before=(await db.query("SELECT * FROM inventory_items WHERE id=$1 AND is_active=true",[req.params.id])).rows[0];
  if(!before) return res.status(404).json({error:"INVENTORY_ITEM_NOT_FOUND"});
  if(!(await locationAllowed(req,before.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const item=(await db.query(`
    UPDATE inventory_items SET minimum_quantity=COALESCE($1,minimum_quantity),game_id=CASE WHEN $2 THEN $3::uuid ELSE game_id END,updated_by=$4,updated_at=now()
    WHERE id=$5 RETURNING *,(quantity<=minimum_quantity) AS low_stock
  `,[input.minimumQuantity??null,Object.hasOwn(input,"gameId"),input.gameId||null,req.user.sub,before.id])).rows[0];
  await audit(req,"inventory.item.update","inventory_item",before.id,before,item);
  res.json(item);
});

app.delete("/inventory/:id", auth, async (req,res) => {
  const before=(await db.query("SELECT * FROM inventory_items WHERE id=$1 AND is_active=true",[req.params.id])).rows[0];
  if(!before) return res.status(404).json({error:"INVENTORY_ITEM_NOT_FOUND"});
  if(!(await locationAllowed(req,before.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  await db.query("UPDATE inventory_items SET is_active=false,updated_by=$1,updated_at=now() WHERE id=$2",[req.user.sub,before.id]);
  await audit(req,"inventory.item.archive","inventory_item",before.id,before,{...before,is_active:false});
  res.status(204).end();
});

app.get("/inventory/:id/movements", auth, async (req,res) => {
  const item=(await db.query(`
    SELECT i.id,i.location_id,i.name,i.unit,i.quantity,i.created_at,
           i.quantity-COALESCE((SELECT sum(m.delta) FROM inventory_movements m WHERE m.item_id=i.id),0) AS initial_quantity
    FROM inventory_items i
    WHERE i.id=$1 AND i.is_active=true
  `,[req.params.id])).rows[0];
  if(!item) return res.status(404).json({error:"INVENTORY_ITEM_NOT_FOUND"});
  if(!(await locationAllowed(req,item.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`
    SELECT m.id,m.delta,m.quantity_after,m.reason,m.operation_count,m.created_at,m.last_event_at,
           COALESCE(u.display_name,'Сотрудник') AS created_by_name
    FROM inventory_movements m
    LEFT JOIN users u ON u.id=m.created_by
    WHERE m.item_id=$1
    ORDER BY m.last_event_at DESC
    LIMIT 200
  `,[item.id]);
  res.json({item,movements:rows});
});

app.post("/inventory/:id/adjust", auth, async (req,res) => {
  const input=z.object({
    delta:z.coerce.number().finite().min(-1_000_000).max(1_000_000).refine(value=>value!==0),
    reason:z.string().trim().min(2).max(240),
  }).parse(req.body);
  const client=await db.connect();
  try {
    await client.query("BEGIN");
    const before=(await client.query("SELECT * FROM inventory_items WHERE id=$1 AND is_active=true FOR UPDATE",[req.params.id])).rows[0];
    if(!before){await client.query("ROLLBACK");return res.status(404).json({error:"INVENTORY_ITEM_NOT_FOUND"});}
    if(!(await locationAllowed(req,before.location_id))){await client.query("ROLLBACK");return res.status(403).json({error:"LOCATION_FORBIDDEN"});}
    const nextQuantity=Number(before.quantity)+input.delta;
    if(nextQuantity<0){await client.query("ROLLBACK");return res.status(409).json({error:"INSUFFICIENT_STOCK"});}
    const item=(await client.query(`
      UPDATE inventory_items SET quantity=$1,updated_by=$2,updated_at=now()
      WHERE id=$3 RETURNING *,(quantity<=minimum_quantity) AS low_stock
    `,[nextQuantity,req.user.sub,before.id])).rows[0];
    const recentMovement=(await client.query(`
      SELECT id FROM inventory_movements
      WHERE item_id=$1 AND created_by=$2 AND reason=$3
        AND sign(delta)=sign($4::numeric)
        AND last_event_at>=now()-interval '5 minutes'
      ORDER BY last_event_at DESC LIMIT 1 FOR UPDATE
    `,[before.id,req.user.sub,input.reason,input.delta])).rows[0];
    if(recentMovement) {
      await client.query(`
        UPDATE inventory_movements
        SET delta=delta+$1,quantity_after=$2,operation_count=operation_count+1,last_event_at=now()
        WHERE id=$3
      `,[input.delta,nextQuantity,recentMovement.id]);
    } else {
      await client.query(`
        INSERT INTO inventory_movements(item_id,delta,quantity_after,reason,created_by)
        VALUES($1,$2,$3,$4,$5)
      `,[before.id,input.delta,nextQuantity,input.reason,req.user.sub]);
    }
    await client.query("COMMIT");
    await audit(req,"inventory.stock.adjust","inventory_item",before.id,before,{quantity:nextQuantity,delta:input.delta,reason:input.reason});
    res.json(item);
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
});

app.get("/rooms", auth, permit("rooms:read"), async (req,res) => {
  const { rows } = isOwner(req)
    ? await db.query("SELECT r.*,l.name location_name FROM rooms r JOIN locations l ON l.id=r.location_id ORDER BY l.name,r.name")
    : await db.query("SELECT r.*,l.name location_name FROM rooms r JOIN locations l ON l.id=r.location_id JOIN user_locations ul ON ul.location_id=r.location_id WHERE ul.user_id=$1 ORDER BY l.name,r.name",[req.user.sub]);
  res.json(rows);
});

app.get("/games", auth, permit("rooms:read"), async (req,res) => {
  const input=z.object({roomId:z.string().uuid().optional()}).parse(req.query);
  const values=isOwner(req) ? [] : [req.user.sub];
  let clause=isOwner(req)
    ? "TRUE"
    : "r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)";
  if (input.roomId) {
    values.push(input.roomId);
    clause+=` AND g.room_id=$${values.length}`;
  }
  const { rows }=await db.query(`
    SELECT g.*,r.name room_name,r.location_id,l.name location_name,l.external_id location_external_id
    FROM games g
    JOIN rooms r ON r.id=g.room_id
    JOIN locations l ON l.id=r.location_id
    WHERE ${clause} AND g.is_active=true
    ORDER BY l.name,r.name,g.name
  `,values);
  res.json(rows);
});

app.post("/games", auth, permit("rooms:manage"), async (req,res) => {
  if (!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=z.object({roomId:z.string().uuid(),name:z.string().trim().min(2).max(120)}).parse(req.body);
  if (!(await db.query("SELECT 1 FROM rooms WHERE id=$1",[input.roomId])).rowCount) return res.status(404).json({error:"ROOM_NOT_FOUND"});
  const { rows }=await db.query(`
    INSERT INTO games(room_id,name) VALUES($1,$2)
    ON CONFLICT(room_id,lower(name)) DO UPDATE SET is_active=true,name=excluded.name
    RETURNING *
  `,[input.roomId,input.name]);
  await audit(req,"game.create","game",rows[0].id,null,rows[0]);
  res.status(201).json(rows[0]);
});

app.patch("/games/:id", auth, permit("rooms:manage"), async (req,res) => {
  if (!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  const input=z.object({name:z.string().trim().min(2).max(120)}).parse(req.body);
  const before=(await db.query("SELECT * FROM games WHERE id=$1",[req.params.id])).rows[0];
  if (!before) return res.status(404).json({error:"GAME_NOT_FOUND"});
  const { rows }=await db.query("UPDATE games SET name=$1 WHERE id=$2 RETURNING *",[input.name,req.params.id]);
  await audit(req,"game.update","game",req.params.id,before,rows[0]);
  res.json(rows[0]);
});

app.delete("/games/:id", auth, permit("rooms:manage"), async (req,res) => {
  if (!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  const before=(await db.query("SELECT * FROM games WHERE id=$1",[req.params.id])).rows[0];
  if (!before) return res.status(404).json({error:"GAME_NOT_FOUND"});
  await db.query("UPDATE games SET is_active=false WHERE id=$1",[req.params.id]);
  await audit(req,"game.archive","game",req.params.id,before,{...before,is_active:false});
  res.status(204).end();
});

app.get("/devices", auth, permit("devices:read"), async (req,res) => {
  const { rows } = isOwner(req)
    ? await db.query("SELECT * FROM devices ORDER BY name")
    : await db.query("SELECT d.* FROM devices d JOIN rooms r ON r.id=d.room_id JOIN user_locations ul ON ul.location_id=r.location_id WHERE ul.user_id=$1 ORDER BY d.name",[req.user.sub]);
  res.json(rows);
});

app.post("/rooms/:id/command", auth, permit("devices:command"), async (req, res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const command = z.object({ action:z.enum(["status","start_game","pause_game","reset_room","send_hint","add_time","end_game"]), payload:z.record(z.unknown()).default({}) }).parse(req.body);
  const commandId = crypto.randomUUID();
  const agent = await db.query("SELECT agent_id FROM devices WHERE room_id=$1 AND agent_id IS NOT NULL LIMIT 1", [req.params.id]);
  if (!agent.rowCount) return res.status(409).json({ error: "AGENT_NOT_CONFIGURED" });
  io.of("/agent").to(`agent:${agent.rows[0].agent_id}`).timeout(7000).emit("command", { id:commandId, roomId:req.params.id, ...command }, async (err, responses) => {
    const result = err ? { success:false, error:"AGENT_TIMEOUT" } : responses?.[0];
    await audit(req,"room.command","room",req.params.id,null,{ commandId,...command,result });
    res.status(result?.success ? 200 : 502).json({ commandId,...result });
  });
});

async function roomAgentRequest(roomId, event, payload) {
  const agent = await db.query(
    "SELECT agent_id FROM devices WHERE room_id=$1 AND agent_id IS NOT NULL ORDER BY last_seen DESC NULLS LAST, id LIMIT 1",
    [roomId]
  );
  if (!agent.rowCount) return { success:false, error:"AGENT_NOT_CONFIGURED" };
  return new Promise(resolve => {
    io.of("/agent").to(`agent:${agent.rows[0].agent_id}`).timeout(8000).emit(event, payload, (err, responses) => {
      resolve(err ? { success:false, error:"AGENT_TIMEOUT" } : responses?.[0] || { success:false, error:"EMPTY_AGENT_RESPONSE" });
    });
  });
}

const krampusRead = z.enum(["status","sensors","logs"]);
const krampusCommands = [
  "START","STATUS","RESET","ESTOP",
  "LIGHT UV","LIGHT WHITE","LIGHT OK","LIGHT OFF","LIGHT RESET","MASK SOUND",
  "PUZZLE SOLVE","PUZZLE RESET","BEAR SOUND","BEAR OPEN","BEAR CLOSE",
  "DOOR OPEN","DOOR CLOSE","TABLE OPEN","TABLE CLOSE","TABLE LEG OPEN","TABLE LEG CLOSE",
  "OVEN SOLVED","OVEN RESET","OVEN UV ON","OVEN UV OFF","OVEN LIGHT ON",
  "OVEN LIGHT OFF","OVEN MOVE ON","OVEN MOVE OFF","OVEN FOG ON","OVEN FOG OFF"
];
const krampusCommand = z.object({ command:z.enum(krampusCommands.map(value=>`ADMIN ${value}`)) }).strict();
const serialPath = z.object({
  path:z.string().trim().min(1).max(255).refine(
    value=>value.startsWith("/dev/")&&!value.includes("..")&&/^\/dev\/[A-Za-z0-9._/-]+$/.test(value),
    "INVALID_SERIAL_PATH"
  )
}).strict();
const voiceHintTypes = ["audio/mpeg","audio/wav","audio/x-wav","audio/ogg","audio/webm","audio/mp4","audio/x-m4a"];
const voiceHintUpload = z.object({
  name:z.string().trim().min(1).max(120),
  fileName:z.string().trim().min(1).max(255),
  contentType:z.enum(voiceHintTypes),
  data:z.string().min(1)
}).strict();

async function allowedRoom(req, roomId) {
  const room=(await db.query("SELECT id,location_id FROM rooms WHERE id=$1",[roomId])).rows[0];
  return room && await locationAllowed(req,room.location_id) ? room : null;
}

const controlManifest = z.object({
  version:z.literal(1),
  title:z.string().trim().min(1).max(120),
  state:z.object({pollMs:z.number().int().min(500).max(60_000).default(2000)}).strict().optional(),
  blocks:z.array(z.object({
    id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    title:z.string().trim().min(1).max(80),
    width:z.enum(["full","half","third"]).default("half"),
    categories:z.array(z.object({
      id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),title:z.string().trim().min(1).max(80),
      controls:z.array(z.object({
        id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),type:z.enum(["button","checkbox","slider","indicator"]),
        label:z.string().trim().min(1).max(80),statePath:z.string().trim().max(160).optional(),
        expectedValue:z.union([z.string(),z.number(),z.boolean()]).optional(),
        onLabel:z.string().trim().max(40).optional(),offLabel:z.string().trim().max(40).optional(),
        min:z.number().optional(),max:z.number().optional(),step:z.number().positive().optional(),unit:z.string().trim().max(20).optional(),
      }).strict()).max(50),
    }).strict()).max(20),
  }).strict()).max(20),
}).strict();

app.get("/rooms/:id/control-panel/manifest",auth,permit("rooms:read"),async(req,res)=>{
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const result=await roomAgentRequest(req.params.id,"control-panel",{operation:"manifest"});
  if(!result.success) return res.status(502).json({error:result.error});
  res.json(controlManifest.parse(result.result));
});

app.get("/rooms/:id/control-panel/state",auth,permit("rooms:read"),async(req,res)=>{
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const result=await roomAgentRequest(req.params.id,"control-panel",{operation:"state"});
  res.status(result.success?200:502).json(result.success?result.result:{error:result.error});
});

app.post("/rooms/:id/control-panel/actions/:controlId",auth,permit("devices:command"),async(req,res)=>{
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const input=z.object({checked:z.boolean().optional(),value:z.number().finite().optional()}).strict().parse(req.body);
  const controlId=z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).parse(req.params.controlId);
  const result=await roomAgentRequest(req.params.id,"control-panel",{operation:"execute",controlId,...input});
  await audit(req,"room.control_panel.command","room",req.params.id,null,{controlId,...input,result});
  res.status(result.success?200:502).json(result.success?result.result:{error:result.error});
});

app.get("/rooms/:id/krampus/:resource", auth, permit("rooms:read"), async (req,res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const resource=krampusRead.parse(req.params.resource);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:resource});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/command", auth, permit("devices:command"), async (req,res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const { command }=krampusCommand.parse(req.body);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:"command",command});
  await audit(req,"krampus.command","room",req.params.id,null,{command,result});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/serial", auth, permit("devices:command"), async (req,res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const {path}=serialPath.parse(req.body);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:"serial",path});
  await audit(req,"krampus.serial.configure","room",req.params.id,null,{path,result});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/sound", auth, permit("devices:command"), async (req,res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const input=z.discriminatedUnion("action",[
    z.object({action:z.literal("play"),sound:z.enum(["alert.mp3","calling.mp3"])}).strict(),
    z.object({action:z.literal("stop"),sound:z.undefined().optional()}).strict()
  ]).parse(req.body);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:"sound",...input});
  await audit(req,"krampus.sound","room",req.params.id,null,{...input,result});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.get("/rooms/:id/voice-hints", auth, permit("rooms:read"), async (req,res) => {
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(
    `SELECT id,name,file_name,content_type,size_bytes,created_at
     FROM voice_hints WHERE room_id=$1 ORDER BY lower(name),created_at`,
    [req.params.id]
  );
  res.json(rows);
});

app.post("/rooms/:id/voice-hints", auth, permit("devices:command"), async (req,res) => {
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const input=voiceHintUpload.parse(req.body);
  let audio;
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) return res.status(400).json({error:"INVALID_AUDIO_DATA"});
  try { audio=Buffer.from(input.data,"base64"); }
  catch { return res.status(400).json({error:"INVALID_AUDIO_DATA"}); }
  if(!audio.length||audio.length>6_000_000) return res.status(413).json({error:"VOICE_HINT_TOO_LARGE"});
  if(input.data.replace(/=+$/,"").length!==Math.ceil(audio.length/3)*4-(audio.length%3?3-audio.length%3:0)) {
    return res.status(400).json({error:"INVALID_AUDIO_DATA"});
  }
  const {rows}=await db.query(
    `INSERT INTO voice_hints(room_id,name,file_name,content_type,audio_data,size_bytes,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING id,name,file_name,content_type,size_bytes,created_at`,
    [req.params.id,input.name,input.fileName,input.contentType,audio,audio.length,req.user.sub]
  );
  await audit(req,"voice_hint.create","voice_hint",rows[0].id,null,{roomId:req.params.id,name:input.name,fileName:input.fileName,sizeBytes:audio.length});
  res.status(201).json(rows[0]);
});

app.get("/rooms/:id/voice-hints/:hintId/audio", auth, permit("rooms:read"), async (req,res) => {
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const hint=(await db.query(
    "SELECT content_type,file_name,audio_data FROM voice_hints WHERE id=$1 AND room_id=$2",
    [req.params.hintId,req.params.id]
  )).rows[0];
  if(!hint) return res.status(404).json({error:"VOICE_HINT_NOT_FOUND"});
  res.set({"content-type":hint.content_type,"content-length":String(hint.audio_data.length),"cache-control":"private, max-age=300","content-disposition":`inline; filename*=UTF-8''${encodeURIComponent(hint.file_name)}`});
  res.send(hint.audio_data);
});

app.post("/rooms/:id/voice-hints/:hintId/play", auth, permit("devices:command"), async (req,res) => {
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const hint=(await db.query(
    "SELECT id,name,content_type,audio_data,size_bytes FROM voice_hints WHERE id=$1 AND room_id=$2",
    [req.params.hintId,req.params.id]
  )).rows[0];
  if(!hint) return res.status(404).json({error:"VOICE_HINT_NOT_FOUND"});
  const agent=(await db.query(
    "SELECT agent_id FROM devices WHERE room_id=$1 AND agent_id IS NOT NULL ORDER BY last_seen DESC NULLS LAST,id LIMIT 1",
    [req.params.id]
  )).rows[0];
  if(!agent) return res.status(409).json({error:"AGENT_NOT_CONFIGURED"});
  if(activeVoiceAgents.has(agent.agent_id)) return res.status(409).json({error:"VOICE_BUSY"});
  const playbackId=`hint:${hint.id}`;
  activeVoiceAgents.set(agent.agent_id,playbackId);
  const finish=()=>{ if(activeVoiceAgents.get(agent.agent_id)===playbackId) activeVoiceAgents.delete(agent.agent_id); };
  agentNs.to(`agent:${agent.agent_id}`).timeout(5000).emit("voice",{operation:"start",contentType:hint.content_type},async(err,responses)=>{
    const result=err?{success:false,error:"AGENT_TIMEOUT"}:responses?.[0]||{success:false,error:"EMPTY_AGENT_RESPONSE"};
    if(!result.success) {
      finish();
      await audit(req,"voice_hint.play","voice_hint",hint.id,null,{roomId:req.params.id,name:hint.name,result});
      return res.status(502).json({error:result.error});
    }
    for(let offset=0;offset<hint.audio_data.length;offset+=64_000) {
      agentNs.to(`agent:${agent.agent_id}`).emit("voice",{operation:"chunk",data:hint.audio_data.subarray(offset,offset+64_000)});
    }
    agentNs.to(`agent:${agent.agent_id}`).emit("voice",{operation:"stop"});
    finish();
    await audit(req,"voice_hint.play","voice_hint",hint.id,null,{roomId:req.params.id,name:hint.name,sizeBytes:hint.size_bytes,result:{success:true}});
    res.json({success:true});
  });
});

app.delete("/rooms/:id/voice-hints/:hintId", auth, permit("devices:command"), async (req,res) => {
  if(!(await allowedRoom(req,req.params.id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const hint=(await db.query(
    "DELETE FROM voice_hints WHERE id=$1 AND room_id=$2 RETURNING id,name,file_name,size_bytes",
    [req.params.hintId,req.params.id]
  )).rows[0];
  if(!hint) return res.status(404).json({error:"VOICE_HINT_NOT_FOUND"});
  await audit(req,"voice_hint.delete","voice_hint",hint.id,hint,null);
  res.status(204).end();
});

const vrPoelten = {
  panelUrl:new URL(env.VR_SANKT_POELTEN_PANEL_URL),
  deviceUrl:new URL(env.VR_SANKT_POELTEN_DEVICE_URL),
};
async function vrPoeltenLocation(req) {
  const location=await vrPoeltenLocationRecord();
  if(!location) return null;
  return await locationAllowed(req,location.id) ? location : false;
}
async function vrPoeltenLocationRecord() {
  return (await db.query(`
    SELECT DISTINCT l.id,l.name
    FROM locations l
    JOIN rooms r ON r.location_id=l.id
    WHERE r.kind='VR'
      AND (lower(l.name) LIKE '%pölten%' OR lower(l.name) LIKE '%polten%' OR lower(l.name) LIKE '%peolten%' OR lower(r.name) LIKE '%sankt polten%')
    ORDER BY l.name LIMIT 1
  `)).rows[0]||null;
}
async function vrReachable(url,path) {
  const started=Date.now();
  try {
    const response=await fetch(new URL(path,url),{method:"HEAD",signal:AbortSignal.timeout(3500),redirect:"manual"});
    return {online:response.ok,latencyMs:Date.now()-started,status:response.status};
  } catch { return {online:false,latencyMs:null,status:null}; }
}
async function vrTcpReachable(url) {
  const started=Date.now();
  return new Promise(resolve=>{
    const socket=net.createConnection({host:url.hostname,port:Number(url.port)||80});
    const finish=online=>{socket.destroy();resolve({online,latencyMs:online?Date.now()-started:null,status:null});};
    socket.setTimeout(3500);
    socket.once("connect",()=>finish(true));
    socket.once("timeout",()=>finish(false));
    socket.once("error",()=>finish(false));
  });
}
function vrCookie(req) {
  return String(req.get("cookie")||"").split(/;\s*/).find(value=>value.startsWith("quest_vr_poelten="))?.slice("quest_vr_poelten=".length);
}
function vrPrivateHost(value) {
  const match=/^192\.168\.31\.(\d{1,3})$/.exec(String(value||""));
  return match&&Number(match[1])<=255 ? match[0] : null;
}
const vrBrowserRequestGuard=`(()=>{
  const station=/^192\\.168\\.31\\.\\d{1,3}$/;
  const prefix="/api/vr/sankt-poelten";
  function safeUrl(value){try{return new URL(String(value),location.href)}catch{return null}}
  function rewrite(value){
    const url=safeUrl(value);if(!url)return value;
    if(url.hostname==="vrp.arvilab.com"&&url.pathname==="/api/widget/support/unread-count"){
      return prefix+"/support/unread-count"+url.search;
    }
    if(!station.test(url.hostname))return value;
    const stationHost=url.hostname;
    if(!url.pathname.startsWith(prefix+"/")){
      const action=/^\\/(?:api\\/vr\\/sankt-poelten\\/station\\/auto\\/)?session\\/(create|terminate|join|leave|joinsession|changepaidtime)\\/?$/.exec(url.pathname);
      if(action)url.pathname=prefix+"/station/"+stationHost+"/session/"+action[1];
      else return value;
    }
    url.protocol=location.protocol;url.host=location.host;
    return url.href;
  }
  const open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,rewrite(url),...rest)};
  if(typeof window.fetch==="function"){
    const originalFetch=window.fetch.bind(window);
    window.fetch=(input,init)=>input instanceof Request
      ? originalFetch(new Request(rewrite(input.url),input),init)
      : originalFetch(rewrite(input),init);
  }
})();`;
const vrSocksAgent=new SocksProxyAgent(env.VR_SANKT_POELTEN_SOCKS_URL);
const vrScreenCache=new Map();
async function requireVrPoeltenAccess(req,res,next) {
  const sessionId=vrCookie(req);
  const raw=sessionId&&await redis.get(`vr-session:${sessionId}`);
  if(!raw) return res.status(401).json({error:"VR_SESSION_EXPIRED"});
  req.vrSession=JSON.parse(raw);
  next();
}
function vrResponseItems(value) {
  const payload=value?.response??value?.data??value;
  return Array.isArray(payload)?payload:Array.isArray(payload?.items)?payload.items:[];
}
async function rememberVrCatalog(path,value) {
  const kind=path==="webadmin/v1/games"?"games":path==="webadmin/v1/instances"?"stations":null;
  if(!kind) return;
  const entries={};
  for(const item of vrResponseItems(value)) {
    const id=item?.sid??item?.id;
    const name=item?.name??item?.title??item?.hostname;
    if(id!==undefined&&name) entries[String(id)]=String(name);
  }
  if(Object.keys(entries).length) await redis.hset(`vr-catalog:${kind}`,entries);
  if(kind==="stations") {
    const ips={};
    for(const item of vrResponseItems(value)) if((item?.sid??item?.id)!==undefined&&vrPrivateHost(item?.ip)) ips[String(item.sid??item.id)]=String(item.ip);
    if(Object.keys(ips).length) await redis.hset("vr-catalog:station-ips",ips);
  }
}
async function trackVrSession(req,path,responseValue,responseOk) {
  if(!responseOk) return;
  await rememberVrCatalog(path,responseValue);
  if(path==="webadmin/v1/sessions") {
    const sessions=vrResponseItems(responseValue);
    const visibleIds=[];
    for(const session of sessions) {
      const externalId=String(session.id??session.sid??"");
      if(externalId) visibleIds.push(externalId);
      if(session?.is_terminated===undefined||session?.is_terminated===false) continue;
      if(!externalId) continue;
      const reportedDuration=Number(session.duration);
      const durationSeconds=Number.isFinite(reportedDuration)&&reportedDuration>=0?Math.round(reportedDuration):null;
      await db.query(`UPDATE vr_session_logs SET status='FINISHED',ended_at=COALESCE(ended_at,now()),duration_seconds=COALESCE($3,duration_seconds,GREATEST(0,extract(epoch FROM now()-started_at)::int)),raw_end=$4
        WHERE location_id=$1 AND external_session_id=$2 AND status='ACTIVE'`,[req.vrSession.locationId,externalId,durationSeconds,{source:"sessions",isTerminated:true,reportedDuration:durationSeconds}]);
    }
    if(visibleIds.length===1) {
      await db.query(`UPDATE vr_session_logs SET external_session_id=$2
        WHERE id=(SELECT id FROM vr_session_logs WHERE location_id=$1 AND status='ACTIVE' AND external_session_id IS NULL ORDER BY started_at DESC LIMIT 1)`,
        [req.vrSession.locationId,visibleIds[0]]);
    }
    for(const session of sessions) {
      const externalId=String(session.id??session.sid??"");
      if(!externalId||session?.is_terminated===true) continue;
      const gameId=String(session.game_sid??session.game?.sid??session.game?.id??"");
      const gameName=String(session.game?.name??session.game_name??await redis.hget("vr-catalog:games",gameId)??"Неизвестная игра");
      const stationNames=[];
      for(const member of Array.isArray(session.members)?session.members:[]) {
        const station=member?.station??member?.instance??member;
        const stationId=String(station?.sid??station?.id??"");
        const stationName=station?.name??(stationId&&await redis.hget("vr-catalog:stations",stationId));
        if(stationName&&!stationNames.includes(String(stationName))) stationNames.push(String(stationName));
      }
      const reportedDuration=Number(session.duration);
      const durationSeconds=Number.isFinite(reportedDuration)&&reportedDuration>=0?Math.round(reportedDuration):0;
      await db.query(`INSERT INTO vr_session_logs(location_id,external_session_id,game_name,stations,started_at,started_by,raw_start)
        VALUES($1,$2,$3,$4,now()-($5::int*interval '1 second'),$6,$7)
        ON CONFLICT(location_id,external_session_id) WHERE external_session_id IS NOT NULL
        DO UPDATE SET game_name=EXCLUDED.game_name,stations=EXCLUDED.stations`,
        [req.vrSession.locationId,externalId,gameName,stationNames,req.vrSession.userId||null,{source:"sessions-monitor",gameId,durationSeconds}]);
    }
    await db.query(`UPDATE vr_session_logs SET status='FINISHED',ended_at=now(),
      duration_seconds=GREATEST(0,extract(epoch FROM now()-started_at)::int),raw_end=$3
      WHERE location_id=$1 AND status='ACTIVE' AND started_at < now()-interval '15 seconds'
        AND (cardinality($2::text[])=0 OR (external_session_id IS NOT NULL AND NOT (external_session_id=ANY($2::text[]))))`,
      [req.vrSession.locationId,visibleIds,{source:"sessions",reason:"no-longer-visible"}]);
    return;
  }
  const match=/^(?:webadmin\/v1\/)?(?:meta)?session\/(create|terminate)$/.exec(path);
  if(!match) return;
  const query=new URL(req.originalUrl,"http://local").searchParams;
  let body={};
  try { if(req.body?.length) body=JSON.parse(req.body.toString("utf8")); } catch {}
  const input={...Object.fromEntries(query),...body};
  const response=responseValue?.response??responseValue?.data??responseValue??{};
  const externalId=String(response?.id??response?.sid??input.sid??"")||null;
  if(match[1]==="create") {
    const gameId=String(input.gsid??input.game_sid??input.game??"");
    const gameName=String(input.game_name??response?.game?.name??response?.game_name??await redis.hget("vr-catalog:games",gameId)??"Неизвестная игра");
    const stationIds=[...query.getAll("ms"),...query.getAll("m"),...(Array.isArray(body.ms)?body.ms:[]),...(Array.isArray(body.m)?body.m:[])].flatMap(value=>String(value).split(",")).filter(Boolean);
    const stationNames=[];
    for(const id of [...new Set(stationIds)]) stationNames.push(await redis.hget("vr-catalog:stations",id)||id);
    await db.query(`INSERT INTO vr_session_logs(location_id,external_session_id,game_name,stations,started_by,raw_start)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(location_id,external_session_id) WHERE external_session_id IS NOT NULL
      DO UPDATE SET game_name=EXCLUDED.game_name,stations=EXCLUDED.stations,started_by=EXCLUDED.started_by,raw_start=EXCLUDED.raw_start`,
      [req.vrSession.locationId,externalId,gameName,stationNames,req.vrSession.userId,{gameId,stationIds}]);
  } else {
    await db.query(`UPDATE vr_session_logs SET status='FINISHED',ended_at=now(),duration_seconds=GREATEST(0,extract(epoch FROM now()-started_at)::int),raw_end=$3
      WHERE id=(SELECT id FROM vr_session_logs WHERE location_id=$1 AND ($2::text IS NULL OR external_session_id=$2) AND status='ACTIVE' ORDER BY started_at DESC LIMIT 1)`,
      [req.vrSession.locationId,externalId,{externalId}]);
  }
}
let vrSessionMonitorBusy=false;
let vrSessionMonitorCatalogAt=0;
async function vrSessionMonitorOnce() {
  if(vrSessionMonitorBusy) return;
  vrSessionMonitorBusy=true;
  try {
    const [location,rawHeaders]=await Promise.all([vrPoeltenLocationRecord(),redis.get("vr-monitor:headers")]);
    if(!location||!rawHeaders) return;
    const headers=JSON.parse(rawHeaders);
    const refreshCatalog=Date.now()-vrSessionMonitorCatalogAt>5*60_000;
    const paths=refreshCatalog?["webadmin/v1/games","webadmin/v1/instances","webadmin/v1/sessions"]:["webadmin/v1/sessions"];
    let sessionsObserved=false;
    for(const path of paths) {
      const response=await fetch(new URL(path,vrPoelten.deviceUrl.href.replace(/\/?$/,"/")),{headers,signal:AbortSignal.timeout(20_000)});
      if(!response.ok||!response.headers.get("content-type")?.includes("application/json")) continue;
      const value=await response.json();
      await trackVrSession({vrSession:{locationId:location.id,userId:null}},path,value,true);
      if(path==="webadmin/v1/sessions") sessionsObserved=true;
    }
    if(refreshCatalog) vrSessionMonitorCatalogAt=Date.now();
    if(sessionsObserved) await redis.set("vr-monitor:last-success",new Date().toISOString());
    else await redis.set("vr-monitor:last-error","ARVI sessions response unavailable");
  } catch(error) {
    await redis.set("vr-monitor:last-error",String(error.message||error));
  } finally { vrSessionMonitorBusy=false; }
}
setInterval(vrSessionMonitorOnce,10_000).unref();
setTimeout(vrSessionMonitorOnce,2_000).unref();
app.get("/vr/sankt-poelten/status",auth,permit("local_sites:open"),async(req,res)=>{
  const location=await vrPoeltenLocation(req);
  if(location===false) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!location) return res.status(404).json({error:"VR_LOCATION_NOT_FOUND"});
  const [panel,device,monitorState]=await Promise.all([
    vrTcpReachable(vrPoelten.panelUrl),
    vrReachable(vrPoelten.deviceUrl,"/content/79/dist/bundle.js"),
    redis.mget("vr-monitor:last-success","vr-monitor:last-error","vr-monitor:headers"),
  ]);
  res.json({location,panel,device,ready:panel.online&&device.online,monitor:{authorized:Boolean(monitorState[2]),lastSuccess:monitorState[0],lastError:monitorState[1]}});
});
app.get("/vr/sankt-poelten/session-logs",auth,permit("local_sites:open"),async(req,res)=>{
  const location=await vrPoeltenLocation(req);
  if(location===false) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!location) return res.status(404).json({error:"VR_LOCATION_NOT_FOUND"});
  const rows=(await db.query(`SELECT l.id,l.game_name,l.stations,l.status,l.started_at,l.ended_at,l.duration_seconds,
    COALESCE(u.display_name,u.email,'Неизвестно') operator
    FROM vr_session_logs l LEFT JOIN users u ON u.id=l.started_by
    WHERE l.location_id=$1 ORDER BY l.started_at DESC LIMIT 100`,[location.id])).rows;
  res.json(rows);
});
app.post("/vr/sankt-poelten/launch",auth,permit("local_sites:open"),async(req,res)=>{
  const location=await vrPoeltenLocation(req);
  if(location===false) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  if(!location) return res.status(404).json({error:"VR_LOCATION_NOT_FOUND"});
  const ticket=crypto.randomBytes(32).toString("base64url");
  await redis.setex(`vr-launch:${ticket}`,60,JSON.stringify({userId:req.user.sub,locationId:location.id}));
  await audit(req,"vr.panel.launch","location",location.id,null,{provider:"ARVI"});
  res.json({url:`/api/vr/sankt-poelten/panel/content/79/index?ticket=${ticket}`,expiresIn:60});
});
app.get("/vr/sankt-poelten/panel/content/79/index",async(req,res)=>{
  const ticket=typeof req.query.ticket==="string"?req.query.ticket:"";
  const ticketRaw=ticket&&await redis.getdel(`vr-launch:${ticket}`);
  let sessionId=vrCookie(req);
  let launchRaw=ticketRaw;
  if(!launchRaw&&sessionId) launchRaw=await redis.get(`vr-session:${sessionId}`);
  if(!launchRaw) return res.status(410).send("Сессия VR завершена. Вернитесь в Quest Control и откройте панель снова.");
  const launch=JSON.parse(launchRaw);
  if(ticketRaw||!sessionId) sessionId=crypto.randomBytes(32).toString("base64url");
  const assetVersion=crypto.randomBytes(8).toString("hex");
  await redis.setex(`vr-session:${sessionId}`,8*60*60,JSON.stringify(launch));
  res.cookie("quest_vr_poelten",sessionId,{httpOnly:true,secure:true,sameSite:"strict",maxAge:8*60*60*1000,path:"/api/vr/sankt-poelten/"});
  res.cookie("quest_vr_poelten",sessionId,{httpOnly:true,secure:true,sameSite:"strict",maxAge:8*60*60*1000,path:"/webadmin/v1/"});
  res.cookie("quest_vr_poelten",sessionId,{httpOnly:true,secure:true,sameSite:"strict",maxAge:8*60*60*1000,path:"/content/"});
  const host=req.get("host").split(":")[0];
  const query=new URLSearchParams({protocol:"https",api:host,apiPort:"443",apiPath:"api/vr/sankt-poelten/proxy/webadmin/v1/",ip:host,cb:assetVersion});
  res.type("html").set("cache-control","no-store").send(`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VR Санкт-Пёльтен</title><style>body{margin:0;background:#3b3b3b;color:#fff;font-family:Arial,sans-serif}#pre-load{margin:16px}</style></head><body><div id="app" class="root"><p id="pre-load">Загрузка VR…</p></div><script>history.replaceState(null,"",location.pathname+"?${query.toString()}");${vrBrowserRequestGuard}</script><script src="/api/vr/sankt-poelten/proxy/content/79/dist/bundle.js?cb=${assetVersion}"></script></body></html>`);
});
app.get("/vr/sankt-poelten/support/unread-count",requireVrPoeltenAccess,async(req,res)=>{
  try {
    const response=await fetch("https://vrp.arvilab.com/api/widget/support/unread-count",{headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)});
    if(!response.ok) throw new Error(`support upstream ${response.status}`);
    res.type("application/json").set("cache-control","private, max-age=30").send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.set("cache-control","private, max-age=30").json({count:0,unread_count:0});
  }
});
app.get("/vr/sankt-poelten/screen/get-screen",requireVrPoeltenAccess,async(req,res)=>{
  const host=vrPrivateHost(req.query.host);
  if(!host) return res.status(400).json({error:"INVALID_VR_HOST"});
  const query=new URLSearchParams();
  for(const name of ["w","h"]) if(/^\d{1,4}$/.test(String(req.query[name]||""))) query.set(name,String(req.query[name]));
  const cacheKey=`${host}?${query}`;
  const cached=vrScreenCache.get(cacheKey);
  if(cached&&cached.expiresAt>Date.now()) return res.type(cached.contentType).set("cache-control","private, max-age=2").send(cached.bytes);
  const target=`http://${host}:1717/catcher/v1/get-screen?${query}`;
  const upstream=http.get(target,{agent:vrSocksAgent,timeout:12_000,headers:{accept:req.get("accept")||"image/*"}},response=>{
    res.status(response.statusCode||502);
    for(const name of ["content-type","content-length","cache-control"]) {
      const value=response.headers[name]; if(value) res.set(name,String(value));
    }
    const chunks=[];
    response.on("data",chunk=>chunks.push(chunk));
    response.on("end",()=>{
      const bytes=Buffer.concat(chunks);
      if((response.statusCode||0)>=200&&(response.statusCode||0)<300) {
        vrScreenCache.set(cacheKey,{bytes,contentType:String(response.headers["content-type"]||"image/jpeg"),expiresAt:Date.now()+5_000});
        if(vrScreenCache.size>50) for(const [key,value] of vrScreenCache) if(value.expiresAt<=Date.now()) vrScreenCache.delete(key);
      }
      res.send(bytes);
    });
  });
  upstream.once("timeout",()=>upstream.destroy(new Error("timeout")));
  upstream.once("error",()=>{if(!res.headersSent) res.status(502).json({error:"VR_SCREEN_UNAVAILABLE"});else res.end();});
});
app.get("/vr/sankt-poelten/telemetry",requireVrPoeltenAccess,async(req,res)=>{
  const stationIps=await redis.hvals("vr-catalog:station-ips");
  const host=stationIps.map(vrPrivateHost).find(Boolean);
  if(!host) return res.status(503).json({error:"VR_TELEMETRY_STATION_UNAVAILABLE"});
  const query=new URLSearchParams();
  if(typeof req.query.modules==="string"&&req.query.modules.length<=500) query.set("modules",req.query.modules);
  const target=`http://${host}:22031/discovery/telemetry${query.size?`?${query}`:""}`;
  const upstream=http.get(target,{agent:vrSocksAgent,timeout:30_000,headers:{accept:req.get("accept")||"application/json"}},response=>{
    res.status(response.statusCode||502);
    for(const name of ["content-type","content-length","cache-control"]) {
      const value=response.headers[name]; if(value) res.set(name,String(value));
    }
    response.pipe(res);
  });
  upstream.once("timeout",()=>upstream.destroy(new Error("timeout")));
  upstream.once("error",()=>{if(!res.headersSent)res.status(502).json({error:"VR_TELEMETRY_UNAVAILABLE"});else res.end();});
});
app.all("/vr/sankt-poelten/station/:host/session/:action",requireVrPoeltenAccess,express.raw({type:()=>true,limit:"1mb"}),async(req,res)=>{
  const requestQuery=new URL(req.originalUrl,"http://local").searchParams;
  let host=vrPrivateHost(req.params.host);
  if(!host) {
    const stationId=String(requestQuery.get("ms")||requestQuery.get("m")||"").split(",").find(Boolean);
    if(stationId) host=vrPrivateHost(await redis.hget("vr-catalog:station-ips",stationId));
    if(!host&&requestQuery.get("sid")) host=vrPrivateHost(await redis.hget("vr-session-hosts",requestQuery.get("sid")));
  }
  if(!host||!["create","terminate","join","leave","joinsession","changepaidtime"].includes(req.params.action)) return res.status(400).json({error:"INVALID_VR_STATION_ACTION"});
  const stationPort=vrPoelten.deviceUrl.port||"6101";
  const target=new URL(`${vrPoelten.deviceUrl.protocol}//${host}:${stationPort}/session/${req.params.action}${new URL(req.originalUrl,"http://local").search}`);
  const headers={accept:req.get("accept")||"application/json"};
  for(const name of ["content-type","vrp_authorization","vrp_user","vrp_session"]) {
    const value=req.get(name)||req.get(name.replaceAll("_","-")); if(value) headers[name]=value;
  }
  const upstream=http.request(target,{method:req.method,headers,agent:vrSocksAgent,timeout:20_000},response=>{
    const chunks=[]; response.on("data",chunk=>chunks.push(chunk)); response.on("end",async()=>{
      const bytes=Buffer.concat(chunks);
      if(response.headers["content-type"]) res.set("content-type",String(response.headers["content-type"]));
      if((response.statusCode||0)>=200&&(response.statusCode||0)<300) {
        try {
          const value=JSON.parse(bytes.toString("utf8"));
          await trackVrSession(req,`session/${req.params.action}`,value,true);
          if(req.params.action==="create") {
            const created=value?.response??value?.data??value;
            const externalId=String(created?.id??created?.sid??created??"");
            if(externalId&&host) await redis.hset("vr-session-hosts",externalId,host);
          }
        } catch(error) { console.warn("VR station event capture failed",error.message); }
      }
      res.status(response.statusCode||502).send(bytes);
    });
  });
  upstream.once("timeout",()=>upstream.destroy(new Error("timeout")));
  upstream.once("error",()=>{if(!res.headersSent)res.status(502).json({error:"VR_STATION_UNAVAILABLE"});});
  if(req.body?.length) upstream.write(req.body);
  upstream.end();
});
app.get("/vr/sankt-poelten/panel/content/79/dist/*",requireVrPoeltenAccess,(req,res)=>{
  const asset=req.params[0]||"";
  if(!asset||asset.includes("..")||asset.includes("\\")) return res.status(400).json({error:"INVALID_VR_PATH"});
  const query=new URL(req.originalUrl,"http://local").search;
  res.redirect(307,`/api/vr/sankt-poelten/proxy/content/79/dist/${asset}${query}`);
});
app.all("/vr/sankt-poelten/proxy/*",rateLimit({windowMs:60_000,limit:900,standardHeaders:true,legacyHeaders:false}),requireVrPoeltenAccess,express.raw({type:()=>true,limit:"20mb"}),async(req,res)=>{
  const path=req.params[0]||"";
  if(!path||path.includes("..")||path.includes("\\")) return res.status(400).json({error:"INVALID_VR_PATH"});
  const target=new URL(path+new URL(req.originalUrl,"http://local").search,vrPoelten.deviceUrl.href.replace(/\/?$/,"/"));
  const headers={};
  for(const name of ["accept","content-type","vrp_authorization","vrp_user","vrp_session"]) {
    const value=req.get(name)||req.get(name.replaceAll("_","-")); if(value) headers[name]=value;
  }
  if(headers.vrp_authorization&&headers.vrp_user&&headers.vrp_session) {
    await redis.set("vr-monitor:headers",JSON.stringify({accept:"application/json",vrp_authorization:headers.vrp_authorization,vrp_user:headers.vrp_user,vrp_session:headers.vrp_session}));
  }
  let body;
  if(!["GET","HEAD"].includes(req.method)&&req.body!==undefined) body=Buffer.isBuffer(req.body)?req.body:JSON.stringify(req.body);
  try {
    const response=await fetch(target,{method:req.method,headers,body,redirect:"manual",signal:AbortSignal.timeout(30_000)});
    let responseBytes=Buffer.from(await response.arrayBuffer());
    if(path==="content/79/dist/bundle.js"&&response.ok) {
      responseBytes=Buffer.from(responseBytes.toString("utf8")
        .replaceAll('REACT_APP_API_PROTOCOL:"http"','REACT_APP_API_PROTOCOL:"https"')
        .replaceAll('REACT_APP_API_HOST:"localhost"','REACT_APP_API_HOST:location.hostname')
        .replaceAll('REACT_APP_API_PORT:"6101"','REACT_APP_API_PORT:"443"')
        .replaceAll(".vrp_authorization",'["vrp-authorization"]')
        .replaceAll(".vrp_session",'["vrp-session"]')
        .replaceAll(".vrp_user",'["vrp-user"]')
        .replace('ri=function(e,t){t=t||{};var n=Object(be.isUndefined)(t.path)?ni:t.path,r=', 'ri=function(e,t){t=t||{};var n=Object(be.isUndefined)(t.path)?ni:t.path;/^192\\.168\\.31\\.\\d+$/.test(t.host||"")&&0===n.indexOf("webadmin/v1/")&&(n="api/vr/sankt-poelten/proxy/"+n);(0===n.indexOf("api/vr/sankt-poelten/")||/^192\\.168\\.31\\.\\d+$/.test(t.host||""))&&(t=Object.assign({},t,{api:location.hostname,host:location.hostname,protocol:"https",port:"443"}));var r=')
        .replace('yD={port:"22031",path:"discovery/telemetry"}', 'yD={protocol:"https",host:location.hostname,port:"443",path:"api/vr/sankt-poelten/telemetry"}')
        .replace('var QH={port:"1717",path:"catcher/v1/"}','var QH={port:"443",path:"api/vr/sankt-poelten/screen/"}')
        .replace('host:null==e?void 0:e.ip,queryParams:{w:', 'host:location.hostname,queryParams:{host:null==e?void 0:e.ip,w:')
        .replace('path:"arvi/vrp2/websockettools/vnc",port:"22035"','path:"api/vr/sankt-poelten/vnc",port:"443"')
        .replace('o.host=e.data.ip', '(o.path=KB.path+"?stationHost="+encodeURIComponent(e.data.ip),o.host=location.hostname)')
        .replace('ri(e,Object.assign({path:"webadmin/v1/gamecommand"},t||{}))', 'ri(e,Object.assign({},t||{},{protocol:"https",host:location.hostname,port:"443",path:"api/vr/sankt-poelten/proxy/webadmin/v1/gamecommand"}))')
        .replace('Nk=function(e,t,n){return!La&&ai(void 0,Ck(Ck({action:e},n||xk),null==t?void 0:t.queryParams))||ri(e,Object.assign({path:"session/"},t||{}))}', 'Nk=function(e,t,n){return!La&&ai(void 0,Ck(Ck({action:e},n||xk),null==t?void 0:t.queryParams))||ri(e,Object.assign({},t||{},{protocol:"https",host:location.hostname,port:"443",path:"api/vr/sankt-poelten/station/"+encodeURIComponent((null==t?void 0:t.host)||"auto")+"/session/"}))}'));
    }
    if(req.method==="GET"&&response.headers.get("content-type")?.includes("application/json")&&/^(webadmin\/v1\/(games|instances|sessions)|webadmin\/v1\/(?:meta)?session\/(create|terminate))$/.test(path)&&response.ok) {
      try { await trackVrSession(req,path,JSON.parse(responseBytes.toString("utf8")),true); } catch(error) { console.warn("VR session log capture failed",error.message); }
    }
    for(const name of ["content-type","cache-control","last-modified","etag"]) {
      const value=response.headers.get(name); if(value) res.set(name,value);
    }
    if(path==="content/79/dist/bundle.js") res.set("cache-control","no-store");
    res.status(response.status).send(responseBytes);
  } catch {
    res.status(502).json({error:"VR_DEVICE_UNAVAILABLE"});
  }
});

app.post("/local-sites/:id/tunnel", auth, permit("local_sites:open"), async (req, res) => {
  const { rows } = await db.query("SELECT * FROM local_sites WHERE id=$1 AND enabled=true", [req.params.id]);
  const site = rows[0]; if (!site) return res.status(404).json({ error:"LOCAL_SITE_NOT_FOUND" });
  const path = z.object({ path:z.string().regex(/^\/(?!\/)/).default("/") }).parse(req.body).path;
  const ticket = crypto.randomBytes(32).toString("base64url");
  await redis.setex(`tunnel:${ticket}`, 60, JSON.stringify({ userId:req.user.sub, siteId:site.id, agentId:site.agent_id, path }));
  await audit(req,"local_site.tunnel.create","local_site",site.id,null,{ path });
  res.json({ url:`/api/tunnel/${ticket}`, expiresIn:60 });
});
app.get("/tunnel/:ticket", auth, permit("local_sites:open"), async (req,res) => {
  const raw=await redis.getdel(`tunnel:${req.params.ticket}`);
  if(!raw) return res.status(410).json({error:"TUNNEL_TICKET_EXPIRED"});
  const ticket=JSON.parse(raw);
  if(ticket.userId!==req.user.sub) return res.status(403).json({error:"TUNNEL_TICKET_OWNER_MISMATCH"});
  io.of("/agent").to(`agent:${ticket.agentId}`).timeout(8000).emit("proxy",{siteId:ticket.siteId,path:ticket.path},(err,responses)=>{
    const result=responses?.[0];
    if(err||!result?.success) return res.status(502).json({error:result?.error||"AGENT_TIMEOUT"});
    for(const [name,value] of Object.entries(result.headers||{})) if(["content-type","cache-control"].includes(name.toLowerCase())) res.set(name,value);
    res.status(result.status||200).send(Buffer.from(result.body,"base64"));
  });
});

app.get("/cameras/:id/stream", auth, permit("cameras:read"), async (req,res) => {
  const { rows } = await db.query("SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1", [req.params.id]);
  const camera=rows[0]; if(!camera) return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if (!(await cameraAllowed(req,camera.id))) return res.status(403).json({ error:"CAMERA_FORBIDDEN" });
  if(camera.provider==="TUYA") {
    if(!tuya.configured) return res.status(503).json({error:"TUYA_NOT_CONFIGURED"});
    if(!camera.external_id) return res.status(409).json({error:"TUYA_DEVICE_NOT_CONFIGURED"});
    // HLS is an explicit compatibility transport only. Returning it after a failed
    // WebRTC capability check concealed broken signaling from operators.
    if(req.query.transport!=="hls") {
      try {
        const config=await tuya.webrtcConfigs(camera.external_id);
        if(!config?.supports_webrtc) return res.status(409).json({error:"TUYA_WEBRTC_UNSUPPORTED"});
        await audit(req,"camera.stream.open","camera",camera.id,null,{provider:"TUYA",transport:"WEBRTC"});
        return res.json({provider:"TUYA",mode:"webrtc",cameraId:camera.id});
      } catch(error) {
        console.error(req.requestId,"Tuya WebRTC discovery failed",error.code,error.message);
        return res.status(502).json({error:"TUYA_WEBRTC_UNAVAILABLE",providerCode:error.code});
      }
    }
    try {
      const endpoint=await tuya.allocateHls(camera.external_id);
      await audit(req,"camera.stream.open","camera",camera.id,null,{provider:"TUYA",transport:"HLS"});
      return res.json({provider:"TUYA",mode:"hls",endpoint});
    } catch(error) {
      console.error(req.requestId,"Tuya stream allocation failed",error.code,error.message);
      return res.status(502).json({error:"TUYA_STREAM_UNAVAILABLE",providerCode:error.code});
    }
  }
  if(!camera.stream_key) return res.status(409).json({error:"CAMERA_STREAM_NOT_CONFIGURED"});
  // The browser iframe cannot forward the application's Authorization header.
  // Give it a stream-specific, short-lived bearer that the nginx gateway checks
  // before it serves the player page or upgrades the media WebSocket.
  const ticket=crypto.randomBytes(32).toString("base64url");
  await redis.setex(`camera-stream:${ticket}`,15*60,JSON.stringify({cameraId:camera.id,streamKey:camera.stream_key,userId:req.user.sub}));
  const endpoint=`/go2rtc/stream.html?src=${encodeURIComponent(camera.stream_key)}&mode=webrtc,mse&ticket=${ticket}`;
  await audit(req,"camera.stream.open","camera",camera.id,null,{provider:camera.provider});
  res.json({provider:camera.provider,mode:"player",endpoint});
});

// nginx calls this as an auth_request subrequest for the go2rtc player and
// WebSocket. It is deliberately ticket-only: iframe requests cannot carry the
// single-page app's bearer header. Tickets are random, scoped to one stream,
// and expire after fifteen minutes.
app.get("/camera-stream/authorize", async (req,res) => {
  // auth_request invokes an internal nginx location. It forwards the original
  // player/WebSocket URI in this header because subrequest query strings are
  // not retained by nginx.
  const originalUri=typeof req.get("x-original-uri")==="string"?req.get("x-original-uri"):"";
  const originalParams=originalUri ? new URL(originalUri,"http://gateway").searchParams : null;
  const ticket=typeof req.query.ticket==="string"?req.query.ticket:(originalParams?.get("ticket")||"");
  const streamKey=typeof req.query.src==="string"?req.query.src:(originalParams?.get("src")||"");
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(ticket)||!streamKey) return res.status(401).end();
  const raw=await redis.get(`camera-stream:${ticket}`);
  if(!raw) return res.status(401).end();
  try {
    const grant=JSON.parse(raw);
    if(grant.streamKey!==streamKey) return res.status(403).end();
    res.status(204).end();
  } catch { res.status(401).end(); }
});

const cameraControlInput=z.discriminatedUnion("action",[
  z.object({action:z.literal("ptz"),direction:z.enum(["UP","RIGHT","DOWN","LEFT","STOP"])}),
  z.object({action:z.literal("nightVision"),mode:z.enum(["auto","on","off"])})
]);

app.post("/cameras/:id/control",auth,permit("devices:command"),async(req,res)=>{
  const input=cameraControlInput.parse(req.body);
  const camera=(await db.query(`
    SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id
    FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1
  `,[req.params.id])).rows[0];
  if(!camera)return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if(!(await cameraAllowed(req,camera.id)))return res.status(403).json({error:"CAMERA_FORBIDDEN"});
  const bridgeAccount=tuyaBridgeAccounts.find(account=>account.id===camera.config?.bridgeAccount);
  const isLanBridgeCamera=camera.provider==="RTSP"&&camera.config?.source==="TUYA_LAN_BRIDGE"&&bridgeAccount;
  if(camera.provider!=="TUYA"&&!isLanBridgeCamera)return res.status(409).json({error:"CAMERA_CONTROL_NOT_SUPPORTED"});
  try{
    if(isLanBridgeCamera) {
      if(input.action!=="ptz") return res.status(409).json({error:"CAMERA_CONTROL_NOT_SUPPORTED"});
      const deviceId=String(camera.config?.bridgeDeviceId||"");
      if(!deviceId) return res.status(409).json({error:"CAMERA_CONTROL_NOT_CONFIGURED"});
      const response=await fetch(new URL("/api/ptz/move",bridgeAccount.apiUrl),{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({deviceId,direction:input.direction.toLowerCase()}),signal:AbortSignal.timeout(8_000)
      });
      if(!response.ok) {
        const detail=await response.json().catch(()=>null);
        // Preserve the bridge diagnostic: it distinguishes a missing LAN route
        // from a Smart Life cloud session that has not been enabled yet.
        throw new Error(detail?.error||`Tuya bridge PTZ returned HTTP ${response.status}`);
      }
      cameraVisionController.recordManualPtz(camera.id);
      await audit(req,"camera.control","camera",camera.id,null,{...input,transport:"TUYA_LAN_BRIDGE"});
      return res.json({ok:true,...input,transport:"TUYA_LAN_BRIDGE"});
    }
    if(!camera.external_id)return res.status(409).json({error:"TUYA_DEVICE_NOT_CONFIGURED"});
    if(!tuya.configured)return res.status(503).json({error:"TUYA_NOT_CONFIGURED"});
    if(input.action==="ptz") {
      cameraVisionController.recordManualPtz(camera.id);
      await tuya.ptz(camera.external_id,input.direction);
    } else {
      const value={auto:"0",off:"1",on:"2"}[input.mode];
      await tuya.sendCommands(camera.external_id,[{code:"basic_nightvision",value}]);
    }
    await audit(req,"camera.control","camera",camera.id,null,input);
    res.json({ok:true,...input});
  }catch(error){
    console.warn(req.requestId,"Tuya camera control failed",camera.external_id,error.code,error.message);
    res.status(502).json({error:"TUYA_CAMERA_CONTROL_FAILED",providerCode:error.code,message:error.message});
  }
});

app.post("/cameras/:id/ai/frame", auth, permit("cameras:read"), async (req, res) => {
  const camera = (await db.query("SELECT id, room_id, ai_enabled, tracking_enabled FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, camera.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });

  let imageBuffer = null;
  if (req.body?.image) {
    const raw = String(req.body.image).includes(",") ? req.body.image.split(",")[1] : req.body.image;
    imageBuffer = Buffer.from(raw, "base64");
  } else if (Buffer.isBuffer(req.body)) {
    imageBuffer = req.body;
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    return res.status(400).json({ error: "MISSING_FRAME" });
  }

  cameraFrameProvider.pushFrame(camera.id, imageBuffer, req.body?.mimeType || "image/jpeg");

  if (camera.ai_enabled === false) {
    return res.json({ ok: true, aiEnabled: false, state: cameraEventEngine.getState(camera.id) });
  }

  const detection = await localVisionService.detect({
    cameraId: camera.id,
    imageBuffer,
    conf: Number(req.body?.conf || 0.25),
  });

  const state = await cameraEventEngine.processDetection({
    cameraId: camera.id,
    roomId: camera.room_id,
    detectionResult: detection,
  });

  res.json({ ok: true, state, peopleCount: detection.peopleCount, people: detection.people });
});

app.get("/cameras/:id/ai/state", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const state = cameraEventEngine.getState(req.params.id);
  res.json(state);
});

app.get("/cameras/ai/states", auth, permit("cameras:read"), async (_req, res) => {
  res.json(cameraEventEngine.getAllStates());
});

app.get("/cameras/:id/ai/events", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const events = await cameraEventEngine.getRecentEvents({ cameraId: req.params.id, limit });
  res.json(events);
});

app.get("/cameras/:id/ai/clip", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const count = Math.min(Math.max(Number(req.query.count || 10), 1), 20);
  const clipBuffer = await localVisionService.getRecentClip(req.params.id, count);
  if (!clipBuffer) return res.status(404).json({ error: "NO_CLIP_AVAILABLE" });
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-cache, no-store");
  res.send(clipBuffer);
});

app.get("/cameras/:id/ai/snapshot", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const frame = cameraFrameProvider.getLatestFrame(req.params.id) ||
    await localVisionService.getLatestFrame(req.params.id);
  if (!frame?.buffer) return res.status(404).json({ error: "NO_FRAME_AVAILABLE" });
  res.set("Content-Type", frame.mimeType || "image/jpeg");
  res.set("Cache-Control", "no-cache, no-store");
  res.send(frame.buffer);
});

app.get("/rooms/:id/ai/events", auth, permit("cameras:read"), async (req, res) => {
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
  const events = await cameraEventEngine.getRecentEvents({ roomId: req.params.id, limit });
  res.json(events);
});

app.post("/cameras/:id/ai/analyze", auth, permit("cameras:read"), async (req, res) => {
  const camera = (await db.query("SELECT id, room_id, analysis_enabled FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, camera.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  if (camera.analysis_enabled === false) {
    return res.status(409).json({ error: "AI_ANALYSIS_DISABLED", description: "Анализ отключен в настройках этой камеры" });
  }

  const question = String(req.body?.question || "Determine what happened during these frames.").slice(0, 300);
  const frames = cameraFrameProvider.getFrames(camera.id, 10, 4);
  const state = cameraEventEngine.getState(camera.id);

  const result = await localVisionService.analyze({
    cameraId: camera.id,
    frames,
    question,
    manual: true,
    yoloContext: state,
  });

  await audit(req, "camera.ai.analyze", "camera", camera.id, null, { question, result });
  res.json(result);
});

app.post("/rooms/:id/ai/inspect", auth, permit("devices:command"), async (req, res) => {
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  const report = await cameraVisionController.inspectRoom(req.params.id);
  await audit(req, "room.ai.inspect", "room", req.params.id, null, report);
  res.json(report);
});

app.post("/rooms/:id/ai/query", auth, permit("cameras:read"), async (req, res) => {
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  const question = z.string().min(1).max(300).parse(req.body?.question);
  const canControlPtz = isOwner(req) || (req.user?.permissions || []).some(p => p === "*" || p === "devices:command");
  const response = await cameraAIAgent.answerQuestion({ roomId: req.params.id, question, canControlPtz });
  res.json(response);
});

app.get("/rooms/:id/headset/state", auth, permit("cameras:read"), async (req, res) => {
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  const roomState = await headsetTrackingEngine.getRoomHeadsetState(req.params.id);
  res.json(roomState);
});

app.post("/rooms/:id/headset/inspect", auth, permit("devices:command"), async (req, res) => {
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  try {
    const report = await headsetTrackingEngine.inspectRoomHeadsets(req.params.id, {
      cameraVisionController,
      visionService: localVisionService,
      frameProvider: cameraFrameProvider,
    });
    await audit(req, "room.headset.inspect", "room", req.params.id, null, report);
    res.json(report);
  } catch (err) {
    if (err.code === "MANUAL_PTZ_ACTIVE") {
      return res.status(423).json({ error: "MANUAL_PTZ_ACTIVE", message: err.message });
    }
    throw err;
  }
});

app.patch("/rooms/:id/headset/settings", auth, permit("devices:command"), async (req, res) => {
  const input = z.object({
    expectedHeadsetCount: z.number().int().min(0).max(100).nullable().optional(),
  }).parse(req.body);

  const room = (await db.query("SELECT * FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  const count = input.expectedHeadsetCount !== undefined ? input.expectedHeadsetCount : room.expected_headset_count;
  const { rows } = await db.query(
    "UPDATE rooms SET expected_headset_count=$1 WHERE id=$2 RETURNING *",
    [count, req.params.id]
  );
  headsetTrackingEngine.setRoomExpectedHeadsets(req.params.id, count);
  await audit(req, "room.headset_settings.update", "rooms", req.params.id, null, rows[0]);
  res.json(rows[0]);
});

// AI Dataset & Model CRM Lifecycle Routes
app.get("/api/ai/dataset/status", auth, permit("cameras:read"), async (_req, res) => {
  const status = await localVisionService.getPipelineStatus();
  res.json(status);
});

// Dataset capture must distinguish a live worker frame from a camera that is
// merely online in Tuya but currently returning its loading placeholder.
// Filter every worker entry through camera RBAC so this diagnostic cannot
// reveal another location's camera IDs or state.
app.get("/api/ai/dataset/camera-status", auth, permit("cameras:read"), async (req, res) => {
  const workers = await localVisionService.getWorkerStatus();
  const visible = {};
  for (const [cameraId, worker] of Object.entries(workers || {})) {
    if (await cameraAllowed(req, cameraId)) visible[cameraId] = worker;
  }
  res.json({ cameras: visible });
});

app.post("/api/ai/dataset/sessions/start", auth, permit("devices:command"), async (req, res) => {
  const input = z.object({
    roomId: z.string().min(1),
    cameraId: z.string().min(1),
    notes: z.string().optional().default(""),
    autoCaptureEnabled: z.boolean().optional().default(false),
    captureIntervalSec: z.number().int().min(3).max(3600).optional().default(12),
  }).parse(req.body);

  const camera = (await db.query("SELECT * FROM cameras WHERE id=$1", [input.cameraId])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [input.roomId])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });

  if (camera.room_id !== input.roomId) {
    return res.status(400).json({ error: "CAMERA_ROOM_MISMATCH", message: "Camera does not belong to specified room" });
  }
  if (!(await cameraAllowed(req, input.cameraId))) {
    return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  }
  if (!(await locationAllowed(req, room.location_id))) {
    return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  }

  const client = await db.connect();
  let session = null;
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE ai_capture_sessions SET status='CLOSED', closed_at=now() WHERE room_id=$1 AND camera_id=$2 AND status='ACTIVE'",
      [input.roomId, input.cameraId]
    );
    const { rows } = await client.query(
      `INSERT INTO ai_capture_sessions
       (room_id, camera_id, status, notes, created_by, auto_capture_enabled, capture_interval_sec)
       VALUES ($1, $2, 'ACTIVE', $3, $4, $5, $6) RETURNING *`,
      [input.roomId, input.cameraId, input.notes, req.user?.sub || null, input.autoCaptureEnabled, input.captureIntervalSec]
    );
    session = rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await audit(req, "ai.dataset.session_start", "ai_capture_session", session.id, null, session);
  void syncAiWorkersSafe();
  res.status(201).json(session);
});

app.post("/api/ai/dataset/sessions/:id/stop", auth, permit("devices:command"), async (req, res) => {
  const sess = (await db.query(
    "SELECT s.*, r.location_id FROM ai_capture_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.id=$1",
    [req.params.id]
  )).rows[0];
  if (!sess) return res.status(404).json({ error: "SESSION_NOT_FOUND" });

  if (!(await cameraAllowed(req, sess.camera_id))) {
    return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  }
  if (!(await locationAllowed(req, sess.location_id))) {
    return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  }

  const { rows } = await db.query(
    "UPDATE ai_capture_sessions SET status='CLOSED', closed_at=now() WHERE id=$1 RETURNING *",
    [req.params.id]
  );
  const updated = rows[0];
  await audit(req, "ai.dataset.session_stop", "ai_capture_session", req.params.id, sess, updated);
  void syncAiWorkersSafe();
  res.json(updated);
});

app.get("/api/ai/dataset/sessions/active", auth, permit("cameras:read"), async (req, res) => {
  const { rows } = await db.query(
    "SELECT s.*, r.name as room_name, c.name as camera_name, r.location_id FROM ai_capture_sessions s JOIN rooms r ON r.id=s.room_id JOIN cameras c ON c.id=s.camera_id WHERE s.status='ACTIVE' ORDER BY s.created_at DESC"
  );
  const filtered = [];
  for (const row of rows) {
    if ((await cameraAllowed(req, row.camera_id)) && (await locationAllowed(req, row.location_id))) {
      filtered.push(row);
    }
  }
  res.json({ sessions: filtered });
});

app.get("/api/ai/dataset/queue", auth, permit("cameras:read"), async (req, res) => {
  const statusFilter = String(req.query.status || "all");
  const result = await localVisionService.getVerificationQueue(statusFilter);
  const items = Array.isArray(result.items) ? result.items : [];
  const filtered = [];
  for (const item of items) {
    if (!item.cameraId || !item.roomId) {
      if (isOwner(req)) filtered.push(item);
      continue;
    }
    const camera = (await db.query("SELECT id, room_id FROM cameras WHERE id=$1", [item.cameraId])).rows[0];
    const room = (await db.query("SELECT id, location_id FROM rooms WHERE id=$1", [item.roomId])).rows[0];
    if (!camera || !room || camera.room_id !== item.roomId) {
      if (isOwner(req)) filtered.push(item);
      continue;
    }
    if (!(await cameraAllowed(req, item.cameraId))) {
      continue;
    }
    if (!(await locationAllowed(req, room.location_id))) {
      continue;
    }
    filtered.push(item);
  }
  res.json({ items: filtered, count: filtered.length });
});

app.get("/api/ai/dataset/samples/:id/recovery", auth, async (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({ error: "OWNER_REQUIRED", message: "Only owners may access the sample recovery route" });
  }
  const meta = await localVisionService.getSampleMetadata(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: "SAMPLE_NOT_FOUND" });
  }
  const imgBuffer = await localVisionService.getSampleImage(req.params.id);
  res.json({
    sampleId: req.params.id,
    metadata: meta,
    hasImage: Boolean(imgBuffer && imgBuffer.length > 0),
  });
});

app.get("/api/ai/dataset/samples/:id/image", auth, permit("cameras:read"), async (req, res) => {
  const meta = await localVisionService.getSampleMetadata(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: "SAMPLE_NOT_FOUND" });
  }
  if (!meta.cameraId || !meta.roomId) {
    return res.status(403).json({ error: "SAMPLE_SCOPING_FAILED", message: "Sample is missing camera or room scoping" });
  }
  const camera = (await db.query("SELECT id, room_id FROM cameras WHERE id=$1", [meta.cameraId])).rows[0];
  const room = (await db.query("SELECT id, location_id FROM rooms WHERE id=$1", [meta.roomId])).rows[0];
  if (!camera || !room) {
    return res.status(403).json({ error: "SAMPLE_SCOPING_FAILED", message: "Sample camera or room could not be resolved" });
  }
  if (camera.room_id !== meta.roomId) {
    return res.status(403).json({ error: "CAMERA_ROOM_MISMATCH", message: "Camera does not belong to specified room" });
  }
  if (!(await cameraAllowed(req, meta.cameraId))) {
    return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  }
  if (!(await locationAllowed(req, room.location_id))) {
    return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  }
  const imgBuffer = await localVisionService.getSampleImage(req.params.id);
  if (!imgBuffer) {
    return res.status(404).json({ error: "SAMPLE_IMAGE_NOT_FOUND" });
  }
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "no-cache, no-store");
  res.send(imgBuffer);
});

app.post("/api/ai/dataset/capture", auth, permit("devices:command"), async (req, res) => {
  const input = z.object({
    cameraId: z.string().min(1),
    roomId: z.string().min(1),
    preset: z.string().optional().default("default"),
    captureSessionId: z.string().optional().nullable(),
  }).parse(req.body);

  const camera = (await db.query("SELECT * FROM cameras WHERE id=$1", [input.cameraId])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [input.roomId])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });

  // Camera-room membership validation
  if (camera.room_id !== input.roomId) {
    return res.status(400).json({ error: "CAMERA_ROOM_MISMATCH", message: "Camera does not belong to specified room" });
  }

  // Location and camera permissions
  if (!(await cameraAllowed(req, input.cameraId))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  // Server session validation / binding
  let resolvedSessionId = null;
  if (input.captureSessionId) {
    const sessRow = (await db.query(
      "SELECT id, room_id, camera_id, status FROM ai_capture_sessions WHERE id=$1",
      [input.captureSessionId]
    )).rows[0];
    if (!sessRow || sessRow.status !== "ACTIVE") {
      return res.status(400).json({ error: "SESSION_INVALID", message: "Capture session is not active or not found" });
    }
    if (sessRow.room_id !== input.roomId || sessRow.camera_id !== input.cameraId) {
      return res.status(400).json({ error: "SESSION_MISMATCH", message: "Capture session room or camera mismatch" });
    }
    resolvedSessionId = sessRow.id;
  } else {
    const activeRow = (await db.query(
      "SELECT id FROM ai_capture_sessions WHERE room_id=$1 AND camera_id=$2 AND status='ACTIVE' ORDER BY created_at DESC LIMIT 1",
      [input.roomId, input.cameraId]
    )).rows[0];
    if (!activeRow) {
      return res.status(400).json({
        error: "NO_ACTIVE_SESSION",
        message: "No active capture session exists for this camera and room. Start a capture session before capturing.",
      });
    }
    resolvedSessionId = activeRow.id;
  }

  // Unified PTZ navigation and settling
  let settledAt = Date.now();
  if (input.preset && input.preset !== "default" && cameraVisionController) {
    try {
      const moveRes = await cameraVisionController.moveToPresetAndSettle(input.cameraId, input.preset);
      settledAt = moveRes.settledAt;
    } catch (err) {
      return res.status(502).json({
        error: "PRESET_UNAVAILABLE",
        message: `PTZ preset navigation failed: ${err?.message || err}`,
      });
    }
  }

  // Fresh frame cutoff polling: timestamp > settledAt. The API has a small
  // local cache and the AI worker owns the continuous stream buffer. A stale
  // item in the former must never prevent us from checking the latter.
  let frameObj = null;
  const maxPollMs = 8000;
  const pollStart = Date.now();
  const frameTime = (frame) => {
    if (!frame?.timestamp) return NaN;
    if (typeof frame.timestamp === "number") {
      // Worker timestamps are seconds since epoch, API timestamps are millis.
      return frame.timestamp < 100_000_000_000 ? frame.timestamp * 1000 : frame.timestamp;
    }
    return new Date(frame.timestamp).getTime();
  };

  while (Date.now() - pollStart <= maxPollMs) {
    let cachedCandidate = null;
    if (cameraFrameProvider) {
      cachedCandidate = cameraFrameProvider.getLatestFrame(input.cameraId);
    }
    if (cachedCandidate?.buffer && frameTime(cachedCandidate) > settledAt) {
      frameObj = cachedCandidate;
      break;
    }

    // Always check the worker when the local candidate is stale. Before this
    // fallback existed, one old event frame made manual dataset capture fail
    // even though the worker had already decoded a fresh camera frame.
    if (localVisionService) {
      const workerCandidate = await localVisionService.getLatestFrame(input.cameraId).catch(() => null);
      if (workerCandidate?.buffer && frameTime(workerCandidate) > settledAt) {
        frameObj = workerCandidate;
        if (cameraFrameProvider) {
          cameraFrameProvider.pushFrame(
            input.cameraId,
            workerCandidate.buffer,
            workerCandidate.mimeType || "image/jpeg",
            frameTime(workerCandidate),
          );
        }
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!frameObj?.buffer) {
    return res.status(503).json({
      error: "FRAME_UNAVAILABLE",
      message: "Camera stream did not provide a fresh frame after PTZ settling. Check that the AI worker is online and the camera stream is active.",
    });
  }

  const detection = await localVisionService.detectHeadsets({
    cameraId: input.cameraId,
    imageBuffer: frameObj.buffer,
    conf: 0.35,
  }).catch(() => ({ headsets: [] }));

  const initialBboxes = (detection.headsets || []).map((h) => ({
    classId: 0,
    x: h.bbox.x,
    y: h.bbox.y,
    width: h.bbox.width,
    height: h.bbox.height,
  }));

  const collectRes = await localVisionService.collectPtzFrame({
    cameraId: input.cameraId,
    roomId: input.roomId,
    preset: input.preset,
    imageBuffer: frameObj.buffer,
    timestamp: frameObj.timestamp || new Date().toISOString(),
    captureSessionId: resolvedSessionId,
    initialBboxes,
    autoEnqueue: true,
  });

  await audit(req, "ai.dataset.capture", "camera", input.cameraId, null, collectRes);
  res.json(collectRes);
});

app.post("/api/ai/dataset/samples/:id/verify", auth, permit("devices:command"), async (req, res) => {
  const meta = await localVisionService.getSampleMetadata(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: "SAMPLE_NOT_FOUND" });
  }
  if (!meta.cameraId || !meta.roomId) {
    return res.status(403).json({ error: "SAMPLE_SCOPING_FAILED", message: "Sample is missing camera or room scoping" });
  }
  const camera = (await db.query("SELECT id, room_id FROM cameras WHERE id=$1", [meta.cameraId])).rows[0];
  const room = (await db.query("SELECT id, location_id FROM rooms WHERE id=$1", [meta.roomId])).rows[0];
  if (!camera || !room) {
    return res.status(403).json({ error: "SAMPLE_SCOPING_FAILED", message: "Sample camera or room could not be resolved" });
  }
  if (camera.room_id !== meta.roomId) {
    return res.status(403).json({ error: "CAMERA_ROOM_MISMATCH", message: "Camera does not belong to specified room" });
  }
  if (!(await cameraAllowed(req, meta.cameraId))) {
    return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  }
  if (!(await locationAllowed(req, room.location_id))) {
    return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  }

  const input = z.object({
    approved: z.boolean().default(true),
    correctedBboxes: z.array(z.object({
      classId: z.number().int().default(0),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().gt(0).max(1),
      height: z.number().gt(0).max(1),
    })).optional().nullable(),
    negativeConfirmed: z.boolean().optional().default(false),
    notes: z.string().optional().default(""),
  }).parse(req.body);

  const operatorId = req.user?.username || req.user?.id || "operator";
  const result = await localVisionService.verifySample({
    sampleId: req.params.id,
    operatorId,
    approved: input.approved,
    correctedBboxes: input.correctedBboxes,
    negativeConfirmed: input.negativeConfirmed,
    notes: input.notes,
  });

  await audit(req, "ai.dataset.verify_sample", "ai_sample", req.params.id, null, result);
  res.json(result);
});

app.post("/api/ai/dataset/export", auth, permit("devices:command"), async (req, res) => {
  if (!["OWNER", "ADMIN"].includes(req.user?.role)) {
    return res.status(403).json({ error: "ADMIN_OR_OWNER_REQUIRED" });
  }

  const input = z.object({
    version: z.string().regex(/^v\d+\.\d+\.\d+$/).default("v1.0.0"),
  }).parse(req.body || {});

  try {
    const result = await localVisionService.exportDatasetSplits({ version: input.version });
    await audit(req, "ai.dataset.export", "ai_dataset", input.version, null, result);
    res.json(result);
  } catch (error) {
    // Express 4 does not catch rejected async route handlers.  Without this
    // boundary a normal pipeline validation failure becomes an unhandled
    // rejection, restarts the API container, and leaks to the UI as 502.
    const upstreamStatus = Number(error?.status);
    const isValidationFailure = upstreamStatus >= 400 && upstreamStatus < 500;
    const status = isValidationFailure ? upstreamStatus : 502;
    const message = error?.message || "EXPORT_FAILED";
    console.error(req.requestId, "Dataset export failed:", message);
    res.status(status).json({
      error: error?.code || (isValidationFailure ? "EXPORT_FAILED" : "AI_SERVICE_UNAVAILABLE"),
      message,
      requestId: req.requestId,
    });
  }
});

app.post("/api/ai/model/train", auth, permit("devices:command"), async (req, res) => {
  if (!["OWNER", "ADMIN"].includes(req.user?.role)) {
    return res.status(403).json({ error: "ADMIN_OR_OWNER_REQUIRED" });
  }

  const input = z.object({
    epochs: z.number().int().min(1).max(200).optional().default(10),
    batchSize: z.number().int().min(1).max(64).optional().default(8),
    imgSize: z.number().int().min(160).max(1280).optional().default(640),
  }).parse(req.body || {});

  const operatorId = req.user?.username || req.user?.id || "operator";
  const result = await localVisionService.trainHeadsetModel({
    epochs: input.epochs,
    batchSize: input.batchSize,
    imgSize: input.imgSize,
    operatorId,
  });

  await audit(req, "ai.model.train", "ai_model", "candidate_vr_headset", null, result);
  res.status(202).json(result);
});

app.get("/api/ai/model/job-status", auth, permit("cameras:read"), async (_req, res) => {
  const status = await localVisionService.getPipelineJobStatus();
  res.json(status);
});

app.post("/api/ai/model/activate", auth, permit("devices:command"), async (req, res) => {
  if (!["OWNER", "ADMIN"].includes(req.user?.role)) {
    return res.status(403).json({ error: "ADMIN_OR_OWNER_REQUIRED" });
  }

  const input = z.object({
    version: z.string().optional().default("v1.0.0"),
  }).parse(req.body || {});

  const operatorId = req.user?.username || req.user?.id || "operator";
  const result = await localVisionService.activateCandidateModel({
    version: input.version,
    operatorId,
  });

  await audit(req, "ai.model.activate", "ai_model", "vr_headset_yolo", null, result);
  // The AI service validates and swaps the candidate asynchronously. Preserve
  // that fact at the API boundary so callers cannot mistake job acceptance for
  // a completed activation.
  res.status(result?.status === "STARTED" ? 202 : 200).json(result);
});

app.post("/api/ai/model/rollback", auth, permit("devices:command"), async (req, res) => {
  if (!["OWNER", "ADMIN"].includes(req.user?.role)) {
    return res.status(403).json({ error: "ADMIN_OR_OWNER_REQUIRED" });
  }

  const operatorId = req.user?.username || req.user?.id || "operator";
  const result = await localVisionService.rollbackModel({ operatorId });
  await audit(req, "ai.model.rollback", "ai_model", "vr_headset_yolo", null, result);
  res.json(result);
});

// Internal signaling & stream worker endpoints (for local ai-service)
const requireInternalSecret = (req, res, next) => {
  const secret = req.headers["x-internal-secret"] || req.query?.secret;
  if (!secret || typeof secret !== "string") {
    return res.status(403).json({ error: "FORBIDDEN_INTERNAL_ONLY" });
  }
  const secretBuf = Buffer.from(secret);
  const expectedBuf = Buffer.from(env.INTERNAL_API_SECRET);
  if (secretBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(secretBuf, expectedBuf)) {
    return res.status(403).json({ error: "FORBIDDEN_INTERNAL_ONLY" });
  }
  next();
};

const internalSessions = new Map();

app.get("/internal/cameras", requireInternalSecret, async (_req, res) => {
  const { rows } = await db.query(
    `SELECT c.*, COALESCE(c.location_id, r.location_id) AS location_id,
      capture.id AS capture_session_id,
      COALESCE(capture.auto_capture_enabled, false) AS auto_capture_enabled,
      COALESCE(capture.capture_interval_sec, 12) AS capture_interval_sec,
      COALESCE((
        SELECT jsonb_object_agg(s.action_type, jsonb_build_object('enabled', s.enabled, 'config', s.config))
        FROM activity_settings s WHERE s.room_id = c.room_id
      ), '{}'::jsonb) AS activity_settings
     FROM cameras c
     LEFT JOIN rooms r ON r.id = c.room_id
     LEFT JOIN LATERAL (
       SELECT id, auto_capture_enabled, capture_interval_sec
       FROM ai_capture_sessions
       WHERE camera_id=c.id AND room_id=c.room_id AND status='ACTIVE'
       ORDER BY created_at DESC LIMIT 1
     ) capture ON true
     WHERE c.ai_enabled = true`
  );
  res.json(rows);
});

app.post("/internal/tuya-webrtc/session", requireInternalSecret, async (req, res) => {
  const { cameraId, streamType } = req.body || {};
  const camera = (await db.query("SELECT * FROM cameras WHERE id=$1", [cameraId])).rows[0];
  if (!camera || camera.provider !== "TUYA" || !camera.external_id) {
    return res.status(404).json({ error: "TUYA_CAMERA_NOT_FOUND" });
  }
  try {
    const dummySocket = new EventEmitter();
    dummySocket.id = `internal-${crypto.randomUUID()}`;
    dummySocket.connected = true;

    const pendingSignals = [];
    dummySocket.on("signal", (sig) => {
      pendingSignals.push(sig);
      if (sig?.type === "disconnect") internalSessions.delete(sig.sessionId);
    });

    const result = await tuyaWebRTC.startSession({
      deviceId: camera.external_id,
      socket: dummySocket,
      streamType: Number.isInteger(Number(streamType)) && Number(streamType) > 0 ? Number(streamType) : 1,
      purpose: "ai",
    });
    internalSessions.set(result.sessionId, { dummySocket, deviceId: camera.external_id, pendingSignals });
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.code || "SESSION_FAILED" });
  }
});

app.post("/internal/tuya-webrtc/signal", requireInternalSecret, async (req, res) => {
  const { sessionId, type, payload, waitForAnswer = true } = req.body || {};
  const sess = internalSessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: "SESSION_NOT_FOUND" });

  try {
    let answerPromise = null;
    if (type === "offer" && waitForAnswer !== false) {
      answerPromise = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error("Tuya answer timeout")), 10000);
        const existingAns = sess.pendingSignals.find((s) => s.type === "answer");
        if (existingAns) {
          clearTimeout(to);
          return resolve(existingAns.payload);
        }
        sess.dummySocket.on("signal", function onSig(sig) {
          if (sig?.type === "answer") {
            clearTimeout(to);
            sess.dummySocket.off("signal", onSig);
            resolve(sig.payload);
          }
        });
      });
    }

    await tuyaWebRTC.signal({ sessionId, socket: sess.dummySocket, type, payload: payload || "" });
    if (type === "disconnect") internalSessions.delete(sessionId);
    // A real browser signals the offer, then immediately trickles its ICE
    // candidates while the camera is preparing the answer. The AI worker needs
    // that same sequence. Keep the old wait-by-default behaviour for callers
    // that rely on it, but let the worker collect the answer via /signals.
    if (type === "offer" && waitForAnswer === false) {
      return res.json({ ok: true, pending: true });
    }
    if (answerPromise) {
      const answer = await answerPromise;
      const initialCandidates = sess.pendingSignals
        .filter((s) => s.type === "candidate")
        .map((s) => s.payload);
      return res.json({ ok: true, answer, candidates: initialCandidates });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/internal/tuya-webrtc/signals", requireInternalSecret, (req, res) => {
  const { sessionId } = req.query || {};
  const sess = internalSessions.get(String(sessionId));
  if (!sess) return res.status(404).json({ error: "SESSION_NOT_FOUND" });
  const signals = sess.pendingSignals.splice(0, sess.pendingSignals.length);
  res.json({ ok: true, signals });
});

// ==========================================
// Activity Intelligence & Behavioral Detection Endpoints
// ==========================================

app.get("/api/activity/state", auth, permit("cameras:read"), async (req, res) => {
  const roomId = req.query.roomId;
  const cameraId = req.query.cameraId;
  if (!roomId && !cameraId) {
    return res.status(400).json({ error: "ROOM_OR_CAMERA_REQUIRED" });
  }
  if (roomId) {
    const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [roomId])).rows[0];
    if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
    if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
    const state = activityIntelligenceEngine.getRoomState(roomId);
    if (state) return res.json(state);
    const health = await activityIntelligenceEngine.getHealth();
    return res.json({
      roomId,
      status: health.poseEstimatorStatus || health.status || "NOT_OBSERVED",
      observationStatus: "NOT_OBSERVED",
      activeEvents: [],
      peopleCount: 0,
      health,
    });
  }
  if (cameraId) {
    if (!(await cameraAllowed(req, cameraId))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
    const state = activityIntelligenceEngine.getCameraState(cameraId);
    if (state) return res.json(state);
    const health = await activityIntelligenceEngine.getHealth();
    return res.json({
      cameraId,
      status: health.poseEstimatorStatus || health.status || "NOT_OBSERVED",
      observationStatus: "NOT_OBSERVED",
      activeEvents: [],
      peopleCount: 0,
      health,
    });
  }
});

app.get("/api/activity/events", auth, permit("cameras:read"), async (req, res) => {
  const { roomId, locationId, cameraId, limit } = req.query;
  if (locationId && !(await locationAllowed(req, locationId))) {
    return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  }
  if (roomId) {
    const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [roomId])).rows[0];
    if (room && !(await locationAllowed(req, room.location_id))) {
      return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
    }
  }
  if (cameraId && !(await cameraAllowed(req, cameraId))) {
    return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  }

  const events = await activityIntelligenceEngine.getRecentEvents({
    roomId,
    locationId,
    cameraId,
    limit: limit ? parseInt(limit, 10) : 50,
  });
  res.json({ events });
});

app.get("/api/activity/health", auth, permit("cameras:read"), async (_req, res) => {
  const health = await localVisionService.getActivityHealth();
  res.json(health);
});

app.get("/api/activity/plugins", auth, permit("cameras:read"), async (_req, res) => {
  const plugins = await localVisionService.getActivityPlugins();
  res.json(plugins);
});

app.put("/api/activity/plugins/:actionType/enable", auth, permit("settings:manage"), async (req, res) => {
  // A process-global flag would leak a setting from one room into another and
  // disappear after a worker restart.  Activity settings are deliberately
  // persisted and scoped through PUT /api/activity/settings instead.
  res.status(410).json({ error: "ROOM_SCOPED_SETTINGS_REQUIRED" });
});

app.get("/api/activity/settings", auth, permit("cameras:read"), async (req, res) => {
  const { roomId, actionType } = req.query;
  if (!roomId) return res.status(400).json({ error: "ROOM_ID_REQUIRED" });
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [roomId])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  let q = "SELECT * FROM activity_settings WHERE room_id = $1";
  const params = [roomId];
  if (actionType) {
    params.push(actionType);
    q += " AND action_type = $2";
  }
  const { rows } = await db.query(q, params);
  res.json({ settings: rows });
});

app.put("/api/activity/settings", auth, permit("settings:manage"), async (req, res) => {
  const input = z.object({
    roomId: z.string().min(1),
    actionType: z.string().min(1),
    enabled: z.boolean().optional(),
    config: z.record(z.any()).optional(),
  }).parse(req.body);

  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [input.roomId])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  const { rows } = await db.query(
    `INSERT INTO activity_settings(room_id, location_id, action_type, enabled, config, updated_at)
     VALUES($1, $2, $3, COALESCE($4, false), COALESCE($5, '{}'::jsonb), now())
     ON CONFLICT(room_id, action_type) DO UPDATE SET
       enabled = COALESCE($4, activity_settings.enabled),
       config = COALESCE($5, activity_settings.config),
       updated_at = now()
     RETURNING *`,
    [input.roomId, room.location_id, input.actionType, input.enabled, input.config ? JSON.stringify(input.config) : null]
  );
  await audit(req, "activity.settings.update", "activity_settings", input.roomId, null, rows[0]);
  // Worker configuration is derived from these persisted, room-scoped rows.
  // Sync immediately; restart bootstrap uses the same query.
  void syncAiWorkersSafe();
  res.json(rows[0]);
});

app.post("/rooms/:id/activity/inspect", auth, permit("devices:command"), async (req, res) => {
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [req.params.id])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });

  const { rows: cameras } = await db.query(
    "SELECT id FROM cameras WHERE room_id = $1 AND ai_enabled = true",
    [req.params.id]
  );
  if (cameras.length === 0) {
    return res.json({ status: "NO_ACTIVE_CAMERAS", events: [] });
  }

  const results = [];
  for (const cam of cameras) {
    const frame = cameraFrameProvider.getLatestFrame(cam.id);
    const result = await activityIntelligenceEngine.processFrame({
      cameraId: cam.id,
      roomId: req.params.id,
      locationId: room.location_id,
      imageBuffer: frame?.buffer || null,
      timestamp: frame?.timestamp || null,
      presetName: cameraVisionController.getCurrentPreset(cam.id),
    });
    results.push(result);
  }
  await audit(req, "room.activity.inspect", "room", req.params.id, null, { resultsCount: results.length });
  res.json({ roomId: req.params.id, results });
});

app.post("/api/activity/dataset/samples", auth, permit("devices:command"), async (req, res) => {
  const input = z.object({
    roomId: z.string().min(1),
    cameraId: z.string().min(1),
    actionType: z.string().min(1),
    label: z.enum(["POSITIVE", "HARD_NEGATIVE", "BACKGROUND"]).default("POSITIVE"),
    videoClipPath: z.string().optional(),
    durationSec: z.number().optional(),
    keypointsData: z.record(z.any()).optional().default({}),
    metadata: z.record(z.any()).optional().default({}),
  }).parse(req.body);

  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1", [input.roomId])).rows[0];
  if (!room) return res.status(404).json({ error: "ROOM_NOT_FOUND" });
  if (!(await locationAllowed(req, room.location_id))) return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  const camera = (await db.query(
    "SELECT c.id FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1 AND c.room_id=$2 AND COALESCE(c.location_id, r.location_id)=$3",
    [input.cameraId, input.roomId, room.location_id]
  )).rows[0];
  if (!camera) return res.status(403).json({ error: "CAMERA_ROOM_FORBIDDEN" });

  // Requirement 9: Auto/pseudo-labels remain UNVERIFIED until operator approval!
  const { rows } = await db.query(
    `INSERT INTO activity_dataset_samples(
      location_id, room_id, camera_id, action_type, label, verification_status,
      video_clip_path, duration_sec, keypoints_data, metadata
    ) VALUES($1, $2, $3, $4, $5, 'UNVERIFIED', $6, $7, $8, $9) RETURNING *`,
    [
      room.location_id,
      input.roomId,
      input.cameraId,
      input.actionType,
      input.label,
      input.videoClipPath || null,
      input.durationSec || null,
      JSON.stringify(input.keypointsData || {}),
      JSON.stringify(input.metadata || {}),
    ]
  );
  await audit(req, "activity.dataset.sample_captured", "activity_sample", rows[0].id, null, rows[0]);
  res.status(201).json(rows[0]);
});

app.put("/api/activity/dataset/samples/:id/verify", auth, permit("settings:manage"), async (req, res) => {
  const input = z.object({
    approved: z.boolean(),
    label: z.enum(["POSITIVE", "HARD_NEGATIVE", "BACKGROUND"]).optional(),
  }).parse(req.body);

  const operatorId = req.user?.id || req.user?.email || "operator";
  const newStatus = input.approved ? "VERIFIED" : "REJECTED";
  const sample = (await db.query(
    "SELECT id, location_id, room_id FROM activity_dataset_samples WHERE id=$1",
    [req.params.id]
  )).rows[0];
  if (!sample) return res.status(404).json({ error: "SAMPLE_NOT_FOUND" });
  if (!sample.location_id) {
    if (!isOwner(req)) return res.status(403).json({ error: "SAMPLE_SCOPE_UNKNOWN_OWNER_REQUIRED" });
  } else if (!(await locationAllowed(req, sample.location_id))) {
    return res.status(403).json({ error: "LOCATION_FORBIDDEN" });
  }

  let query = "UPDATE activity_dataset_samples SET verification_status=$1, operator_id=$2, verified_at=now()";
  const params = [newStatus, operatorId];
  if (input.label) {
    params.push(input.label);
    query += `, label=$${params.length}`;
  }
  params.push(req.params.id);
  query += ` WHERE id=$${params.length} RETURNING *`;

  const { rows } = await db.query(query, params);
  if (!rows[0]) return res.status(404).json({ error: "SAMPLE_NOT_FOUND" });

  await audit(req, "activity.dataset.sample_verified", "activity_sample", req.params.id, null, rows[0]);
  res.json(rows[0]);
});

app.get("/api/activity/dataset/samples", auth, permit("cameras:read"), async (req, res) => {
  const { actionType, status, limit } = req.query;
  let q = "SELECT * FROM activity_dataset_samples WHERE TRUE";
  const params = [];
  if (!isOwner(req)) {
    params.push(req.user.sub);
    q += ` AND location_id IN (SELECT location_id FROM user_locations WHERE user_id=$${params.length})`;
  }
  if (actionType) {
    params.push(actionType);
    q += ` AND action_type = $${params.length}`;
  }
  if (status) {
    params.push(status);
    q += ` AND verification_status = $${params.length}`;
  }
  params.push(limit ? parseInt(limit, 10) : 50);
  q += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const { rows } = await db.query(q, params);
  res.json({ samples: rows });
});

app.post("/internal/tuya/hls", requireInternalSecret, async (req, res) => {
  const { cameraId } = req.body || {};
  const camera = (await db.query("SELECT * FROM cameras WHERE id=$1", [cameraId])).rows[0];
  if (!camera || !camera.external_id) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  try {
    const endpoint = await tuya.allocateHls(camera.external_id);
    res.json({ endpoint });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/internal/ai/camera-state", requireInternalSecret, async (req, res) => {
  const { cameraId, peopleCount, people, motion, unusual, unusualDescription, status, image } = req.body || {};
  if (!cameraId) return res.status(400).json({ error: "MISSING_CAMERA_ID" });

  const camera = (await db.query(
    "SELECT c.id, c.room_id, COALESCE(c.location_id, r.location_id) AS location_id, c.ai_enabled, c.tracking_enabled FROM cameras c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.id = $1",
    [cameraId]
  )).rows[0];

  if (!camera || camera.ai_enabled === false) {
    return res.json({ ok: true, ignored: true });
  }

  if (image) {
    try {
      const frameBuf = Buffer.from(image, "base64");
      cameraFrameProvider.pushFrame(camera.id, frameBuf);
    } catch (err) {
      console.warn("Failed to push worker frame into cameraFrameProvider:", err.message);
    }
  }

  if (status === "OFFLINE" || status === "ONLINE") {
    await cameraEventEngine.handleCameraStatus({
      cameraId: camera.id,
      status,
      roomId: camera.room_id,
      locationId: camera.location_id,
    });
  }

  if (status !== "OFFLINE" && peopleCount !== undefined) {
    // The worker normally filters this already.  Keep the API boundary strict
    // as well so an uncertain person can never occupy a room or start PTZ.
    const confirmedPeople = Array.isArray(people)
      ? people.filter((person) => Number(person?.confidence) > 0.85)
      : [];
    const state = await cameraEventEngine.processDetection({
      cameraId: camera.id,
      roomId: camera.room_id,
      locationId: camera.location_id,
      detectionResult: {
        peopleCount: confirmedPeople.length,
        people: confirmedPeople,
        motion: Boolean(motion),
        unusual: Boolean(unusual),
        unusualDescription,
      },
    });

    if (camera.tracking_enabled && confirmedPeople.length > 0) {
      cameraVisionController.processAutoTracking(camera.id, confirmedPeople).catch(() => {});
    }

    return res.json({ ok: true, state });
  }

  res.json({ ok: true, status });
});

// The AI worker sends completed pose/action inference here.  Scope is never
// accepted from the worker: the API derives camera -> room -> location from
// PostgreSQL before persistence, Socket.IO or Telegram can occur.
app.post("/internal/ai/camera-activity", requireInternalSecret, async (req, res) => {
  const { cameraId, preset, timestamp, result: rawResult, image } = req.body || {};
  if (!cameraId || !rawResult || typeof rawResult !== "object") {
    return res.status(400).json({ error: "INVALID_ACTIVITY_PAYLOAD" });
  }
  const camera = (await db.query(
    "SELECT c.id, c.room_id, COALESCE(c.location_id, r.location_id) AS location_id, c.ai_enabled FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1",
    [cameraId]
  )).rows[0];
  if (!camera || camera.ai_enabled === false) return res.json({ ok: true, ignored: true });

  const { rows: enabledSettings } = camera.room_id
    ? await db.query("SELECT action_type FROM activity_settings WHERE room_id=$1 AND enabled=true", [camera.room_id])
    : { rows: [] };
  const enabledActions = new Set(enabledSettings.map((row) => row.action_type));
  const safeEvents = Array.isArray(rawResult.events)
    ? rawResult.events.filter((event) => enabledActions.has(event?.actionType || event?.action_type))
    : [];
  const result = { ...rawResult, events: safeEvents };
  let imageBuffer = null;
  if (safeEvents.length && typeof image === "string" && image.length <= 9_000_000) {
    try { imageBuffer = Buffer.from(image, "base64"); } catch { imageBuffer = null; }
  }
  const state = await activityIntelligenceEngine.processResult({
    cameraId: camera.id,
    roomId: camera.room_id,
    locationId: camera.location_id,
    presetName: typeof preset === "string" ? preset : "default",
    timestamp: typeof timestamp === "number" ? new Date(timestamp * 1000).toISOString() : null,
    result,
    imageBuffer,
  });
  res.json({ ok: true, state });
});

app.post("/internal/ai/camera-headsets", requireInternalSecret, async (req, res) => {
  const { cameraId, preset, headsets = [], people = [], status, modelStatus } = req.body || {};
  const camera = (
    await db.query(
      "SELECT c.*, COALESCE(c.location_id, r.location_id) AS location_id FROM cameras c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.id=$1",
      [cameraId]
    )
  ).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });

  const state = await headsetTrackingEngine.processDetections({
    cameraId: camera.id,
    preset: preset || "default",
    detectedHeadsets: Array.isArray(headsets) ? headsets : [],
    // Person confidence was already filtered by the worker; retain the same
    // threshold at this boundary before using it to suppress an alert.
    people: Array.isArray(people) ? people.filter((person) => Number(person?.confidence) > 0.85) : [],
    status: status || modelStatus || "READY",
    modelStatus: modelStatus || status || "READY",
    roomId: camera.room_id,
    locationId: camera.location_id,
    cameraName: camera.name,
  });

  res.json({ ok: true, state });
});

app.patch("/cameras/:id/ai/settings", auth, permit("cameras:manage"), async (req, res) => {
  const input = z.object({
    aiEnabled: z.boolean().optional(),
    trackingEnabled: z.boolean().optional(),
    analysisEnabled: z.boolean().optional(),
    headsetTrackingEnabled: z.boolean().optional(),
  }).parse(req.body);

  const before = (await db.query("SELECT * FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, before.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });

  const aiEnabled = input.aiEnabled ?? before.ai_enabled ?? true;
  const trackingEnabled = input.trackingEnabled ?? before.tracking_enabled ?? false;
  const analysisEnabled = input.analysisEnabled ?? before.analysis_enabled ?? true;
  const headsetTrackingEnabled = input.headsetTrackingEnabled ?? before.headset_tracking_enabled ?? false;

  const { rows } = await db.query(
    `UPDATE cameras SET ai_enabled=$1, tracking_enabled=$2, analysis_enabled=$3, headset_tracking_enabled=$4 WHERE id=$5 RETURNING *`,
    [aiEnabled, trackingEnabled, analysisEnabled, headsetTrackingEnabled, req.params.id]
  );

  cameraVisionController.setTracking(req.params.id, trackingEnabled);
  void syncAiWorkersSafe();
  await audit(req, "camera.ai.settings.update", "camera", req.params.id, before, rows[0]);
  res.json(rows[0]);
});

app.get("/cameras/:id/presets", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const presets = await cameraVisionController.getPresets(req.params.id);
  res.json(presets);
});

app.post("/cameras/:id/presets", auth, permit("cameras:manage"), async (req, res) => {
  const { name, ptzPreset, description } = z.object({
    name: z.string().min(1).max(80),
    ptzPreset: z.string().min(1).max(80),
    description: z.string().max(200).optional().default(""),
  }).parse(req.body);

  const camera = (await db.query("SELECT id FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, camera.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });

  const { rows } = await db.query(
    `INSERT INTO camera_presets(camera_id, name, ptz_preset, description)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(camera_id, name) DO UPDATE SET ptz_preset=excluded.ptz_preset, description=excluded.description
     RETURNING *`,
    [req.params.id, name, ptzPreset, description]
  );
  res.status(201).json(rows[0]);
});

app.post("/cameras/:id/presets/:name/goto", auth, permit("devices:command"), async (req, res) => {
  const camera = (await db.query("SELECT id FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, camera.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });

  await cameraVisionController.lookAtPreset(camera.id, req.params.name);
  await audit(req, "camera.preset.goto", "camera", camera.id, null, { preset: req.params.name });
  res.json({ ok: true, preset: req.params.name });
});

app.get("/cameras/:id/headset/zones", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const preset = req.query.preset ? String(req.query.preset) : null;
  const zones = headsetTrackingEngine.getZones(req.params.id, preset);
  res.json(zones);
});

app.post("/cameras/:id/headset/zones", auth, permit("cameras:manage"), async (req, res) => {
  const camera = (await db.query("SELECT id FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, camera.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });

  const input = z.object({
    presetName: z.string().min(1).max(80).default("default"),
    name: z.string().min(1).max(80),
    zoneType: z.enum(["WORK_ZONE", "CHARGING_BASE"]).default("WORK_ZONE"),
    headsetId: z.string().max(80).optional().nullable(),
    x: z.number().min(0).max(1).default(0),
    y: z.number().min(0).max(1).default(0),
    width: z.number().min(0).max(1).default(0.1),
    height: z.number().min(0).max(1).default(0.1),
    polygon: z.array(z.object({ x: z.number(), y: z.number() })).optional().nullable(),
    baseStationId: z.string().min(1).max(80).default("default"),
    isCanonicalBase: z.boolean().default(false),
    expectedHeadsetCount: z.number().int().min(0).max(100).optional().nullable(),
    enabled: z.boolean().default(true),
  }).parse(req.body);

  const camRoom = (await db.query("SELECT room_id FROM cameras WHERE id=$1", [camera.id])).rows[0]?.room_id;

  let effectiveBaseStationId = input.baseStationId;
  if (input.zoneType === "CHARGING_BASE" && (!req.body?.baseStationId || req.body.baseStationId === "default")) {
    if (camRoom) {
      const existingBases = (
        await db.query(
          `SELECT z.id, z.name, z.camera_id, z.base_station_id
           FROM camera_headset_zones z
           JOIN cameras c ON c.id = z.camera_id
           WHERE c.room_id = $1 AND z.zone_type = 'CHARGING_BASE'`,
          [camRoom]
        )
      ).rows;
      if (existingBases.length > 0 && !req.body?.baseStationId) {
        const baseSlug = input.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "base";
        effectiveBaseStationId = `${baseSlug}_${camera.id.slice(0, 8)}`;
      }
    }
  }

  if (input.zoneType === "CHARGING_BASE" && input.isCanonicalBase) {
    if (!camRoom) {
      return res.status(400).json({
        error: "CANONICAL_BASE_REQUIRES_ROOM",
        message: "Canonical charging base station requires camera to be assigned to a room.",
      });
    }
    const existingCanonical = (
      await db.query(
        `SELECT z.id, z.camera_id
         FROM camera_headset_zones z
         JOIN cameras c ON c.id = z.camera_id
         WHERE (z.room_id = $1 OR c.room_id = $1) AND z.base_station_id = $2 AND z.is_canonical_base = true`,
        [camRoom, effectiveBaseStationId]
      )
    ).rows[0];
    if (existingCanonical) {
      return res.status(400).json({
        error: "CANONICAL_BASE_ALREADY_EXISTS",
        message: `A canonical view already exists for base station '${effectiveBaseStationId}' in this room (zone ${existingCanonical.id}). Only one canonical view is permitted per physical base station per room.`,
      });
    }
  }

  const { rows } = await db.query(
    `INSERT INTO camera_headset_zones(
       camera_id, room_id, preset_name, name, zone_type, headset_id, x, y, width, height, polygon,
       base_station_id, is_canonical_base, expected_headset_count, enabled
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      camera.id,
      camRoom || null,
      input.presetName,
      input.name,
      input.zoneType,
      input.headsetId || null,
      input.x,
      input.y,
      input.width,
      input.height,
      input.polygon ? JSON.stringify(input.polygon) : null,
      effectiveBaseStationId,
      input.isCanonicalBase,
      input.expectedHeadsetCount ?? null,
      input.enabled,
    ]
  );
  headsetTrackingEngine.addZoneToCache(rows[0]);
  await audit(req, "camera.headset_zone.create", "camera_headset_zones", rows[0].id, null, rows[0]);
  res.status(201).json(rows[0]);
});

app.delete("/cameras/:id/headset/zones/:zoneId", auth, permit("cameras:manage"), async (req, res) => {
  const camera = (await db.query("SELECT id FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!camera) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  if (!(await cameraAllowed(req, camera.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });

  const { rowCount } = await db.query("DELETE FROM camera_headset_zones WHERE id=$1 AND camera_id=$2", [
    req.params.zoneId,
    camera.id,
  ]);
  if (!rowCount) return res.status(404).json({ error: "ZONE_NOT_FOUND" });
  headsetTrackingEngine.removeZoneFromCache(req.params.zoneId, camera.id);
  await audit(req, "camera.headset_zone.delete", "camera_headset_zones", req.params.zoneId, null, null);
  res.json({ ok: true });
});

app.get("/cameras/:id/headset/state", auth, permit("cameras:read"), async (req, res) => {
  if (!(await cameraAllowed(req, req.params.id))) return res.status(403).json({ error: "CAMERA_FORBIDDEN" });
  const state = headsetTrackingEngine.getState(req.params.id);
  res.json(state);
});

app.get("/rooms/:id/doorbell-calls", auth, permit("cameras:read"), async (req,res) => {
  const room=(await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if(!room) return res.status(404).json({error:"ROOM_NOT_FOUND"});
  if(!(await locationAllowed(req,room.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`
    SELECT dc.id,dc.camera_id,dc.external_message_id,dc.status,dc.rang_at,dc.acknowledged_at,
           c.name AS camera_name,c.status AS camera_status
    FROM doorbell_calls dc
    JOIN cameras c ON c.id=dc.camera_id
    WHERE dc.room_id=$1 AND dc.rang_at > now()-interval '24 hours'
    ORDER BY dc.rang_at DESC
    LIMIT 20
  `,[req.params.id]);
  res.json(rows);
});

app.get("/rooms/:id/help-button", auth, permit("cameras:read"), async (req,res) => {
  const room=(await db.query("SELECT location_id,metadata FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if(!room) return res.status(404).json({error:"ROOM_NOT_FOUND"});
  if(!(await locationAllowed(req,room.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`
    SELECT c.id,c.name,c.provider,c.status,c.external_id,c.config
    FROM cameras c
    LEFT JOIN rooms r ON r.id=c.room_id
    WHERE c.provider='TUYA' AND COALESCE(c.location_id,r.location_id)=$1
    ORDER BY
      CASE WHEN lower(c.name) LIKE '%doorbell%' OR c.config->>'category'='dghsxj' THEN 0 ELSE 1 END,
      c.name
  `,[room.location_id]);
  const configured=room.metadata?.help_button_camera_id;
  const fallback=rows.find(camera=>/doorbell/i.test(camera.name)||camera.config?.category==="dghsxj")?.id||null;
  res.json({cameraId:configured||fallback,cameras:rows});
});

app.patch("/rooms/:id/help-button", auth, permit("cameras:manage"), async (req,res) => {
  const {cameraId}=z.object({cameraId:z.string().uuid()}).parse(req.body);
  const room=(await db.query("SELECT location_id,metadata FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if(!room) return res.status(404).json({error:"ROOM_NOT_FOUND"});
  if(!(await locationAllowed(req,room.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const camera=(await db.query(`
    SELECT c.id,c.name FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id
    WHERE c.id=$1 AND c.provider='TUYA' AND COALESCE(c.location_id,r.location_id)=$2
  `,[cameraId,room.location_id])).rows[0];
  if(!camera) return res.status(400).json({error:"HELP_BUTTON_CAMERA_INVALID"});
  const metadata={...(room.metadata||{}),help_button_camera_id:cameraId};
  await db.query("UPDATE rooms SET metadata=$1 WHERE id=$2",[metadata,req.params.id]);
  await audit(req,"room.help_button.update","room",req.params.id,room.metadata,metadata);
  res.json({cameraId,cameraName:camera.name});
});

app.patch("/rooms/:roomId/doorbell-calls/:id/acknowledge", auth, permit("devices:command"), async (req,res) => {
  const room=(await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.roomId])).rows[0];
  if(!room) return res.status(404).json({error:"ROOM_NOT_FOUND"});
  if(!(await locationAllowed(req,room.location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const {rows}=await db.query(`
    UPDATE doorbell_calls
    SET status='ACKNOWLEDGED',acknowledged_at=now(),acknowledged_by=$1
    WHERE id=$2 AND room_id=$3
    RETURNING *
  `,[req.user.sub,req.params.id,req.params.roomId]);
  if(!rows[0]) return res.status(404).json({error:"DOORBELL_CALL_NOT_FOUND"});
  await audit(req,"doorbell.call.acknowledge","doorbell_call",req.params.id,null,rows[0]);
  res.json(rows[0]);
});

app.post("/rooms/:id/doorbell-calls/test", auth, async (req,res) => {
  if(!isOwner(req)) return res.status(403).json({error:"OWNER_REQUIRED"});
  const camera=(await db.query(`
    SELECT c.id,c.name FROM rooms room
    JOIN cameras c ON c.id=COALESCE(
      NULLIF(room.metadata->>'help_button_camera_id','')::uuid,
      (SELECT fallback.id FROM cameras fallback
       WHERE fallback.room_id=room.id AND fallback.provider='TUYA'
         AND (lower(fallback.name) LIKE '%doorbell%' OR fallback.config->>'category'='dghsxj')
       ORDER BY fallback.id LIMIT 1)
    )
    WHERE room.id=$1
  `,[req.params.id])).rows[0];
  if(!camera) return res.status(404).json({error:"DOORBELL_NOT_FOUND"});
  const {rows}=await db.query(`
    INSERT INTO doorbell_calls(room_id,camera_id,external_message_id,raw_event)
    VALUES($1,$2,$3,$4) RETURNING *
  `,[req.params.id,camera.id,`test-${crypto.randomUUID()}`,{test:true}]);
  io.emit("doorbell-call",{...rows[0],room_id:req.params.id,camera_name:camera.name,camera_status:"ONLINE"});
  res.status(201).json(rows[0]);
});

const agentNs = io.of("/agent");
agentNs.use(async (socket,next) => {
  const { agentId, token } = socket.handshake.auth;
  if (!agentId || !token) return next(new Error("unauthorized"));
  const expected = await redis.get(`agent-token:${agentId}`);
  if (!expected || !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(crypto.createHash("sha256").update(token).digest("hex")))) return next(new Error("unauthorized"));
  socket.data.agentId=agentId; next();
});
agentNs.on("connection", socket => {
  socket.join(`agent:${socket.data.agentId}`);
  redis.hset("agents",socket.data.agentId,JSON.stringify({status:"ONLINE",lastSeen:new Date().toISOString()}));
  socket.on("heartbeat", async data => {
    await Promise.all([
      redis.hset("agents",socket.data.agentId,JSON.stringify({status:"ONLINE",lastSeen:new Date().toISOString(),...data})),
      db.query("UPDATE devices SET status='ONLINE',last_seen=now() WHERE agent_id=$1", [socket.data.agentId]),
    ]);
  });
  socket.on("disconnect", async () => {
    await Promise.all([
      redis.hset("agents",socket.data.agentId,JSON.stringify({status:"OFFLINE",lastSeen:new Date().toISOString()})),
      db.query("UPDATE devices SET status='OFFLINE' WHERE agent_id=$1", [socket.data.agentId]),
    ]);
  });
});

const voiceNs=io.of("/voice");
const activeVoiceAgents=new Map();
voiceNs.use(async(socket,next)=>{
  try {
    const token=socket.handshake.auth?.token;
    if(!token) throw new Error("missing token");
    const { payload }=await jwtVerify(token,key(env.JWT_ACCESS_SECRET));
    const permissions=payload.permissions||[];
    if(!(permissions.includes("*")||permissions.includes("devices:command")||permissions.includes("devices:*"))) throw new Error("forbidden");
    socket.data.user=payload;
    next();
  } catch { next(new Error("unauthorized")); }
});
voiceNs.on("connection",socket=>{
  let agentId;
  let roomId;
  const stop=()=>{
    if(agentId&&activeVoiceAgents.get(agentId)===socket.id) {
      activeVoiceAgents.delete(agentId);
      agentNs.to(`agent:${agentId}`).emit("voice",{operation:"stop"});
    }
    agentId=undefined; roomId=undefined;
  };
  socket.on("start",async(message,ack)=>{
    try {
      const input=z.object({roomId:z.string().uuid(),contentType:z.enum(["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"])}).parse(message);
      const room=(await db.query("SELECT location_id FROM rooms WHERE id=$1",[input.roomId])).rows[0];
      const fakeReq={user:socket.data.user};
      if(!room||!(await locationAllowed(fakeReq,room.location_id))) return ack({success:false,error:"LOCATION_FORBIDDEN"});
      const agent=(await db.query("SELECT agent_id FROM devices WHERE room_id=$1 AND agent_id IS NOT NULL ORDER BY last_seen DESC NULLS LAST,id LIMIT 1",[input.roomId])).rows[0];
      if(!agent) return ack({success:false,error:"AGENT_NOT_CONFIGURED"});
      if(activeVoiceAgents.has(agent.agent_id)&&activeVoiceAgents.get(agent.agent_id)!==socket.id) return ack({success:false,error:"VOICE_BUSY"});
      activeVoiceAgents.set(agent.agent_id,socket.id);
      agentNs.to(`agent:${agent.agent_id}`).timeout(5000).emit("voice",{operation:"start",contentType:input.contentType},(err,responses)=>{
        const result=err?{success:false,error:"AGENT_TIMEOUT"}:responses?.[0]||{success:false,error:"EMPTY_AGENT_RESPONSE"};
        if(result.success&&socket.connected){ agentId=agent.agent_id; roomId=input.roomId; activeVoiceAgents.set(agentId,socket.id); }
        else if(result.success) agentNs.to(`agent:${agent.agent_id}`).emit("voice",{operation:"stop"});
        else if(activeVoiceAgents.get(agent.agent_id)===socket.id) activeVoiceAgents.delete(agent.agent_id);
        if(!socket.connected&&activeVoiceAgents.get(agent.agent_id)===socket.id) activeVoiceAgents.delete(agent.agent_id);
        ack(result);
      });
    } catch(error){ ack({success:false,error:error instanceof z.ZodError?"INVALID_INPUT":error.message}); }
  });
  socket.on("chunk",data=>{
    if(!agentId||!roomId) return;
    const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);
    if(chunk.length<=256_000) agentNs.to(`agent:${agentId}`).emit("voice",{operation:"chunk",data:chunk});
  });
  socket.on("stop",(_,ack=()=>{})=>{ stop(); ack({success:true}); });
  socket.on("disconnect",stop);
});

const cameraNs=io.of("/webrtc");
cameraNs.use(async(socket,next)=>{
  try {
    const token=socket.handshake.auth?.token;
    if(!token) throw new Error("missing token");
    const {payload}=await jwtVerify(token,key(env.JWT_ACCESS_SECRET));
    const permissions=payload.permissions||[];
    if(!(permissions.includes("*")||permissions.includes("cameras:read")||permissions.includes("cameras:*"))) throw new Error("forbidden");
    socket.data.user=payload;
    next();
  } catch { next(new Error("unauthorized")); }
});
cameraNs.on("connection",socket=>{
  socket.on("diagnostic",message=>{
    const parsed=z.object({cameraId:z.string().uuid(),stage:z.string().max(40),detail:z.string().max(160).optional()}).safeParse(message);
    if(parsed.success)console.info("Tuya WebRTC client",parsed.data.cameraId,parsed.data.stage,parsed.data.detail||"");
  });
  socket.on("start",async(message,ack=()=>{})=>{
    try {
      const input=z.object({cameraId:z.string().uuid()}).parse(message);
      const camera=(await db.query(`
        SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id
        FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id
        WHERE c.id=$1
      `,[input.cameraId])).rows[0];
      if(!camera||camera.provider!=="TUYA"||!camera.external_id) return ack({success:false,error:"CAMERA_NOT_AVAILABLE"});
      if(!(await cameraAllowed({user:socket.data.user},camera.id))) return ack({success:false,error:"CAMERA_FORBIDDEN"});
      const result=await tuyaWebRTC.startSession({deviceId:camera.external_id,socket,purpose:"browser"});
      ack({success:true,...result});
    } catch(error) {
      console.error("Tuya WebRTC session failed",error.code||"",error.message);
      ack({success:false,error:error.code||"TUYA_WEBRTC_UNAVAILABLE"});
    }
  });
  socket.on("signal",async(message,ack=()=>{})=>{
    try {
      const input=z.object({
        sessionId:z.string().regex(/^[a-f0-9]{32}$/),
        type:z.enum(["offer","candidate","disconnect"]),
        payload:z.string().max(20_000).default(""),
      }).parse(message);
      await tuyaWebRTC.signal({...input,socket});
      ack({success:true});
    } catch(error) {
      ack({success:false,error:error instanceof z.ZodError?"INVALID_SIGNAL":error.code||"TUYA_SIGNAL_FAILED"});
    }
  });
  socket.on("disconnect",()=>void tuyaWebRTC.closeSocket(socket));
});

io.use(async (socket,next) => {
  try { socket.data.user=(await jwtVerify(socket.handshake.auth.token,key(env.JWT_ACCESS_SECRET))).payload; next(); }
  catch { next(new Error("unauthorized")); }
});
io.on("connection", async (socket) => {
  socket.join(`user:${socket.data.user.sub}`);
  try {
    const user = socket.data.user;
    if (isOwner({ user })) {
      const { rows } = await db.query("SELECT id FROM locations");
      for (const r of rows) socket.join(`location:${r.id}`);
      const { rows: cams } = await db.query("SELECT id FROM cameras");
      for (const c of cams) socket.join(`camera:${c.id}`);
    } else if (user.role === "CAMERA_GUEST" && Array.isArray(user.cameraIds)) {
      for (const cid of user.cameraIds) socket.join(`camera:${cid}`);
    } else if (user.role === "CAMERA_VIEWER") {
      const { rows } = await db.query("SELECT camera_id FROM user_cameras WHERE user_id=$1", [user.sub]);
      for (const r of rows) socket.join(`camera:${r.camera_id}`);
    } else {
      const { rows } = await db.query("SELECT location_id FROM user_locations WHERE user_id=$1", [user.sub]);
      for (const r of rows) socket.join(`location:${r.location_id}`);
      const { rows: cams } = await db.query(`
        SELECT c.id FROM cameras c
        LEFT JOIN rooms r ON r.id = c.room_id
        WHERE COALESCE(c.location_id, r.location_id) IN (SELECT location_id FROM user_locations WHERE user_id=$1)
      `, [user.sub]);
      for (const c of cams) socket.join(`camera:${c.id}`);
    }
  } catch (err) {
    console.error("Failed to join socket rooms:", err.message);
  }

  socket.on("subscribe:camera", async (cameraId, ack = () => {}) => {
    if (await cameraAllowed({ user: socket.data.user }, cameraId)) {
      socket.join(`camera:${cameraId}`);
      ack({ ok: true });
    } else {
      ack({ ok: false, error: "FORBIDDEN" });
    }
  });
});

app.use((err, req, res, _next) => {
  console.error(req.requestId, err);
  if (err instanceof z.ZodError) return res.status(400).json({ error:"INVALID_INPUT",details:err.flatten(),requestId:req.requestId });
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error:err.message||"REQUEST_FAILED",requestId:req.requestId });
  res.status(500).json({ error:"INTERNAL_ERROR",requestId:req.requestId });
});
try {
  await runMigrations(db);
} catch (migErr) {
  console.error("Warning: migration runner error:", migErr.message);
}
await db.query("CREATE TABLE IF NOT EXISTS app_settings(key text PRIMARY KEY,encrypted_value bytea NOT NULL,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now())");
await db.query("CREATE TABLE IF NOT EXISTS telegram_connections(user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,telegram_user_id bigint UNIQUE NOT NULL,chat_id bigint UNIQUE NOT NULL,username text,first_name text,linked_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now())");
await db.query("CREATE TABLE IF NOT EXISTS telegram_link_codes(code_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");
await db.query("CREATE INDEX IF NOT EXISTS telegram_link_codes_expires_at_idx ON telegram_link_codes(expires_at)");
await db.query("CREATE TABLE IF NOT EXISTS telegram_notification_log(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,notification_key text NOT NULL,sent_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,notification_key))");
await db.query("ALTER TABLE locations ADD COLUMN IF NOT EXISTS external_id text");
await db.query("CREATE UNIQUE INDEX IF NOT EXISTS locations_external_id_idx ON locations(external_id) WHERE external_id IS NOT NULL");
await db.query("CREATE TABLE IF NOT EXISTS user_locations(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,PRIMARY KEY(user_id,location_id))");
await db.query(`INSERT INTO roles(name,permissions) VALUES('CAMERA_VIEWER','["cameras:read","locations:read"]'::jsonb) ON CONFLICT(name) DO UPDATE SET permissions=excluded.permissions`);
await db.query("CREATE TABLE IF NOT EXISTS user_cameras(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,PRIMARY KEY(user_id,camera_id))");
await db.query("CREATE TABLE IF NOT EXISTS camera_shares(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text UNIQUE NOT NULL,created_by uuid REFERENCES users(id) ON DELETE CASCADE,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())");
await db.query("CREATE TABLE IF NOT EXISTS camera_share_cameras(share_id uuid NOT NULL REFERENCES camera_shares(id) ON DELETE CASCADE,camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,PRIMARY KEY(share_id,camera_id))");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE SET NULL");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS plan_x numeric(6,3)");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS plan_y numeric(6,3)");
await db.query("UPDATE cameras c SET location_id=r.location_id FROM rooms r WHERE c.room_id=r.id AND c.location_id IS NULL");
await db.query("CREATE TABLE IF NOT EXISTS location_plans(location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,background_image text,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now())");
await db.query("ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_mode text NOT NULL DEFAULT 'CONTAIN'");
await db.query("ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_scale numeric(6,2) NOT NULL DEFAULT 100");
await db.query("ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_x numeric(6,2) NOT NULL DEFAULT 50");
await db.query("ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_y numeric(6,2) NOT NULL DEFAULT 50");
await db.query(`CREATE TABLE IF NOT EXISTS plan_zones(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,name text NOT NULL,type text NOT NULL,color text NOT NULL DEFAULT '#64748b',
  x numeric(6,3) NOT NULL,y numeric(6,3) NOT NULL,width numeric(6,3) NOT NULL,height numeric(6,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS plan_zone_id uuid REFERENCES plan_zones(id) ON DELETE SET NULL");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS tracking_enabled boolean NOT NULL DEFAULT false");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS analysis_enabled boolean NOT NULL DEFAULT true");
await db.query("ALTER TABLE cameras ADD COLUMN IF NOT EXISTS archived_at timestamptz");
await db.query("CREATE TABLE IF NOT EXISTS camera_ai_states (camera_id uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE, room_id uuid REFERENCES rooms(id) ON DELETE SET NULL, people_count integer NOT NULL DEFAULT 0, occupied boolean NOT NULL DEFAULT false, motion boolean NOT NULL DEFAULT false, last_person_entered timestamptz, last_person_left timestamptz, last_activity timestamptz NOT NULL DEFAULT now(), last_updated timestamptz NOT NULL DEFAULT now())");
await db.query("CREATE TABLE IF NOT EXISTS camera_ai_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE, room_id uuid REFERENCES rooms(id) ON DELETE SET NULL, type text NOT NULL, timestamp timestamptz NOT NULL DEFAULT now(), people_count integer NOT NULL DEFAULT 0, confidence numeric(5,4) NOT NULL DEFAULT 1.0, description text, metadata jsonb NOT NULL DEFAULT '{}')");
await db.query("CREATE INDEX IF NOT EXISTS camera_ai_events_camera_idx ON camera_ai_events(camera_id, timestamp DESC)");
await db.query("CREATE INDEX IF NOT EXISTS camera_ai_events_room_idx ON camera_ai_events(room_id, timestamp DESC) WHERE room_id IS NOT NULL");
await db.query("CREATE TABLE IF NOT EXISTS camera_presets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE, name text NOT NULL, ptz_preset text NOT NULL, description text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(camera_id, name))");
await db.query(`UPDATE roles SET permissions='["bookings:read","rooms:read","locations:read","sessions:*","devices:read","devices:command","cameras:read","local_sites:open"]'::jsonb WHERE name='OPERATOR'`);
await db.query(
  `INSERT INTO locations(external_id,name,timezone,address)
   VALUES($1,$2,'Europe/Vienna',$3)
   ON CONFLICT(external_id) WHERE external_id IS NOT NULL
   DO UPDATE SET name=excluded.name,timezone=excluded.timezone,address=excluded.address`,
  ["01js4ahx79xbw5gd05jy1mmsdw","Escapers_Peolten","St. Pölten, Traisenpark EKZ Traisenpark auf der Fläche Top-Nr. EG S35B"]
);
await db.query(
  `UPDATE rooms SET location_id=(SELECT id FROM locations WHERE external_id=$1)
   WHERE lower(replace(name,' ','_')) LIKE '%krampus%'`,
  ["01js4ahx79xbw5gd05jy1mmsdw"]
);
await db.query(
  `UPDATE cameras
   SET room_id=(SELECT id FROM rooms WHERE lower(replace(name,' ','_')) LIKE '%krampus%' ORDER BY id LIMIT 1)
   WHERE provider='TUYA' AND room_id IS NULL AND name ~* '(LSC|PTZ)'
     AND EXISTS(SELECT 1 FROM rooms WHERE lower(replace(name,' ','_')) LIKE '%krampus%')`
);
await db.query(
  `UPDATE rooms
   SET location_id=(SELECT id FROM locations WHERE external_id=$1)
   WHERE location_id IN (
     SELECT id FROM locations
     WHERE external_id IS DISTINCT FROM $1
       AND lower(replace(name,' ','_')) LIKE '%krampus%'
   )`,
  ["01js4ahx79xbw5gd05jy1mmsdw"]
);
await db.query(
  `UPDATE integrations
   SET location_id=(SELECT id FROM locations WHERE external_id=$1)
   WHERE location_id IN (
     SELECT id FROM locations
     WHERE external_id IS DISTINCT FROM $1
       AND lower(replace(name,' ','_')) LIKE '%krampus%'
   )`,
  ["01js4ahx79xbw5gd05jy1mmsdw"]
);
await db.query(
  `DELETE FROM locations
   WHERE external_id IS DISTINCT FROM $1
     AND lower(replace(name,' ','_')) LIKE '%krampus%'`,
  ["01js4ahx79xbw5gd05jy1mmsdw"]
);
await db.query(`CREATE TABLE IF NOT EXISTS doorbell_calls(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  external_message_id text UNIQUE,
  status text NOT NULL DEFAULT 'RINGING' CHECK(status IN ('RINGING','ACKNOWLEDGED','EXPIRED')),
  raw_event jsonb NOT NULL DEFAULT '{}',
  rang_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL
)`);
await db.query("CREATE INDEX IF NOT EXISTS doorbell_calls_room_rang_idx ON doorbell_calls(room_id,rang_at DESC)");
await db.query(`CREATE TABLE IF NOT EXISTS inventory_items(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL,
  unit text NOT NULL DEFAULT 'шт.',
  quantity numeric(12,2) NOT NULL DEFAULT 0 CHECK(quantity>=0),
  minimum_quantity numeric(12,2) NOT NULL DEFAULT 0 CHECK(minimum_quantity>=0),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`);
await db.query("CREATE INDEX IF NOT EXISTS inventory_items_location_idx ON inventory_items(location_id,is_active)");
await db.query(`CREATE TABLE IF NOT EXISTS inventory_movements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  delta numeric(12,2) NOT NULL CHECK(delta<>0),
  quantity_after numeric(12,2) NOT NULL CHECK(quantity_after>=0),
  reason text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  operation_count integer NOT NULL DEFAULT 1 CHECK(operation_count>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now()
)`);
await db.query("ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS operation_count integer NOT NULL DEFAULT 1");
await db.query("ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS last_event_at timestamptz");
await db.query("UPDATE inventory_movements SET last_event_at=created_at WHERE last_event_at IS NULL");
await db.query("ALTER TABLE inventory_movements ALTER COLUMN last_event_at SET DEFAULT now()");
await db.query("ALTER TABLE inventory_movements ALTER COLUMN last_event_at SET NOT NULL");
await db.query("CREATE INDEX IF NOT EXISTS inventory_movements_item_created_idx ON inventory_movements(item_id,created_at DESC)");
await db.query("CREATE INDEX IF NOT EXISTS inventory_movements_item_last_event_idx ON inventory_movements(item_id,last_event_at DESC)");

const tuyaEventSignals = (value, signals=[], depth=0) => {
  if(depth>5||signals.length>=40||value==null) return signals;
  if(Array.isArray(value)) {
    for(const item of value) tuyaEventSignals(item,signals,depth+1);
    return signals;
  }
  if(typeof value!=="object") return signals;
  const code=value.code??value.dpCode??value.dp_code??value.dpId??value.dp_id;
  if(code!==undefined) signals.push({code:String(code).toLowerCase(),value:value.value??value.val??value.dpValue??value.dp_value});
  for(const nested of Object.values(value)) tuyaEventSignals(nested,signals,depth+1);
  return signals;
};
const initiativeDoorbellEvent = (signal) => {
  if(signal.code!=="initiative_message"||typeof signal.value!=="string") return false;
  try {
    const event=JSON.parse(Buffer.from(signal.value,"base64").toString("utf8"));
    return String(event.cmd||"").toLowerCase()==="ipc_doorbell"&&event.alarm!==false;
  } catch { return false; }
};
const doorbellEvent = (message) => {
  const data=message?.payload?.data||{};
  const signals=tuyaEventSignals(data);
  const codes=signals.map(item=>item.code);
  const bizCode=String(data.bizCode||data.biz_code||"").toLowerCase();
  if(bizCode==="deviceeventmessage") return true;
  return signals.some(initiativeDoorbellEvent)||signals.some(item=>
    /(doorbell|door_bell|door bell|bell|help|call|ac_doorbell|ipc_panel_doorbell|doorbell_pic)/.test(item.code)
    && ![false,0,"0","false",null,undefined].includes(item.value)
  )||/(doorbell|door_bell|door bell|ac_doorbell|ipc_panel_doorbell|doorbell_pic)/.test(JSON.stringify({bizCode,type:data.type||"",codes}).toLowerCase());
};
tuyaMessages.on("message",async message=>{
  try {
    const data=message?.payload?.data||{};
    const externalId=String(data.devId||data.deviceId||data.dev_id||message.key||"");
    const bizCode=String(data.bizCode||data.biz_code||"unknown");
    console.log("Tuya message received",bizCode,externalId||"no-device");
    if(!externalId) return;
    const camera=(await db.query(`
      SELECT c.id,r.id AS room_id FROM cameras c
      JOIN rooms r ON
        r.metadata->>'help_button_camera_id'=c.id::text OR
        (r.metadata->>'help_button_camera_id' IS NULL AND c.room_id=r.id)
      WHERE c.provider='TUYA' AND c.external_id=$1
        AND (
          r.metadata->>'help_button_camera_id'=c.id::text OR
          (r.metadata->>'help_button_camera_id' IS NULL AND
           (lower(c.name) LIKE '%doorbell%' OR c.config->>'category'='dghsxj'))
        )
      LIMIT 1
    `,[externalId])).rows[0];
    if(!camera) return;
    const signals=tuyaEventSignals(data);
    console.log("Tuya help device event",bizCode,externalId,JSON.stringify(signals.slice(0,20).map(item=>({
      code:item.code,
      value:typeof item.value==="string"&&item.value.length>80?`[string:${item.value.length}]`:item.value,
    }))));
    if(!doorbellEvent(message)) return;
    const externalMessageId=String(message.messageId||data.dataId||crypto.randomUUID());
    const call=(await db.query(`
      INSERT INTO doorbell_calls(room_id,camera_id,external_message_id,raw_event)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(external_message_id) DO NOTHING
      RETURNING *
    `,[camera.room_id,camera.id,externalMessageId,message])).rows[0];
    if(call){
      console.log("Doorbell call received",camera.id,call.id);
      const cameraInfo=(await db.query("SELECT name,status FROM cameras WHERE id=$1",[camera.id])).rows[0];
      io.emit("doorbell-call",{...call,camera_name:cameraInfo?.name||"Doorbell",camera_status:cameraInfo?.status||"ONLINE"});
    }
  } catch(error) {
    console.error("Doorbell event processing failed",error.message);
  }
});
await db.query(`CREATE TABLE IF NOT EXISTS user_signatures(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK(content_type IN ('image/png','image/jpeg')),
  image_data bytea NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
)`);
await db.query(`CREATE TABLE IF NOT EXISTS document_templates(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,file_name text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',template_data bytea NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
)`);
await db.query(`CREATE TABLE IF NOT EXISTS document_scripts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,file_name text NOT NULL DEFAULT 'script.py',source_code text NOT NULL,
  input_fields jsonb NOT NULL DEFAULT '[]'::jsonb,created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
)`);
await db.query("ALTER TABLE document_scripts ADD COLUMN IF NOT EXISTS file_name text NOT NULL DEFAULT 'script.py'");
await db.query("ALTER TABLE document_scripts ADD COLUMN IF NOT EXISTS input_fields jsonb NOT NULL DEFAULT '[]'::jsonb");
const bundledTemplatePath=path.resolve("templates/Arbeitszeitaufzeichnung_Template.docx");
if(fs.existsSync(bundledTemplatePath)){
  const bundledTemplate=fs.readFileSync(bundledTemplatePath);
  if(!(await db.query("SELECT 1 FROM document_templates WHERE name='Arbeitszeitaufzeichnung Standard' LIMIT 1")).rowCount){
    await db.query("INSERT INTO document_templates(name,file_name,template_data) VALUES($1,$2,$3)",["Arbeitszeitaufzeichnung Standard","Arbeitszeitaufzeichnung_Template.docx",bundledTemplate]);
  }
  // Keep the bundled system template current without touching uploaded files.
  await db.query(`UPDATE document_templates SET template_data=$1,file_name='Arbeitszeitaufzeichnung_Template.docx',updated_at=now()
    WHERE name='Arbeitszeitaufzeichnung Standard' AND created_by IS NULL`,[bundledTemplate]);
}
const bundledScriptPath=path.resolve("templates/monthly-work-time-report.py");
if(fs.existsSync(bundledScriptPath)){
  const bundledDocumentScript=fs.readFileSync(bundledScriptPath,"utf8");
  if(!(await db.query("SELECT 1 FROM document_scripts WHERE name='Monatlicher Arbeitszeitbericht Standard' LIMIT 1")).rowCount){
    await db.query("INSERT INTO document_scripts(name,file_name,source_code,input_fields) VALUES($1,$2,$3,$4)",["Monatlicher Arbeitszeitbericht Standard","monthly-work-time-report.py",bundledDocumentScript,JSON.stringify(["report_rows","locations"])]);
  }
  // Repair the one-off placeholder script used while restoring production. The
  // conditions only target the bundled system script, never user-written code.
  await db.query(`UPDATE document_scripts
    SET source_code=$1,input_fields=$2,file_name='monthly-work-time-report.py',updated_at=now()
    WHERE name='Monatlicher Arbeitszeitbericht Standard' AND created_by IS NULL
      AND source_code='def run(context): return {}'`,[bundledDocumentScript,JSON.stringify(["report_rows","locations"])]);
  // Upgrade the previous bundled version to compact notes. This retains the
  // one-page layout but intentionally leaves any customised script untouched.
  await db.query(`UPDATE document_scripts
    SET source_code=$1,input_fields=$2,file_name='monthly-work-time-report.py',updated_at=now()
    WHERE name='Monatlicher Arbeitszeitbericht Standard' AND created_by IS NULL
      AND source_code LIKE '%row["n"] = ", ".join(row.pop("notes"))%'`,[bundledDocumentScript,JSON.stringify(["report_rows","locations"])]);
}
tuyaMessages.start();
server.on("upgrade",async(req,socket,head)=>{
  let parsed;
  try { parsed=new URL(req.url,"http://local"); } catch { return; }
  if(parsed.pathname!=="/vr/sankt-poelten/vnc") return;
  const sessionId=String(req.headers.cookie||"").split(/;\s*/).find(value=>value.startsWith("quest_vr_poelten="))?.slice("quest_vr_poelten=".length);
  const host=vrPrivateHost(parsed.searchParams.get("stationHost"));
  if(!sessionId||!host||!(await redis.get(`vr-session:${sessionId}`))) return socket.destroy();
  vrVncServer.handleUpgrade(req,socket,head,client=>{
    const upstream=new WebSocket(`ws://${host}:22035/arvi/vrp2/websockettools/vnc`,{agent:vrSocksAgent});
    const close=()=>{if(client.readyState<2)client.close();if(upstream.readyState<2)upstream.close();};
    client.on("message",data=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(data);});
    upstream.on("message",data=>{if(client.readyState===WebSocket.OPEN)client.send(data);});
    client.on("close",close); upstream.on("close",close); upstream.on("error",close); client.on("error",close);
  });
});
telegramBot = new TelegramBot({ token: env.TELEGRAM_BOT_TOKEN, onUpdate: telegramHandleUpdate });
let telegramNotificationsBusy=false;
async function runTelegramNotifications() {
  if (telegramNotificationsBusy || !telegramBot.enabled) return;
  telegramNotificationsBusy=true;
  try { await telegramNotificationsOnce(); }
  catch (error) { console.error("Telegram notification scheduler failed", error.message); }
  finally { telegramNotificationsBusy=false; }
}
// Restore camera AI state from PostgreSQL and run resilient stream worker supervisor
await cameraEventEngine.loadStatesFromDb();
await headsetTrackingEngine.loadStatesFromDb();
const aiWorkerSupervisor = startAiWorkerSyncSupervisor({ db, localVisionService });


server.listen(env.PORT, "0.0.0.0", () => {
  console.log(`QuestControl API listening on ${env.PORT}`);
  void telegramBot.start();
  setInterval(() => void runTelegramNotifications(), 60_000).unref();
  setTimeout(() => void runTelegramNotifications(), 5_000).unref();

  // Discover Tuya cameras continuously.  A newly added device is written with
  // ai_enabled=true and is immediately synchronized to ai-service; operators
  // do not need to press the manual sync button or restart the stack.
  const discoveryInterval = Math.max(60_000, Number(process.env.TUYA_CAMERA_DISCOVERY_INTERVAL_MS || 300_000));
  const discoverCameras = async () => {
    if (!tuya.configured) return;
    try {
      const result = await syncTuyaCameraInventory();
      if (result.created || result.updated) {
        console.info(`[Tuya discovery] cameras created=${result.created} updated=${result.updated}`);
      }
    } catch (error) {
      console.warn("[Tuya discovery] failed:", error.message);
    }
  };
  setTimeout(() => void discoverCameras(), 20_000).unref();
  setInterval(() => void discoverCameras(), discoveryInterval).unref();
  const discoverBridgeCameras = async () => {
    if (!tuyaBridgeAccounts.length) return;
    try {
      const result=await syncTuyaBridgeInventory();
      if(result.created||result.updated) console.info(`[Tuya bridge] cameras created=${result.created} updated=${result.updated}`);
    } catch(error) {
      console.warn("[Tuya bridge] discovery failed:",error.message);
    }
  };
  setTimeout(() => void discoverBridgeCameras(), 30_000).unref();
  setInterval(() => void discoverBridgeCameras(), discoveryInterval).unref();
});
