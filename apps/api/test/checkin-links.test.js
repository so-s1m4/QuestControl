import test from "node:test";
import assert from "node:assert/strict";
import {
  checkinTokenMatches,
  createCheckinToken,
  isCheckinToken,
} from "../src/checkin-links.js";

const secret = "a-secret-that-is-long-enough-for-production-tests";
const clubId = "01js42s5vwvwrx3fme9zvgdj1v";
const bookingId = "01js4ahx79xbw5gd05jy1mmsdw";

test("check-in token is opaque, stable and booking-specific", () => {
  const token = createCheckinToken(secret, clubId, bookingId);
  assert.equal(isCheckinToken(token), true);
  assert.equal(token.length, 43);
  assert.equal(token.includes(bookingId), false);
  assert.equal(token, createCheckinToken(secret, clubId, bookingId));
  assert.notEqual(token, createCheckinToken(secret, clubId, `${bookingId.slice(0, -1)}x`));
});

test("check-in token cannot be reused for another club or booking", () => {
  const token = createCheckinToken(secret, clubId, bookingId);
  assert.equal(checkinTokenMatches(token, secret, clubId, bookingId), true);
  assert.equal(checkinTokenMatches(token, secret, "01js4ahx79xbw5gd05jy1mmsdw", bookingId), false);
  assert.equal(checkinTokenMatches(token, secret, clubId, "01js42s5vwvwrx3fme9zvgdj1v"), false);
  assert.equal(checkinTokenMatches(`${token.slice(0, -1)}A`, secret, clubId, bookingId), false);
  assert.equal(checkinTokenMatches("not-a-token", secret, clubId, bookingId), false);
});
