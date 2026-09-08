export class CameraFrameProvider {
  constructor({ maxBufferSeconds = 30, maxFramesPerCamera = 60 } = {}) {
    this.maxBufferSeconds = maxBufferSeconds;
    this.maxFramesPerCamera = maxFramesPerCamera;
    /** @type {Map<string, Array<{ buffer: Buffer, timestamp: number, mimeType: string }>>} */
    this.buffers = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.subscribers = new Map();
  }

  pushFrame(cameraId, buffer, mimeType = "image/jpeg") {
    if (!cameraId || !buffer) return;
    const now = Date.now();
    let queue = this.buffers.get(cameraId);
    if (!queue) {
      queue = [];
      this.buffers.set(cameraId, queue);
    }

    queue.push({ buffer, timestamp: now, mimeType });

    // Prune frames older than maxBufferSeconds or exceeding maxFramesPerCamera
    const cutoff = now - this.maxBufferSeconds * 1000;
    while (queue.length > 1 && (queue[0].timestamp < cutoff || queue.length > this.maxFramesPerCamera)) {
      queue.shift();
    }

    const subs = this.subscribers.get(cameraId);
    if (subs && subs.size > 0) {
      const frameItem = queue[queue.length - 1];
      for (const sub of subs) {
        try {
          sub(frameItem);
        } catch (err) {
          console.error("Frame subscriber error for camera", cameraId, err.message);
        }
      }
    }
  }

  getLatestFrame(cameraId) {
    const queue = this.buffers.get(cameraId);
    if (!queue || queue.length === 0) return null;
    return queue[queue.length - 1];
  }

  getFrames(cameraId, seconds = 10, maxCount = 6) {
    const queue = this.buffers.get(cameraId);
    if (!queue || queue.length === 0) return [];
    const cutoff = Date.now() - seconds * 1000;
    const matching = queue.filter((item) => item.timestamp >= cutoff);
    if (matching.length <= maxCount) return matching;

    // Evenly sample maxCount frames across the time window
    const sampled = [];
    const step = (matching.length - 1) / (maxCount - 1);
    for (let i = 0; i < maxCount; i++) {
      sampled.push(matching[Math.round(i * step)]);
    }
    return sampled;
  }

  subscribeFrames(cameraId, callback) {
    if (!this.subscribers.has(cameraId)) {
      this.subscribers.set(cameraId, new Set());
    }
    const set = this.subscribers.get(cameraId);
    set.add(callback);
    return () => set.delete(callback);
  }

  clearCamera(cameraId) {
    this.buffers.delete(cameraId);
    this.subscribers.delete(cameraId);
  }
}
