import test from "node:test";
import assert from "node:assert/strict";
import {
  checkinTokenMatches,
  createCheckinToken,
  createExtraGuestAuthorization,
  isCheckinToken,
  readCheckinToken,
  readExtraGuestAuthorization,
} from "../src/checkin-links.js";

const secret = "a-secret-that-is-long-enough-for-production-tests";
const clubId = "01js42s5vwvwrx3fme9zvgdj1v";
const bookingId = "01js4ahx79xbw5gd05jy1mmsdw";

test("check-in token is signed, stable and booking-specific", () => {
  const token = createCheckinToken(secret, clubId, bookingId);
  assert.equal(isCheckinToken(token), true);
  assert.equal(token.includes(bookingId), false);
  assert.equal(token, createCheckinToken(secret, clubId, bookingId));
  assert.notEqual(token, createCheckinToken(secret, clubId, `${bookingId.slice(0, -1)}x`));
  assert.deepEqual(readCheckinToken(token,secret),{ clubId,bookingId });
});

test("check-in token rejects tampering and another secret", () => {
  const token = createCheckinToken(secret,clubId,bookingId);
  assert.equal(readCheckinToken(`${token.slice(0,-1)}A`,secret),null);
  assert.equal(readCheckinToken(token,"another-secret-that-is-long-enough-for-tests"),null);
  assert.equal(readCheckinToken("not-a-token",secret),null);
});

test("legacy check-in links remain valid", () => {
  const legacy = "Czu8IVzNwrpB0fPLC9L6wZxOZTzNwqhHmza-oFyam0I";
  assert.equal(isCheckinToken(legacy),true);
  assert.equal(checkinTokenMatches(legacy,secret,clubId,bookingId),true);
  assert.equal(checkinTokenMatches(legacy,secret,"01js4ahx79xbw5gd05jy1mmsdw",bookingId),false);
});

test("extra guest authorization is booking-link specific and expires", () => {
  const token=createCheckinToken(secret,clubId,bookingId);
  const anotherToken=createCheckinToken(secret,clubId,`${bookingId.slice(0,-1)}x`);
  const authorization=createExtraGuestAuthorization(secret,token,7,2_000);
  assert.deepEqual(readExtraGuestAuthorization(authorization,secret,token,1_000),{maxGuests:7,expiresAt:2_000});
  assert.equal(readExtraGuestAuthorization(authorization,secret,anotherToken,1_000),null);
  assert.equal(readExtraGuestAuthorization(authorization,secret,token,2_000),null);
  assert.equal(readExtraGuestAuthorization(`${authorization.slice(0,-1)}A`,secret,token,1_000),null);
});
