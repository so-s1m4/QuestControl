export class CameraAIAgent {
  constructor({ db, eventEngine, frameProvider, visionService, visionController }) {
    this.db = db;
    this.eventEngine = eventEngine;
    this.frameProvider = frameProvider;
    this.visionService = visionService;
    this.visionController = visionController;
  }

  async getRoomCamera(roomId) {
    const { rows } = await this.db.query(
      `SELECT c.*, r.name AS room_name
       FROM cameras c
       JOIN rooms r ON r.id = c.room_id
       WHERE c.room_id = $1 OR lower(r.name) = lower($1) OR lower(replace(r.name,' ','_')) LIKE '%' || lower(replace($1,' ','_')) || '%'
       ORDER BY (c.provider = 'TUYA') DESC LIMIT 1`,
      [roomId]
    );
    return rows[0] || null;
  }

  async getCameraState(cameraId) {
    return this.eventEngine.getState(cameraId);
  }

  async getCameraPeopleCount(cameraId) {
    const state = this.eventEngine.getState(cameraId);
    return state?.peopleCount || 0;
  }

  async getCameraSnapshot(cameraId) {
    let frame = this.frameProvider.getLatestFrame(cameraId);
    if (!frame && this.visionService?.getLatestFrame) {
      frame = await this.visionService.getLatestFrame(cameraId);
      if (frame?.buffer) {
        this.frameProvider.pushFrame(cameraId, frame.buffer);
      }
    }
    if (!frame) return null;
    return {
      timestamp: frame.timestamp,
      base64: frame.buffer.toString("base64"),
      mimeType: frame.mimeType,
    };
  }

  async getCameraRecentFrames(cameraId, seconds = 10) {
    let frames = this.frameProvider.getFrames(cameraId, seconds);
    if ((!frames || frames.length === 0) && this.visionService?.getLatestFrame) {
      const fallback = await this.visionService.getLatestFrame(cameraId);
      if (fallback) {
        this.frameProvider.pushFrame(cameraId, fallback.buffer);
        frames = [fallback];
      }
    }
    return frames;
  }

  async analyzeCamera(cameraId, question) {
    let frames = this.frameProvider.getFrames(cameraId, 10, 4);
    if ((!frames || frames.length === 0) && this.visionService?.getLatestFrame) {
      const fallback = await this.visionService.getLatestFrame(cameraId);
      if (fallback) {
        this.frameProvider.pushFrame(cameraId, fallback.buffer);
        frames = [fallback];
      }
    }
    const state = this.eventEngine.getState(cameraId);
    return this.visionService.analyze({
      cameraId,
      frames,
      question,
      manual: true,
      yoloContext: state,
    });
  }

  async lookAtPreset(cameraId, preset) {
    return this.visionController.lookAtPreset(cameraId, preset);
  }

  async inspectRoom(roomId) {
    let resolvedRoomId = roomId;
    const roomCamera = await this.getRoomCamera(roomId);
    if (roomCamera?.room_id) {
      resolvedRoomId = roomCamera.room_id;
    }
    return this.visionController.inspectRoom(resolvedRoomId);
  }

  async findPeople(roomId) {
    const inspection = await this.inspectRoom(roomId);
    return {
      roomId,
      peopleFound: inspection.estimatedPeople > 0,
      estimatedPeople: inspection.estimatedPeople,
      observations: inspection.observations,
    };
  }

  async getRecentCameraEvents(roomId) {
    let resolvedRoomId = roomId;
    const roomCamera = await this.getRoomCamera(roomId);
    if (roomCamera?.room_id) {
      resolvedRoomId = roomCamera.room_id;
    }
    return this.eventEngine.getRecentEvents({ roomId: resolvedRoomId, limit: 15 });
  }

  async answerQuestion({ roomId, cameraId, question, canControlPtz = false }) {
    const qLower = String(question || "").toLowerCase().trim();
    let targetCamera = null;

    if (cameraId) {
      const { rows } = await this.db.query("SELECT * FROM cameras WHERE id = $1", [cameraId]);
      targetCamera = rows[0] || null;
    } else if (roomId) {
      targetCamera = await this.getRoomCamera(roomId);
    }

    if (!targetCamera && !roomId) {
      return {
        answer: "Укажите комнату или камеру для ответа на вопрос.",
        toolCalled: null,
      };
    }

    const effectiveRoomId = targetCamera?.room_id || roomId;
    const effectiveCameraId = targetCamera?.id || cameraId;

    // Pattern 1: Inspect entire room / "проверь комнату"
    if (
      qLower.includes("проверь всю") ||
      qLower.includes("осмотр") ||
      qLower.includes("инспекция")
    ) {
      if (!canControlPtz) {
        return {
          answer: "Для физического поворота камеры и полного осмотра комнаты требуются права управления устройствами (devices:command).",
          toolCalled: null,
          error: "PERMISSION_DENIED",
        };
      }
      const report = await this.inspectRoom(effectiveRoomId);
      const answer = report.estimatedPeople > 0
        ? `Осмотр завершён: в комнате находится ориентировочно ${report.estimatedPeople} человек(а).`
        : "Осмотр завершён: комната пуста, людей не обнаружено.";
      return {
        answer,
        toolCalled: "inspectRoom",
        data: report,
      };
    }

    // Pattern 2: "Кто-то остался?" / "Остались ли игроки?" / "Есть ли кто-то в комнате?"
    if (
      qLower.includes("остал") ||
      qLower.includes("есть ли кто") ||
      qLower.includes("кто-нибудь") ||
      qLower.includes("кто в комнате")
    ) {
      const state = this.eventEngine.getState(effectiveCameraId);
      if (state.peopleCount > 0) {
        return {
          answer: `В комнате сейчас находится ${state.peopleCount} человек(а).`,
          toolCalled: "getCameraState",
          data: state,
        };
      }
      if (canControlPtz) {
        const report = await this.inspectRoom(effectiveRoomId);
        const answer = report.estimatedPeople > 0
          ? `При детальном осмотре в комнате обнаружено людей: ${report.estimatedPeople}.`
          : "В комнате никого нет, игроки не обнаружены.";
        return {
          answer,
          toolCalled: "inspectRoom",
          data: report,
        };
      }
      return {
        answer: "По текущему ракурсу камеры комната свободна.",
        toolCalled: "getCameraState",
        data: state,
      };
    }

    // Pattern 3: "Сколько сейчас людей?"
    if (qLower.includes("сколько") || qLower.includes("количество")) {
      const count = await this.getCameraPeopleCount(effectiveCameraId);
      return {
        answer: `По текущим данным камеры, в зоне видимости находится ${count} человек(а).`,
        toolCalled: "getCameraPeopleCount",
        data: { peopleCount: count },
      };
    }

    // Pattern 4: "Что сейчас происходит?" / General scene analysis via VLM
    if (
      qLower.includes("что происходит") ||
      qLower.includes("чем заняты") ||
      qLower.includes("опиши") ||
      qLower.includes("что делают")
    ) {
      const vlmResult = await this.analyzeCamera(effectiveCameraId, question);
      return {
        answer: vlmResult.description || "Анализ кадра завершён.",
        toolCalled: "analyzeCamera",
        data: vlmResult,
      };
    }

    // Default fallback: VLM analysis
    const vlmResult = await this.analyzeCamera(effectiveCameraId, question);
    return {
      answer: vlmResult.description || "Анализ кадра завершён.",
      toolCalled: "analyzeCamera",
      data: vlmResult,
    };
  }
}
