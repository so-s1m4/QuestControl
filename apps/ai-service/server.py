import base64
import hmac
import io
import json
import logging
import os
import secrets
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse
from PIL import Image, ImageDraw

# Ensure ai-service directory is on sys.path for direct or cross-directory execution
_AI_SERVICE_DIR = str(Path(__file__).resolve().parent)
if _AI_SERVICE_DIR not in sys.path:
    sys.path.insert(0, _AI_SERVICE_DIR)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("questcontrol.ai.server")

from model_validator import (
    prevent_ultralytics_network_downloads,
    load_general_yolo_model,
    load_yolo_world_model,
    validate_and_load_headset_model,
    ValidationResult,
)

from scripts.dataset_pipeline import (
    collect_ptz_frame,
    enqueue_for_verification,
    verify_sample,
    list_verification_queue,
    get_sample_image,
    get_sample_metadata,
    export_dataset_splits,
    train_headset_model,
    activate_candidate_model,
    rollback_model,
    reconcile_model_pointers,
    get_pipeline_status,
    get_job_status,
    update_job_status,
    reconcile_daemon_job_status,
    resolve_active_dataset_manifest,
    PipelineJobLock,
    DATA_DIR,
    MODELS_DIR,
    DATASET_DIR,
)

# Immediately enforce air-gapped offline operation
prevent_ultralytics_network_downloads()

YOLO_MODEL = None
YOLO_AVAILABLE = False
YOLO_ERROR = None

# People below this confidence are ignored entirely.  Camera occupancy, motion,
# tracking and notifications must be driven only by a clearly identified person.
try:
    PERSON_CONFIDENCE_THRESHOLD = float(os.environ.get("PERSON_CONFIDENCE_THRESHOLD", "0.85"))
except ValueError:
    PERSON_CONFIDENCE_THRESHOLD = 0.85
PERSON_CONFIDENCE_THRESHOLD = max(0.0, min(1.0, PERSON_CONFIDENCE_THRESHOLD))

HEADSET_MODEL = None
HEADSET_MODEL_STATUS = "MODEL_UNAVAILABLE"
HEADSET_MODEL_ERROR = None
HEADSET_MODEL_METRICS = None
HEADSET_MODEL_METADATA = None
HEADSET_CLASSES: List[int] = []
HEADSET_MODEL_SOURCE = "custom"
YOLO_WORLD_MODEL = None
YOLO_WORLD_AVAILABLE = False
YOLO_WORLD_ERROR = None
# "Helmet" is deliberately included: on the venue cameras Quest headsets are
# often side-on, and YOLO-World consistently scores that silhouette under this
# broader visual term. The detector still returns it only as a VR candidate.
YOLO_WORLD_CLASSES = ["VR headset", "Meta Quest headset", "Oculus headset", "helmet"]
try:
    YOLO_WORLD_CONFIDENCE = float(os.environ.get("YOLO_WORLD_CONFIDENCE", "0.01"))
except ValueError:
    YOLO_WORLD_CONFIDENCE = 0.01
YOLO_WORLD_CONFIDENCE = max(0.001, min(0.5, YOLO_WORLD_CONFIDENCE))

raw_headset_classes = os.environ.get("HEADSET_CLASSES", "").strip()
if raw_headset_classes:
    try:
        HEADSET_CLASSES = [int(c.strip()) for c in raw_headset_classes.split(",") if c.strip()]
        logger.info("Configured HEADSET_CLASSES filter: %s", HEADSET_CLASSES)
    except Exception as e:
        logger.warning("Failed parsing HEADSET_CLASSES: %s", e)

# 1. Load general YOLO model strictly from local disk (no internet downloads)
expected_general_sha = os.environ.get("YOLO_MODEL_SHA256")
YOLO_MODEL, YOLO_AVAILABLE, YOLO_ERROR = load_general_yolo_model(expected_sha256=expected_general_sha)

# YOLO-World is the primary headset detector. The smaller custom model remains
# available for continued training and evaluation, but does not replace the
# open-vocabulary detector until we explicitly choose to change that policy.
YOLO_WORLD_MODEL, YOLO_WORLD_AVAILABLE, YOLO_WORLD_ERROR = load_yolo_world_model(
    classes=YOLO_WORLD_CLASSES,
)

# Reconcile model symlinks from activation journal if needed after container restart / crash
try:
    rec_res = reconcile_model_pointers(MODELS_DIR)
    if rec_res and rec_res.get("status") == "ACTIVATION_STATE_UNCERTAIN":
        HEADSET_MODEL = None
        HEADSET_MODEL_STATUS = "ACTIVATION_STATE_UNCERTAIN"
        HEADSET_MODEL_ERROR = rec_res.get("error", "Ambiguous pointer state requires manual reconciliation")
except Exception as _r_err:
    if "JOURNAL_CORRUPT" in str(_r_err):
        HEADSET_MODEL = None
        HEADSET_MODEL_STATUS = "JOURNAL_CORRUPT"
        HEADSET_MODEL_ERROR = str(_r_err)
    elif "ACTIVATION_STATE_UNCERTAIN" in str(_r_err):
        HEADSET_MODEL = None
        HEADSET_MODEL_STATUS = "ACTIVATION_STATE_UNCERTAIN"
        HEADSET_MODEL_ERROR = str(_r_err)
    else:
        logger.warning("Model pointer reconciliation warning: %s", _r_err)

# 2. Validate and load specialized VR headset detection model if status is not uncertain/corrupt
if HEADSET_MODEL_STATUS not in ("JOURNAL_CORRUPT", "ACTIVATION_STATE_UNCERTAIN"):
    val_res = validate_and_load_headset_model()
    HEADSET_MODEL = val_res.model
    HEADSET_MODEL_STATUS = val_res.status if val_res.is_valid else "DATASET_REQUIRED"
    HEADSET_MODEL_ERROR = val_res.error
    HEADSET_MODEL_METRICS = val_res.metrics
    HEADSET_MODEL_METADATA = val_res.metadata


def set_primary_headset_model() -> None:
    """Keep YOLO-World as the live detector after model lifecycle operations."""
    global HEADSET_MODEL, HEADSET_MODEL_STATUS, HEADSET_MODEL_ERROR, HEADSET_MODEL_METRICS, HEADSET_MODEL_METADATA, HEADSET_MODEL_SOURCE
    if YOLO_WORLD_AVAILABLE and YOLO_WORLD_MODEL is not None:
        HEADSET_MODEL = YOLO_WORLD_MODEL
        HEADSET_MODEL_STATUS = "READY"
        HEADSET_MODEL_ERROR = None
        HEADSET_MODEL_METRICS = {"source": "YOLO-World", "classes": YOLO_WORLD_CLASSES}
        HEADSET_MODEL_METADATA = {"modelName": "yolov8s-worldv2", "source": "YOLO-World"}
        HEADSET_MODEL_SOURCE = "yolo-world"


set_primary_headset_model()

# Reconcile stale background daemon jobs on startup
reconcile_daemon_job_status(DATA_DIR)

from vlm import LocalVisionService
from receiver import AIORTC_AVAILABLE, StreamWorkerManager
from activity import ActivityIntelligenceEngine, YoloPersonTracker, LocalPoseEstimator

vision_service = LocalVisionService()
worker_manager = StreamWorkerManager()
activity_engine = ActivityIntelligenceEngine(
    tracker=YoloPersonTracker(yolo_model=YOLO_MODEL),
    pose_estimator=LocalPoseEstimator(),
)

def run_yolo_detection(image_bytes: bytes, camera_id: str, conf_threshold: float = PERSON_CONFIDENCE_THRESHOLD, test_count: int = 0) -> Dict[str, Any]:
    ts = datetime.now(timezone.utc).isoformat()
    people: List[Dict[str, Any]] = []

    if test_count > 0:
        for i in range(test_count):
            people.append({
                "trackId": i + 1,
                "confidence": 0.94,
                "bbox": {"x": round(0.2 + i * 0.25, 2), "y": 0.15, "width": 0.20, "height": 0.65},
            })
        return {
            "cameraId": camera_id,
            "timestamp": ts,
            "status": "READY",
            "peopleCount": len(people),
            "people": people,
        }

    if not YOLO_AVAILABLE or YOLO_MODEL is None:
        return {
            "cameraId": camera_id,
            "timestamp": ts,
            "status": "MODEL_UNAVAILABLE",
            "error": YOLO_ERROR or "MODEL_UNAVAILABLE: General YOLO model weights not found on disk",
            "peopleCount": 0,
            "people": [],
        }

    if image_bytes:
        try:
            required_confidence = max(PERSON_CONFIDENCE_THRESHOLD, conf_threshold)
            pil_img = Image.open(io.BytesIO(image_bytes))
            width, height = pil_img.size
            results = YOLO_MODEL.track(
                pil_img,
                persist=True,
                tracker="bytetrack.yaml",
                conf=required_confidence,
                classes=[0],
                verbose=False,
            )
            if results and len(results) > 0:
                boxes = results[0].boxes
                if boxes is not None and len(boxes) > 0:
                    for i, box in enumerate(boxes):
                        xyxy = box.xyxy[0].tolist() if hasattr(box.xyxy[0], "tolist") else list(box.xyxy[0])
                        conf = float(box.conf[0])
                        track_id = int(box.id[0]) if box.id is not None else (i + 1)
                        x_norm = max(0.0, min(1.0, round(xyxy[0] / width, 4)))
                        y_norm = max(0.0, min(1.0, round(xyxy[1] / height, 4)))
                        w_norm = max(0.0, min(1.0, round((xyxy[2] - xyxy[0]) / width, 4)))
                        h_norm = max(0.0, min(1.0, round((xyxy[3] - xyxy[1]) / height, 4)))
                        # Strictly above 85%; exactly 85% is ignored as asked.
                        if conf > required_confidence:
                            people.append({
                                "trackId": track_id,
                                # Preserve enough precision for the API safety check.
                                "confidence": round(conf, 3),
                                "bbox": {"x": x_norm, "y": y_norm, "width": w_norm, "height": h_norm},
                            })
        except Exception as exc:
            logger.warning("YOLO detection error: %s", exc)

    return {
        "cameraId": camera_id,
        "timestamp": ts,
        "status": "READY",
        "peopleCount": len(people),
        "people": people,
    }

def run_headset_detection(
    image_bytes: bytes,
    camera_id: str,
    conf_threshold: float = 0.4,
    test_headsets: Optional[List[Dict[str, Any]]] = None,
    model_override: Optional[Any] = None,
) -> Dict[str, Any]:
    ts = datetime.now(timezone.utc).isoformat()
    headsets = []

    if test_headsets is not None:
        return {
            "cameraId": camera_id,
            "timestamp": ts,
            "status": "READY",
            "headsetCount": len(test_headsets),
            "headsets": test_headsets,
        }

    active_model = model_override or HEADSET_MODEL

    if active_model is None or (model_override is None and HEADSET_MODEL_STATUS != "READY"):
        st = HEADSET_MODEL_STATUS if HEADSET_MODEL_STATUS in ("ACTIVATION_STATE_UNCERTAIN", "JOURNAL_CORRUPT") else "MODEL_UNAVAILABLE"
        return {
            "cameraId": camera_id,
            "timestamp": ts,
            "status": st,
            "error": HEADSET_MODEL_ERROR or f"{st}: Headset model weights not loaded or failed validation",
            "headsetCount": 0,
            "headsets": [],
        }

    if active_model is not None and image_bytes:
        try:
            img = Image.open(io.BytesIO(image_bytes))
            effective_confidence = (
                YOLO_WORLD_CONFIDENCE
                if model_override is None and HEADSET_MODEL_SOURCE == "yolo-world"
                else conf_threshold
            )
            results = active_model(img, conf=effective_confidence, verbose=False)
            width, height = img.size
            for r in results:
                names = getattr(r, "names", {})
                for box in r.boxes:
                    cls_id = int(box.cls[0]) if hasattr(box, "cls") and len(box.cls) > 0 else 0
                    cls_name = str(names.get(cls_id, "")).lower()

                    is_headset = True
                    if names and len(names) > 1 and cls_name:
                        if HEADSET_CLASSES:
                            is_headset = (cls_id in HEADSET_CLASSES)
                        elif not any(k in cls_name for k in ("headset", "vr", "goggle", "glasses", "helmet")):
                            is_headset = False
                    elif HEADSET_CLASSES:
                        is_headset = (cls_id in HEADSET_CLASSES)

                    if not is_headset:
                        continue

                    xyxy = box.xyxy[0].tolist() if hasattr(box.xyxy[0], "tolist") else list(box.xyxy[0])
                    conf = float(box.conf[0])
                    x_norm = max(0.0, min(1.0, round(xyxy[0] / width, 4)))
                    y_norm = max(0.0, min(1.0, round(xyxy[1] / height, 4)))
                    w_norm = max(0.0, min(1.0, round((xyxy[2] - xyxy[0]) / width, 4)))
                    h_norm = max(0.0, min(1.0, round((xyxy[3] - xyxy[1]) / height, 4)))
                    headsets.append({
                        "confidence": round(conf, 2),
                        "classId": cls_id,
                        "className": cls_name or "headset",
                        "bbox": {"x": x_norm, "y": y_norm, "width": w_norm, "height": h_norm},
                    })
        except Exception as e:
            logger.warning("Headset YOLO inference error: %s", e)

    # YOLO-World uses several equivalent prompts for the same object. Its
    # built-in NMS is class-aware, so collapse overlapping prompt hits before
    # they reach the inventory counter or the visual overlay.
    def _iou(left: Dict[str, Any], right: Dict[str, Any]) -> float:
        a, b = left["bbox"], right["bbox"]
        ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
        bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
        iw, ih = max(0.0, min(ax2, bx2) - max(a["x"], b["x"])), max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
        intersection = iw * ih
        union = a["width"] * a["height"] + b["width"] * b["height"] - intersection
        return intersection / union if union > 0 else 0.0

    unique_headsets: List[Dict[str, Any]] = []
    for candidate in sorted(headsets, key=lambda item: item["confidence"], reverse=True):
        if all(_iou(candidate, accepted) < 0.55 for accepted in unique_headsets):
            unique_headsets.append(candidate)
    headsets = unique_headsets

    return {
        "cameraId": camera_id,
        "timestamp": ts,
        "status": "READY",
        "headsetCount": len(headsets),
        "headsets": headsets,
        "modelSource": "override" if model_override is not None else HEADSET_MODEL_SOURCE,
    }


def point_in_polygon_py(px: float, py: float, poly: list) -> bool:
    if not poly or len(poly) < 3:
        return False
    inside = False
    n = len(poly)
    for i in range(n):
        j = (i - 1 + n) % n
        p1 = poly[i]
        p2 = poly[j]
        x1 = p1.get("x", p1[0] if isinstance(p1, (list, tuple)) else 0)
        y1 = p1.get("y", p1[1] if isinstance(p1, (list, tuple)) else 0)
        x2 = p2.get("x", p2[0] if isinstance(p2, (list, tuple)) else 0)
        y2 = p2.get("y", p2[1] if isinstance(p2, (list, tuple)) else 0)
        if ((y1 > py) != (y2 > py)) and (px < (x2 - x1) * (py - y1) / (y2 - y1 + 1e-9) + x1):
            inside = not inside
    return inside


def is_point_in_zone_py(px: float, py: float, zone: dict) -> bool:
    poly = zone.get("polygon")
    if poly and isinstance(poly, list) and len(poly) >= 3:
        return point_in_polygon_py(px, py, poly)
    zx = float(zone.get("x", 0))
    zy = float(zone.get("y", 0))
    zw = float(zone.get("width", 0.1))
    zh = float(zone.get("height", 0.1))
    return zx <= px <= zx + zw and zy <= py <= zy + zh


def annotate_headset_frame(
    image_bytes: bytes,
    headsets: List[Dict[str, Any]],
    zones: List[Dict[str, Any]],
    not_on_base_count: int = 0,
    on_charging_base_count: int = 0,
    camera_name: str = "Камера",
    preset: str = "default",
    timestamp: str = "",
) -> bytes:
    """Draws visual zones, detected headsets (with distinct charging base / work zone / outside status), and alert banner."""
    try:
        pil_img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        draw = ImageDraw.Draw(pil_img, "RGBA")
        width, height = pil_img.size

        # 1. Draw zones
        for z in zones:
            z_type = z.get("zone_type") or z.get("zoneType") or "WORK_ZONE"
            z_name = z.get("name") or "Зона"
            hid = z.get("headset_id") or z.get("headsetId") or ""

            poly = z.get("polygon")
            if poly and isinstance(poly, list) and len(poly) >= 3:
                pts = [(int(p.get("x", 0) * width), int(p.get("y", 0) * height)) for p in poly]
            else:
                zx = int(float(z.get("x", 0)) * width)
                zy = int(float(z.get("y", 0)) * height)
                zw = int(float(z.get("width", 0.1)) * width)
                zh = int(float(z.get("height", 0.1)) * height)
                pts = [(zx, zy), (zx + zw, zy), (zx + zw, zy + zh), (zx, zy + zh)]

            if z_type == "CHARGING_BASE":
                color_outline = (46, 204, 113, 255)
                color_fill = (46, 204, 113, 40)
                label_text = f"СТОЛ ЗАРЯДКИ ({z_name})"
            else:
                color_outline = (243, 156, 18, 255)
                color_fill = (243, 156, 18, 30)
                label_text = f"КВАДРАТ {hid or z_name}"

            if len(pts) >= 3:
                draw.polygon(pts, fill=color_fill, outline=color_outline, width=3)
                label_pt = pts[0]
                draw.rectangle([label_pt[0], max(0, label_pt[1] - 18), label_pt[0] + len(label_text) * 8 + 8, label_pt[1]], fill=(0, 0, 0, 200))
                draw.text((label_pt[0] + 4, max(0, label_pt[1] - 16)), label_text, fill=(255, 255, 255, 255))

        # 2. Draw detected headsets
        for h in headsets:
            bbox = h.get("bbox") or {}
            bx = float(bbox.get("x", 0))
            by = float(bbox.get("y", 0))
            bw = float(bbox.get("width", 0.1))
            bh = float(bbox.get("height", 0.1))
            cx = bx + bw / 2.0
            cy = by + bh / 2.0

            x1 = int(bx * width)
            y1 = int(by * height)
            x2 = int((bx + bw) * width)
            y2 = int((by + bh) * height)

            in_base = any(is_point_in_zone_py(cx, cy, z) for z in zones if (z.get("zone_type") or z.get("zoneType")) == "CHARGING_BASE")
            in_wz = None
            if not in_base:
                for z in zones:
                    if (z.get("zone_type") or z.get("zoneType")) == "WORK_ZONE" and is_point_in_zone_py(cx, cy, z):
                        in_wz = z.get("headset_id") or z.get("headsetId") or z.get("name")
                        break

            if in_base:
                box_color = (46, 204, 113, 255)
                badge_text = "НА БАЗЕ"
            elif in_wz:
                box_color = (230, 126, 34, 255)
                badge_text = f"НЕ НА БАЗЕ: {in_wz}"
            else:
                box_color = (231, 76, 60, 255)
                badge_text = "НЕ НА БАЗЕ: ВНЕ ЗОН"

            draw.rectangle([x1, y1, x2, y2], outline=box_color, width=3)
            draw.rectangle([x1, max(0, y1 - 20), x1 + len(badge_text) * 8 + 10, y1], fill=(0, 0, 0, 220))
            draw.text((x1 + 4, max(0, y1 - 18)), badge_text, fill=box_color)

        # 3. Top status banner
        banner_h = 36
        draw.rectangle([0, 0, width, banner_h], fill=(0, 0, 0, 210))
        if not_on_base_count > 0:
            banner_text = f"⚠️ НЕ НА БАЗЕ: {not_on_base_count} | На базе: {on_charging_base_count} | Камера: {camera_name} ({preset}) | {timestamp}"
            banner_color = (231, 76, 60, 255)
        else:
            banner_text = f"✅ ВСЕ VR-ШЛЕМЫ НА БАЗЕ ({on_charging_base_count}) | Камера: {camera_name} ({preset}) | {timestamp}"
            banner_color = (46, 204, 113, 255)
        draw.text((12, 10), banner_text, fill=banner_color)

        out_buf = io.BytesIO()
        pil_img.save(out_buf, format="JPEG", quality=90)
        return out_buf.getvalue()
    except Exception as exc:
        logger.warning("Frame annotation error: %s", exc)
        return image_bytes


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
worker_manager.set_headset_detection_fn(lambda b, cid, conf: run_headset_detection(b, cid, conf))
worker_manager.set_activity_detection_fn(
    lambda b, cid, preset, timestamp, enabled_actions: activity_engine.process_frame(
        camera_id=cid,
        image_bytes=b,
        timestamp_epoch=timestamp,
        preset_name=preset,
        enabled_action_types=set(enabled_actions),
    )
)


def dataset_frame_rejection_reason(image_bytes: bytes) -> Optional[str]:
    """Reject placeholders and unusably dark frames before they enter a dataset.

    Tuya's cloud HLS endpoint can yield its own black loading screen while a
    camera session is being established. That is a syntactically valid JPEG,
    but it is never a useful training example. A genuinely dark IR frame still
    has appreciable scene luminance; the observed loader frames have a mean
    luminance below 1 on a 0..255 scale.
    """
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            gray = image.convert("L")
            if gray.width < 32 or gray.height < 32:
                return "FRAME_INVALID: image dimensions are too small"
            histogram = gray.histogram()
            pixel_count = gray.width * gray.height
            mean_luminance = sum(level * count for level, count in enumerate(histogram)) / pixel_count
    except Exception:
        return "FRAME_INVALID: image cannot be decoded"

    if mean_luminance < 5.0:
        return "FRAME_NOT_READY: camera stream is still showing a black loading screen"
    return None


def _collect_background_dataset_frame(image_bytes, camera_id, preset, timestamp, camera_config, initial_bboxes):
    """Save a worker-selected frame for human review; never self-approve it."""
    room_id = str(camera_config.get("room_id") or "")
    session_id = str(camera_config.get("capture_session_id") or "")
    if not room_id or not session_id:
        return
    rejected_reason = dataset_frame_rejection_reason(image_bytes)
    if rejected_reason:
        logger.warning("Skipping unusable automatic dataset frame from %s: %s", camera_id, rejected_reason)
        return
    iso_timestamp = datetime.fromtimestamp(float(timestamp), tz=timezone.utc).isoformat()
    raw_path = collect_ptz_frame(
        camera_id=str(camera_id),
        room_id=room_id,
        preset_name=str(preset or "default"),
        image_bytes=image_bytes,
        timestamp=iso_timestamp,
        capture_session_id=session_id,
        output_root=DATA_DIR,
    )
    enqueue_for_verification(raw_path, initial_bboxes=initial_bboxes, queue_root=DATA_DIR)

worker_manager.set_dataset_capture_fn(_collect_background_dataset_frame)
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Internal-Secret, X-Camera-Id, X-Test-People-Count, X-Test-Headset-Bboxes, X-Camera-Preset")
        self.end_headers()

    def do_GET(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        query = parse_qs(parsed_url.query)

        if path == "/health":
            self._send_json(200, {
                "status": "ok",
                "yolo": YOLO_AVAILABLE,
                "yoloStatus": "READY" if YOLO_AVAILABLE else "MODEL_UNAVAILABLE",
                "yoloError": YOLO_ERROR,
                "headsetModelStatus": HEADSET_MODEL_STATUS,
                "headsetModelError": HEADSET_MODEL_ERROR,
                "headsetValidationMetrics": HEADSET_MODEL_METRICS,
                "headsetModelSource": HEADSET_MODEL_SOURCE,
                "webrtcAvailable": AIORTC_AVAILABLE,
                "tuyaTransport": "WEBRTC_REQUIRED",
                "vlm": True,
                "vlmEndpoint": bool(vision_service.endpoint),
                "workers": worker_manager.get_statuses(),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            return

        if not self._check_auth():
            return

        if path == "/worker/status":
            self._send_json(200, worker_manager.get_statuses())
        elif path == "/pipeline/status":
            pipeline_status = get_pipeline_status(data_root=DATA_DIR, models_dir=MODELS_DIR)
            if YOLO_WORLD_AVAILABLE:
                pipeline_status.update({
                    "modelStatus": "READY",
                    "modelError": "YOLO-World активна для поиска VR-шлемов.",
                    "hasWeights": True,
                    "modelName": "yolov8s-worldv2",
                    "modelSource": "YOLO-World",
                })
            self._send_json(200, pipeline_status)
        elif path == "/pipeline/job-status":
            self._send_json(200, get_job_status(data_root=DATA_DIR))
        elif path == "/pipeline/queue":
            status_filter = query.get("status", ["all"])[0]
            items = list_verification_queue(status_filter=status_filter, queue_root=DATA_DIR)
            self._send_json(200, {"items": items, "count": len(items)})
        elif path.startswith("/pipeline/samples/") and path.endswith("/image"):
            parts = path.strip("/").split("/")
            if len(parts) == 4:
                sample_id = parts[2]
                res = get_sample_image(sample_id, queue_root=DATA_DIR)
                if not res:
                    self._send_json(404, {"error": "SAMPLE_IMAGE_NOT_FOUND"})
                else:
                    img_bytes, mime_type = res
                    self.send_response(200)
                    self.send_header("Content-Type", mime_type)
                    self.send_header("Content-Length", str(len(img_bytes)))
                    self.send_header("Cache-Control", "no-cache, no-store")
                    self.end_headers()
                    self.wfile.write(img_bytes)
            else:
                self._send_json(400, {"error": "INVALID_SAMPLE_PATH"})
        elif path.startswith("/pipeline/samples/") and (path.endswith("/meta") or len(path.strip("/").split("/")) == 3):
            parts = path.strip("/").split("/")
            sample_id = parts[2]
            meta = get_sample_metadata(sample_id, queue_root=DATA_DIR)
            if not meta:
                self._send_json(404, {"error": "SAMPLE_NOT_FOUND"})
            else:
                self._send_json(200, meta)
        elif path.startswith("/cameras/") and "/frames" in path:
            parts = path.strip("/").split("/")
            if len(parts) >= 3:
                cid = parts[1]
                frames = worker_manager.get_cached_frames(cid, 4)
                self._send_json(200, {"cameraId": cid, "frames": frames})
            else:
                self._send_json(400, {"error": "INVALID_CAMERA_PATH"})
        elif path.startswith("/cameras/") and "/clip" in path:
            parts = path.strip("/").split("/")
            if len(parts) >= 3:
                cid = parts[1]
                count = 10
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
        elif path == "/activity/health":
            self._send_json(200, activity_engine.get_health())
        elif path == "/activity/plugins":
            self._send_json(200, {"plugins": activity_engine.registry.get_all_health()})
        else:
            self._send_json(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        if not self._check_auth():
            return

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 25_000_000:
            return self._send_json(413, {"error": "PAYLOAD_TOO_LARGE"})

        body = self.rfile.read(content_length)
        parsed_url = urlparse(self.path)
        path = parsed_url.path

        if path == "/detect":
            self.handle_detect(body)
        elif path == "/detect/headsets":
            self.handle_detect_headsets(body)
        elif path == "/annotate/headsets":
            self.handle_annotate_headsets(body)
        elif path == "/analyze":
            self.handle_analyze(body)
        elif path == "/worker/sync":
            self.handle_worker_sync(body)
        elif path == "/worker/moving":
            self.handle_worker_moving(body)
        elif path == "/pipeline/collect":
            self.handle_pipeline_collect(body)
        elif path == "/pipeline/verify":
            self.handle_pipeline_verify(body)
        elif path == "/pipeline/export":
            self.handle_pipeline_export(body)
        elif path == "/pipeline/train":
            self.handle_pipeline_train(body)
        elif path == "/pipeline/activate":
            self.handle_pipeline_activate(body)
        elif path == "/detect/activity":
            self.handle_detect_activity(body)
        elif path.startswith("/activity/plugins/") and path.endswith("/enable"):
            self.handle_activity_plugin_enable(path, body)
        elif path == "/pipeline/rollback":
            self.handle_pipeline_rollback(body)
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
            conf_threshold = PERSON_CONFIDENCE_THRESHOLD
            image_bytes = None

            if "application/json" in content_type:
                data = json.loads(body.decode("utf-8"))
                camera_id = str(data.get("cameraId", ""))
                # Clients can ask for stricter matching, never a lower floor.
                conf_threshold = max(
                    PERSON_CONFIDENCE_THRESHOLD,
                    float(data.get("conf", PERSON_CONFIDENCE_THRESHOLD)),
                )
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

    def handle_detect_headsets(self, body: bytes):
        try:
            content_type = self.headers.get("Content-Type", "")
            camera_id = self.headers.get("X-Camera-Id", "")
            conf_threshold = 0.4
            image_bytes = None
            test_headsets = None

            test_header = self.headers.get("X-Test-Headset-Bboxes")
            if test_header:
                try:
                    test_headsets = json.loads(test_header)
                except Exception:
                    pass

            if "application/json" in content_type:
                data = json.loads(body.decode("utf-8"))
                camera_id = str(data.get("cameraId", camera_id))
                conf_threshold = float(data.get("conf", 0.4))
                if "testHeadsets" in data:
                    test_headsets = data["testHeadsets"]
                raw_img = data.get("image", "")
                if "," in raw_img:
                    raw_img = raw_img.split(",", 1)[1]
                if raw_img:
                    image_bytes = base64.b64decode(raw_img)
            elif "image/" in content_type or body.startswith(b"\xff\xd8") or body.startswith(b"\x89PNG"):
                image_bytes = body
            else:
                if test_headsets is None:
                    return self._send_json(400, {"error": "UNSUPPORTED_CONTENT_TYPE"})

            result = run_headset_detection(image_bytes or b"", camera_id, conf_threshold, test_headsets)
            self._send_json(200, result)
        except Exception as exc:
            logger.error("Headset detection error: %s", exc, exc_info=True)
            self._send_json(500, {"error": "HEADSET_DETECTION_FAILED", "message": str(exc)})

    def handle_annotate_headsets(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8"))
            raw_img = data.get("image", "")
            if "," in raw_img:
                raw_img = raw_img.split(",", 1)[1]
            image_bytes = base64.b64decode(raw_img) if raw_img else None
            if not image_bytes:
                return self._send_json(400, {"error": "NO_IMAGE_PROVIDED"})

            annotated_jpeg = annotate_headset_frame(
                image_bytes=image_bytes,
                headsets=data.get("headsets", []),
                zones=data.get("zones", []),
                not_on_base_count=int(data.get("notOnBaseCount", 0)),
                on_charging_base_count=int(data.get("onChargingBaseCount", 0)),
                camera_name=str(data.get("cameraName", "Камера")),
                preset=str(data.get("preset", "default")),
                timestamp=str(data.get("timestamp", datetime.now(timezone.utc).strftime("%H:%M:%S"))),
            )
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(annotated_jpeg)))
            self.send_header("Cache-Control", "no-cache, no-store")
            self.end_headers()
            self.wfile.write(annotated_jpeg)
        except Exception as exc:
            logger.error("Annotation failed: %s", exc)
            self._send_json(500, {"error": "ANNOTATION_FAILED", "message": str(exc)})

    def handle_worker_moving(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8"))
            cid = str(data.get("cameraId", ""))
            moving = bool(data.get("moving", False))
            preset = str(data.get("preset", ""))
            worker_manager.set_camera_moving(cid, moving, preset)
            activity_engine.set_camera_moving(cid, moving, preset)
            self._send_json(200, {"ok": True, "cameraId": cid, "moving": moving, "preset": preset})
        except Exception as exc:
            self._send_json(500, {"error": "FAILED_TO_SET_MOVING", "message": str(exc)})

    def handle_detect_activity(self, body: bytes):
        try:
            content_type = self.headers.get("Content-Type", "")
            camera_id = self.headers.get("X-Camera-Id", "")
            room_id = self.headers.get("X-Room-Id", "")
            preset_name = self.headers.get("X-Preset-Name", "")
            t_hdr = self.headers.get("X-Timestamp-Epoch", "")
            timestamp_epoch = float(t_hdr) if t_hdr else None
            image_bytes = None
            synthetic_poses = None
            synthetic_people = None

            if "application/json" in content_type:
                data = json.loads(body.decode("utf-8")) if body else {}
                camera_id = str(data.get("cameraId", camera_id))
                room_id = str(data.get("roomId", room_id)) or None
                preset_name = str(data.get("presetName", preset_name)) or None
                if "timestamp" in data:
                    try:
                        timestamp_epoch = float(data["timestamp"])
                    except (ValueError, TypeError):
                        pass
                raw_img = data.get("image", "")
                if "," in raw_img:
                    raw_img = raw_img.split(",", 1)[1]
                if raw_img:
                    image_bytes = base64.b64decode(raw_img)

                if "syntheticPoses" in data:
                    from activity.base import PersonPose, Keypoint
                    synthetic_poses = []
                    for sp in data["syntheticPoses"]:
                        kpts = {}
                        for kname, kdata in sp.get("keypoints", {}).items():
                            kpts[kname] = Keypoint(
                                name=kname,
                                x=float(kdata["x"]),
                                y=float(kdata["y"]),
                                confidence=float(kdata.get("confidence", 0.9)),
                            )
                        synthetic_poses.append(
                            PersonPose(
                                track_id=int(sp["trackId"]),
                                keypoints=kpts,
                                bbox=sp.get("bbox", {"x": 0.2, "y": 0.2, "width": 0.2, "height": 0.5}),
                                confidence=float(sp.get("confidence", 0.9)),
                            )
                        )
                if "syntheticPeople" in data:
                    from activity.base import TrackedPerson
                    synthetic_people = [
                        TrackedPerson(
                            track_id=int(p["trackId"]),
                            bbox=p.get("bbox", {"x": 0.2, "y": 0.2, "width": 0.2, "height": 0.5}),
                            confidence=float(p.get("confidence", 0.9)),
                        )
                        for p in data["syntheticPeople"]
                    ]
            elif "image/" in content_type or body.startswith(b"\xff\xd8") or body.startswith(b"\x89PNG"):
                image_bytes = body

            res = activity_engine.process_frame(
                camera_id=camera_id,
                image_bytes=image_bytes or b"",
                timestamp_epoch=timestamp_epoch,
                room_id=room_id,
                preset_name=preset_name,
                synthetic_poses=synthetic_poses,
                synthetic_people=synthetic_people,
            )
            self._send_json(200, res)
        except Exception as exc:
            logger.error("Activity detection error: %s", exc, exc_info=True)
            self._send_json(500, {"error": "ACTIVITY_DETECTION_FAILED", "message": str(exc)})

    def handle_activity_plugin_enable(self, path: str, body: bytes):
        try:
            parts = path.strip("/").split("/")
            if len(parts) < 4:
                return self._send_json(400, {"error": "INVALID_PATH"})
            action_type = parts[2]
            data = json.loads(body.decode("utf-8")) if body else {}
            enabled = bool(data.get("enabled", True))
            ok = activity_engine.registry.set_plugin_enabled(action_type, enabled)
            if not ok:
                return self._send_json(404, {"error": f"Plugin '{action_type}' not found"})
            self._send_json(200, {"ok": True, "actionType": action_type, "enabled": enabled})
        except Exception as exc:
            self._send_json(500, {"error": "PLUGIN_UPDATE_FAILED", "message": str(exc)})

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

    def handle_pipeline_collect(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8"))
            camera_id = str(data.get("cameraId", ""))
            room_id = str(data.get("roomId", ""))
            preset_name = str(data.get("preset", "default"))
            capture_session_id = data.get("captureSessionId")
            timestamp = data.get("timestamp")
            initial_bboxes = data.get("initialBboxes")
            auto_enqueue = bool(data.get("autoEnqueue", True))

            raw_img = data.get("image", "")
            if "," in raw_img:
                raw_img = raw_img.split(",", 1)[1]
            if not raw_img:
                return self._send_json(400, {"error": "MISSING_IMAGE_DATA"})
            image_bytes = base64.b64decode(raw_img)
            rejected_reason = dataset_frame_rejection_reason(image_bytes)
            if rejected_reason:
                return self._send_json(422, {
                    "error": "FRAME_NOT_READY",
                    "message": "Camera has not produced a usable video frame yet. Please wait for live video and retry.",
                    "detail": rejected_reason,
                })

            saved_path = collect_ptz_frame(
                camera_id=camera_id,
                room_id=room_id,
                preset_name=preset_name,
                image_bytes=image_bytes,
                timestamp=timestamp,
                capture_session_id=capture_session_id,
                output_root=DATA_DIR,
            )

            sample_id = None
            if auto_enqueue:
                sample_id = enqueue_for_verification(
                    raw_image_path=saved_path,
                    initial_bboxes=initial_bboxes,
                    queue_root=DATA_DIR,
                )

            self._send_json(200, {
                "ok": True,
                "sampleId": sample_id,
                "imagePath": str(saved_path),
                "cameraId": camera_id,
                "presetName": preset_name,
            })
        except Exception as exc:
            logger.error("Pipeline collect error: %s", exc, exc_info=True)
            self._send_json(500, {"error": "COLLECT_FAILED", "message": str(exc)})

    def handle_pipeline_verify(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8"))
            sample_id = str(data.get("sampleId", ""))
            operator_id = str(data.get("operatorId", ""))
            approved = bool(data.get("approved", True))
            corrected_bboxes = data.get("correctedBboxes")
            negative_confirmed = bool(data.get("negativeConfirmed", False))
            notes = str(data.get("notes", ""))

            verify_sample(
                sample_id=sample_id,
                operator_id=operator_id,
                approved=approved,
                corrected_bboxes=corrected_bboxes,
                negative_confirmed=negative_confirmed,
                notes=notes,
                queue_root=DATA_DIR,
            )
            self._send_json(200, {
                "ok": True,
                "sampleId": sample_id,
                "approved": approved,
                "negativeConfirmed": negative_confirmed,
            })
        except ValueError as val_err:
            self._send_json(400, {"error": "VALIDATION_FAILED", "message": str(val_err)})
        except Exception as exc:
            logger.error("Pipeline verify error: %s", exc, exc_info=True)
            self._send_json(500, {"error": "VERIFY_FAILED", "message": str(exc)})

    def handle_pipeline_export(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
            version = str(data.get("version", "v1.0.0"))
            res = export_dataset_splits(
                output_dir=DATASET_DIR,
                data_root=DATA_DIR,
                version=version,
            )
            self._send_json(200, res)
        except ValueError as val_err:
            self._send_json(400, {"error": "EXPORT_FAILED", "message": str(val_err)})
        except Exception as exc:
            logger.error("Pipeline export error: %s", exc, exc_info=True)
            self._send_json(500, {"error": "EXPORT_ERROR", "message": str(exc)})

    def handle_pipeline_train(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
            epochs = int(data.get("epochs", 10))
            batch_size = int(data.get("batchSize", 8))
            img_size = int(data.get("imgSize", 640))
            operator_id = str(data.get("operatorId", "system"))
            job_id = f"job_{uuid.uuid4().hex[:12]}"

            # Synchronously reserve lock
            lock = PipelineJobLock(DATA_DIR / ".pipeline_job.lock")
            lock.acquire("training", operator_id, job_id=job_id)

            update_job_status(
                status="TRAINING",
                job_type="training",
                job_id=job_id,
                progress=0.05,
                message=f"Training started in background ({epochs} epochs, batch {batch_size})",
                data_root=DATA_DIR,
            )

            def _run():
                try:
                    res_path = train_headset_model(
                        dataset_yaml=resolve_active_dataset_manifest(DATASET_DIR),
                        epochs=epochs,
                        batch_size=batch_size,
                        img_size=img_size,
                        base_model=MODELS_DIR / "yolo11n.pt",
                        output_candidate=MODELS_DIR / "candidate_vr_headset.pt",
                        operator_id=operator_id,
                        _acquired_lock=lock,
                    )
                except Exception as t_err:
                    logger.error("Background training failed: %s", t_err, exc_info=True)
                    update_job_status(
                        status="FAILED",
                        job_type="training",
                        job_id=job_id,
                        progress=0.0,
                        error=str(t_err),
                        data_root=DATA_DIR,
                    )
                finally:
                    lock.release()

            th = threading.Thread(target=_run, daemon=True)
            th.start()
            self._send_json(202, {
                "ok": True,
                "jobId": job_id,
                "status": "STARTED",
                "message": f"Training started in background ({epochs} epochs, batch {batch_size})",
            })
        except RuntimeError as r_err:
            if "JOB_IN_PROGRESS" in str(r_err):
                self._send_json(409, {"error": "JOB_IN_PROGRESS", "message": str(r_err)})
            else:
                self._send_json(500, {"error": "TRAIN_FAILED", "message": str(r_err)})
        except Exception as exc:
            self._send_json(500, {"error": "TRAIN_FAILED", "message": str(exc)})

    def handle_pipeline_activate(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
            cand = data.get("candidate", str(MODELS_DIR / "candidate_vr_headset.pt"))
            version = str(data.get("version", "v1.0.0"))
            operator_id = str(data.get("operatorId", "system"))
            job_id = f"job_{uuid.uuid4().hex[:12]}"

            # Synchronously reserve lock
            lock = PipelineJobLock(DATA_DIR / ".pipeline_job.lock")
            lock.acquire("activation", operator_id, job_id=job_id)

            update_job_status(
                status="ACTIVATING",
                job_type="activation",
                job_id=job_id,
                progress=0.1,
                message="Validating candidate and quality gates...",
                data_root=DATA_DIR,
            )

            def _run():
                global HEADSET_MODEL, HEADSET_MODEL_STATUS, HEADSET_MODEL_ERROR, HEADSET_MODEL_METRICS, HEADSET_MODEL_METADATA
                activation_succeeded = False
                res = None
                try:
                    res = activate_candidate_model(
                        candidate_model_path=cand,
                        dataset_version=version,
                        dataset_yaml=resolve_active_dataset_manifest(DATASET_DIR),
                        models_dir=MODELS_DIR,
                        operator_id=operator_id,
                        _acquired_lock=lock,
                    )
                    activation_succeeded = True

                    # Hot reload headset model in runtime
                    try:
                        reval = validate_and_load_headset_model()
                        if not YOLO_WORLD_AVAILABLE:
                            HEADSET_MODEL = reval.model
                            HEADSET_MODEL_STATUS = reval.status
                            HEADSET_MODEL_ERROR = reval.error
                            HEADSET_MODEL_METRICS = reval.metrics
                            HEADSET_MODEL_METADATA = reval.metadata
                        set_primary_headset_model()
                    except Exception as reload_err:
                        logger.warning("Post-activation runtime reload warning: %s", reload_err, exc_info=True)

                    update_job_status(
                        status="COMPLETED",
                        job_type="activation",
                        job_id=job_id,
                        progress=1.0,
                        message="Model activated successfully",
                        result=res,
                        metrics=res.get("metrics") if res else None,
                        data_root=DATA_DIR,
                    )
                except Exception as a_err:
                    logger.error("Background activation error: %s", a_err, exc_info=True)
                    if activation_succeeded:
                        # Model was actually activated on disk! Do not mark job as FAILED
                        logger.warning("Activation succeeded on disk but post-activation step had notice: %s", a_err)
                        try:
                            update_job_status(
                                status="COMPLETED",
                                job_type="activation",
                                job_id=job_id,
                                progress=1.0,
                                message=f"Model activated on disk (post-activation notice: {a_err})",
                                result=res or {},
                                metrics=res.get("metrics") if res else None,
                                data_root=DATA_DIR,
                            )
                        except Exception:
                            pass
                    else:
                        is_uncertain = "ACTIVATION_STATE_UNCERTAIN" in str(a_err)
                        if is_uncertain:
                            HEADSET_MODEL = None
                            HEADSET_MODEL_STATUS = "ACTIVATION_STATE_UNCERTAIN"
                            HEADSET_MODEL_ERROR = str(a_err)
                            update_job_status(
                                status="ACTIVATION_STATE_UNCERTAIN",
                                job_type="activation",
                                job_id=job_id,
                                progress=0.0,
                                error=str(a_err),
                                data_root=DATA_DIR,
                            )
                        else:
                            update_job_status(
                                status="FAILED",
                                job_type="activation",
                                job_id=job_id,
                                progress=0.0,
                                error=str(a_err),
                                data_root=DATA_DIR,
                            )
                finally:
                    lock.release()

            th = threading.Thread(target=_run, daemon=True)
            th.start()
            self._send_json(202, {
                "ok": True,
                "jobId": job_id,
                "status": "STARTED",
                "message": "Activation started in background",
            })
        except RuntimeError as r_err:
            if "JOB_IN_PROGRESS" in str(r_err):
                self._send_json(409, {"error": "JOB_IN_PROGRESS", "message": str(r_err)})
            else:
                self._send_json(500, {"error": "ACTIVATION_FAILED", "message": str(r_err)})
        except Exception as exc:
            self._send_json(500, {"error": "ACTIVATION_FAILED", "message": str(exc)})

    def handle_pipeline_rollback(self, body: bytes):
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
            operator_id = str(data.get("operatorId", "system"))
            job_id = f"job_{uuid.uuid4().hex[:12]}"

            # Synchronously reserve lock
            lock = PipelineJobLock(DATA_DIR / ".pipeline_job.lock")
            lock.acquire("rollback", operator_id, job_id=job_id)

            update_job_status(
                status="ROLLING_BACK",
                job_type="rollback",
                job_id=job_id,
                progress=0.1,
                message="Restoring previous model...",
                data_root=DATA_DIR,
            )

            def _run():
                global HEADSET_MODEL, HEADSET_MODEL_STATUS, HEADSET_MODEL_ERROR, HEADSET_MODEL_METRICS, HEADSET_MODEL_METADATA
                rollback_succeeded = False
                try:
                    rollback_model(models_dir=MODELS_DIR, operator_id=operator_id, _acquired_lock=lock)
                    rollback_succeeded = True

                    try:
                        reval = validate_and_load_headset_model()
                        if not YOLO_WORLD_AVAILABLE:
                            HEADSET_MODEL = reval.model
                            HEADSET_MODEL_STATUS = reval.status
                            HEADSET_MODEL_ERROR = reval.error
                            HEADSET_MODEL_METRICS = reval.metrics
                            HEADSET_MODEL_METADATA = reval.metadata
                        set_primary_headset_model()
                    except Exception as reload_err:
                        logger.warning("Post-rollback runtime reload warning: %s", reload_err, exc_info=True)

                    update_job_status(
                        status="COMPLETED",
                        job_type="rollback",
                        job_id=job_id,
                        progress=1.0,
                        message="Model rolled back successfully",
                        data_root=DATA_DIR,
                    )
                except Exception as rb_err:
                    logger.error("Background rollback error: %s", rb_err, exc_info=True)
                    if rollback_succeeded:
                        logger.warning("Rollback succeeded on disk but post-rollback step had notice: %s", rb_err)
                        try:
                            update_job_status(
                                status="COMPLETED",
                                job_type="rollback",
                                job_id=job_id,
                                progress=1.0,
                                message=f"Model rolled back on disk (post-rollback notice: {rb_err})",
                                data_root=DATA_DIR,
                            )
                        except Exception:
                            pass
                    else:
                        is_uncertain = "ACTIVATION_STATE_UNCERTAIN" in str(rb_err)
                        if is_uncertain:
                            HEADSET_MODEL = None
                            HEADSET_MODEL_STATUS = "ACTIVATION_STATE_UNCERTAIN"
                            HEADSET_MODEL_ERROR = str(rb_err)
                            update_job_status(
                                status="ACTIVATION_STATE_UNCERTAIN",
                                job_type="rollback",
                                job_id=job_id,
                                progress=0.0,
                                error=str(rb_err),
                                data_root=DATA_DIR,
                            )
                        else:
                            update_job_status(
                                status="FAILED",
                                job_type="rollback",
                                job_id=job_id,
                                progress=0.0,
                                error=str(rb_err),
                                data_root=DATA_DIR,
                            )
                finally:
                    lock.release()

            th = threading.Thread(target=_run, daemon=True)
            th.start()
            self._send_json(202, {
                "ok": True,
                "jobId": job_id,
                "status": "STARTED",
                "message": "Rollback started in background",
            })
        except RuntimeError as r_err:
            if "JOB_IN_PROGRESS" in str(r_err):
                self._send_json(409, {"error": "JOB_IN_PROGRESS", "message": str(r_err)})
            else:
                self._send_json(500, {"error": "ROLLBACK_FAILED", "message": str(r_err)})
        except Exception as exc:
            self._send_json(500, {"error": "ROLLBACK_FAILED", "message": str(exc)})

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
