import base64
import hmac
import io
import json
import logging
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
from PIL import Image

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("questcontrol.ai.server")

# Try importing Ultralytics YOLO
YOLO_MODEL = None
YOLO_AVAILABLE = False
try:
    from ultralytics import YOLO
    model_name = os.environ.get("YOLO_MODEL", "yolo11n.pt")
    logger.info("Loading YOLO model: %s", model_name)
    YOLO_MODEL = YOLO(model_name)
    YOLO_AVAILABLE = True
    logger.info("YOLO model loaded successfully")
except Exception as exc:
    logger.warning("Ultralytics YOLO not available in current environment: %s. Using fallback detector.", exc)

from vlm import LocalVisionService
from receiver import StreamWorkerManager

vision_service = LocalVisionService()
worker_manager = StreamWorkerManager()

def run_yolo_detection(image_bytes: bytes, camera_id: str, conf_threshold: float = 0.25, test_count: int = 0) -> Dict[str, Any]:
    pil_img = Image.open(io.BytesIO(image_bytes))
    width, height = pil_img.size
    ts = datetime.now(timezone.utc).isoformat()
    people: List[Dict[str, Any]] = []

    if YOLO_AVAILABLE and YOLO_MODEL is not None:
        results = YOLO_MODEL.track(
            pil_img,
            persist=True,
            tracker="bytetrack.yaml",
            conf=conf_threshold,
            classes=[0],
            verbose=False,
        )
        if results and len(results) > 0:
            boxes = results[0].boxes
            if boxes is not None and len(boxes) > 0:
                for i, box in enumerate(boxes):
                    xyxy = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    track_id = int(box.id[0]) if box.id is not None else (i + 1)
                    x_norm = max(0.0, min(1.0, round(xyxy[0] / width, 4)))
                    y_norm = max(0.0, min(1.0, round(xyxy[1] / height, 4)))
                    w_norm = max(0.0, min(1.0, round((xyxy[2] - xyxy[0]) / width, 4)))
                    h_norm = max(0.0, min(1.0, round((xyxy[3] - xyxy[1]) / height, 4)))
                    people.append({
                        "trackId": track_id,
                        "confidence": round(conf, 2),
                        "bbox": {"x": x_norm, "y": y_norm, "width": w_norm, "height": h_norm},
                    })
    else:
        for i in range(test_count):
            people.append({
                "trackId": i + 1,
                "confidence": 0.94,
                "bbox": {"x": round(0.2 + i * 0.25, 2), "y": 0.15, "width": 0.20, "height": 0.65},
            })

    return {
        "cameraId": camera_id,
        "timestamp": ts,
        "peopleCount": len(people),
        "people": people,
    }

DEV_SECRET_FALLBACK = "development-internal-ai-secret-key-32chars-min"
INTERNAL_API_SECRET = os.environ.get("INTERNAL_API_SECRET", "").strip()
IS_PRODUCTION = os.environ.get("NODE_ENV") == "production" or os.environ.get("ENV") == "production"

if not INTERNAL_API_SECRET or len(INTERNAL_API_SECRET) < 16 or INTERNAL_API_SECRET in ("internal-ai-service-secret", DEV_SECRET_FALLBACK):
    if IS_PRODUCTION:
        logger.critical("FATAL: INTERNAL_API_SECRET must be explicitly set (>=16 chars) and cannot use dev default in production! Refusing to start.")
        raise RuntimeError("CRITICAL SECURITY VIOLATION: INTERNAL_API_SECRET must be set securely in production")
    else:
        logger.warning("INTERNAL_API_SECRET not set or insecure in development. Using development fallback secret.")
        INTERNAL_API_SECRET = DEV_SECRET_FALLBACK

worker_manager.set_detection_fn(lambda b, cid, conf: run_yolo_detection(b, cid, conf))
worker_manager.bootstrap_from_api()

class AIServiceHandler(BaseHTTPRequestHandler):
    server_version = "QuestControlAI/1.0"

    def _check_auth(self) -> bool:
        if not INTERNAL_API_SECRET:
            self._send_json(403, {"error": "FORBIDDEN_INTERNAL_ONLY"})
            return False
        provided = self.headers.get("X-Internal-Secret", "")
        if not provided and "?" in self.path:
            query = parse_qs(urlparse(self.path).query)
            provided = query.get("secret", [""])[0]
        if not provided or not hmac.compare_digest(str(provided), str(INTERNAL_API_SECRET)):
            self._send_json(403, {"error": "FORBIDDEN_INTERNAL_ONLY"})
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Internal-Secret, X-Camera-Id, X-Test-People-Count")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "ok",
                "yolo": YOLO_AVAILABLE,
                "vlm": True,
                "vlmEndpoint": bool(vision_service.endpoint),
                "workers": worker_manager.get_statuses(),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            return

        if not self._check_auth():
            return

        if self.path == "/worker/status":
            self._send_json(200, worker_manager.get_statuses())
        elif self.path.startswith("/cameras/") and "/frames" in self.path:
            parts = self.path.split("?")[0].strip("/").split("/")
            if len(parts) >= 3:
                cid = parts[1]
                frames = worker_manager.get_cached_frames(cid, 4)
                self._send_json(200, {"cameraId": cid, "frames": frames})
            else:
                self._send_json(400, {"error": "INVALID_CAMERA_PATH"})
        elif self.path.startswith("/cameras/") and "/clip" in self.path:
            parts = self.path.split("?")[0].strip("/").split("/")
            if len(parts) >= 3:
                cid = parts[1]
                count = 10
                if "?" in self.path:
                    query = parse_qs(urlparse(self.path).query)
                    try:
                        count = min(int(query.get("count", [10])[0]), 20)
                    except (ValueError, TypeError):
                        count = 10
                clip_bytes = worker_manager.get_recent_clip(cid, count=count)
                if not clip_bytes:
                    self._send_json(404, {"error": "NO_CLIP_AVAILABLE"})
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "image/gif")
                    self.send_header("Content-Length", str(len(clip_bytes)))
                    self.send_header("Cache-Control", "no-cache, no-store")
                    self.end_headers()
                    self.wfile.write(clip_bytes)
            else:
                self._send_json(400, {"error": "INVALID_CAMERA_PATH"})
        else:
            self._send_json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        if not self._check_auth():
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 25_000_000:
            return self._send_json(413, {"error": "PAYLOAD_TOO_LARGE"})

        body = self.rfile.read(content_length)
        if self.path == "/detect":
            self.handle_detect(body)
        elif self.path == "/analyze":
            self.handle_analyze(body)
        elif self.path == "/worker/sync":
            self.handle_worker_sync(body)
        else:
            self._send_json(404, {"error": "NOT_FOUND"})

    def handle_worker_sync(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8"))
            cameras = data.get("cameras", [])
            worker_manager.sync_cameras(cameras)
            self._send_json(200, {"ok": True, "active": len(worker_manager.sessions)})
        except Exception as exc:
            logger.error("Worker sync failed: %s", exc)
            self._send_json(500, {"error": "WORKER_SYNC_FAILED", "message": str(exc)})

    def handle_detect(self, body: bytes):
        try:
            content_type = self.headers.get("Content-Type", "")
            camera_id = ""
            conf_threshold = 0.25
            image_bytes = None

            if "application/json" in content_type:
                data = json.loads(body.decode("utf-8"))
                camera_id = str(data.get("cameraId", ""))
                conf_threshold = float(data.get("conf", 0.25))
                raw_img = data.get("image", "")
                if "," in raw_img:
                    raw_img = raw_img.split(",", 1)[1]
                image_bytes = base64.b64decode(raw_img)
            elif "image/" in content_type or body.startswith(b"\xff\xd8") or body.startswith(b"\x89PNG"):
                image_bytes = body
                camera_id = self.headers.get("X-Camera-Id", "")
            else:
                return self._send_json(400, {"error": "UNSUPPORTED_CONTENT_TYPE"})

            if not image_bytes:
                return self._send_json(400, {"error": "MISSING_IMAGE"})

            test_count = int(self.headers.get("X-Test-People-Count", "0"))
            result = run_yolo_detection(image_bytes, camera_id, conf_threshold, test_count)
            self._send_json(200, result)
        except Exception as exc:
            logger.error("Detection error: %s", exc, exc_info=True)
            self._send_json(500, {"error": "DETECTION_FAILED", "message": str(exc)})

    def handle_analyze(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8"))
            camera_id = str(data.get("cameraId", ""))
            question = str(data.get("question", "Determine what happened during these frames."))
            is_manual = bool(data.get("manual", False))
            yolo_context = data.get("yoloContext", None)
            
            raw_frames = data.get("frames", [])
            if not raw_frames and "image" in data:
                raw_frames = [data["image"]]
            if not raw_frames and camera_id:
                cached = worker_manager.get_cached_frames(camera_id, 4)
                raw_frames = [f.get("base64") if isinstance(f, dict) else f for f in cached]

            result = vision_service.analyze_frames(
                camera_id=camera_id,
                frames_base64=raw_frames,
                question=question,
                is_manual=is_manual,
                yolo_context=yolo_context,
            )
            self._send_json(200, result)
        except Exception as exc:
            logger.error("Analysis error: %s", exc, exc_info=True)
            self._send_json(500, {
                "error": "ANALYSIS_FAILED",
                "message": str(exc),
                "people": 0,
                "activity": "error",
                "doorState": "unknown",
                "unusual": False,
                "confidence": 0.0,
                "description": "Не удалось выполнить VLM-анализ кадра.",
            })

    def _send_json(self, status: int, payload: Dict[str, Any]):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Internal-Secret, X-Camera-Id, X-Test-People-Count")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # Suppress routine health check logs
        if len(args) > 0 and "GET /health" in str(args[0]):
            return
        super().log_message(format, *args)

def main():
    port = int(os.environ.get("PORT", "8088"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AIServiceHandler)
    logger.info("QuestControl AI service listening on port %d", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down AI service")
        server.shutdown()

if __name__ == "__main__":
    main()
