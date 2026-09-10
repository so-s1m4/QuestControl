#!/usr/bin/env python3
"""
QuestControl VR Headset Dataset & Model Lifecycle Pipeline

Enforces:
1. PTZ raw inspection frame collection in data/raw/<camera_id>/
2. Human verification queue (operator bbox verification, rejecting unverified self-training)
3. Room-level stratified train/val/test export (zero room angle leakage between splits)
4. Model quality gates on holdout test split (mAP50 >= 0.85, Precision >= 0.80, Recall >= 0.80)
5. Atomic activation with automatic backup and rollback upon performance degradation.

Licensed under GNU AGPL-3.0.
"""

import argparse
import fcntl
import hashlib
import json
import logging
import math
import os
import random
import shutil
import sys
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("questcontrol.ai.pipeline")

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
DATA_DIR = AI_SERVICE_DIR / "data"
MODELS_DIR = AI_SERVICE_DIR / "models"
DATASET_DIR = AI_SERVICE_DIR / "dataset"

if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from model_validator import (
    DEFAULT_MIN_MAP50,
    DEFAULT_MIN_PRECISION,
    DEFAULT_MIN_RECALL,
    compute_dataset_manifest_hash,
    compute_sha256,
    prevent_ultralytics_network_downloads,
    validate_and_load_headset_model,
)

prevent_ultralytics_network_downloads()


_IN_PROCESS_LOCK = threading.Lock()


def _is_pid_running(pid: int) -> bool:
    """Checks if a process with the given PID is currently active."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class PipelineJobLock:
    """
    Mutual exclusion lock to prevent concurrent training, activation, or rollback jobs.
    Combines an in-process threading.Lock (for thread safety) with an OS-level fcntl.flock
    on an open file descriptor (for process safety), ensuring true atomicity.
    """
    def __init__(self, lock_file: Union[str, Path] = DATA_DIR / ".pipeline_job.lock"):
        self.lock_path = Path(lock_file)
        self._fd: Optional[int] = None
        self._in_process_acquired: bool = False

    def acquire(self, job_type: str, operator_id: str, job_id: Optional[str] = None) -> bool:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        if not _IN_PROCESS_LOCK.acquire(blocking=False):
            raise RuntimeError(
                f"JOB_IN_PROGRESS: Another pipeline job is currently executing in this process."
            )
        self._in_process_acquired = True

        try:
            self._fd = os.open(str(self.lock_path), os.O_RDWR | os.O_CREAT, 0o644)
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (BlockingIOError, OSError) as e:
                raise RuntimeError(
                    f"JOB_IN_PROGRESS: Another pipeline job currently holds the file lock."
                ) from e

            actual_job_id = job_id or f"job_{uuid.uuid4().hex[:12]}"
            payload = {
                "pid": os.getpid(),
                "jobId": actual_job_id,
                "jobType": job_type,
                "operatorId": operator_id,
                "startedAt": datetime.now(timezone.utc).isoformat(),
            }
            os.ftruncate(self._fd, 0)
            os.lseek(self._fd, 0, os.SEEK_SET)
            os.write(self._fd, json.dumps(payload, indent=2).encode("utf-8"))
            os.fsync(self._fd)
            return True
        except Exception:
            if self._fd is not None:
                try:
                    os.close(self._fd)
                except OSError:
                    pass
                self._fd = None
            if self._in_process_acquired:
                _IN_PROCESS_LOCK.release()
                self._in_process_acquired = False
            raise

    def release(self):
        try:
            if self._fd is not None:
                try:
                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                except OSError:
                    pass
                try:
                    os.close(self._fd)
                except OSError:
                    pass
            # Never unlink lock_path to preserve stable inode across locks and avoid POSIX flock race
            pass
        finally:
            if self._in_process_acquired:
                _IN_PROCESS_LOCK.release()
                self._in_process_acquired = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.release()


def reconcile_daemon_job_status(data_root: Union[str, Path] = DATA_DIR) -> Dict[str, Any]:
    """
    Reconciles in-progress daemon job status upon restart or crash.
    If a job is recorded as TRAINING, ACTIVATING, or ROLLING_BACK, but no process holds
    the pipeline file lock, transitions status to INTERRUPTED.
    """
    st_file = Path(data_root) / "pipeline_job_status.json"
    if not st_file.is_file():
        return {"status": "IDLE", "updatedAt": datetime.now(timezone.utc).isoformat()}
    try:
        data = json.loads(st_file.read_text(encoding="utf-8"))
    except Exception:
        return {"status": "UNKNOWN", "error": "Invalid status file"}

    st = data.get("status")
    if st in ("TRAINING", "ACTIVATING", "ROLLING_BACK", "RUNNING"):
        lock_file = Path(data_root) / ".pipeline_job.lock"
        is_held = False
        if lock_file.is_file():
            try:
                fd = os.open(str(lock_file), os.O_RDWR)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(fd, fcntl.LOCK_UN)
                    is_held = False
                except (BlockingIOError, OSError):
                    is_held = True
                finally:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            except OSError:
                is_held = False

        if not is_held:
            logger.warning(
                "Stale background job detected without lock: jobId=%s, type=%s, status=%s. Reconciling to INTERRUPTED.",
                data.get("jobId"),
                data.get("jobType"),
                st,
            )
            update_job_status(
                status="INTERRUPTED",
                job_type=data.get("jobType", ""),
                job_id=data.get("jobId"),
                progress=data.get("progress", 0.0),
                error="Job was interrupted by daemon restart or process termination",
                data_root=data_root,
            )
            try:
                return json.loads(st_file.read_text(encoding="utf-8"))
            except Exception:
                pass
    return data


def get_job_status(data_root: Union[str, Path] = DATA_DIR) -> Dict[str, Any]:
    """Reads current status of background pipeline training or activation with auto-reconciliation."""
    return reconcile_daemon_job_status(data_root=data_root)


def update_job_status(
    status: str,
    job_type: str = "",
    job_id: Optional[str] = None,
    progress: float = 0.0,
    message: str = "",
    error: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    metrics: Optional[Dict[str, float]] = None,
    data_root: Union[str, Path] = DATA_DIR,
):
    """Atomically records background job status for UI and API status polling."""
    d_dir = Path(data_root)
    d_dir.mkdir(parents=True, exist_ok=True)
    st_file = d_dir / "pipeline_job_status.json"
    data = {
        "status": status,
        "jobId": job_id,
        "jobType": job_type,
        "progress": round(progress, 2),
        "message": message,
        "error": error,
        "result": result,
        "metrics": metrics,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    with tempfile.NamedTemporaryFile(dir=d_dir, delete=False, prefix="tmp_status_", suffix=".json", mode="w", encoding="utf-8") as tf:
        json.dump(data, tf, indent=2)
        tf.flush()
        os.fsync(tf.fileno())
        tmp_name = tf.name
    os.replace(tmp_name, st_file)



def collect_ptz_frame(
    camera_id: str,
    room_id: str,
    preset_name: str,
    image_bytes: bytes,
    timestamp: Optional[str] = None,
    capture_session_id: Optional[str] = None,
    output_root: Union[str, Path] = DATA_DIR,
) -> Path:
    """
    Saves raw PTZ inspection frame to data/raw/<camera_id>/<ts>_<preset>.jpg
    along with sidecar JSON metadata.
    """
    ts_str = timestamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_preset = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in preset_name)
    raw_dir = Path(output_root) / "raw" / camera_id
    raw_dir.mkdir(parents=True, exist_ok=True)

    filename_base = f"{ts_str}_{safe_preset}"
    img_path = raw_dir / f"{filename_base}.jpg"
    meta_path = raw_dir / f"{filename_base}.json"

    with open(img_path, "wb") as f:
        f.write(image_bytes)

    meta = {
        "cameraId": camera_id,
        "roomId": room_id,
        "presetName": preset_name,
        "captureSessionId": capture_session_id,
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        "imagePath": str(img_path),
        "sha256": hashlib.sha256(image_bytes).hexdigest(),
    }
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    logger.info("Collected raw PTZ frame for camera %s preset %s: %s", camera_id, preset_name, img_path.name)
    return img_path


def enqueue_for_verification(
    raw_image_path: Union[str, Path],
    initial_bboxes: Optional[List[Dict[str, Any]]] = None,
    queue_root: Union[str, Path] = DATA_DIR,
) -> str:
    """
    Enqueues a raw frame into data/verification_queue/<sample_id>/ for human review.
    """
    raw_path = Path(raw_image_path)
    if not raw_path.is_file():
        raise FileNotFoundError(f"Raw frame not found: {raw_image_path}")

    sidecar_path = raw_path.with_suffix(".json")
    meta: Dict[str, Any] = {}
    if sidecar_path.is_file():
        try:
            with open(sidecar_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass

    sample_id = f"sample_{hashlib.sha256(raw_path.read_bytes()).hexdigest()[:12]}"
    sample_dir = Path(queue_root) / "verification_queue" / sample_id
    sample_dir.mkdir(parents=True, exist_ok=True)

    shutil.copy2(raw_path, sample_dir / "image.jpg")

    item_data = {
        "sampleId": sample_id,
        "rawSource": str(raw_path),
        "roomId": meta.get("roomId", "unknown_room"),
        "cameraId": meta.get("cameraId", "unknown_cam"),
        "presetName": meta.get("presetName", "default"),
        "captureSessionId": meta.get("captureSessionId"),
        "collectedAt": meta.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "bboxes": initial_bboxes or [],
        "verified": False,
        "approved": False,
        "negativeConfirmed": False,
        "operatorId": None,
        "notes": "",
    }
    with open(sample_dir / "annotation.json", "w", encoding="utf-8") as f:
        json.dump(item_data, f, indent=2)

    logger.info("Enqueued sample %s for human verification", sample_id)
    return sample_id


def record_audit_event(
    action: str,
    operator_id: str,
    details: Dict[str, Any],
    audit_log_path: Union[str, Path] = DATA_DIR / "audit_trail.jsonl",
):
    """Appends an immutable audit log entry for model and dataset lifecycle operations."""
    audit_file = Path(audit_log_path)
    audit_file.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "action": action,
        "operatorId": operator_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "details": details,
    }
    with open(audit_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def validate_bboxes(
    bboxes: List[Dict[str, Any]],
    allow_empty: bool = False,
) -> List[str]:
    """
    Validates annotation bounding boxes for YOLO training.
    Returns list of error strings (empty list = valid).

    Rules:
    - classId must be 0 (vr_headset) — defaults to 0 when absent.
    - x, y, width, height must be finite floats in [0, 1].
    - width > 0 and height > 0.
    - boxes inside bounds: x + width <= 1.0, y + height <= 1.0.
    - Empty bboxes are only valid if allow_empty (operator-confirmed negative sample).
    """
    errors: List[str] = []
    if not bboxes:
        if not allow_empty:
            errors.append("No bounding boxes provided and sample not confirmed as negative")
        return errors

    for i, b in enumerate(bboxes):
        cls_id = b.get("classId", b.get("class_id", 0))
        try:
            if int(cls_id) != 0:
                errors.append(f"bbox[{i}]: classId must be 0 (vr_headset), got {cls_id}")
        except (ValueError, TypeError):
            errors.append(f"bbox[{i}]: classId is not a valid integer: {cls_id}")

        coords_valid = True
        for coord in ("x", "y", "width", "height"):
            val = b.get(coord)
            if val is None:
                errors.append(f"bbox[{i}]: missing required field '{coord}'")
                coords_valid = False
                continue
            try:
                fval = float(val)
            except (ValueError, TypeError):
                errors.append(f"bbox[{i}]: '{coord}' is not a valid number: {val}")
                coords_valid = False
                continue
            if not math.isfinite(fval):
                errors.append(f"bbox[{i}]: '{coord}' is not finite: {val}")
                coords_valid = False
            elif fval < 0.0 or fval > 1.0:
                errors.append(f"bbox[{i}]: '{coord}' out of normalized [0,1] range: {val}")
                coords_valid = False

        if coords_valid:
            bx = float(b["x"])
            by = float(b["y"])
            bw = float(b["width"])
            bh = float(b["height"])
            if bw <= 0:
                errors.append(f"bbox[{i}]: width must be > 0, got {bw}")
            if bh <= 0:
                errors.append(f"bbox[{i}]: height must be > 0, got {bh}")
            if bx + bw > 1.0001:
                errors.append(f"bbox[{i}]: box extends outside horizontal bounds: x={bx} + width={bw} = {bx+bw:.4f} > 1.0")
            if by + bh > 1.0001:
                errors.append(f"bbox[{i}]: box extends outside vertical bounds: y={by} + height={bh} = {by+bh:.4f} > 1.0")

    return errors


def verify_sample(
    sample_id: str,
    operator_id: str,
    approved: bool = True,
    corrected_bboxes: Optional[List[Dict[str, Any]]] = None,
    negative_confirmed: bool = False,
    notes: str = "",
    queue_root: Union[str, Path] = DATA_DIR,
) -> bool:
    """
    Human verification step. Only operator-verified and approved samples
    are moved to data/verified/ and eligible for training.
    Validates bboxes on approval. Empty bboxes require negative_confirmed=True.
    """
    if not operator_id or not operator_id.strip():
        raise ValueError("Operator ID is strictly required for verification audit")

    src_dir = Path(queue_root) / "verification_queue" / sample_id
    if not src_dir.is_dir():
        raise FileNotFoundError(f"Sample not found in verification queue: {sample_id}")

    anno_file = src_dir / "annotation.json"
    with open(anno_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    data["verified"] = True
    data["approved"] = bool(approved)
    data["operatorId"] = operator_id
    data["verifiedAt"] = datetime.now(timezone.utc).isoformat()
    data["notes"] = notes
    data["negativeConfirmed"] = bool(negative_confirmed)
    if corrected_bboxes is not None:
        data["bboxes"] = corrected_bboxes

    # Validate bboxes on approval
    if approved:
        bbox_errors = validate_bboxes(
            data["bboxes"],
            allow_empty=negative_confirmed,
        )
        if bbox_errors:
            raise ValueError(f"Bbox validation failed: {'; '.join(bbox_errors)}")

    with open(anno_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    dest_folder = "verified" if approved else "rejected"
    dest_dir = Path(queue_root) / dest_folder / sample_id
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    shutil.move(str(src_dir), str(dest_dir))

    record_audit_event(
        action="verify_sample",
        operator_id=operator_id,
        details={
            "sampleId": sample_id,
            "approved": approved,
            "negativeConfirmed": negative_confirmed,
            "bboxCount": len(data.get("bboxes", [])),
            "notes": notes,
        },
        audit_log_path=Path(queue_root) / "audit_trail.jsonl",
    )

    logger.info(
        "Sample %s verified by operator %s: approved=%s, moved to %s",
        sample_id,
        operator_id,
        approved,
        dest_folder,
    )
    return True


def list_verification_queue(
    status_filter: str = "pending",
    queue_root: Union[str, Path] = DATA_DIR,
) -> List[Dict[str, Any]]:
    """
    Returns items in verification queue or verified/rejected archives.
    status_filter options: 'pending', 'verified', 'rejected', 'all'.
    """
    root = Path(queue_root)
    folders = []
    if status_filter in ("pending", "all"):
        folders.append((root / "verification_queue", "pending"))
    if status_filter in ("verified", "all"):
        folders.append((root / "verified", "verified"))
    if status_filter in ("rejected", "all"):
        folders.append((root / "rejected", "rejected"))

    items = []
    for fld, queue_status in folders:
        if not fld.is_dir():
            continue
        for s_dir in sorted(fld.iterdir(), reverse=True):
            if not s_dir.is_dir():
                continue
            anno_file = s_dir / "annotation.json"
            img_file = s_dir / "image.jpg"
            if not anno_file.is_file():
                continue
            try:
                data = json.loads(anno_file.read_text(encoding="utf-8"))
                data["queueStatus"] = queue_status
                data["hasImage"] = img_file.is_file()
                items.append(data)
            except Exception:
                continue
    return items


def get_sample_image(
    sample_id: str,
    queue_root: Union[str, Path] = DATA_DIR,
) -> Optional[Tuple[bytes, str]]:
    """
    Finds and reads raw JPEG image bytes for a sample across queue folders.
    """
    root = Path(queue_root)
    for folder_name in ("verification_queue", "verified", "rejected"):
        img_p = root / folder_name / sample_id / "image.jpg"
        if img_p.is_file():
            return img_p.read_bytes(), "image/jpeg"
    return None


def get_sample_metadata(
    sample_id: str,
    queue_root: Union[str, Path] = DATA_DIR,
) -> Optional[Dict[str, Any]]:
    """
    Finds and reads annotation.json metadata for a sample across queue folders.
    """
    root = Path(queue_root)
    for folder_name in ("verification_queue", "verified", "rejected"):
        anno_p = root / folder_name / sample_id / "annotation.json"
        if anno_p.is_file():
            try:
                data = json.loads(anno_p.read_text(encoding="utf-8"))
                data["queueStatus"] = "pending" if folder_name == "verification_queue" else folder_name
                return data
            except Exception:
                pass
    return None


def _derive_session_key(anno: Dict[str, Any]) -> str:
    """
    Derives an independent capture session key from annotation metadata.
    Priority: explicit captureSessionId > date+cameraId (one recording session).
    Adjacent frames from one recording stay grouped together.
    """
    session_id = anno.get("captureSessionId")
    if session_id:
        return str(session_id)
    # Fallback: date portion of collectedAt + cameraId
    collected = anno.get("collectedAt", "")
    date_part = collected[:10] if len(collected) >= 10 else "unknown_date"
    camera_id = anno.get("cameraId", "unknown_cam")
    return f"{date_part}_{camera_id}"


def export_dataset_splits(
    output_dir: Union[str, Path] = DATASET_DIR,
    data_root: Union[str, Path] = DATA_DIR,
    version: str = "v1.0.0",
    val_ratio: float = 0.20,
    test_ratio: float = 0.20,
    seed: int = 42,
) -> Dict[str, Any]:
    """
    Exports versioned dataset (YOLO format) strictly from operator-verified samples.
    Builds the entire dataset in a temporary sibling directory (.staging_<uuid>),
    validates zero leakage and matching label files, fsyncs, then atomically replaces
    the target directory so zero stale files remain from previous exports.

    Enforces SESSION-LEVEL stratification: all frames from one independent capture session
    (captureSessionId or date+camera) are assigned together to a single split,
    guaranteeing zero cross-split leakage of adjacent frames.

    Requires at least 3 independent sessions to populate non-empty train/val/test splits.
    Generates manifest.json with complete sample provenance and test split checksum.
    """
    verified_dir = Path(data_root) / "verified"
    if not verified_dir.is_dir():
        raise ValueError("No verified dataset samples found. Verification is required before export.")

    samples: List[Dict[str, Any]] = []
    for s_dir in sorted(verified_dir.iterdir()):
        if not s_dir.is_dir():
            continue
        anno_file = s_dir / "annotation.json"
        img_file = s_dir / "image.jpg"
        if not anno_file.is_file() or not img_file.is_file():
            continue
        with open(anno_file, "r", encoding="utf-8") as f:
            anno = json.load(f)
        if not anno.get("verified") or not anno.get("approved"):
            continue

        # Validate bboxes at export time (belt-and-suspenders with verify_sample)
        bboxes = anno.get("bboxes", [])
        is_negative = anno.get("negativeConfirmed", False)
        bbox_errs = validate_bboxes(bboxes, allow_empty=is_negative)
        if bbox_errs:
            logger.warning("Skipping sample %s: bbox validation failed: %s", s_dir.name, "; ".join(bbox_errs))
            continue

        samples.append({"id": s_dir.name, "dir": s_dir, "anno": anno})

    if not samples:
        raise ValueError("Cannot export dataset: 0 operator-verified and approved samples available.")

    # Group by independent capture session (NOT roomId) to prevent leakage
    session_groups: Dict[str, List[Dict[str, Any]]] = {}
    for s in samples:
        session_key = _derive_session_key(s["anno"])
        session_groups.setdefault(session_key, []).append(s)

    session_keys = sorted(session_groups.keys())
    n_sessions = len(session_keys)

    if n_sessions < 3:
        raise ValueError(
            f"DATASET_INSUFFICIENT: At least 3 independent capture sessions required for "
            f"train/val/test splits, but only {n_sessions} found: {session_keys}. "
            f"Collect more data from different sessions/dates/cameras before exporting."
        )

    rng = random.Random(seed)
    rng.shuffle(session_keys)

    n_test = max(1, int(round(n_sessions * test_ratio)))
    n_val = max(1, int(round(n_sessions * val_ratio)))
    # Ensure train gets at least 1 session
    if n_test + n_val >= n_sessions:
        n_val = max(1, n_sessions - n_test - 1)
        if n_test + n_val >= n_sessions:
            n_test = 1
            n_val = 1

    test_sessions = set(session_keys[:n_test])
    val_sessions = set(session_keys[n_test:n_test + n_val])
    train_sessions = set(session_keys[n_test + n_val:])

    assert train_sessions, "Internal error: train split must have at least 1 session"

    out_p = Path(output_dir).resolve()
    out_p.mkdir(parents=True, exist_ok=True)

    releases_dir = out_p / "releases"
    releases_dir.mkdir(parents=True, exist_ok=True)

    rel_dir = releases_dir / version
    if rel_dir.exists():
        raise ValueError(
            f"DATASET_RELEASE_EXISTS: Dataset release '{version}' already exists at '{rel_dir}'. "
            "Published dataset releases are strictly immutable and cannot be overwritten."
        )

    # Build entire dataset in a temporary sibling directory inside the persistent volume root
    staging_p = out_p / f".staging_{uuid.uuid4().hex}"
    staging_p.mkdir(parents=False, exist_ok=False)

    try:
        for split in ["train", "val", "test"]:
            (staging_p / "images" / split).mkdir(parents=True, exist_ok=True)
            (staging_p / "labels" / split).mkdir(parents=True, exist_ok=True)

        split_counts = {"train": 0, "val": 0, "test": 0}
        sample_sha_to_split: Dict[str, str] = {}  # Track SHA→split for leakage detection
        provenance_samples: List[Dict[str, Any]] = []

        for session_key, s_samples in session_groups.items():
            if session_key in test_sessions:
                target_split = "test"
            elif session_key in val_sessions:
                target_split = "val"
            else:
                target_split = "train"

            for s in s_samples:
                s_id = s["id"]
                src_img = s["dir"] / "image.jpg"
                img_sha = hashlib.sha256(src_img.read_bytes()).hexdigest()

                # Verify no SHA appears in multiple splits (detect accidental leakage)
                if img_sha in sample_sha_to_split and sample_sha_to_split[img_sha] != target_split:
                    raise ValueError(
                        f"DATASET_LEAKAGE: Image SHA {img_sha[:12]} appears in both "
                        f"'{sample_sha_to_split[img_sha]}' and '{target_split}' splits"
                    )
                sample_sha_to_split[img_sha] = target_split

                dst_img = staging_p / "images" / target_split / f"{s_id}.jpg"
                dst_lbl = staging_p / "labels" / target_split / f"{s_id}.txt"

                shutil.copy2(src_img, dst_img)

                # Convert bboxes to YOLO format: class x_center y_center width height
                lines = []
                for b in s["anno"].get("bboxes", []):
                    cls_id = int(b.get("classId", b.get("class_id", 0)))
                    bx = float(b.get("x", 0.0))
                    by = float(b.get("y", 0.0))
                    bw = float(b.get("width", 0.0))
                    bh = float(b.get("height", 0.0))
                    xc = max(0.0, min(1.0, bx + bw / 2.0))
                    yc = max(0.0, min(1.0, by + bh / 2.0))
                    lines.append(f"{cls_id} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}\n")

                with open(dst_lbl, "w", encoding="utf-8") as lf:
                    lf.writelines(lines)
                    lf.flush()
                    os.fsync(lf.fileno())

                lbl_sha = hashlib.sha256(dst_lbl.read_bytes()).hexdigest()

                split_counts[target_split] += 1
                provenance_samples.append({
                    "sampleId": s_id,
                    "sha256": img_sha,
                    "imageSha256": img_sha,
                    "labelSha256": lbl_sha,
                    "split": target_split,
                    "sessionKey": session_key,
                    "bboxCount": len(s["anno"].get("bboxes", [])),
                    "operatorId": s["anno"].get("operatorId"),
                    "verifiedAt": s["anno"].get("verifiedAt"),
                })

        # Final check: all splits must be non-empty (guaranteed by 3+ sessions assignment)
        for split_name, count in split_counts.items():
            if count == 0:
                raise ValueError(
                    f"DATASET_INSUFFICIENT: '{split_name}' split ended up with 0 samples "
                    f"despite {n_sessions} sessions. Check session distribution."
                )

        curr_link = out_p / "current"

        # Ultralytics resolves `path: .` against the worker process directory,
        # not necessarily the directory containing this YAML.  Point it at the
        # immutable release explicitly so training always reads its own images.
        dataset_yaml_content = f"""# QuestControl VR Headset YOLO Dataset
path: {rel_dir.resolve()}
train: images/train
val: images/val
test: images/test
names:
  0: vr_headset
version: {version}
exported_at: {datetime.now(timezone.utc).isoformat()}
"""
        yaml_path = staging_p / "dataset.yaml"
        with open(yaml_path, "w", encoding="utf-8") as yf:
            yf.write(dataset_yaml_content)
            yf.flush()
            os.fsync(yf.fileno())

        # Manifest hash covers dataset.yaml and all images + labels across all splits
        manifest_hash = compute_dataset_manifest_hash(yaml_path)

        manifest_data = {
            "version": version,
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "manifestHash": manifest_hash,
            "splitCounts": split_counts,
            "totalSamples": len(samples),
            "sessionGroups": list(session_groups.keys()),
            "samples": provenance_samples,
        }
        manifest_path = staging_p / "manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as mf:
            json.dump(manifest_data, mf, indent=2)
            mf.flush()
            os.fsync(mf.fileno())

        # Move immutable release to releases_dir / version
        os.replace(staging_p, rel_dir)

        # Single-pointer atomic update inside the persistent mount root: current -> releases/<version>
        tmp_link = out_p / f".tmp_dcurr_{uuid.uuid4().hex}"
        try:
            os.symlink(f"releases/{version}", str(tmp_link))
            os.replace(str(tmp_link), str(curr_link))
        except Exception:
            if tmp_link.is_symlink() or tmp_link.exists():
                try:
                    tmp_link.unlink()
                except OSError:
                    pass
            raise

        try:
            dir_fd = os.open(str(out_p), os.O_RDONLY)
            os.fsync(dir_fd)
            os.close(dir_fd)
        except OSError:
            pass

        summary = {
            "version": version,
            "manifestHash": manifest_hash,
            "datasetYaml": str(curr_link / "dataset.yaml"),
            "manifestJson": str(curr_link / "manifest.json"),
            "releaseDir": str(rel_dir),
            "currentSymlink": str(curr_link),
            "splitCounts": split_counts,
            "totalSamples": len(samples),
            "sessionGroups": list(session_groups.keys()),
        }
        logger.info("Exported dataset version %s: %s", version, split_counts)
        return summary

    finally:
        if staging_p.exists():
            shutil.rmtree(staging_p, ignore_errors=True)



def verify_dataset_manifest_and_provenance(
    dataset_yaml: Union[str, Path] = DATASET_DIR / "dataset.yaml",
    expected_split: str = "test",
) -> Dict[str, Any]:
    """
    Rigorously verifies dataset manifest and provenance:
    1. manifest.json must exist and contain valid JSON.
    2. Required fields present: 'version', 'manifestHash', 'samples', 'splitCounts'.
    3. Recomputes manifestHash over dataset.yaml and disk image/label files across all splits (train, val, test),
       matching exactly.
    4. Non-empty train/val/test split counts and directories. Exact count matching between manifest and disk.
    5. Checks every manifest sample against disk: file exists, image SHA-256 matches, and label SHA-256 matches.
    6. Enforces strict cross-split disjointness: rejects duplicate sample IDs or duplicate image SHAs across splits.
    7. Traverses all split directories on disk: rejects untracked extra image or label files.
    8. Validates every YOLO label file: class 0 ('vr_headset'), finite normalized coordinates [0, 1], w > 0, h > 0.
    """
    yaml_p = Path(dataset_yaml).resolve()
    if not yaml_p.is_file():
        raise FileNotFoundError(f"DATASET_REQUIRED: Dataset descriptor not found at '{dataset_yaml}'")

    base_dir = yaml_p.parent
    manifest_file = base_dir / "manifest.json"
    if not manifest_file.is_file():
        raise ValueError(
            f"DATASET_CORRUPT: Missing manifest.json with sample provenance at '{manifest_file}'. "
            "Dataset must be exported through verified pipeline."
        )

    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise ValueError(f"DATASET_CORRUPT: Invalid manifest.json at '{manifest_file}': {e}")

    for field in ("version", "manifestHash", "samples", "splitCounts"):
        if field not in manifest:
            raise ValueError(f"DATASET_CORRUPT: manifest.json missing required field '{field}'")

    # Split counts check
    split_counts = manifest.get("splitCounts", {})
    for split_name in ("train", "val", "test"):
        if split_counts.get(split_name, 0) <= 0:
            raise ValueError(f"DATASET_INSUFFICIENT: Split '{split_name}' has 0 samples in manifest.")

    # Recompute and verify manifestHash
    expected_hash = manifest.get("manifestHash")
    recomputed_hash = compute_dataset_manifest_hash(yaml_p)
    if recomputed_hash != expected_hash:
        alt_hash = compute_dataset_manifest_hash(yaml_p, split=expected_split)
        if alt_hash != expected_hash:
            for split_check in ("train", "val", "test"):
                img_dir_check = base_dir / "images" / split_check
                if img_dir_check.is_dir():
                    manifest_sids = {s.get("sampleId") for s in manifest.get("samples", []) if s.get("sampleId")}
                    for f in img_dir_check.iterdir():
                        if f.is_file() and f.stem not in manifest_sids:
                            raise ValueError(
                                f"DATASET_CORRUPT: Untracked extra image found on disk not recorded in manifest.json: sample '{f.stem}'"
                            )
            raise ValueError(
                f"DATASET_CORRUPT: Manifest hash mismatch: expected '{expected_hash}', recomputed '{recomputed_hash}'. "
                "Dataset files have been tampered with or modified."
            )

    # Check images and labels directories exist on disk
    manifest_samples = manifest.get("samples", [])
    samples_by_id = {}
    seen_sids: Dict[str, str] = {}
    seen_image_shas: Dict[str, str] = {}
    manifest_counts_by_split = {"train": 0, "val": 0, "test": 0}

    for sample in manifest_samples:
        sid = sample.get("sampleId")
        split = sample.get("split")
        expected_img_sha = sample.get("sha256") or sample.get("imageSha256")
        expected_lbl_sha = sample.get("labelSha256")

        if not sid or not split or not expected_img_sha:
            raise ValueError(f"DATASET_CORRUPT: Manifest sample missing sampleId, split, or sha256: {sample}")

        if split not in manifest_counts_by_split:
            raise ValueError(f"DATASET_CORRUPT: Invalid split '{split}' in manifest sample '{sid}'")

        # Disjointness check: sample ID must not appear in multiple splits
        if sid in seen_sids:
            raise ValueError(
                f"DATASET_CORRUPT: Duplicate sample ID '{sid}' found across splits ('{seen_sids[sid]}' and '{split}')"
            )
        seen_sids[sid] = split

        # Disjointness check: image SHA must not appear in multiple splits
        if expected_img_sha in seen_image_shas and seen_image_shas[expected_img_sha] != split:
            raise ValueError(
                f"DATASET_CORRUPT: Duplicate image SHA '{expected_img_sha[:12]}' appears in multiple splits "
                f"('{seen_image_shas[expected_img_sha]}' and '{split}')"
            )
        seen_image_shas[expected_img_sha] = split
        manifest_counts_by_split[split] += 1
        samples_by_id[sid] = sample

        # Check image exists on disk and verify SHA-256
        target_img = base_dir / "images" / split / f"{sid}.jpg"
        if not target_img.is_file():
            target_img = base_dir / "images" / split / f"{sid}.png"
        if not target_img.is_file():
            raise ValueError(f"DATASET_CORRUPT: Manifest sample '{sid}' in split '{split}' not found on disk at '{target_img}'")

        actual_img_sha = compute_sha256(target_img)
        if actual_img_sha.lower() != expected_img_sha.strip().lower():
            raise ValueError(
                f"DATASET_CORRUPT: SHA-256 mismatch for sample '{sid}' in split '{split}': expected {expected_img_sha}, got {actual_img_sha}"
            )

        # Check label exists on disk and verify labelSha256 if present
        target_lbl = base_dir / "labels" / split / f"{sid}.txt"
        if not target_lbl.is_file():
            raise ValueError(f"DATASET_CORRUPT: Manifest sample '{sid}' label not found on disk at '{target_lbl}'")

        if expected_lbl_sha:
            actual_lbl_sha = compute_sha256(target_lbl)
            if actual_lbl_sha.lower() != expected_lbl_sha.strip().lower():
                raise ValueError(
                    f"DATASET_CORRUPT: Label SHA-256 mismatch for sample '{sid}' in split '{split}': expected {expected_lbl_sha}, got {actual_lbl_sha}"
                )

    disk_images_found = set()

    for split_name in ("train", "val", "test"):
        img_dir = base_dir / "images" / split_name
        lbl_dir = base_dir / "labels" / split_name
        if not img_dir.is_dir() or not lbl_dir.is_dir():
            raise ValueError(f"DATASET_CORRUPT: Missing directory '{img_dir}' or '{lbl_dir}'")

        imgs = sorted(list(img_dir.glob("*.jpg")) + list(img_dir.glob("*.png")) + list(img_dir.glob("*.jpeg")))
        lbls = sorted(list(lbl_dir.glob("*.txt")))

        if not imgs:
            raise ValueError(f"DATASET_INSUFFICIENT: Split '{split_name}' has no images on disk.")

        # Exact count matching
        if len(imgs) != split_counts.get(split_name, 0):
            raise ValueError(
                f"DATASET_CORRUPT: Split '{split_name}' disk image count ({len(imgs)}) does not match manifest count ({split_counts.get(split_name)})"
            )
        if len(lbls) != split_counts.get(split_name, 0):
            raise ValueError(
                f"DATASET_CORRUPT: Split '{split_name}' disk label count ({len(lbls)}) does not match manifest count ({split_counts.get(split_name)})"
            )
        if manifest_counts_by_split[split_name] != split_counts.get(split_name, 0):
            raise ValueError(
                f"DATASET_CORRUPT: Split '{split_name}' sample records ({manifest_counts_by_split[split_name]}) does not match splitCounts ({split_counts.get(split_name)})"
            )

        # Every image must have matching label file and vice versa
        img_stems = {img.stem: img for img in imgs}
        lbl_stems = {lbl.stem: lbl for lbl in lbls}

        for stem, img_path in img_stems.items():
            if stem not in lbl_stems:
                raise ValueError(f"DATASET_CORRUPT: Image '{img_path.name}' in '{split_name}' has no matching label file.")
            disk_images_found.add(stem)

        for stem, lbl_path in lbl_stems.items():
            if stem not in img_stems:
                raise ValueError(f"DATASET_CORRUPT: Label '{lbl_path.name}' in '{split_name}' has no matching image file.")

            # Validate label file contents
            content = lbl_path.read_text(encoding="utf-8").strip()
            if content:
                for line_idx, line in enumerate(content.splitlines(), start=1):
                    parts = line.strip().split()
                    if not parts:
                        continue
                    if len(parts) != 5:
                        raise ValueError(
                            f"DATASET_CORRUPT: Invalid label format in '{lbl_path.name}' line {line_idx}: expected 5 parts, got {len(parts)}: '{line}'"
                        )
                    try:
                        cls_id = int(parts[0])
                        xc = float(parts[1])
                        yc = float(parts[2])
                        bw = float(parts[3])
                        bh = float(parts[4])
                    except (ValueError, TypeError) as parse_err:
                        raise ValueError(
                            f"DATASET_CORRUPT: Non-numeric values in '{lbl_path.name}' line {line_idx}: {parse_err}"
                        )
                    if cls_id != 0:
                        raise ValueError(
                            f"DATASET_CORRUPT: Invalid class ID {cls_id} in '{lbl_path.name}' line {line_idx}. Only class 0 (vr_headset) is permitted."
                        )
                    for val_name, val in [("xc", xc), ("yc", yc), ("width", bw), ("height", bh)]:
                        if not math.isfinite(val):
                            raise ValueError(
                                f"DATASET_CORRUPT: Non-finite coordinate {val_name}={val} in '{lbl_path.name}' line {line_idx}"
                            )
                    if bw <= 0.0 or bw > 1.0 or bh <= 0.0 or bh > 1.0:
                        raise ValueError(
                            f"DATASET_CORRUPT: Bounding box dimensions out of bounds (w={bw}, h={bh}) in '{lbl_path.name}' line {line_idx}"
                        )
                    if xc < 0.0 or xc > 1.0 or yc < 0.0 or yc > 1.0:
                        raise ValueError(
                            f"DATASET_CORRUPT: Center coordinates out of bounds (xc={xc}, yc={yc}) in '{lbl_path.name}' line {line_idx}"
                        )
                    # Check box boundaries
                    left = xc - bw / 2.0
                    right = xc + bw / 2.0
                    top = yc - bh / 2.0
                    bottom = yc + bh / 2.0
                    if left < -1e-4 or right > 1.0 + 1e-4 or top < -1e-4 or bottom > 1.0 + 1e-4:
                        raise ValueError(
                            f"DATASET_CORRUPT: Bounding box exceeds [0, 1] range (left={left:.4f}, right={right:.4f}, top={top:.4f}, bottom={bottom:.4f}) in '{lbl_path.name}' line {line_idx}"
                        )

    # Reject untracked extra files
    for sid in disk_images_found:
        if sid not in samples_by_id:
            raise ValueError(f"DATASET_CORRUPT: Untracked extra image found on disk not recorded in manifest.json: sample '{sid}'")

    return manifest


def resolve_active_dataset_manifest(dataset_dir: Optional[Union[str, Path]] = None) -> Path:
    """
    Resolves dataset.yaml through the dataset/current pointer inside the persistent volume.
    """
    d_dir = Path(dataset_dir).resolve() if dataset_dir else DATASET_DIR.resolve()

    # 1. Primary: d_dir / "current" / "dataset.yaml"
    curr_yaml = d_dir / "current" / "dataset.yaml"
    if curr_yaml.is_file():
        return curr_yaml

    # 2. Legacy: d_dir / "dataset.yaml"
    legacy_yaml = d_dir / "dataset.yaml"
    if legacy_yaml.is_file():
        return legacy_yaml

    # 3. Fallback to parent dataset_current (for backwards compatibility if present)
    p_curr = d_dir.parent / "dataset_current" / "dataset.yaml"
    if p_curr.is_file():
        return p_curr

    return curr_yaml


def train_headset_model(
    dataset_yaml: Union[str, Path] = DATASET_DIR / "current" / "dataset.yaml",
    epochs: int = 10,
    batch_size: int = 8,
    img_size: int = 640,
    base_model: Union[str, Path] = MODELS_DIR / "yolo11n.pt",
    output_candidate: Union[str, Path] = MODELS_DIR / "candidate_vr_headset.pt",
    operator_id: Optional[str] = None,
    yolo_factory: Optional[Any] = None,
    _acquired_lock: Optional[PipelineJobLock] = None,
    data_root: Union[str, Path] = DATA_DIR,
) -> Path:
    """
    Runs fine-tuning strictly on verified dataset using Ultralytics YOLO.
    Enforces provenance and integrity via verify_dataset_manifest_and_provenance:
    1. Dataset manifest.json must exist with sample provenance and matching manifestHash.
    2. Non-empty train/val/test splits with zero untracked extra files.
    3. Validated YOLO bounding box label coordinates.
    4. Base pretrained weights exist on disk (offline mode).
    5. Acquires mutual exclusion job lock to prevent concurrent runs.
    Extracts best.pt checkpoint into output_candidate.
    """
    if str(dataset_yaml) in (str(DATASET_DIR / "dataset.yaml"), str(DATASET_DIR / "current" / "dataset.yaml")):
        yaml_p = resolve_active_dataset_manifest(DATASET_DIR)
    else:
        yaml_p = Path(dataset_yaml).resolve()

    if not yaml_p.is_file():
        raise FileNotFoundError(f"DATASET_REQUIRED: Dataset descriptor not found at '{dataset_yaml}'")

    base_dir = yaml_p.parent

    # Rigorously verify dataset manifest, file hashes, extra files, and label format
    manifest = verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")

    # Check base model exists on disk (air-gapped offline mode)
    base_p = Path(base_model)
    if not base_p.is_file():
        alt_base = MODELS_DIR / Path(base_model).name
        if alt_base.is_file():
            base_p = alt_base
        elif Path("/opt/models/base/yolo11n.pt").is_file():
            base_p = Path("/opt/models/base/yolo11n.pt")
        else:
            raise FileNotFoundError(
                f"TRAINING_UNAVAILABLE: Pretrained base weights '{base_model}' not found on disk. "
                "Air-gapped offline mode active: remote downloads are blocked."
            )

    # Resource isolation: limit CPU threads so live inference is not starved
    try:
        import torch
        isolated_threads = max(1, min(4, (os.cpu_count() or 4) // 2))
        torch.set_num_threads(isolated_threads)
        if hasattr(torch, "set_num_interop_threads"):
            try:
                torch.set_num_interop_threads(isolated_threads)
            except RuntimeError:
                pass
        logger.info("Resource isolation: PyTorch CPU threads capped at %d during training", isolated_threads)
    except Exception as t_err:
        logger.debug("PyTorch thread capping skipped: %s", t_err)

    # Resolve YOLO framework
    if yolo_factory is not None:
        YOLO_cls = yolo_factory
    else:
        try:
            from ultralytics import YOLO
            YOLO_cls = YOLO
        except ImportError as imp_err:
            raise RuntimeError(
                f"TRAINING_UNAVAILABLE: Ultralytics framework not available in environment: {imp_err}"
            )

    d_root = Path(data_root)
    # Acquire PipelineJobLock if not already pre-acquired
    lock = _acquired_lock or PipelineJobLock(d_root / ".pipeline_job.lock")
    should_release = False
    if _acquired_lock is None:
        lock.acquire("training", operator_id or "system")
        should_release = True

    try:
        update_job_status(
            status="TRAINING",
            job_type="training",
            progress=0.1,
            message="Starting YOLO fine-tuning...",
            data_root=d_root,
        )

        out_cand = Path(output_candidate)
        out_cand.parent.mkdir(parents=True, exist_ok=True)

        project_dir = AI_SERVICE_DIR / "runs" / "train"
        project_dir.mkdir(parents=True, exist_ok=True)

        train_imgs_count = len(list((base_dir / "images" / "train").glob("*.*")))
        logger.info("Initializing YOLO from %s for fine-tuning on %d images...", base_p, train_imgs_count)
        model = YOLO_cls(str(base_p))

        results = model.train(
            data=str(yaml_p.resolve()),
            epochs=epochs,
            batch=batch_size,
            imgsz=img_size,
            project=str(project_dir),
            name="vr_headset_candidate",
            exist_ok=True,
            save=True,
            verbose=True,
            # Plot generation makes Ultralytics fetch optional fonts on a fresh
            # container.  Training must remain fully air-gapped.
            plots=False,
        )

        # Locate best.pt
        save_dir = getattr(results, "save_dir", project_dir / "vr_headset_candidate")
        best_pt = Path(save_dir) / "weights" / "best.pt"
        if not best_pt.is_file():
            best_pt = Path(save_dir) / "best.pt"

        if not best_pt.is_file():
            raise FileNotFoundError(
                f"TRAINING_UNAVAILABLE: Training finished, but best.pt checkpoint was not found in '{save_dir}'."
            )

        shutil.copy2(best_pt, out_cand)
        logger.info("Successfully exported best.pt checkpoint to: %s", out_cand)

        try:
            record_audit_event(
                action="train_model",
                operator_id=operator_id or "system",
                details={
                    "datasetYaml": str(yaml_p),
                    "epochs": epochs,
                    "batchSize": batch_size,
                    "candidatePath": str(out_cand),
                    "manifestHash": manifest.get("manifestHash"),
                },
                audit_log_path=d_root / "audit_trail.jsonl",
            )
        except Exception as audit_err:
            logger.warning("Audit event recording failed during training (training succeeded): %s", audit_err)

        update_job_status(
            status="TRAINING_COMPLETED",
            job_type="training",
            progress=1.0,
            message="Training completed successfully",
            data_root=d_root,
        )
        return out_cand

    except Exception as train_exc:
        update_job_status(
            status="FAILED",
            job_type="training",
            progress=0.0,
            error=str(train_exc),
            data_root=d_root,
        )
        raise
    finally:
        if should_release:
            lock.release()


def evaluate_quality_gate(
    candidate_model_path: Union[str, Path],
    dataset_yaml: Union[str, Path] = DATASET_DIR / "dataset.yaml",
    split: str = "test",
    min_map50: float = DEFAULT_MIN_MAP50,
    min_prec: float = DEFAULT_MIN_PRECISION,
    min_rec: float = DEFAULT_MIN_RECALL,
    simulated_metrics: Optional[Dict[str, float]] = None,
    yolo_factory: Optional[Any] = None,
    verify_provenance: bool = True,
) -> Tuple[bool, Dict[str, float], Optional[str]]:
    """
    Evaluates candidate weights against quality gates on the holdout 'test' split.
    Runs real YOLO.val(data=dataset.yaml, split='test') and extracts real mAP50, precision, recall.
    Simulated metrics are only used when explicitly injected (e.g. for isolated test suites).
    """
    cand_p = Path(candidate_model_path)
    if not cand_p.is_file():
        return False, {}, f"Candidate weights not found: {candidate_model_path}"

    if str(dataset_yaml) == str(DATASET_DIR / "dataset.yaml"):
        yaml_p = resolve_active_dataset_manifest(DATASET_DIR)
    else:
        yaml_p = Path(dataset_yaml)

    if not yaml_p.is_file():
        return False, {}, f"Dataset descriptor not found: {dataset_yaml}"

    if split != "test":
        return False, {}, f"Quality gate strictly requires split='test', got '{split}'"

    if verify_provenance:
        try:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split=split)
        except Exception as prov_err:
            return False, {}, f"Quality gate dataset verification failed: {prov_err}"

    if simulated_metrics is not None:
        metrics = simulated_metrics
    else:
        if yolo_factory is not None:
            YOLO_cls = yolo_factory
        else:
            try:
                from ultralytics import YOLO
                YOLO_cls = YOLO
            except ImportError as imp_err:
                return False, {}, f"TRAINING_UNAVAILABLE: Ultralytics framework not available: {imp_err}"

        try:
            model = YOLO_cls(str(cand_p))
            val_results = model.val(data=str(yaml_p.resolve()), split="test", verbose=False)
        except Exception as exc:
            return False, {}, f"Model evaluation failed: {exc}"

        map50 = None
        prec = None
        rec = None

        res_dict = getattr(val_results, "results_dict", None)
        if isinstance(val_results, dict):
            res_dict = val_results

        if res_dict and isinstance(res_dict, dict):
            for k in ("metrics/mAP50(B)", "mAP50", "map50", "metrics/mAP_0.5"):
                if k in res_dict and isinstance(res_dict[k], (int, float, str)):
                    try:
                        map50 = float(res_dict[k])
                        break
                    except (ValueError, TypeError):
                        pass
            for k in ("metrics/precision(B)", "precision", "prec", "mp"):
                if k in res_dict and isinstance(res_dict[k], (int, float, str)):
                    try:
                        prec = float(res_dict[k])
                        break
                    except (ValueError, TypeError):
                        pass
            for k in ("metrics/recall(B)", "recall", "rec", "mr"):
                if k in res_dict and isinstance(res_dict[k], (int, float, str)):
                    try:
                        rec = float(res_dict[k])
                        break
                    except (ValueError, TypeError):
                        pass

        # If not found in results_dict, check box object
        box = getattr(val_results, "box", None)
        if box is not None:
            raw_m = getattr(box, "map50", None)
            if map50 is None and isinstance(raw_m, (int, float)):
                map50 = float(raw_m)
            raw_p = getattr(box, "mp", None)
            if prec is None and isinstance(raw_p, (int, float)):
                prec = float(raw_p)
            raw_r = getattr(box, "mr", None)
            if rec is None and isinstance(raw_r, (int, float)):
                rec = float(raw_r)

        if map50 is None or prec is None or rec is None:
            return False, {}, f"Failed to extract quality metrics from validation results: {val_results}"

        metrics = {
            "mAP50": float(map50),
            "precision": float(prec),
            "recall": float(rec),
        }

    errors = []
    if metrics.get("mAP50", 0.0) < min_map50:
        errors.append(f"mAP50 ({metrics.get('mAP50'):.4f}) < required ({min_map50:.4f})")
    if metrics.get("precision", 0.0) < min_prec:
        errors.append(f"precision ({metrics.get('precision'):.4f}) < required ({min_prec:.4f})")
    if metrics.get("recall", 0.0) < min_rec:
        errors.append(f"recall ({metrics.get('recall'):.4f}) < required ({min_rec:.4f})")

    if errors:
        return False, metrics, f"Quality gate failed: {'; '.join(errors)}"

    logger.info("Quality gate passed on '%s' split: %s", split, metrics)
    return True, metrics, None


class JournalCorruptError(RuntimeError):
    """Raised when an earlier journal entry is corrupt, blocking automatic rollback/reconciliation."""
    pass


class ActivationStateUncertainError(RuntimeError):
    """Raised when pointer swap is in an ambiguous state and restoration cannot be proven."""
    pass


def _read_journal_entries(journal_file: Path) -> List[Dict[str, Any]]:
    """
    Safely reads journal entries from JSONL.
    Tolerates ONLY a torn/truncated final record (e.g. power loss during append).
    Corruption of any earlier newline-terminated record raises JournalCorruptError ("JOURNAL_CORRUPT")
    and blocks automatic rollback/reconciliation.
    """
    entries = []
    if not journal_file.is_file():
        return entries

    with open(journal_file, "r", encoding="utf-8", errors="replace") as jf:
        raw_lines = jf.readlines()

    # Find the index of the last non-empty line
    last_non_empty_idx = -1
    for idx in range(len(raw_lines) - 1, -1, -1):
        if raw_lines[idx].strip():
            last_non_empty_idx = idx
            break

    if last_non_empty_idx == -1:
        return entries

    for idx, line in enumerate(raw_lines):
        line_str = line.strip()
        if not line_str:
            continue
        line_num = idx + 1
        is_final_record = (idx == last_non_empty_idx)
        try:
            data = json.loads(line_str)
            if not isinstance(data, dict) or "status" not in data:
                raise ValueError("Journal entry must be a JSON object with a 'status' field")
            entries.append(data)
        except Exception as parse_err:
            if is_final_record:
                logger.warning("Ignoring torn/truncated final journal record at line %d: %s", line_num, parse_err)
                break
            else:
                err_msg = f"JOURNAL_CORRUPT: Corruption detected in journal record at line {line_num}: {parse_err}"
                logger.critical(err_msg)
                raise JournalCorruptError(err_msg)

    return entries


def _derive_rollback_target_from_history(committed_entries: List[Dict[str, Any]], curr_target: Optional[str]) -> Optional[str]:
    """
    Derives the prior active release target strictly from successfully COMMITTED history
    and the actual current pointer.
    """
    if not committed_entries:
        return None

    # Walk backwards through committed entries to find the transition that set curr_target
    for i in range(len(committed_entries) - 1, -1, -1):
        entry = committed_entries[i]
        target = entry.get("target")
        if target == curr_target or (curr_target and Path(target).name == Path(curr_target).name):
            if entry.get("action") == "activate":
                return entry.get("oldTarget")
            elif entry.get("action") == "rollback":
                # Rolled back to 'target'. Find what preceded 'target' in previous activation
                for prev_entry in reversed(committed_entries[:i]):
                    prev_target = prev_entry.get("target", "")
                    if (prev_target == target or Path(prev_target).name == Path(target).name) and prev_entry.get("action") == "activate":
                        return prev_entry.get("oldTarget")
                return entry.get("oldTarget")

    # If curr_target was not matched directly, fall back to the most recent committed entry's oldTarget or target
    last = committed_entries[-1]
    if last.get("target") != curr_target:
        return last.get("target")
    return last.get("oldTarget")


def activate_candidate_model(
    candidate_model_path: Union[str, Path],
    dataset_version: str = "v1.0.0",
    dataset_yaml: Union[str, Path] = DATASET_DIR / "dataset.yaml",
    models_dir: Union[str, Path] = MODELS_DIR,
    operator_id: Optional[str] = None,
    yolo_factory: Optional[Any] = None,
    min_map50: float = DEFAULT_MIN_MAP50,
    min_prec: float = DEFAULT_MIN_PRECISION,
    min_rec: float = DEFAULT_MIN_RECALL,
    _eval_gate_fn: Optional[Any] = None,
    _acquired_lock: Optional[PipelineJobLock] = None,
    verify_provenance: bool = True,
) -> Dict[str, Any]:
    """
    Atomically activates candidate model after verifying:
    1. Recomputes test metrics on holdout test split via evaluate_quality_gate.
       Caller-supplied metrics override is strictly impossible.
    2. Candidate weights load into YOLO without corruption (e.g. not random bytes).
    3. Model class 0 is strictly 'vr_headset' or 'headset'.
    4. Test forward pass dry-run succeeds.
    5. Saves weights and metadata into a versioned release directory: models/releases/<release_id>/
    6. Writes temp files on the same filesystem and fsyncs.
    7. Atomically replaces active model and metadata with transactional rollback on failure,
       and updates single-pointer symlinks (models/current -> releases/<release_id>),
       ensuring active model and metadata never become mismatched.
    Failure leaves the active model and metadata completely unchanged.
    """
    cand_p = Path(candidate_model_path)
    if not cand_p.is_file():
        raise FileNotFoundError(f"Candidate weights not found: {candidate_model_path}")

    if str(dataset_yaml) == str(DATASET_DIR / "dataset.yaml"):
        yaml_p = resolve_active_dataset_manifest(DATASET_DIR)
    else:
        yaml_p = Path(dataset_yaml)

    if not yaml_p.is_file():
        raise FileNotFoundError(f"Dataset descriptor not found: {dataset_yaml}")

    m_dir = Path(models_dir)
    m_dir.mkdir(parents=True, exist_ok=True)

    # Acquire mutual exclusion lock if not pre-acquired
    lock = _acquired_lock or PipelineJobLock(m_dir.parent / "data" / ".pipeline_job.lock")
    should_release = False
    if _acquired_lock is None:
        lock.acquire("activation", operator_id or "system")
        should_release = True

    temp_cand_path: Optional[Path] = None

    try:
        # Provenance check
        if verify_provenance:
            verify_dataset_manifest_and_provenance(yaml_p, expected_split="test")

        # 1. Recompute quality metrics on holdout 'test' split (no caller override allowed)
        if _eval_gate_fn is not None:
            passed, metrics, gate_err = _eval_gate_fn(
                candidate_model_path=cand_p,
                dataset_yaml=yaml_p,
                split="test",
                min_map50=min_map50,
                min_prec=min_prec,
                min_rec=min_rec,
                yolo_factory=yolo_factory,
            )
        else:
            passed, metrics, gate_err = evaluate_quality_gate(
                candidate_model_path=cand_p,
                dataset_yaml=yaml_p,
                split="test",
                min_map50=min_map50,
                min_prec=min_prec,
                min_rec=min_rec,
                yolo_factory=yolo_factory,
                verify_provenance=verify_provenance,
            )

        if not passed:
            raise ValueError(f"Candidate metrics failed quality gate: {gate_err}")

        # 2. Write temp weights on same filesystem and fsync
        with tempfile.NamedTemporaryFile(
            dir=m_dir, delete=False, prefix="tmp_cand_", suffix=".pt"
        ) as tf_cand:
            temp_cand_path = Path(tf_cand.name)
            with open(cand_p, "rb") as src_f:
                shutil.copyfileobj(src_f, tf_cand)
            tf_cand.flush()
            os.fsync(tf_cand.fileno())

        actual_sha = compute_sha256(temp_cand_path)

        # 3. Verify candidate model can truly be loaded via ultralytics.YOLO
        if yolo_factory is not None:
            YOLO_cls = yolo_factory
        else:
            try:
                from ultralytics import YOLO
                YOLO_cls = YOLO
            except ImportError as imp_err:
                raise RuntimeError(
                    f"TRAINING_UNAVAILABLE: Ultralytics framework not available: {imp_err}"
                )

        try:
            model = YOLO_cls(str(temp_cand_path))
        except Exception as load_err:
            raise ValueError(f"Candidate model failed YOLO instantiation: {load_err}")

        # 4. Verify class 0
        names = getattr(model, "names", {})
        class0 = ""
        if isinstance(names, dict):
            class0 = str(names.get(0, "")).strip().lower()
        elif isinstance(names, (list, tuple)) and len(names) > 0:
            class0 = str(names[0]).strip().lower()

        valid_headset_identifiers = ("vr_headset", "headset", "oculus", "quest", "vr")
        if not any(target in class0 for target in valid_headset_identifiers):
            raise ValueError(
                f"Candidate model class 0 is '{class0}', expected 'vr_headset' or 'headset'"
            )

        # 5. Forward pass dry-run
        try:
            from PIL import Image
            dummy_img = Image.new("RGB", (64, 64), color=(128, 128, 128))
            _ = model(dummy_img, verbose=False)
        except Exception as fwd_err:
            raise ValueError(f"Candidate model forward pass dry-run failed: {fwd_err}")

        # 6. Prepare versioned release directory
        manifest_hash = compute_dataset_manifest_hash(yaml_p) if yaml_p.is_file() else ""
        rel_ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        rel_uuid = uuid.uuid4().hex[:8]
        release_id = f"release_{rel_ts}_{actual_sha[:12]}_{rel_uuid}"

        rel_parent = m_dir / "releases"
        rel_parent.mkdir(parents=True, exist_ok=True)

        releases_dir = rel_parent / release_id
        # Exclusive creation of unique release directory: must not exist!
        releases_dir.mkdir(parents=False, exist_ok=False)

        meta_obj = {
            "modelName": "vr_headset_yolo",
            "releaseId": release_id,
            "sha256": actual_sha,
            "datasetVersion": dataset_version,
            "datasetManifestHash": manifest_hash,
            "validatedSplit": "test",
            "validationMetrics": metrics,
            "operatorId": operator_id,
            "activatedAt": datetime.now(timezone.utc).isoformat(),
        }

        # Store immutable copy in versioned release directory
        rel_model_path = releases_dir / "vr_headset_yolo.pt"
        rel_meta_path = releases_dir / "model_metadata.json"
        with open(rel_model_path, "wb") as rmf:
            with open(temp_cand_path, "rb") as src_cand:
                shutil.copyfileobj(src_cand, rmf)
            rmf.flush()
            os.fsync(rmf.fileno())

        with open(rel_meta_path, "w", encoding="utf-8") as rmetaf:
            json.dump(meta_obj, rmetaf, indent=2)
            rmetaf.flush()
            os.fsync(rmetaf.fileno())

        # Fsync the release directory itself
        try:
            rdir_fd = os.open(str(releases_dir), os.O_RDONLY)
            os.fsync(rdir_fd)
            os.close(rdir_fd)
        except OSError:
            pass

        # Crash-safe rollback bookkeeping via append-only activation journal
        current_link = m_dir / "current"
        previous_link = m_dir / "previous"
        old_current_target = None
        if current_link.is_symlink() or current_link.exists():
            try:
                old_current_target = os.readlink(str(current_link))
            except OSError:
                pass

        old_previous_target = None
        if previous_link.is_symlink() or previous_link.exists():
            try:
                old_previous_target = os.readlink(str(previous_link))
            except OSError:
                pass

        journal_file = m_dir / "activation_journal.jsonl"
        intended_target = f"releases/{release_id}"
        tx_id = f"tx_act_{uuid.uuid4().hex[:12]}"

        prep_entry = {
            "txId": tx_id,
            "action": "activate",
            "status": "PREPARED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": release_id,
            "target": intended_target,
            "oldTarget": old_current_target,
            "sha256": actual_sha,
            "datasetVersion": dataset_version,
            "operatorId": operator_id or "system",
            "metrics": metrics,
        }

        # 1. Append and fsync PREPARED record BEFORE switching current pointer
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(prep_entry) + "\n")
            jf.flush()
            os.fsync(jf.fileno())

        # Step A: Update previous pointer cache if old_current_target exists
        # Treat previous as a derived cache. If previous update fails, abort activation before current is touched.
        if old_current_target:
            tmp_prev = m_dir / f".tmp_prev_{uuid.uuid4().hex}"
            try:
                os.symlink(old_current_target, str(tmp_prev))
                os.replace(str(tmp_prev), str(previous_link))
            except Exception as prev_err:
                if tmp_prev.is_symlink() or tmp_prev.exists():
                    try:
                        tmp_prev.unlink()
                    except OSError:
                        pass
                logger.error("Failed to update previous release pointer: %s", prev_err)
                abort_entry = {
                    "txId": tx_id,
                    "action": "activate",
                    "status": "ABORTED",
                    "reason": f"Previous cache update failed: {prev_err}",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                try:
                    with open(journal_file, "a", encoding="utf-8") as jf:
                        jf.write(json.dumps(abort_entry) + "\n")
                        jf.flush()
                        os.fsync(jf.fileno())
                except Exception:
                    pass
                raise RuntimeError(f"Model activation failed while updating rollback pointer: {prev_err}") from prev_err

        # Step B: Perform atomic current pointer swap
        tmp_curr = m_dir / f".tmp_curr_{uuid.uuid4().hex}"
        try:
            os.symlink(intended_target, str(tmp_curr))
            os.replace(str(tmp_curr), str(current_link))
        except Exception as swap_err:
            if tmp_curr.is_symlink() or tmp_curr.exists():
                try:
                    tmp_curr.unlink()
                except OSError:
                    pass
            # If current pointer switch fails, roll back previous_link to old_previous_target
            if old_previous_target:
                try:
                    t_restore = m_dir / f".tmp_rest_{uuid.uuid4().hex}"
                    os.symlink(old_previous_target, str(t_restore))
                    os.replace(str(t_restore), str(previous_link))
                except Exception:
                    pass
            elif previous_link.is_symlink() or previous_link.exists():
                try:
                    previous_link.unlink()
                except OSError:
                    pass
            abort_entry = {
                "txId": tx_id,
                "action": "activate",
                "status": "ABORTED",
                "reason": f"Current swap failed: {swap_err}",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            try:
                with open(journal_file, "a", encoding="utf-8") as jf:
                    jf.write(json.dumps(abort_entry) + "\n")
                    jf.flush()
                    os.fsync(jf.fileno())
            except Exception:
                pass
            logger.error("Atomic release symlink swap failed: %s", swap_err)
            raise RuntimeError(f"Model activation failed: {swap_err}") from swap_err

        # Step C: Fsync models directory
        try:
            m_fd = os.open(str(m_dir), os.O_RDONLY)
            os.fsync(m_fd)
            os.close(m_fd)
        except OSError:
            pass

        # Step D: Append and fsync COMMITTED only after swap succeeds
        commit_entry = {
            "txId": tx_id,
            "action": "activate",
            "status": "COMMITTED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": release_id,
            "target": intended_target,
            "oldTarget": old_current_target,
            "sha256": actual_sha,
            "datasetVersion": dataset_version,
            "operatorId": operator_id or "system",
            "metrics": metrics,
        }
        try:
            with open(journal_file, "a", encoding="utf-8") as jf:
                jf.write(json.dumps(commit_entry) + "\n")
                jf.flush()
                os.fsync(jf.fileno())
        except Exception as commit_err:
            logger.error("Failed appending COMMITTED record after pointer swap: %s", commit_err)
            # Explicit fail-closed semantics:
            # Atomically restore current to oldTarget, fsync, restore derived previous cache, and report failure.
            restoration_proven = False
            revert_err_msg = ""
            try:
                if old_current_target:
                    t_revert = m_dir / f".tmp_revert_curr_{uuid.uuid4().hex}"
                    os.symlink(old_current_target, str(t_revert))
                    os.replace(str(t_revert), str(current_link))
                elif current_link.is_symlink() or current_link.exists():
                    current_link.unlink()

                # Restore previous cache
                if old_previous_target:
                    t_prev_rev = m_dir / f".tmp_revert_prev_{uuid.uuid4().hex}"
                    os.symlink(old_previous_target, str(t_prev_rev))
                    os.replace(str(t_prev_rev), str(previous_link))
                elif previous_link.is_symlink() or previous_link.exists():
                    previous_link.unlink()

                # Fsync models directory
                try:
                    m_fd = os.open(str(m_dir), os.O_RDONLY)
                    os.fsync(m_fd)
                    os.close(m_fd)
                except OSError:
                    pass

                # Check if restoration is proven
                curr_read = os.readlink(str(current_link)) if (current_link.is_symlink() or current_link.exists()) else None
                if curr_read == old_current_target:
                    restoration_proven = True

                # Best effort: append ABORTED to journal
                try:
                    abort_entry = {
                        "txId": tx_id,
                        "action": "activate",
                        "status": "ABORTED",
                        "reason": f"Committed write failed: {commit_err}; reverted to oldTarget",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    with open(journal_file, "a", encoding="utf-8") as jf:
                        jf.write(json.dumps(abort_entry) + "\n")
                        jf.flush()
                        os.fsync(jf.fileno())
                except Exception:
                    pass

            except Exception as rev_ex:
                revert_err_msg = str(rev_ex)
                logger.critical("Failed to revert current pointer to oldTarget after commit write error: %s", rev_ex)

            if restoration_proven:
                raise RuntimeError(f"Model activation failed: committed write error: {commit_err} (pointer safely reverted to oldTarget)")
            else:
                raise ActivationStateUncertainError(
                    f"ACTIVATION_STATE_UNCERTAIN: Failed writing COMMITTED record ({commit_err}) "
                    f"and restoration of current pointer to oldTarget could not be proven ({revert_err_msg or 'target mismatch'}). "
                    "Reconciliation required."
                )

        # Post-switch audit failure must NEVER fail an already activated model
        try:
            record_audit_event(
                action="activate_model",
                operator_id=operator_id or "system",
                details={
                    "sha256": actual_sha,
                    "releaseId": release_id,
                    "datasetVersion": dataset_version,
                    "metrics": metrics,
                },
                audit_log_path=m_dir.parent / "data" / "audit_trail.jsonl",
            )
        except Exception as audit_err:
            logger.warning("Post-activation audit logging failed (model is activated): %s", audit_err)

        logger.info("✅ Activated new model release %s (sha256=%s)", release_id, actual_sha[:12])
        return {
            "status": "ACTIVATED",
            "sha256": actual_sha,
            "releaseId": release_id,
            "datasetVersion": dataset_version,
            "metrics": metrics,
        }

    finally:
        if should_release:
            lock.release()
        if temp_cand_path and temp_cand_path.is_file():
            try:
                temp_cand_path.unlink()
            except OSError:
                pass


def rollback_model(
    models_dir: Union[str, Path] = MODELS_DIR,
    operator_id: Optional[str] = None,
    _acquired_lock: Optional[PipelineJobLock] = None,
) -> bool:
    """
    Rolls back the active model strictly by switching the models/current pointer
    to the deterministic previous release target derived from the activation journal.
    Uses transaction state machine: PREPARED -> pointer swap -> fsync -> COMMITTED.
    """
    m_dir = Path(models_dir)
    current_link = m_dir / "current"
    previous_link = m_dir / "previous"
    journal_file = m_dir / "activation_journal.jsonl"

    lock = _acquired_lock or PipelineJobLock(m_dir.parent / "data" / ".pipeline_job.lock")
    should_release = False
    if _acquired_lock is None:
        lock.acquire("rollback", operator_id or "system")
        should_release = True

    try:
        # Determine current target
        old_curr_target = None
        if current_link.is_symlink() or current_link.exists():
            try:
                old_curr_target = os.readlink(str(current_link))
            except OSError:
                pass

        old_previous_target = None
        if previous_link.is_symlink() or previous_link.exists():
            try:
                old_previous_target = os.readlink(str(previous_link))
            except OSError:
                pass

        rollback_target = None

        # 1. Authoritative crash-safe source of truth: activation_journal.jsonl
        if journal_file.is_file():
            entries = _read_journal_entries(journal_file)
            committed = [e for e in entries if e.get("status") == "COMMITTED"]
            rollback_target = _derive_rollback_target_from_history(committed, old_curr_target)

        # 2. If journal did not resolve target, fall back to previous_link symlink cache
        has_prev_link = previous_link.is_symlink() or previous_link.exists()
        if not rollback_target and has_prev_link:
            try:
                rollback_target = os.readlink(str(previous_link))
            except OSError:
                pass

        # 3. Fallback to legacy backup weights if no release pointer found
        if not rollback_target:
            has_legacy_backup = (m_dir / "backup_vr_headset_yolo.pt").is_file()
            if not has_legacy_backup:
                raise FileNotFoundError("No backup model weights or previous release available for rollback")

            backup_model = m_dir / "backup_vr_headset_yolo.pt"
            backup_meta = m_dir / "backup_model_metadata.json"
            active_model = m_dir / "vr_headset_yolo.pt"
            active_meta = m_dir / "model_metadata.json"

            shutil.copy2(backup_model, active_model)
            if backup_meta.is_file():
                shutil.copy2(backup_meta, active_meta)
            logger.info("✅ Rolled back legacy model files from backup")
            return True

        # Verify rollback target exists on disk
        target_path = (m_dir / rollback_target).resolve() if not Path(rollback_target).is_absolute() else Path(rollback_target)
        if not target_path.exists() or not (target_path / "vr_headset_yolo.pt").is_file():
            raise FileNotFoundError(f"Rollback target release not found on disk at '{target_path}'")

        tx_id = f"tx_rb_{uuid.uuid4().hex[:12]}"
        rb_prep = {
            "txId": tx_id,
            "action": "rollback",
            "status": "PREPARED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": Path(rollback_target).name,
            "target": rollback_target,
            "oldTarget": old_curr_target,
            "operatorId": operator_id or "system",
        }

        # 1. Append and fsync PREPARED record BEFORE switching pointer
        with open(journal_file, "a", encoding="utf-8") as jf:
            jf.write(json.dumps(rb_prep) + "\n")
            jf.flush()
            os.fsync(jf.fileno())

        # Step A: Update previous pointer cache to point to old_curr_target
        if old_curr_target:
            tmp_prev = m_dir / f".tmp_rbprev_{uuid.uuid4().hex}"
            try:
                os.symlink(old_curr_target, str(tmp_prev))
                os.replace(str(tmp_prev), str(previous_link))
            except Exception as prev_err:
                if tmp_prev.is_symlink() or tmp_prev.exists():
                    try:
                        tmp_prev.unlink()
                    except OSError:
                        pass
                abort_entry = {
                    "txId": tx_id,
                    "action": "rollback",
                    "status": "ABORTED",
                    "reason": f"Rollback previous cache update failed: {prev_err}",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                try:
                    with open(journal_file, "a", encoding="utf-8") as jf:
                        jf.write(json.dumps(abort_entry) + "\n")
                        jf.flush()
                        os.fsync(jf.fileno())
                except Exception:
                    pass
                raise RuntimeError(f"Rollback failed while updating previous pointer: {prev_err}") from prev_err

        # Step B: Atomically switch models/current to rollback_target
        tmp_curr = m_dir / f".tmp_rbcurr_{uuid.uuid4().hex}"
        try:
            os.symlink(rollback_target, str(tmp_curr))
            os.replace(str(tmp_curr), str(current_link))
        except Exception as rb_err:
            if tmp_curr.is_symlink() or tmp_curr.exists():
                try:
                    tmp_curr.unlink()
                except OSError:
                    pass
            # Restore previous cache if needed
            if old_previous_target:
                try:
                    t_restore = m_dir / f".tmp_rbrest_{uuid.uuid4().hex}"
                    os.symlink(old_previous_target, str(t_restore))
                    os.replace(str(t_restore), str(previous_link))
                except Exception:
                    pass
            abort_entry = {
                "txId": tx_id,
                "action": "rollback",
                "status": "ABORTED",
                "reason": f"Rollback pointer swap failed: {rb_err}",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            try:
                with open(journal_file, "a", encoding="utf-8") as jf:
                    jf.write(json.dumps(abort_entry) + "\n")
                    jf.flush()
                    os.fsync(jf.fileno())
            except Exception:
                pass
            raise RuntimeError(f"Rollback failed: {rb_err}") from rb_err

        # Step C: Fsync models directory
        try:
            m_fd = os.open(str(m_dir), os.O_RDONLY)
            os.fsync(m_fd)
            os.close(m_fd)
        except OSError:
            pass

        # Step D: Append and fsync COMMITTED record
        rb_commit = {
            "txId": tx_id,
            "action": "rollback",
            "status": "COMMITTED",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "releaseId": Path(rollback_target).name,
            "target": rollback_target,
            "oldTarget": old_curr_target,
            "operatorId": operator_id or "system",
        }
        try:
            with open(journal_file, "a", encoding="utf-8") as jf:
                jf.write(json.dumps(rb_commit) + "\n")
                jf.flush()
                os.fsync(jf.fileno())
        except Exception as rb_commit_err:
            logger.error("Failed appending COMMITTED record after rollback swap: %s", rb_commit_err)
            restoration_proven = False
            revert_err_msg = ""
            try:
                if old_curr_target:
                    t_revert = m_dir / f".tmp_revert_rbcurr_{uuid.uuid4().hex}"
                    os.symlink(old_curr_target, str(t_revert))
                    os.replace(str(t_revert), str(current_link))
                elif current_link.is_symlink() or current_link.exists():
                    current_link.unlink()

                if old_previous_target:
                    t_prev_rev = m_dir / f".tmp_revert_rbprev_{uuid.uuid4().hex}"
                    os.symlink(old_previous_target, str(t_prev_rev))
                    os.replace(str(t_prev_rev), str(previous_link))
                elif previous_link.is_symlink() or previous_link.exists():
                    previous_link.unlink()

                try:
                    m_fd = os.open(str(m_dir), os.O_RDONLY)
                    os.fsync(m_fd)
                    os.close(m_fd)
                except OSError:
                    pass

                curr_read = os.readlink(str(current_link)) if (current_link.is_symlink() or current_link.exists()) else None
                if curr_read == old_curr_target:
                    restoration_proven = True

                try:
                    abort_entry = {
                        "txId": tx_id,
                        "action": "rollback",
                        "status": "ABORTED",
                        "reason": f"Rollback commit write failed: {rb_commit_err}; reverted to oldTarget",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    with open(journal_file, "a", encoding="utf-8") as jf:
                        jf.write(json.dumps(abort_entry) + "\n")
                        jf.flush()
                        os.fsync(jf.fileno())
                except Exception:
                    pass
            except Exception as rev_ex:
                revert_err_msg = str(rev_ex)
                logger.critical("Failed to revert current pointer to oldTarget after rollback commit write error: %s", rev_ex)

            if restoration_proven:
                raise RuntimeError(f"Rollback failed: committed write error: {rb_commit_err} (pointer safely reverted to oldTarget)")
            else:
                raise ActivationStateUncertainError(
                    f"ACTIVATION_STATE_UNCERTAIN: Failed writing rollback COMMITTED record ({rb_commit_err}) "
                    f"and restoration of current pointer to oldTarget could not be proven ({revert_err_msg or 'target mismatch'}). "
                    "Reconciliation required."
                )

        try:
            record_audit_event(
                action="rollback_model",
                operator_id=operator_id or "system",
                details={"restoredTarget": rollback_target, "rolledBackFrom": old_curr_target},
                audit_log_path=m_dir.parent / "data" / "audit_trail.jsonl",
            )
        except Exception as audit_err:
            logger.warning("Post-rollback audit logging failed (rollback succeeded): %s", audit_err)

        logger.info("✅ Rolled back model pointer to %s", rollback_target)
        return True

    finally:
        if should_release:
            lock.release()


def reconcile_model_pointers(models_dir: Union[str, Path] = MODELS_DIR) -> Dict[str, Any]:
    """
    Deterministically reconciles models/current and models/previous from the
    append-only activation journal following a crash or container restart.
    Uses transaction state machine:
    - If last entry is PREPARED:
      - If current == intended target: safely finalize as COMMITTED (crash after swap)
      - If current != intended target: abort PREPARED (crash before swap / swap failed)
    - Derives authoritative current and previous from COMMITTED history.
    """
    m_dir = Path(models_dir)
    current_link = m_dir / "current"
    previous_link = m_dir / "previous"
    journal_file = m_dir / "activation_journal.jsonl"

    if not journal_file.is_file():
        return {"reconciled": False, "reason": "NO_JOURNAL"}

    entries = _read_journal_entries(journal_file)
    if not entries:
        return {"reconciled": False, "reason": "NO_VALID_ENTRIES"}

    curr_target = None
    if current_link.is_symlink() or current_link.exists():
        try:
            curr_target = os.readlink(str(current_link))
        except OSError:
            pass

    # Inspect in-flight / dangling PREPARED transaction
    last_entry = entries[-1]
    if last_entry.get("status") == "PREPARED":
        intended = last_entry.get("target")
        tx_id = last_entry.get("txId")
        # If current pointer on disk matches intended target, swap succeeded before crash!
        if curr_target and (curr_target == intended or Path(curr_target).name == Path(intended).name):
            logger.info("Recovery: found PREPARED transaction %s with pointer already swapped to %s. Finalizing COMMITTED.", tx_id, intended)
            commit_entry = dict(last_entry)
            commit_entry["status"] = "COMMITTED"
            commit_entry["timestamp"] = datetime.now(timezone.utc).isoformat()
            commit_entry["finalizedOnRecovery"] = True
            try:
                with open(journal_file, "a", encoding="utf-8") as jf:
                    jf.write(json.dumps(commit_entry) + "\n")
                    jf.flush()
                    os.fsync(jf.fileno())
                entries.append(commit_entry)
            except Exception as j_err:
                logger.error("Failed to write recovery commit record: %s", j_err)
        else:
            # Current pointer did NOT equal intended target: crash before swap, or swap failed.
            # Check if current matches oldTarget or is ambiguous
            old_tgt = last_entry.get("oldTarget")
            is_old_match = (curr_target == old_tgt) or (old_tgt and curr_target and Path(curr_target).name == Path(old_tgt).name) or (not old_tgt and not curr_target)
            if not is_old_match and curr_target is not None:
                # Ambiguous state: current matches neither intended nor oldTarget!
                logger.critical("Recovery: ACTIVATION_STATE_UNCERTAIN: current pointer (%s) matches neither intended (%s) nor oldTarget (%s)", curr_target, intended, old_tgt)
                return {
                    "reconciled": False,
                    "status": "ACTIVATION_STATE_UNCERTAIN",
                    "error": f"ACTIVATION_STATE_UNCERTAIN: Current pointer ({curr_target}) matches neither intended ({intended}) nor oldTarget ({old_tgt})",
                }

            logger.info("Recovery: found uncommitted PREPARED transaction %s; current is %s (not %s). Aborting transaction.", tx_id, curr_target, intended)
            abort_entry = {
                "txId": tx_id,
                "action": last_entry.get("action"),
                "status": "ABORTED",
                "reason": "Aborted on recovery: current pointer did not match intended target",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            try:
                with open(journal_file, "a", encoding="utf-8") as jf:
                    jf.write(json.dumps(abort_entry) + "\n")
                    jf.flush()
                    os.fsync(jf.fileno())
                entries.append(abort_entry)
            except Exception as j_err:
                logger.error("Failed to write recovery abort record: %s", j_err)

    # Filter to COMMITTED entries
    committed = [e for e in entries if e.get("status") == "COMMITTED"]
    if not committed:
        return {"reconciled": False, "reason": "NO_COMMITTED_ENTRIES"}

    last_committed = committed[-1]
    expected_target = last_committed.get("target")
    expected_prev = _derive_rollback_target_from_history(committed, expected_target)

    if expected_target:
        target_path = m_dir / expected_target
        if not target_path.exists():
            return {
                "reconciled": False,
                "status": "ACTIVATION_STATE_UNCERTAIN",
                "error": f"ACTIVATION_STATE_UNCERTAIN: Committed target '{expected_target}' does not exist on disk",
            }

    reconciled = False
    if curr_target != expected_target and expected_target:
        target_path = m_dir / expected_target
        if target_path.exists():
            tmp = m_dir / f".tmp_reconcile_curr_{uuid.uuid4().hex}"
            try:
                os.symlink(expected_target, str(tmp))
                os.replace(str(tmp), str(current_link))
                reconciled = True
                logger.info("Reconciled models/current to %s from journal", expected_target)
            except Exception as e:
                logger.error("Failed reconciling models/current: %s", e)

    prev_target = None
    if previous_link.is_symlink() or previous_link.exists():
        try:
            prev_target = os.readlink(str(previous_link))
        except OSError:
            pass

    if expected_prev and prev_target != expected_prev:
        prev_path = m_dir / expected_prev
        if prev_path.exists():
            tmp = m_dir / f".tmp_reconcile_prev_{uuid.uuid4().hex}"
            try:
                os.symlink(expected_prev, str(tmp))
                os.replace(str(tmp), str(previous_link))
                reconciled = True
                logger.info("Reconciled models/previous to %s from journal", expected_prev)
            except Exception as e:
                logger.error("Failed reconciling models/previous: %s", e)

    if reconciled:
        try:
            m_fd = os.open(str(m_dir), os.O_RDONLY)
            os.fsync(m_fd)
            os.close(m_fd)
        except OSError:
            pass

    return {"reconciled": reconciled, "currentTarget": expected_target, "previousTarget": expected_prev}


def run_pipeline_workflow(
    operator_id: str,
    dataset_yaml: Union[str, Path] = DATASET_DIR / "dataset.yaml",
    dataset_version: str = "v1.0.0",
    epochs: int = 10,
    batch_size: int = 8,
    base_model: Union[str, Path] = MODELS_DIR / "yolo11n.pt",
    output_candidate: Union[str, Path] = MODELS_DIR / "candidate_vr_headset.pt",
    models_dir: Union[str, Path] = MODELS_DIR,
) -> Dict[str, Any]:
    """
    End-to-end chained workflow: train -> evaluate_quality_gate -> activate_candidate_model.
    Guarantees operator audit tracking throughout the entire cycle.
    """
    if not operator_id or not operator_id.strip():
        raise ValueError("Operator ID is strictly required for workflow audit")

    logger.info("🚀 Starting end-to-end pipeline workflow by operator '%s'...", operator_id)

    # 1. Train
    candidate_path = train_headset_model(
        dataset_yaml=dataset_yaml,
        epochs=epochs,
        batch_size=batch_size,
        base_model=base_model,
        output_candidate=output_candidate,
        operator_id=operator_id,
    )

    # 2. Gate (pre-check)
    passed, metrics, error = evaluate_quality_gate(
        candidate_model_path=candidate_path,
        dataset_yaml=dataset_yaml,
        split="test",
    )
    if not passed:
        raise RuntimeError(f"Quality gate rejected candidate model: {error}")

    # 3. Activate (re-evaluates gate internally and commits atomically)
    act_res = activate_candidate_model(
        candidate_model_path=candidate_path,
        dataset_version=dataset_version,
        dataset_yaml=dataset_yaml,
        models_dir=models_dir,
        operator_id=operator_id,
    )

    return {
        "status": "ACTIVATED",
        "operatorId": operator_id,
        "candidate": str(candidate_path),
        "releaseId": act_res.get("releaseId"),
        "metrics": metrics,
        "version": dataset_version,
    }


def get_pipeline_status(
    data_root: Union[str, Path] = DATA_DIR,
    models_dir: Union[str, Path] = MODELS_DIR,
) -> Dict[str, Any]:
    """
    Returns pipeline inventory status.
    """
    d_root = Path(data_root)
    m_dir = Path(models_dir)

    raw_count = len(list((d_root / "raw").glob("**/*.jpg"))) if (d_root / "raw").is_dir() else 0
    queue_count = len(list((d_root / "verification_queue").glob("*/annotation.json"))) if (d_root / "verification_queue").is_dir() else 0
    verified_count = len(list((d_root / "verified").glob("*/annotation.json"))) if (d_root / "verified").is_dir() else 0
    rejected_count = len(list((d_root / "rejected").glob("*/annotation.json"))) if (d_root / "rejected").is_dir() else 0

    active_weights = m_dir / "vr_headset_yolo.pt"
    has_weights = active_weights.is_file()
    has_backup = (m_dir / "backup_vr_headset_yolo.pt").is_file()

    val_res = validate_and_load_headset_model(model_path=active_weights, metadata_path=m_dir / "model_metadata.json")

    job_st = get_job_status(data_root=data_root)

    return {
        "rawFrames": raw_count,
        "queuePending": queue_count,
        "verifiedSamples": verified_count,
        "rejectedSamples": rejected_count,
        "hasWeights": has_weights,
        "hasBackup": has_backup,
        "modelStatus": val_res.status if has_weights else "DATASET_REQUIRED",
        "modelError": val_res.error,
        "metrics": val_res.metrics,
        "jobStatus": job_st,
    }


def main():
    parser = argparse.ArgumentParser(description="QuestControl Dataset & Model Pipeline CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("status", help="Show pipeline status and model readiness")

    p_collect = subparsers.add_parser("collect-ptz", help="Collect raw PTZ frame")
    p_collect.add_argument("--camera-id", required=True)
    p_collect.add_argument("--room-id", required=True)
    p_collect.add_argument("--preset", default="default")
    p_collect.add_argument("--image", required=True, help="Path to raw jpeg, or '-' to read from stdin")
    p_collect.add_argument("--capture-session-id", default=None, help="Capture session ID grouping adjacent frames")
    p_collect.add_argument("--timestamp", default=None, help="Explicit ISO-8601 timestamp")

    p_enq = subparsers.add_parser("enqueue", help="Enqueue frame for human verification")
    p_enq.add_argument("--raw-image", required=True)
    p_enq.add_argument("--bboxes", default=None, help="Initial bounding boxes as JSON string or file path")

    p_ver = subparsers.add_parser("verify", help="Operator verification of bboxes")
    p_ver.add_argument("--sample-id", required=True)
    p_ver.add_argument("--operator-id", required=True)
    p_ver.add_argument("--approve", dest="approve", action="store_true", default=True, help="Approve sample")
    p_ver.add_argument("--reject", dest="approve", action="store_false", help="Reject sample")
    p_ver.add_argument("--bboxes", default=None, help="Corrected bounding boxes as JSON string or file path")
    p_ver.add_argument("--negative-sample", action="store_true", default=False, help="Confirm sample has 0 headsets")
    p_ver.add_argument("--notes", default="")

    p_exp = subparsers.add_parser("export-splits", help="Export session-stratified train/val/test splits")
    p_exp.add_argument("--version", default="v1.0.0")
    p_exp.add_argument("--output-dir", default=str(DATASET_DIR))
    p_exp.add_argument("--data-root", default=str(DATA_DIR))

    p_train = subparsers.add_parser("train", help="Train VR headset model on verified dataset")
    p_train.add_argument("--dataset-yaml", default=str(DATASET_DIR / "dataset.yaml"))
    p_train.add_argument("--epochs", type=int, default=10)
    p_train.add_argument("--batch-size", type=int, default=8)
    p_train.add_argument("--img-size", type=int, default=640)
    p_train.add_argument("--base-model", default=str(MODELS_DIR / "yolo11n.pt"))
    p_train.add_argument("--output-candidate", default=str(MODELS_DIR / "candidate_vr_headset.pt"))
    p_train.add_argument("--operator-id", default="cli_operator")

    p_gate = subparsers.add_parser("gate", help="Evaluate candidate model against quality gate")
    p_gate.add_argument("--candidate", default=str(MODELS_DIR / "candidate_vr_headset.pt"))
    p_gate.add_argument("--dataset-yaml", default=str(DATASET_DIR / "dataset.yaml"))
    p_gate.add_argument("--split", default="test")

    p_act = subparsers.add_parser("activate", help="Atomically activate candidate model (recomputing test metrics)")
    p_act.add_argument("--candidate", default=str(MODELS_DIR / "candidate_vr_headset.pt"))
    p_act.add_argument("--dataset-yaml", default=str(DATASET_DIR / "dataset.yaml"))
    p_act.add_argument("--version", default="v1.0.0")
    p_act.add_argument("--operator-id", required=True)

    p_wf = subparsers.add_parser("train-gate-activate", help="End-to-end chained workflow: train -> gate -> activate")
    p_wf.add_argument("--operator-id", required=True)
    p_wf.add_argument("--version", default="v1.0.0")
    p_wf.add_argument("--dataset-yaml", default=str(DATASET_DIR / "dataset.yaml"))
    p_wf.add_argument("--epochs", type=int, default=10)
    p_wf.add_argument("--batch-size", type=int, default=8)
    p_wf.add_argument("--base-model", default=str(MODELS_DIR / "yolo11n.pt"))

    p_rb = subparsers.add_parser("rollback", help="Roll back model to previous backup")
    p_rb.add_argument("--operator-id", default=None)

    args = parser.parse_args()

    if args.command == "status":
        st = get_pipeline_status(data_root=DATA_DIR, models_dir=MODELS_DIR)
        print(json.dumps(st, indent=2))
    elif args.command == "collect-ptz":
        if args.image == "-":
            img_bytes = sys.stdin.buffer.read()
        else:
            with open(args.image, "rb") as f:
                img_bytes = f.read()
        collect_ptz_frame(
            camera_id=args.camera_id,
            room_id=args.room_id,
            preset_name=args.preset,
            image_bytes=img_bytes,
            timestamp=args.timestamp,
            capture_session_id=args.capture_session_id,
            output_root=DATA_DIR,
        )
    elif args.command == "enqueue":
        bboxes = None
        if args.bboxes:
            if Path(args.bboxes).is_file():
                bboxes = json.loads(Path(args.bboxes).read_text(encoding="utf-8"))
            else:
                bboxes = json.loads(args.bboxes)
        enqueue_for_verification(args.raw_image, initial_bboxes=bboxes, queue_root=DATA_DIR)
    elif args.command == "verify":
        bboxes = None
        if args.bboxes:
            if Path(args.bboxes).is_file():
                bboxes = json.loads(Path(args.bboxes).read_text(encoding="utf-8"))
            else:
                bboxes = json.loads(args.bboxes)
        verify_sample(
            sample_id=args.sample_id,
            operator_id=args.operator_id,
            approved=args.approve,
            corrected_bboxes=bboxes,
            negative_confirmed=args.negative_sample,
            notes=args.notes,
            queue_root=DATA_DIR,
        )
    elif args.command == "export-splits":
        res = export_dataset_splits(
            output_dir=args.output_dir,
            data_root=args.data_root,
            version=args.version,
        )
        print(json.dumps(res, indent=2))
    elif args.command == "train":
        train_headset_model(
            dataset_yaml=args.dataset_yaml,
            epochs=args.epochs,
            batch_size=args.batch_size,
            img_size=args.img_size,
            base_model=args.base_model,
            output_candidate=args.output_candidate,
            operator_id=args.operator_id,
        )
    elif args.command == "gate":
        passed, metrics, error = evaluate_quality_gate(
            candidate_model_path=args.candidate,
            dataset_yaml=args.dataset_yaml,
            split=args.split,
        )
        print(json.dumps({"passed": passed, "metrics": metrics, "error": error}, indent=2))
        if not passed:
            sys.exit(1)
    elif args.command == "activate":
        res = activate_candidate_model(
            candidate_model_path=args.candidate,
            dataset_version=args.version,
            dataset_yaml=args.dataset_yaml,
            operator_id=args.operator_id,
        )
        print(json.dumps(res, indent=2))
    elif args.command == "train-gate-activate":
        res = run_pipeline_workflow(
            operator_id=args.operator_id,
            dataset_yaml=args.dataset_yaml,
            dataset_version=args.version,
            epochs=args.epochs,
            batch_size=args.batch_size,
            base_model=args.base_model,
        )
        print(json.dumps(res, indent=2))
    elif args.command == "rollback":
        rollback_model(operator_id=args.operator_id)


if __name__ == "__main__":
    main()
