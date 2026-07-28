import test from "node:test";
import assert from "node:assert/strict";
import { createTuyaHeaders } from "../src/tuya.js";

test("Tuya request signature is stable and includes the token", () => {
  const headers = createTuyaHeaders({
    clientId: "client",
    clientSecret: "secret",
    method: "POST",
    path: "/v1.0/devices/device/stream/actions/allocate",
    body: '{"type":"HLS"}',
    accessToken: "token",
    timestamp: 1700000000000,
    nonce: "fixed-nonce",
  });
  assert.deepEqual(headers, {
    client_id: "client",
    sign: "DC15903CCBF21C2FB812952C4A8F7C9CADF889922145D1A1B3C724120CBD6AE2",
    sign_method: "HMAC-SHA256",
    t: "1700000000000",
    nonce: "fixed-nonce",
    access_token: "token",
  });
});
