import test from "node:test";
import assert from "node:assert/strict";
import { createCheckinToken } from "../src/checkin-links.js";
import { resolveCheckinBooking, findPaginatedCheckinRecord } from "../src/checkin-reservations.js";

const secret = "a-secret-that-is-long-enough-for-production-tests";
const clubId = "01js42s5vwvwrx3fme9zvgdj1v";
const bookingId = "01js4ahx79xbw5gd05jy1mmsdw";
const token = createCheckinToken(secret, clubId, bookingId);

for (const date of ["2020-01-01", "2030-01-01"]) {
  test(`cached link works outside the visit window (${date}), without fetching visits`, async () => {
    const snapshot = { visit: { id: bookingId, booking_id: bookingId, start: { date, time: "15:00" }, size: 4 } };
    const result = await resolveCheckinBooking(token, {
      secret, config: { viennaClubId: clubId },
      readSnapshots: async signed => {
        assert.deepEqual(signed, { clubId, bookingId });
        return [{ clubId, bookingId, snapshot }];
      },
      findRecord: async () => assert.fail("cached link must not depend on upcoming visits"),
    });
    assert.deepEqual(result, { location: "vienna", clubId, ...snapshot });
  });
}

test("signed link falls back to the admin booking when no app visit exists", async () => {
  const booking = { id: bookingId, size: 3, start: { date: "2030-01-01", time: "12:30" }, owner: { name: "Team" } };
  const calls = [];
  const result = await resolveCheckinBooking(token, {
    secret, config: {}, readSnapshots: async () => [],
    findRecord: async (club, matches, admin) => {
      calls.push(admin);
      assert.equal(club, clubId);
      assert.equal(matches(admin ? booking : { booking_id: bookingId }), true);
      assert.equal(matches({ id: `${bookingId.slice(0, -1)}x`, booking_id: `${bookingId.slice(0, -1)}x` }), false);
      return admin ? booking : null;
    },
  });
  assert.deepEqual(calls, [false, true]);
  assert.equal(result.visit.booking_id, bookingId);
  assert.equal(result.visit.size, 3);
  assert.equal(result.visit.start.date, "2030-01-01");
});

test("invalid signature does not query stored or upstream bookings", async () => {
  const wrongToken = createCheckinToken("wrong-secret", clubId, bookingId);
  assert.equal(await resolveCheckinBooking(wrongToken, {
    secret, config: {}, readSnapshots: async () => assert.fail(), findRecord: async () => assert.fail(),
  }), null);
});

test("legacy links resolve saved bookings after their visit has ended", async () => {
  const snapshot = { visit: { id: bookingId, booking_id: bookingId, size: 2 } };
  const result = await resolveCheckinBooking("Czu8IVzNwrpB0fPLC9L6wZxOZTzNwqhHmza-oFyam0I", {
    secret, config: {}, readSnapshots: async signed => {
      assert.equal(signed, null);
      return [{ clubId, bookingId, snapshot }];
    },
    findRecord: async () => assert.fail(),
  });
  assert.equal(result.visit.booking_id, bookingId);
});

test("booking lookup checks later pages even when the upstream caps page size", async () => {
  const pages = [];
  const result = await findPaginatedCheckinRecord(async page => {
    pages.push(page);
    return { data: page === 3 ? [{ id: bookingId }] : [{ id: `other-${page}` }] };
  }, row => row.id === bookingId);
  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.id, bookingId);
});

test("booking lookup terminates on empty pages or broken upstream pagination", async () => {
  assert.equal(await findPaginatedCheckinRecord(async () => ({ data: [] }), () => false), null);
  await assert.rejects(findPaginatedCheckinRecord(async () => ({ data: [{ id: "same" }] }), () => false), /did not advance/);
});
