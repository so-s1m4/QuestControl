export class AiWorkerSupervisor {
  constructor({
    db,
    localVisionService,
    logger = console,
    retryIntervalMs = 2000,
    maxStartupRetries = 15,
    watchdogIntervalMs = 30000,
  } = {}) {
    this.db = db;
    this.localVisionService = localVisionService;
    this.logger = logger;
    this.retryIntervalMs = retryIntervalMs;
    this.maxStartupRetries = maxStartupRetries;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.running = false;
    this.watchdogTimer = null;
    this.startupTimer = null;
    this.isSynced = false;
  }

  async getAiCamerasFromDb() {
    const { rows } = await this.db.query(
      "SELECT c.*, COALESCE(c.location_id, r.location_id) AS location_id FROM cameras c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.ai_enabled = true"
    );
    return rows;
  }

  async syncOnce() {
    const cameras = await this.getAiCamerasFromDb();
    const success = await this.localVisionService.syncWorkers(cameras);
    return { success: Boolean(success), count: cameras.length };
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this._runStartupLoop(1);
    return this;
  }

  _runStartupLoop(attempt) {
    if (!this.running) return;

    void (async () => {
      try {
        const { success, count } = await this.syncOnce();
        if (success) {
          this.isSynced = true;
          this.logger.log(`[AI-Supervisor] Successfully synchronized ${count} AI camera stream workers.`);
          this._scheduleWatchdog();
          return;
        }
      } catch (err) {
        this.logger.warn(`[AI-Supervisor] Startup sync attempt ${attempt} failed:`, err.message);
      }

      if (attempt >= this.maxStartupRetries) {
        this.logger.warn(
          `[AI-Supervisor] Maximum startup retries (${this.maxStartupRetries}) reached. AI service might be booting late or unavailable. Periodic watchdog will continue monitoring.`
        );
        this._scheduleWatchdog();
        return;
      }

      const delay = Math.min(this.retryIntervalMs * Math.pow(1.3, attempt - 1), 10000);
      this.startupTimer = setTimeout(() => this._runStartupLoop(attempt + 1), delay);
      if (this.startupTimer && typeof this.startupTimer.unref === "function") {
        this.startupTimer.unref();
      }
    })();
  }

  _scheduleWatchdog() {
    if (!this.running) return;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
    }
    this.watchdogTimer = setInterval(() => void this.checkAndReconcile(), this.watchdogIntervalMs);
    if (this.watchdogTimer && typeof this.watchdogTimer.unref === "function") {
      this.watchdogTimer.unref();
    }
  }

  async checkAndReconcile() {
    if (!this.running) return;
    try {
      const isHealthy = await this.localVisionService.isHealthy();
      if (!isHealthy) {
        return;
      }

      const cameras = await this.getAiCamerasFromDb();
      const expectedIds = new Set(cameras.map((c) => String(c.id)));
      const workerStatus = await this.localVisionService.getWorkerStatus();
      const activeIds = new Set(Object.keys(workerStatus || {}));

      let needsSync = false;
      if (expectedIds.size !== activeIds.size) {
        needsSync = true;
      } else {
        for (const id of expectedIds) {
          if (!activeIds.has(id)) {
            needsSync = true;
            break;
          }
        }
      }

      if (needsSync) {
        this.logger.log(
          `[AI-Supervisor] Discrepancy detected (DB cameras: ${expectedIds.size}, Active Workers: ${activeIds.size}). Resynchronizing...`
        );
        const success = await this.localVisionService.syncWorkers(cameras);
        if (success) {
          this.isSynced = true;
        }
      }
    } catch (err) {
      this.logger.warn("[AI-Supervisor] Watchdog check failed:", err.message);
    }
  }

  stop() {
    this.running = false;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}

export function startAiWorkerSyncSupervisor(options) {
  const supervisor = new AiWorkerSupervisor(options);
  return supervisor.start();
}
