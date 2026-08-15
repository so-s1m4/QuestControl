import crypto from "node:crypto";

const ID_PATTERN = /^[a-z0-9]{26}$/;
const LEGACY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{70,120}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EXTRA_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{20,180}$/;

const signatureFor = (secret, payload) => crypto
  .createHmac("sha256", secret)
  .update(`quest-control:checkin:v2\0${payload}`, "utf8")
  .digest("base64url");

const extraSignatureFor = (secret, payload) => crypto
  .createHmac("sha256", secret)
  .update(`quest-control:checkin-extra:v1\0${payload}`, "utf8")
  .digest("base64url");

const checkinTokenHash = (token) => crypto.createHash("sha256").update(token,"utf8").digest("base64url");

export function createCheckinToken(secret, clubId, bookingId) {
  if (!ID_PATTERN.test(clubId) || !ID_PATTERN.test(bookingId)) throw new Error("Invalid check-in token identifiers");
  const payload = Buffer.from(JSON.stringify([clubId,bookingId]), "utf8").toString("base64url");
  return `v2.${payload}.${signatureFor(secret,payload)}`;
}

export function isCheckinToken(value) {
  if (typeof value !== "string") return false;
  if (LEGACY_TOKEN_PATTERN.test(value)) return true;
  const [version,payload,signature,...rest] = value.split(".");
  return version === "v2" && PAYLOAD_PATTERN.test(payload || "") && SIGNATURE_PATTERN.test(signature || "") && rest.length === 0;
}

export function checkinTokenMatches(token, secret, clubId, bookingId) {
  if (!LEGACY_TOKEN_PATTERN.test(token || "")) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`quest-control:checkin:v1\0${clubId}\0${bookingId}`, "utf8")
    .digest("base64url");
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export function readCheckinToken(token, secret) {
  if (!isCheckinToken(token) || LEGACY_TOKEN_PATTERN.test(token)) return null;
  const [,payload,signature] = token.split(".");
  const expected = signatureFor(secret,payload);
  if (!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return null;
  try {
    const [clubId,bookingId,...rest] = JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if (rest.length || !ID_PATTERN.test(clubId) || !ID_PATTERN.test(bookingId)) return null;
    return { clubId,bookingId };
  } catch {
    return null;
  }
}

export function createExtraGuestAuthorization(secret, checkinToken, maxGuests, expiresAt = Date.now() + 12 * 60 * 60_000) {
  if (!isCheckinToken(checkinToken) || !Number.isInteger(maxGuests) || maxGuests < 1) {
    throw new Error("Invalid extra guest authorization");
  }
  const payload = Buffer.from(JSON.stringify([checkinTokenHash(checkinToken),maxGuests,expiresAt]),"utf8").toString("base64url");
  return `x1.${payload}.${extraSignatureFor(secret,payload)}`;
}

export function readExtraGuestAuthorization(value, secret, checkinToken, now = Date.now()) {
  if (typeof value !== "string" || !isCheckinToken(checkinToken)) return null;
  const [version,payload,signature,...rest] = value.split(".");
  if (version !== "x1" || !EXTRA_PAYLOAD_PATTERN.test(payload || "") || !SIGNATURE_PATTERN.test(signature || "") || rest.length) return null;
  const expected = extraSignatureFor(secret,payload);
  if (!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return null;
  try {
    const [tokenHash,maxGuests,expiresAt,...extra] = JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if (extra.length || tokenHash !== checkinTokenHash(checkinToken) || !Number.isInteger(maxGuests) || maxGuests < 1 || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
    return { maxGuests,expiresAt };
  } catch {
    return null;
  }
}
