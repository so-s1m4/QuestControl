import crypto from "node:crypto";

export function matchesSubmittedParticipant(player, input) {
  const text = value => String(value || "").trim().toLocaleLowerCase("en");
  return text(player.first_name) === text(input.firstName)
    && text(player.last_name) === text(input.lastName)
    && text(player.email) === text(input.email)
    && player.birthday === input.birthday
    && (!player.gender || player.gender === input.gender);
}

export function participantFingerprint(input) {
  const normalized = [
    input.firstName ?? input.first_name,
    input.lastName ?? input.last_name,
    input.email,
  ].map(value => String(value || "").trim().toLocaleLowerCase("en"));
  return crypto.createHash("sha256").update(JSON.stringify([
    ...normalized,
    String(input.phone || "").trim(),
    input.birthday,
    input.gender,
  ])).digest("hex");
}

// An interrupted POST may already have succeeded upstream. Reconcile before
// retrying it; if reconciliation is unavailable, keep the form in the outbox.
export async function deliverCheckinSubmission(payload, attempts, { findParticipant, sendParticipant }) {
  try {
    if (attempts > 0) {
      const existing = await findParticipant(payload);
      if (existing) return { completed: true, participantId: existing.id || null };
    }
    const response = await sendParticipant(payload);
    if (!response.ok) return { completed: false, error: `TIME_TO_GROW_HTTP_${response.status}` };
    // Do not lose a successful delivery if the response has no JSON body.
    const body = await response.json().catch(() => null);
    return { completed: true, participantId: body?.data?.id || null };
  } catch (error) {
    return { completed: false, error: error?.code || error?.name || "TIME_TO_GROW_REQUEST_FAILED" };
  }
}

export class CheckinOutbox {
  constructor({ db, encrypt, decrypt, findParticipant, sendParticipant }) {
    Object.assign(this, { db, encrypt, decrypt, findParticipant, sendParticipant });
    this.busy = false;
  }

  async enqueue(clubId, bookingId, input, bookingDate) {
    const payload = { clubId, bookingId, input, bookingDate };
    const result = await this.db.query(`
      INSERT INTO checkin_submissions (club_id,booking_id,fingerprint,encrypted_payload)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (club_id,booking_id,fingerprint) DO UPDATE
        SET fingerprint=checkin_submissions.fingerprint
      RETURNING id,completed_at,participant_id
    `, [clubId, bookingId, participantFingerprint(input), this.encrypt(payload)]);
    return result.rows[0];
  }

  async process(id) {
    const client = await this.db.connect();
    let hasLock = false;
    try {
      await client.query("BEGIN");
      // Serialize claiming a row before acquiring its session advisory lock.
      const row = (await client.query(`
        SELECT * FROM checkin_submissions
        WHERE id=$1 AND completed_at IS NULL AND next_attempt_at<=now()
        FOR UPDATE SKIP LOCKED
      `, [id])).rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      // Commit the attempt before POSTing: a process crash must force
      // reconciliation on the next attempt. The session advisory lock stays
      // held across that commit and is explicitly released before returning
      // this connection to the pool.
      const locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [id])).rows[0]?.locked;
      if (!locked) {
        await client.query("COMMIT");
        return null;
      }
      hasLock = true;
      await client.query("UPDATE checkin_submissions SET attempts=attempts+1 WHERE id=$1", [id]);
      await client.query("COMMIT");
      const payload = this.decrypt(row.encrypted_payload);
      const result = await deliverCheckinSubmission(payload, row.attempts, this);
      if (result.completed) {
        await client.query(`
          UPDATE checkin_submissions SET completed_at=now(),participant_id=$2,
            encrypted_payload=NULL,last_error=NULL WHERE id=$1
        `, [id, result.participantId]);
      } else {
        const delaySeconds = Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6));
        await client.query(`
          UPDATE checkin_submissions SET last_error=$2,
            next_attempt_at=now()+($3*interval '1 second') WHERE id=$1
        `, [id, result.error, delaySeconds]);
      }
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      let releaseError;
      if (hasLock) {
        try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [id]); }
        catch (error) { releaseError = error; }
      }
      // Destroy a connection that could still own the lock instead of putting
      // it back into the pool with a session lock attached.
      client.release(releaseError);
    }
  }

  async runOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const { rows } = await this.db.query(`
        SELECT id FROM checkin_submissions
        WHERE completed_at IS NULL AND next_attempt_at<=now()
        ORDER BY next_attempt_at LIMIT 25
      `);
      for (const row of rows) {
        try { await this.process(row.id); }
        catch (error) { console.error("Check-in outbox entry failed", { submissionId: row.id, code: error?.code || error?.name }); }
      }
    } finally {
      this.busy = false;
    }
  }
}
