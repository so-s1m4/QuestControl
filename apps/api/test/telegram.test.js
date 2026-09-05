import test from "node:test";
import assert from "node:assert/strict";
import { escapeTelegramHtml, renderTelegramTemplate } from "../src/telegram.js";

test("Telegram templates escape booking values while preserving owner formatting", () => {
  const message = renderTelegramTemplate("<b>{{customerName}}</b> · {{location}}", {
    customerName: "A & B <team>",
    location: "Wien",
  });
  assert.equal(message, "<b>A &amp; B &lt;team&gt;</b> · Wien");
});

test("Telegram HTML escaping handles all special markup characters", () => {
  assert.equal(escapeTelegramHtml("<x>&"), "&lt;x&gt;&amp;");
});
