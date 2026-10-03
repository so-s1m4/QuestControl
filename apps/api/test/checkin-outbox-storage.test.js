import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { CheckinOutbox } from "../src/checkin-outbox.js";

const migration = await fs.readFile(new URL("../../../infra/postgres/migrations/040-checkin-outbox.sql", import.meta.url), "utf8");
const input = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", phone: "", birthday: "1990-01-01", gender: "female", acceptWaiver: true, acceptPrivacyPolicy: true, allowMarketingMaterials: false, participantNumber: 1 };
const encrypt = value => Buffer.from(JSON.stringify(value));
const decrypt = value => JSON.parse(Buffer.from(value).toString());
const poolFor = database => ({
  query: (sql, params) => database.query(sql, params),
  connect: async () => ({ query: (sql, params) => database.query(sql, params), release() {} }),
});

test("outbox persists a refused check-in across restart, delivers later, and deduplicates retries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quest-checkin-outbox-"));
  let database = new PGlite(directory);
  try {
    await database.exec(migration);
    await database.exec(migration); // Stack migrations can be replayed.
    let posts = 0;
    const queue = new CheckinOutbox({ db: poolFor(database), encrypt, decrypt,
      findParticipant: async () => null,
      sendParticipant: async () => { posts++; return new Response(null, { status: 422 }); },
    });
    const saved = await queue.enqueue("club", "booking", input, "2030-01-01");
    const retry = await queue.enqueue("club", "booking", input, "2030-01-01");
    assert.equal(retry.id, saved.id);
    assert.equal((await queue.process(saved.id)).completed, false);
    const pending = (await database.query("SELECT * FROM checkin_submissions WHERE id=$1", [saved.id])).rows[0];
    assert.equal(pending.attempts, 1);
    assert.equal(pending.last_error, "TIME_TO_GROW_HTTP_422");
    assert.equal(decrypt(pending.encrypted_payload).input.acceptPrivacyPolicy, true);
    assert.equal(await queue.process(saved.id), null); // Honor backoff.
    assert.equal(posts, 1);
    await database.close();

    database = new PGlite(directory);
    const resumed = new CheckinOutbox({ db: poolFor(database), encrypt, decrypt,
      findParticipant: async payload => { assert.equal(payload.bookingDate, "2030-01-01"); return null; },
      sendParticipant: async payload => {
        posts++;
        assert.equal(payload.input.allowMarketingMaterials, false);
        return new Response(JSON.stringify({ data: { id: "upstream-player" } }), { status: 201 });
      },
    });
    await database.query("UPDATE checkin_submissions SET next_attempt_at=now() WHERE id=$1", [saved.id]);
    await resumed.runOnce();
    const completed = (await database.query("SELECT * FROM checkin_submissions WHERE id=$1", [saved.id])).rows[0];
    assert.ok(completed.completed_at);
    assert.equal(completed.encrypted_payload, null);
    assert.equal(completed.last_error, null);
    const duplicate = await resumed.enqueue("club", "booking", input, "2030-01-01");
    assert.ok(duplicate.completed_at);
    assert.equal(duplicate.id, saved.id);
    assert.equal(await resumed.process(duplicate.id), null);
    assert.equal(posts, 2);
    const otherPerson = await resumed.enqueue("club", "booking", { ...input, firstName: "Grace" }, "2030-01-01");
    assert.notEqual(otherPerson.id, saved.id);
  } finally {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a crash after an upstream POST leaves a committed attempt for reconciliation", async () => {
  const database = new PGlite();
  try {
    await database.exec(migration);
    let accepted = null, posts = 0;
    const pool = poolFor(database);
    const queue = new CheckinOutbox({ db: pool, encrypt, decrypt,
      findParticipant: async () => accepted,
      sendParticipant: async () => {
        posts++;
        accepted = { id: "upstream-player" };
        return new Response(JSON.stringify({ data: accepted }), { status: 201 });
      },
    });
    const saved = await queue.enqueue("club", "booking", input, "2030-01-01");
    // Inject a local persistence failure after the remote service accepted it.
    pool.connect = async () => ({
      query: async (sql, params) => {
        if (sql.includes("SET completed_at=now()")) throw new Error("database connection lost");
        return database.query(sql, params);
      },
      release() {},
    });
    await assert.rejects(queue.process(saved.id), /database connection lost/);
    assert.equal((await database.query("SELECT attempts FROM checkin_submissions WHERE id=$1", [saved.id])).rows[0].attempts, 1);
    pool.connect = poolFor(database).connect;
    await queue.runOnce();
    assert.equal(posts, 1);
    assert.ok((await database.query("SELECT completed_at FROM checkin_submissions WHERE id=$1", [saved.id])).rows[0].completed_at);
  } finally { await database.close(); }
});
