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
  PSEUDONYMIZATION_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string(),
  TRUST_PROXY: z.coerce.number().default(1),
  TUYA_BASE_URL: z.string().url().default("https://openapi.tuyaeu.com"),
  TUYA_CLIENT_ID: z.string().optional(),
  TUYA_CLIENT_SECRET: z.string().optional(),
  TIME_TO_GROW_BASE_URL: z.string().url().default("https://api.time-to-grow.com"),
  TIME_TO_GROW_CLUB_ID: z.string().optional(),
  TIME_TO_GROW_JWT: z.string().optional(),
  TIME_TO_GROW_EMAIL: z.union([z.string().email(), z.literal("")]).optional(),
  TIME_TO_GROW_PASSWORD: z.string().optional(),
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
const isOwner = (req) => req.user?.role === "OWNER";
const canConfigureCameras = (req) => ["OWNER","ADMIN"].includes(req.user?.role);
async function locationAllowed(req, locationId) {
  if (isOwner(req)) return true;
  return Boolean((await db.query("SELECT 1 FROM user_locations WHERE user_id=$1 AND location_id=$2", [req.user.sub, locationId])).rowCount);
}
app.set("trust proxy", env.TRUST_PROXY);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.CORS_ORIGIN.split(","), credentials: true }));
app.use(express.json({ limit: "8mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const server = http.createServer(app);
const io = new Server(server, { path: "/socket.io", cors: { origin: env.CORS_ORIGIN.split(","), credentials: true }, maxHttpBufferSize: 1e6 });
const key = (v) => new TextEncoder().encode(v);
const normalizeEmail = (email) => email.trim().normalize("NFKC").toLowerCase();
const identityToken = (email) => crypto
  .createHmac("sha256", env.PSEUDONYMIZATION_SECRET)
  .update(normalizeEmail(email), "utf8")
  .digest();
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

app.patch("/auth/password", auth, async (req,res) => {
  const input=z.object({currentPassword:z.string().min(1).max(200),newPassword:z.string().min(12).max(200)}).parse(req.body);
  const user=(await db.query("SELECT id,password_hash FROM users WHERE id=$1 AND is_active=true",[req.user.sub])).rows[0];
  if(!user || !(await argon2.verify(user.password_hash,input.currentPassword))) return res.status(400).json({error:"CURRENT_PASSWORD_INVALID"});
  await db.query("UPDATE users SET password_hash=$1,refresh_token_hash=NULL WHERE id=$2",[await argon2.hash(input.newPassword),req.user.sub]);
  await audit(req,"user.password.change","user",req.user.sub,null,{changed:true});
  res.status(204).end();
});

app.get("/users", auth, permit("users:manage"), async (_, res) => {
  const { rows } = await db.query(`
    SELECT u.id,u.email,u.display_name,u.is_active,u.created_at,r.name AS role,
           COALESCE(array_agg(ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL),'{}') AS location_ids
    FROM users u
    JOIN roles r ON r.id=u.role_id
    LEFT JOIN user_locations ul ON ul.user_id=u.id
    GROUP BY u.id,r.name
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

const userInput = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(120),
  password: z.string().min(12).max(200),
  role: z.enum(["OWNER", "ADMIN", "OPERATOR", "TECHNICIAN"]),
  locationIds: z.array(z.string().uuid()).default([]),
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  const user = { ...rows[0], role: input.role };
  await audit(req, "user.create", "user", user.id, null, user);
  res.status(201).json(user);
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

app.get("/dashboard", auth, async (req, res) => {
  const scope = isOwner(req) ? { clause:"TRUE", values:[] } : { clause:"r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)", values:[req.user.sub] };
  const [rooms, bookings, devices] = await Promise.all([
    db.query(`SELECT r.*,l.name location_name,
      COALESCE((SELECT d.status FROM devices d WHERE d.room_id=r.id ORDER BY d.last_seen DESC NULLS LAST LIMIT 1),r.status) live_status
      FROM rooms r JOIN locations l ON l.id=r.location_id WHERE ${scope.clause} ORDER BY r.name`,scope.values),
    db.query(`SELECT b.*,r.name room_name FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE starts_at::date=current_date AND ${scope.clause} ORDER BY starts_at`,scope.values),
    db.query(`SELECT d.status,count(*)::int total FROM devices d JOIN rooms r ON r.id=d.room_id WHERE ${scope.clause} GROUP BY d.status`,scope.values)
  ]);
  res.json({ rooms: rooms.rows, bookings: bookings.rows, deviceSummary: devices.rows });
});

app.get("/bookings", auth, permit("bookings:read"), async (req, res) => {
  const scoped = isOwner(req) ? { clause:"TRUE", values:[] } : { clause:"r.location_id IN (SELECT location_id FROM user_locations WHERE user_id=$1)", values:[req.user.sub] };
  const { rows } = await db.query(`
    SELECT b.*,r.name room_name,s.id session_id,s.status session_status
    FROM bookings b
    JOIN rooms r ON r.id=b.room_id
    LEFT JOIN sessions s ON s.booking_id=b.id
    WHERE ${scoped.clause}
    ORDER BY b.starts_at DESC LIMIT 250
  `,scoped.values);
  res.json(rows);
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
async function timeToGrowLogin(force = false) {
  if (timeToGrowJwt && !force) return timeToGrowJwt;
  if (!env.TIME_TO_GROW_EMAIL || !env.TIME_TO_GROW_PASSWORD) {
    const error = new Error("Time to Grow credentials are not configured");
    error.code = "TIME_TO_GROW_NOT_CONFIGURED";
    throw error;
  }
  const response = await fetch(`${env.TIME_TO_GROW_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email: env.TIME_TO_GROW_EMAIL, password: env.TIME_TO_GROW_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error("Time to Grow login failed");
    error.code = "TIME_TO_GROW_LOGIN_FAILED";
    error.upstreamStatus = response.status;
    throw error;
  }
  const setCookie = response.headers.get("set-cookie") || "";
  const jwt = setCookie.match(/(?:^|[,;\s])jwt=([^;,\s]+)/)?.[1];
  if (!jwt) {
    const error = new Error("Time to Grow login response has no JWT cookie");
    error.code = "TIME_TO_GROW_INVALID_LOGIN_RESPONSE";
    throw error;
  }
  timeToGrowJwt = jwt;
  return jwt;
}

async function timeToGrowFetch(path) {
  let jwt = await timeToGrowLogin();
  let response = await fetch(`${env.TIME_TO_GROW_BASE_URL}${path}`, {
    headers: { accept: "application/json", cookie: `jwt=${jwt}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 && env.TIME_TO_GROW_EMAIL && env.TIME_TO_GROW_PASSWORD) {
    jwt = await timeToGrowLogin(true);
    response = await fetch(`${env.TIME_TO_GROW_BASE_URL}${path}`, {
      headers: { accept: "application/json", cookie: `jwt=${jwt}` },
      signal: AbortSignal.timeout(10_000),
    });
  }
  return response;
}

app.get("/time-to-grow/clubs", auth, permit("bookings:read"), async (_, res) => {
  try {
    const response = await timeToGrowFetch("/api/admin/clubs");
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
      defaultClubId: visibleClubs.some(club=>club.id===env.TIME_TO_GROW_CLUB_ID) ? env.TIME_TO_GROW_CLUB_ID : visibleClubs[0]?.id || null,
    });
  } catch (error) {
    if (error?.code === "TIME_TO_GROW_NOT_CONFIGURED") return res.status(503).json({ error: error.code });
    const code = error?.name === "TimeoutError" ? "TIME_TO_GROW_TIMEOUT" : (error?.code || "TIME_TO_GROW_INVALID_RESPONSE");
    res.status(502).json({ error: code, upstreamStatus: error?.upstreamStatus });
  }
});

app.get("/time-to-grow/bookings", auth, permit("bookings:read"), async (req, res) => {
  if (!timeToGrowJwt && (!env.TIME_TO_GROW_EMAIL || !env.TIME_TO_GROW_PASSWORD)) {
    return res.status(503).json({ error: "TIME_TO_GROW_NOT_CONFIGURED" });
  }
  const parsed = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    clubId: z.string().regex(/^[a-z0-9]{26}$/).optional(),
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DATE" });
  const clubId = parsed.data.clubId || env.TIME_TO_GROW_CLUB_ID;
  if (!clubId) return res.status(400).json({ error: "CLUB_REQUIRED" });
  if (!isOwner(req)) {
    const allowed = await db.query("SELECT 1 FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=$1 AND l.external_id=$2", [req.user.sub,clubId]);
    if (!allowed.rowCount) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  }

  const query = new URLSearchParams({
    filtering: JSON.stringify({ status: "reserved", start_date: parsed.data.date, view_mode: "bookings" }),
    pagination: JSON.stringify({ page: 1, size: 100 }),
    sorting: JSON.stringify([{ name: "smart", direction: "desc" }]),
  });

  try {
    const response = await timeToGrowFetch(`/api/admin/clubs/${encodeURIComponent(clubId)}/bookings?${query}`);
    if (!response.ok) {
      return res.status(502).json({ error: "TIME_TO_GROW_REQUEST_FAILED", upstreamStatus: response.status });
    }
    const payload = await response.json();
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
    }).passthrough()).parse(payload.data);

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

    res.json({
      data: bookings.map(booking => ({
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
        currency: "EUR",
        paymentStatus: booking.order.payment_status,
        paymentStatusDisplay: booking.order.payment_status_display,
        checkedIn: booking.check_in_status?.checked_in ?? 0,
        checkInTotal: booking.check_in_status?.total ?? booking.size,
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

app.get("/sessions", auth, permit("sessions:read"), async (req, res) => {
  if (!["OWNER","ADMIN"].includes(req.user?.role)) return res.status(403).json({ error:"SESSIONS_HISTORY_FORBIDDEN" });
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
    SELECT s.*,r.name room_name,r.location_id,l.name location_name,
           count(sp.person_id)::int player_count,
           count(sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_player_count,
           count(sp.person_id) FILTER (WHERE p.identity_type='BOOKING_RANDOM')::int anonymous_player_count,
           CASE WHEN s.started_at IS NULL THEN NULL
             ELSE extract(epoch FROM (COALESCE(s.ended_at,now())-s.started_at))::int
           END elapsed_seconds
    FROM sessions s
    JOIN rooms r ON r.id=s.room_id
    JOIN locations l ON l.id=r.location_id
    LEFT JOIN session_participants sp ON sp.session_id=s.id
    LEFT JOIN people p ON p.id=sp.person_id
    WHERE ${scopeClause} AND ${locationClause} AND ${dateClause}
    GROUP BY s.id,r.id,r.name,r.location_id,l.name
    ORDER BY COALESCE(s.started_at,now()) DESC LIMIT 250
  `,values);
  res.json(rows);
});

app.post("/sessions", auth, permit("sessions:create"), async (req, res) => {
  const input = z.object({ bookingId:z.string().uuid(), durationSeconds:z.number().int().min(300).max(14400).default(3600) }).parse(req.body);
  const booking = (await db.query("SELECT * FROM bookings WHERE id=$1", [input.bookingId])).rows[0];
  if (!booking) return res.status(404).json({ error:"BOOKING_NOT_FOUND" });
  const bookingRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[booking.room_id])).rows[0];
  if (!bookingRoom || !(await locationAllowed(req,bookingRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  if ((await db.query("SELECT 1 FROM sessions WHERE booking_id=$1 AND status NOT IN ('FINISHED','CANCELLED')", [booking.id])).rowCount) {
    return res.status(409).json({ error:"SESSION_EXISTS" });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "INSERT INTO sessions(booking_id,room_id,status,started_at,remaining_seconds) VALUES($1,$2,'RUNNING',now(),$3) RETURNING *",
      [booking.id,booking.room_id,input.durationSeconds]
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
    res.status(201).json(rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.patch("/sessions/:id", auth, permit("sessions:manage"), async (req, res) => {
  const action = z.enum(["PAUSE","RESUME","FINISH"]).parse(req.body.action);
  const before = (await db.query("SELECT * FROM sessions WHERE id=$1", [req.params.id])).rows[0];
  if (!before) return res.status(404).json({ error:"SESSION_NOT_FOUND" });
  const sessionRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[before.room_id])).rows[0];
  if (!sessionRoom || !(await locationAllowed(req,sessionRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const status = action === "PAUSE" ? "PAUSED" : action === "RESUME" ? "RUNNING" : "FINISHED";
  const { rows } = await db.query(
    "UPDATE sessions SET status=$1,ended_at=CASE WHEN $1='FINISHED' THEN now() ELSE ended_at END WHERE id=$2 RETURNING *",
    [status,req.params.id]
  );
  await audit(req,`session.${action.toLowerCase()}`,"session",req.params.id,before,rows[0]);
  res.json(rows[0]);
});

app.get("/statistics/players", auth, permit("statistics:read"), async (req, res) => {
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
    WHERE s.started_at >= $1::date
      AND s.started_at < ($2::date + interval '1 day')
      AND ${scoped.clause}
  `;
  const [summary,crossLocation,categories,ageBands,games,locations] = await Promise.all([
    db.query(`SELECT count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(*) FILTER (WHERE p.identity_type='BOOKING_RANDOM')::int anonymous_player_plays,count(DISTINCT s.id)::int sessions ${base}`,scoped.values),
    db.query(`SELECT count(*)::int cross_location_players FROM (SELECT sp.person_id ${base} AND p.identity_type='EMAIL_HMAC' GROUP BY sp.person_id HAVING count(DISTINCT r.location_id)>1) visitors`,scoped.values),
    db.query(`SELECT COALESCE(sp.category_at_play,'UNKNOWN') category,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players ${base} GROUP BY 1 ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT COALESCE(sp.age_band_at_play,'UNKNOWN') age_band,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players ${base} GROUP BY 1 ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT r.id room_id,r.name game,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(DISTINCT s.id)::int sessions ${base} GROUP BY r.id,r.name ORDER BY player_plays DESC`,scoped.values),
    db.query(`SELECT l.id location_id,l.name location,count(*)::int player_plays,count(DISTINCT sp.person_id) FILTER (WHERE p.identity_type='EMAIL_HMAC')::int identified_unique_players,count(DISTINCT s.id)::int sessions ${base} GROUP BY l.id,l.name ORDER BY player_plays DESC`,scoped.values),
  ]);
  res.json({
    period: input,
    summary: { ...summary.rows[0], ...crossLocation.rows[0] },
    byCategory: categories.rows,
    byAgeBand: ageBands.rows,
    byGame: games.rows,
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

app.get("/cameras", auth, permit("cameras:read"), async (req, res) => {
  const scoped = isOwner(req) ? { clause:"TRUE", values:[] } : { clause:"COALESCE(c.location_id,r.location_id) IN (SELECT location_id FROM user_locations WHERE user_id=$1)", values:[req.user.sub] };
  const { rows } = await db.query(`
    SELECT c.id,c.room_id,c.integration_id,c.name,c.provider,c.external_id,c.stream_key,c.status,
           c.plan_x,c.plan_y,COALESCE(c.location_id,r.location_id) AS location_id,r.name AS room_name
    FROM cameras c
    LEFT JOIN rooms r ON r.id=c.room_id
    WHERE ${scoped.clause}
    ORDER BY c.name
  `,scoped.values);
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
      const existing = await db.query("SELECT id FROM cameras WHERE provider='TUYA' AND external_id=$1 LIMIT 1", [externalId]);
      if (existing.rowCount) {
        await db.query("UPDATE cameras SET name=$1,status=$2,room_id=COALESCE(room_id,$3) WHERE id=$4", [name, status, autoRoomId, existing.rows[0].id]);
        updated += 1;
      } else {
        await db.query(
          "INSERT INTO cameras(room_id,name,provider,external_id,status,config) VALUES($1,$2,'TUYA',$3,$4,$5)",
          [autoRoomId, name, externalId, status, { category: device.category || null, productId: device.productId || null }]
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
  res.json(rows[0]);
});

app.patch("/cameras/:id/room", auth, permit("cameras:manage"), async (req,res) => {
  const { roomId } = z.object({ roomId:z.string().uuid() }).parse(req.body);
  const room = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[roomId])).rows[0];
  if (!room || !(await locationAllowed(req,room.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const { rows } = await db.query("UPDATE cameras SET room_id=$1,location_id=$2 WHERE id=$3 RETURNING *",[roomId,room.location_id,req.params.id]);
  if (!rows[0]) return res.status(404).json({ error:"CAMERA_NOT_FOUND" });
  await audit(req,"camera.room.assign","camera",req.params.id,null,{roomId});
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
  if(!before.effective_location_id || !(await locationAllowed(req,before.effective_location_id))) return res.status(403).json({error:"LOCATION_FORBIDDEN"});
  const { rows }=await db.query("UPDATE cameras SET name=$1 WHERE id=$2 RETURNING *",[name,req.params.id]);
  await audit(req,"camera.name.update","camera",req.params.id,{name:before.name},{name});
  res.json(rows[0]);
});

app.get("/camera-settings", auth, async (req,res) => {
  if(!canConfigureCameras(req)) return res.status(403).json({error:"CAMERA_SETTINGS_FORBIDDEN"});
  const scoped=isOwner(req)
    ? {clause:"TRUE",values:[]}
    : {clause:"COALESCE(c.location_id,r.location_id) IS NULL OR COALESCE(c.location_id,r.location_id) IN (SELECT location_id FROM user_locations WHERE user_id=$1)",values:[req.user.sub]};
  const { rows }=await db.query(`
    SELECT c.id,c.name,c.provider,c.external_id,c.status,c.location_id,c.room_id,c.plan_zone_id,
           l.name AS location_name,r.name AS room_name,z.name AS zone_name
    FROM cameras c
    LEFT JOIN locations l ON l.id=c.location_id
    LEFT JOIN rooms r ON r.id=c.room_id
    LEFT JOIN plan_zones z ON z.id=c.plan_zone_id
    WHERE ${scoped.clause}
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
  const { rows } = await db.query("DELETE FROM cameras WHERE id=$1 RETURNING *", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "CAMERA_NOT_FOUND" });
  await audit(req, "camera.delete", "camera", rows[0].id, rows[0], null);
  res.status(204).end();
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

app.get("/rooms", auth, permit("rooms:read"), async (req,res) => {
  const { rows } = isOwner(req)
    ? await db.query("SELECT r.*,l.name location_name FROM rooms r JOIN locations l ON l.id=r.location_id ORDER BY l.name,r.name")
    : await db.query("SELECT r.*,l.name location_name FROM rooms r JOIN locations l ON l.id=r.location_id JOIN user_locations ul ON ul.location_id=r.location_id WHERE ul.user_id=$1 ORDER BY l.name,r.name",[req.user.sub]);
  res.json(rows);
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
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const resource=krampusRead.parse(req.params.resource);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:resource});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/command", auth, permit("devices:command"), async (req,res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
  const command=z.string().regex(/^ADMIN [A-Z0-9 _-]{2,120}$/).parse(req.body.command);
  const result=await roomAgentRequest(req.params.id,"krampus",{operation:"command",command});
  await audit(req,"krampus.command","room",req.params.id,null,{command,result});
  res.status(result.success ? 200 : 502).json(result.success ? result.result : {error:result.error});
});

app.post("/rooms/:id/krampus/sound", auth, permit("devices:command"), async (req,res) => {
  const targetRoom = (await db.query("SELECT location_id FROM rooms WHERE id=$1",[req.params.id])).rows[0];
  if (!targetRoom || !(await locationAllowed(req,targetRoom.location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
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
  const { rows } = await db.query("SELECT c.*,COALESCE(c.location_id,r.location_id) AS effective_location_id FROM cameras c LEFT JOIN rooms r ON r.id=c.room_id WHERE c.id=$1", [req.params.id]);
  const camera=rows[0]; if(!camera) return res.status(404).json({error:"CAMERA_NOT_FOUND"});
  if (!camera.effective_location_id || !(await locationAllowed(req,camera.effective_location_id))) return res.status(403).json({ error:"LOCATION_FORBIDDEN" });
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
await db.query("ALTER TABLE locations ADD COLUMN IF NOT EXISTS external_id text");
await db.query("CREATE UNIQUE INDEX IF NOT EXISTS locations_external_id_idx ON locations(external_id) WHERE external_id IS NOT NULL");
await db.query("CREATE TABLE IF NOT EXISTS user_locations(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,PRIMARY KEY(user_id,location_id))");
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
server.listen(env.PORT, "0.0.0.0", () => console.log(`QuestControl API listening on ${env.PORT}`));
