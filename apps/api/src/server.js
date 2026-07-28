import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import argon2 from "argon2";
import pg from "pg";
import Redis from "ioredis";
import { Server } from "socket.io";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { TuyaCloud } from "./tuya.js";

const env = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  CORS_ORIGIN: z.string(),
  TRUST_PROXY: z.coerce.number().default(1),
  TUYA_BASE_URL: z.string().url().default("https://openapi.tuyaeu.com"),
  TUYA_CLIENT_ID: z.string().optional(),
  TUYA_CLIENT_SECRET: z.string().optional(),
}).parse(process.env);

const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const tuya = new TuyaCloud({
  baseUrl: env.TUYA_BASE_URL,
  clientId: env.TUYA_CLIENT_ID,
  clientSecret: env.TUYA_CLIENT_SECRET,
  redis,
});
const app = express();
app.set("trust proxy", env.TRUST_PROXY);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.CORS_ORIGIN.split(","), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const server = http.createServer(app);
const io = new Server(server, { path: "/socket.io", cors: { origin: env.CORS_ORIGIN.split(","), credentials: true }, maxHttpBufferSize: 1e6 });
const key = (v) => new TextEncoder().encode(v);
const requestId = (req, res, next) => { req.requestId = req.get("x-request-id") || crypto.randomUUID(); res.set("x-request-id", req.requestId); next(); };
app.use(requestId);

async function sign(user, secret, ttl) {
  return new SignJWT({ role: user.role, permissions: user.permissions }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuedAt().setExpirationTime(ttl).sign(key(secret));
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
  await db.query("INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,ip,user_agent,request_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [req.user?.sub || null, action, entityType, entityId, req.ip, req.get("user-agent"), req.requestId, beforeState || null, afterState || null]);
}

app.get("/health/live", (_, res) => res.json({ status: "ok", service: "quest-control-api" }));
app.get("/health/ready", async (_, res) => {
  try { await Promise.all([db.query("SELECT 1"), redis.ping()]); res.json({ status: "ready", postgres: "ok", redis: "ok" }); }
  catch (error) { res.status(503).json({ status: "not-ready", error: error.message }); }
});

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
    const { rows } = await db.query("SELECT u.*,r.name role,r.permissions FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1", [payload.sub]);
    const user = rows[0];
    if (!user || !user.refresh_token_hash || !(await argon2.verify(user.refresh_token_hash, req.body.refreshToken))) throw new Error();
    res.json({ accessToken: await sign(user, env.JWT_ACCESS_SECRET, "15m") });
  } catch { res.status(401).json({ error: "INVALID_REFRESH_TOKEN" }); }
});

app.get("/users", auth, permit("users:manage"), async (_, res) => {
  const { rows } = await db.query(`
    SELECT u.id,u.email,u.display_name,u.is_active,u.created_at,r.name AS role
    FROM users u
    JOIN roles r ON r.id=u.role_id
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

const userInput = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(["OWNER", "ADMIN", "OPERATOR", "TECHNICIAN"]),
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
  const { rows } = await db.query(
    `INSERT INTO users(email,password_hash,display_name,role_id)
     VALUES($1,$2,$3,$4)
     RETURNING id,email,display_name,is_active,created_at`,
    [input.email, await argon2.hash(input.password), input.displayName, role.id]
  );
  const user = { ...rows[0], role: input.role };
  await audit(req, "user.create", "user", user.id, null, user);
  res.status(201).json(user);
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

app.get("/dashboard", auth, async (req, res) => {
  const [rooms, bookings, devices] = await Promise.all([
    db.query(`SELECT r.*,l.name location_name,
      COALESCE((SELECT d.status FROM devices d WHERE d.room_id=r.id ORDER BY d.last_seen DESC NULLS LAST LIMIT 1),r.status) live_status
      FROM rooms r JOIN locations l ON l.id=r.location_id ORDER BY r.name`),
    db.query("SELECT b.*,r.name room_name FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE starts_at::date=current_date ORDER BY starts_at"),
    db.query("SELECT status,count(*)::int total FROM devices GROUP BY status")
  ]);
  res.json({ rooms: rooms.rows, bookings: bookings.rows, deviceSummary: devices.rows });
});

app.get("/bookings", auth, permit("bookings:read"), async (_, res) => {
  const { rows } = await db.query(`
    SELECT b.*,r.name room_name,s.id session_id,s.status session_status
    FROM bookings b
    JOIN rooms r ON r.id=b.room_id
    LEFT JOIN sessions s ON s.booking_id=b.id
    ORDER BY b.starts_at DESC LIMIT 250
  `);
  res.json(rows);
});

app.get("/sessions", auth, permit("sessions:read"), async (_, res) => {
  const { rows } = await db.query(`
    SELECT s.*,r.name room_name,b.customer_name
    FROM sessions s JOIN rooms r ON r.id=s.room_id
    LEFT JOIN bookings b ON b.id=s.booking_id
    ORDER BY COALESCE(s.started_at,now()) DESC LIMIT 250
  `);
  res.json(rows);
});

app.post("/sessions", auth, permit("sessions:create"), async (req, res) => {
  const input = z.object({ bookingId:z.string().uuid(), durationSeconds:z.number().int().min(300).max(14400).default(3600) }).parse(req.body);
  const booking = (await db.query("SELECT * FROM bookings WHERE id=$1", [input.bookingId])).rows[0];
  if (!booking) return res.status(404).json({ error:"BOOKING_NOT_FOUND" });
  if ((await db.query("SELECT 1 FROM sessions WHERE booking_id=$1 AND status NOT IN ('FINISHED','CANCELLED')", [booking.id])).rowCount) {
    return res.status(409).json({ error:"SESSION_EXISTS" });
  }
  const { rows } = await db.query(
    "INSERT INTO sessions(booking_id,room_id,status,started_at,remaining_seconds) VALUES($1,$2,'RUNNING',now(),$3) RETURNING *",
    [booking.id,booking.room_id,input.durationSeconds]
  );
  await audit(req,"session.start","session",rows[0].id,null,rows[0]);
  res.status(201).json(rows[0]);
});

app.patch("/sessions/:id", auth, permit("sessions:manage"), async (req, res) => {
  const action = z.enum(["PAUSE","RESUME","FINISH"]).parse(req.body.action);
  const before = (await db.query("SELECT * FROM sessions WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error:"SESSION_NOT_FOUND" });
  const status = action === "PAUSE" ? "PAUSED" : action === "RESUME" ? "RUNNING" : "FINISHED";
  const { rows } = await db.query(
    "UPDATE sessions SET status=$1,ended_at=CASE WHEN $1='FINISHED' THEN now() ELSE ended_at END WHERE id=$2 RETURNING *",
    [status,req.params.id]
  );
  await audit(req,`session.${action.toLowerCase()}`,"session",req.params.id,before,rows[0]);
  res.json(rows[0]);
});

app.post("/rooms", auth, permit("rooms:manage"), async (req, res) => {
  const input = z.object({ locationId:z.string().uuid(),name:z.string().trim().min(2).max(120),kind:z.enum(["REAL","VR"]),capacity:z.number().int().min(1).max(100) }).parse(req.body);
  const { rows } = await db.query(
    "INSERT INTO rooms(location_id,name,kind,capacity,status) VALUES($1,$2,$3,$4,'OFFLINE') RETURNING *",
    [input.locationId,input.name,input.kind,input.capacity]
  );
  await audit(req,"room.create","room",rows[0].id,null,rows[0]);
  res.status(201).json(rows[0]);
});

app.get("/cameras", auth, permit("cameras:read"), async (_, res) => {
  const { rows } = await db.query(`
    SELECT c.id,c.room_id,c.integration_id,c.name,c.provider,c.external_id,c.stream_key,c.status,
           r.name AS room_name
    FROM cameras c
    LEFT JOIN rooms r ON r.id=c.room_id
    ORDER BY c.name
  `);
  res.json(rows);
});

const tuyaCameraCategories = new Set(["sp", "ipc", "camera", "wf_camera"]);
const isTuyaCamera = (device) => {
  const category = String(device.category || device.categoryCode || "").toLowerCase();
  const description = `${device.name || ""} ${device.customName || ""} ${device.productName || ""}`.toLowerCase();
  return tuyaCameraCategories.has(category) || /(camera|камера|ipc|ptz)/i.test(description);
};

app.post("/cameras/sync/tuya", auth, permit("cameras:manage"), async (req, res) => {
  if (!tuya.configured) return res.status(503).json({ error: "TUYA_NOT_CONFIGURED" });
  try {
    const devices = await tuya.listProjectDevices();
    const cameras = devices.filter(isTuyaCamera);
    let created = 0;
    let updated = 0;
    for (const device of cameras) {
      const externalId = String(device.id || device.deviceId || "");
      if (!externalId) continue;
      const name = String(device.customName || device.name || device.productName || `Tuya ${externalId.slice(-6)}`).slice(0, 120);
      const status = (device.isOnline ?? device.online) ? "ONLINE" : "OFFLINE";
      const existing = await db.query("SELECT id FROM cameras WHERE provider='TUYA' AND external_id=$1 LIMIT 1", [externalId]);
      if (existing.rowCount) {
        await db.query("UPDATE cameras SET name=$1,status=$2 WHERE id=$3", [name, status, existing.rows[0].id]);
        updated += 1;
      } else {
        await db.query(
          "INSERT INTO cameras(name,provider,external_id,status,config) VALUES($1,'TUYA',$2,$3,$4)",
          [name, externalId, status, { category: device.category || null, productId: device.productId || null }]
        );
        created += 1;
      }
    }
    const result = { discovered: devices.length, cameras: cameras.length, created, updated };
    await audit(req, "camera.sync", "integration", "tuya", null, result);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.code || "TUYA_SYNC_FAILED", message: error.message });
  }
});

const cameraInput = z.object({
  name: z.string().trim().min(2).max(120),
  roomId: z.string().uuid().nullable().optional(),
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
  const { rows } = await db.query(
    `INSERT INTO cameras(room_id,name,provider,external_id,stream_key,status)
     VALUES($1,$2,$3,$4,$5,'OFFLINE') RETURNING *`,
    [input.roomId || null, input.name, input.provider, input.externalId || null, input.streamKey || null]
  );
  await audit(req, "camera.create", "camera", rows[0].id, null, rows[0]);
  res.status(201).json(rows[0]);
});

app.patch("/cameras/:id", auth, permit("cameras:manage"), async (req, res) => {
  const input = cameraInput.parse(req.body);
  const before = (await db.query("SELECT * FROM cameras WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  const { rows } = await db.query(
    `UPDATE cameras SET room_id=$1,name=$2,provider=$3,external_id=$4,stream_key=$5
     WHERE id=$6 RETURNING *`,
    [input.roomId || null, input.name, input.provider, input.externalId || null, input.streamKey || null, req.params.id]
  );
  await audit(req, "camera.update", "camera", rows[0].id, before, rows[0]);
  res.json(rows[0]);
});

app.delete("/cameras/:id", auth, permit("cameras:manage"), async (req, res) => {
  const { rows } = await db.query("DELETE FROM cameras WHERE id=$1 RETURNING *", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  await audit(req, "camera.delete", "camera", rows[0].id, rows[0], null);
  res.status(204).end();
});

for (const resource of ["locations","rooms","integrations","local_sites","devices","bookings","sessions"]) {
  app.get(`/${resource}`, auth, permit(`${resource}:read`), async (_, res) => res.json((await db.query(`SELECT * FROM ${resource} ORDER BY 1 DESC LIMIT 250`)).rows));
}

app.post("/bookings", auth, permit("bookings:create"), async (req, res) => {
  const input = z.object({ roomId:z.string().uuid(), customerName:z.string().min(2), customerPhone:z.string().optional(), startsAt:z.string().datetime(), endsAt:z.string().datetime(), players:z.number().int().positive(), amountCents:z.number().int().nonnegative().default(0), notes:z.string().max(2000).optional() }).parse(req.body);
  const conflict = await db.query("SELECT 1 FROM bookings WHERE room_id=$1 AND tstzrange(starts_at,ends_at) && tstzrange($2,$3) LIMIT 1", [input.roomId,input.startsAt,input.endsAt]);
  if (conflict.rowCount) return res.status(409).json({ error: "BOOKING_CONFLICT" });
  const { rows } = await db.query("INSERT INTO bookings(room_id,customer_name,customer_phone,starts_at,ends_at,players,amount_cents,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [input.roomId,input.customerName,input.customerPhone||null,input.startsAt,input.endsAt,input.players,input.amountCents,input.notes||null]);
  await audit(req,"booking.create","booking",rows[0].id,null,rows[0]); res.status(201).json(rows[0]);
});

app.post("/rooms/:id/command", auth, permit("devices:command"), async (req, res) => {
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
  const agent = await db.query("SELECT agent_id FROM devices WHERE room_id=$1 AND agent_id IS NOT NULL LIMIT 1", [roomId]);
  if (!agent.rowCount) return { success:false, error:"AGENT_NOT_CONFIGURED" };
  return new Promise(resolve => {
    io.of("/agent").to(`agent:${agent.rows[0].agent_id}`).timeout(8000).emit(event, payload, (err, responses) => {
      resolve(err ? { success:false, error:"AGENT_TIMEOUT" } : responses?.[0] || { success:false, error:"EMPTY_AGENT_RESPONSE" });
    });
  });
}

const krampusRead = z.enum(["status","sensors","logs"]);
app.get("/rooms/:id/krampus/:resource", auth, permit("rooms:read"), async (req,res) => {
  const resource=krampusRead.parse(req.params.resource);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:resource});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/command", auth, permit("devices:command"), async (req,res) => {
  const command=z.string().regex(/^ADMIN [A-Z0-9 _-]{2,120}$/).parse(req.body.command);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:"command",command});
  await audit(req,"krampus.command","room",req.params.id,null,{command,result});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/sound", auth, permit("devices:command"), async (req,res) => {
  const input=z.object({action:z.enum(["play","stop"]),sound:z.enum(["alert.mp3","calling.mp3"]).optional()}).parse(req.body);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:"sound",...input});
  await audit(req,"krampus.sound","room",req.params.id,null,{...input,result});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
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
  const { rows } = await db.query("SELECT * FROM cameras WHERE id=$1", [req.params.id]);
  const camera=rows[0]; if(!camera) return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if(camera.provider==="TUYA") {
    if(!tuya.configured) return res.status(503).json({error:"TUYA_NOT_CONFIGURED"});
    if(!camera.external_id) return res.status(409).json({error:"TUYA_DEVICE_NOT_CONFIGURED"});
    try {
      const endpoint=await tuya.allocateHls(camera.external_id);
      await audit(req,"camera.stream.open","camera",camera.id,null,{provider:"TUYA"});
      return res.json({provider:"TUYA",mode:"hls",endpoint});
    } catch(error) {
      console.error(req.requestId,"Tuya stream allocation failed",error.code,error.message);
      return res.status(502).json({error:"TUYA_STREAM_UNAVAILABLE",providerCode:error.code});
    }
  }
  if(!camera.stream_key) return res.status(409).json({error:"CAMERA_STREAM_NOT_CONFIGURED"});
  const endpoint=`/go2rtc/stream.html?src=${encodeURIComponent(camera.stream_key)}&mode=webrtc,mse`;
  await audit(req,"camera.stream.open","camera",camera.id,null,{provider:camera.provider});
  res.json({provider:camera.provider,mode:"player",endpoint});
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

io.use(async (socket,next) => {
  try { socket.data.user=(await jwtVerify(socket.handshake.auth.token,key(env.JWT_ACCESS_SECRET))).payload; next(); }
  catch { next(new Error("unauthorized")); }
});
io.on("connection", socket => socket.join(`user:${socket.data.user.sub}`));

app.use((err, req, res, _next) => {
  console.error(req.requestId, err);
  if (err instanceof z.ZodError) return res.status(400).json({ error:"INVALID_INPUT",details:err.flatten(),requestId:req.requestId });
  res.status(500).json({ error:"INTERNAL_ERROR",requestId:req.requestId });
});
server.listen(env.PORT, "0.0.0.0", () => console.log(`QuestControl API listening on ${env.PORT}`));
