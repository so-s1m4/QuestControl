const TELEGRAM_API = "https://api.telegram.org";
export function escapeTelegramHtml(value) {
  return String(value ?? "").replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
}

export function renderTelegramTemplate(template, values) {
  return String(template).replace(/{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g, (_match, key) =>
    escapeTelegramHtml(values[key] ?? ""),
  );
}

export class TelegramBot {
  constructor({ token, onUpdate, logger = console }) {
    this.token = token;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.offset = 0;
    this.polling = false;
    this.timer = null;
    this.username = null;
  }

  get enabled() { return Boolean(this.token); }

  async request(method, payload = {}) {
    if (!this.enabled) throw new Error("TELEGRAM_NOT_CONFIGURED");
    const response = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const error = new Error(body?.description || `Telegram ${method} failed`);
      error.code = body?.error_code;
      throw error;
    }
    return body.result;
  }

  async start() {
    if (!this.enabled) return;
    try {
      // QuestControl receives button presses through getUpdates. A webhook left
      // from an earlier setup makes Telegram reject polling with HTTP 409.
      await this.request("deleteWebhook", { drop_pending_updates: false });
      const me = await this.request("getMe");
      this.username = me.username || null;
      this.logger.info(`Telegram bot @${this.username || "unknown"} is ready`);
      this.timer = setInterval(() => void this.poll(), 3_000).unref();
      void this.poll();
    } catch (error) {
      this.logger.error("Telegram bot could not start", error.message);
    }
  }

  async poll() {
    if (this.polling || !this.enabled) return;
    this.polling = true;
    try {
      const updates = await this.request("getUpdates", { offset: this.offset, timeout: 0, allowed_updates: ["message", "callback_query"] });
      for (const update of updates) {
        this.offset = update.update_id + 1;
        await this.onUpdate(update);
      }
    } catch (error) {
      this.logger.error("Telegram update polling failed", error.message);
    } finally {
      this.polling = false;
    }
  }

  async sendMessage(chatId, text, replyMarkup) {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendPhoto(chatId, photoBuffer, caption = "", replyMarkup = null) {
    if (!this.enabled) throw new Error("TELEGRAM_NOT_CONFIGURED");
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", new Blob([photoBuffer], { type: "image/jpeg" }), "snapshot.jpg");
    if (caption) {
      formData.append("caption", caption);
      formData.append("parse_mode", "HTML");
    }
    if (replyMarkup) {
      formData.append("reply_markup", JSON.stringify(replyMarkup));
    }

    const response = await fetch(`${TELEGRAM_API}/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(25_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const error = new Error(body?.description || "Telegram sendPhoto failed");
      error.code = body?.error_code;
      throw error;
    }
    return body.result;
  }

  async sendAnimation(chatId, animationBuffer, caption = "", replyMarkup = null) {
    if (!this.enabled) throw new Error("TELEGRAM_NOT_CONFIGURED");
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("animation", new Blob([animationBuffer], { type: "image/gif" }), "clip.gif");
    if (caption) {
      formData.append("caption", caption);
      formData.append("parse_mode", "HTML");
    }
    if (replyMarkup) {
      formData.append("reply_markup", JSON.stringify(replyMarkup));
    }

    const response = await fetch(`${TELEGRAM_API}/bot${this.token}/sendAnimation`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const error = new Error(body?.description || "Telegram sendAnimation failed");
      error.code = body?.error_code;
      throw error;
    }
    return body.result;
  }

  async answerCallbackQuery(callbackQueryId, text) {
    return this.request("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
  }

  async clearInlineKeyboard(chatId, messageId) {
    return this.request("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }
}
