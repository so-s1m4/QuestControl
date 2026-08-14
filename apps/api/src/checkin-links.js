import crypto from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createCheckinToken(secret, clubId, bookingId) {
  return crypto
    .createHmac("sha256", secret)
    .update(`quest-control:checkin:v1\0${clubId}\0${bookingId}`, "utf8")
    .digest("base64url");
}

export function isCheckinToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function checkinTokenMatches(token, secret, clubId, bookingId) {
  if (!isCheckinToken(token)) return false;
  const expected = createCheckinToken(secret, clubId, bookingId);
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
