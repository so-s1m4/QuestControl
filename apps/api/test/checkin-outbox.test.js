import test from "node:test";
import assert from "node:assert/strict";
import { deliverCheckinSubmission, participantFingerprint, matchesSubmittedParticipant } from "../src/checkin-outbox.js";

const input = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "+43 123", birthday: "1990-01-01", gender: "female", acceptWaiver: true, acceptPrivacyPolicy: true, allowMarketingMaterials: false };
const payload = { clubId: "club", bookingId: "booking", bookingDate: "2030-01-01", input };
const success = () => new Response(JSON.stringify({ data: { id: "participant" } }), { status: 201 });

test("first delivery sends the saved form with its explicit consent values", async () => {
  const result = await deliverCheckinSubmission(payload, 0, {
    findParticipant: async () => assert.fail("no reconciliation before first POST"),
    sendParticipant: async saved => { assert.deepEqual(saved, payload); return success(); },
  });
  assert.deepEqual(result, { completed: true, participantId: "participant" });
});

test("a check-in refused outside the upstream window remains pending and is sent automatically later", async () => {
  let posts = 0;
  const delivery = {
    findParticipant: async () => null,
    sendParticipant: async () => ++posts === 1 ? new Response(null, { status: 422 }) : success(),
  };
  assert.deepEqual(await deliverCheckinSubmission(payload, 0, delivery), { completed: false, error: "TIME_TO_GROW_HTTP_422" });
  assert.deepEqual(await deliverCheckinSubmission(payload, 1, delivery), { completed: true, participantId: "participant" });
  assert.equal(posts, 2);
});

test("a POST accepted upstream followed by a lost response does not create another participant", async () => {
  let posts = 0;
  let accepted = null;
  const delivery = {
    findParticipant: async () => accepted,
    sendParticipant: async () => { posts++; accepted = { id: "already-created" }; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); },
  };
  assert.equal((await deliverCheckinSubmission(payload, 0, delivery)).completed, false);
  assert.deepEqual(await deliverCheckinSubmission(payload, 1, delivery), { completed: true, participantId: "already-created" });
  assert.equal(posts, 1);
});

test("a failed reconciliation keeps the saved form pending and does not blindly repeat POST", async () => {
  const result = await deliverCheckinSubmission(payload, 1, {
    findParticipant: async () => { throw Object.assign(new Error("offline"), { code: "TIME_TO_GROW_REQUEST_FAILED" }); },
    sendParticipant: async () => assert.fail("must not risk a duplicate while upstream is unavailable"),
  });
  assert.deepEqual(result, { completed: false, error: "TIME_TO_GROW_REQUEST_FAILED" });
});

test("successful delivery with an empty response body is still complete", async () => {
  assert.deepEqual(await deliverCheckinSubmission(payload, 0, {
    sendParticipant: async () => new Response(null, { status: 204 }),
  }), { completed: true, participantId: null });
});

test("form retries share a fingerprint but different people on participant 1 do not", () => {
  assert.equal(participantFingerprint(input), participantFingerprint({ ...input, firstName: " ADA ", email: "ADA@example.com", participantNumber: 2 }));
  assert.notEqual(participantFingerprint(input), participantFingerprint({ ...input, firstName: "Grace", participantNumber: 1 }));
});

test("reconciliation tolerates upstream phone formatting and omitted gender", () => {
  const player = { first_name: "Ada", last_name: "Lovelace", email: "ADA@example.com", phone: "+43123", birthday: input.birthday };
  assert.equal(matchesSubmittedParticipant(player, input), true);
  assert.equal(matchesSubmittedParticipant({ ...player, email: "other@example.com" }, input), false);
  assert.equal(matchesSubmittedParticipant({ ...player, birthday: "1991-01-01" }, input), false);
});
