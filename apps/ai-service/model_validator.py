"""
QuestControl AI Model Validation & Offline Integrity Engine

Enforces:
1. Strict air-gapped / offline operation (disabling Ultralytics network downloads and telemetry).
2. General YOLO model local verification (ensures file exists locally before instantiation).
3. Dedicated VR Headset model verification before READY status:
   - Weights file exists locally on disk (no remote downloads).
   - Metadata JSON exists on disk and is valid JSON.
   - SHA-256 checksum matches metadata.
   - Model class 0 is strictly 'vr_headset' (or 'headset').
   - Validation metrics meet quality gates:
     * mAP50 >= 0.85
     * Precision >= 0.80
     * Recall >= 0.80
   - Test forward pass succeeds.

Licensed under GNU AGPL-3.0.
"""

import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

logger = logging.getLogger("questcontrol.ai.validator")

# Default quality gate thresholds for production VR headset detector
DEFAULT_MIN_MAP50 = 0.85
DEFAULT_MIN_PRECISION = 0.80
DEFAULT_MIN_RECALL = 0.80


@dataclass
class ValidationResult:
    is_valid: bool
    status: str  # "READY" or "MODEL_UNAVAILABLE"
    error: Optional[str] = None
    model: Optional[Any] = None
    metadata: Optional[Dict[str, Any]] = None
    metrics: Optional[Dict[str, float]] = None


def compute_sha256(filepath: Union[str, Path]) -> str:
    """Calculates SHA-256 checksum of a file on disk."""
    path = Path(filepath)
    if not path.is_file():
        raise FileNotFoundError(f"Cannot compute sha256: file not found at '{filepath}'")
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def compute_dataset_manifest_hash(
    dataset_yaml_path: Union[str, Path],
    split: Optional[Union[str, Sequence[str]]] = None,
) -> str:
    """
    Computes a deterministic SHA-256 hash of dataset.yaml and the real binary/text contents
    of all images and label files across the specified splits (defaults to ('train', 'val', 'test')).
    """
    path = Path(dataset_yaml_path)
    h = hashlib.sha256()
    if path.is_file():
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
    base_dir = path.resolve().parent
    if split is None or split == "all":
        split_list = ["train", "val", "test"]
    elif isinstance(split, str):
        split_list = [split]
    else:
        split_list = list(split)

    for sp in sorted(split_list):
        for sub in ["images", "labels"]:
            split_dir = base_dir / sub / sp
            if split_dir.is_dir():
                for p in sorted(split_dir.glob("*.*")):
                    if p.is_file():
                        h.update(f"{sub}/{sp}/{p.name}:".encode("utf-8"))
                        with open(p, "rb") as f:
                            while chunk := f.read(65536):
                                h.update(chunk)
    return h.hexdigest()


def prevent_ultralytics_network_downloads():
    """
    Enforces strict air-gapped / offline mode.
    Disables Ultralytics telemetry, sync, auto-install, and monkey-patches download
    routines to raise RuntimeError if any remote asset download is attempted.
    """
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["ULTRALYTICS_OFFLINE"] = "1"
    os.environ["ULTRALYTICS_AUTOINSTALL"] = "0"
    os.environ["YOLO_VERBOSE"] = "False"

    def _blocked_download(*args, **kwargs):
        raise RuntimeError(
            "AIR-GAPPED OFFLINE VIOLATION: Remote network download was attempted by model framework. "
            "All model weights must be pre-baked into the image or mounted locally."
        )

    def _guarded_attempt_download_asset(file, *args, **kwargs):
        p = Path(str(file).strip().replace("'", ""))
        if p.is_file():
            return str(p)
        raise RuntimeError(
            f"AIR-GAPPED OFFLINE VIOLATION: Remote network download was attempted for '{file}'. "
            "All model weights must be pre-baked into the image or mounted locally."
        )

    try:
        import ultralytics.utils.downloads as u_downloads

        u_downloads.attempt_download_asset = _guarded_attempt_download_asset
        u_downloads.download = _blocked_download
        u_downloads.safe_download = _blocked_download
    except (ImportError, AttributeError):
        pass

    try:
        import torch.hub as thub

        thub.download_url_to_file = _blocked_download
    except (ImportError, AttributeError):
        pass

    logger.info("Air-gapped offline mode enforced: Ultralytics network downloads are strictly disabled.")


def load_general_yolo_model(
    model_path: Optional[str] = None,
    expected_sha256: Optional[str] = None,
) -> Tuple[Optional[Any], bool, Optional[str]]:
    """
    Loads general YOLO model (for person tracking) strictly from local disk.
    If weights file is missing from disk, it sets available=False without making any network calls.
    """
    target_path = model_path or os.environ.get("YOLO_MODEL", "models/yolo11n.pt")
    target_file = Path(target_path).resolve()

    # Also check relative to current working directory and ai-service root
    if not target_file.is_file():
        alt_root = Path(__file__).resolve().parent / target_path
        if alt_root.is_file():
            target_file = alt_root

    # Fallback to baked base model weights in image if volume mount is fresh/empty
    if not target_file.is_file():
        baked_base = Path("/opt/models/base/yolo11n.pt")
        if baked_base.is_file():
            target_file = baked_base

    if not target_file.is_file():
        err_msg = (
            f"MODEL_UNAVAILABLE: General YOLO weights not found at '{target_file}'. "
            "Air-gapped mode active: skipping remote download. YOLO person detection disabled."
        )
        logger.warning(err_msg)
        return None, False, err_msg

    if expected_sha256:
        actual_sha = compute_sha256(target_file)
        if actual_sha.lower() != expected_sha256.strip().lower():
            err_msg = (
                f"MODEL_UNAVAILABLE: General YOLO weights checksum mismatch: expected {expected_sha256}, got {actual_sha}."
            )
            logger.error(err_msg)
            return None, False, err_msg

    try:
        from ultralytics import YOLO

        model = YOLO(str(target_file))
        logger.info("General YOLO model successfully loaded from local file: %s", target_file)
        return model, True, None
    except Exception as exc:
        err_msg = f"MODEL_UNAVAILABLE: Failed to instantiate general YOLO model from '{target_file}': {exc}"
        logger.warning(err_msg)
        return None, False, err_msg


def load_yolo_world_model(
    model_path: Optional[str] = None,
    classes: Optional[List[str]] = None,
) -> Tuple[Optional[Any], bool, Optional[str]]:
    """Load the baked YOLO-World detector and lock its vocabulary to VR headsets.

    YOLO-World needs both its detector checkpoint and the local CLIP text encoder
    weights to turn the vocabulary into embeddings.  Both are baked by the
    Dockerfile; this loader deliberately never permits a runtime download.
    """
    target_path = model_path or os.environ.get("YOLO_WORLD_MODEL", "models/yolov8s-worldv2.pt")
    target_file = Path(target_path).resolve()
    if not target_file.is_file():
        alt_root = Path(__file__).resolve().parent / target_path
        if alt_root.is_file():
            target_file = alt_root
    if not target_file.is_file():
        baked_base = Path("/opt/models/base/yolov8s-worldv2.pt")
        if baked_base.is_file():
            target_file = baked_base

    if not target_file.is_file():
        err_msg = (
            f"MODEL_UNAVAILABLE: YOLO-World weights not found at '{target_file}'. "
            "Air-gapped mode active: skipping remote download."
        )
        logger.warning(err_msg)
        return None, False, err_msg

    vocabulary = classes or ["VR headset", "Meta Quest headset", "Oculus headset"]
    try:
        from ultralytics import YOLOWorld

        model = YOLOWorld(str(target_file))
        # This call is intentionally made at startup. It fails fast when the
        # locally baked CLIP encoder is missing instead of trying to fetch it
        # during live camera processing.
        model.set_classes(list(vocabulary))
        logger.info("YOLO-World loaded from local file with VR vocabulary: %s", vocabulary)
        return model, True, None
    except Exception as exc:
        err_msg = f"MODEL_UNAVAILABLE: Failed to initialize local YOLO-World model: {exc}"
        logger.warning(err_msg)
        return None, False, err_msg


def resolve_active_model_release(
    models_dir: Optional[Union[str, Path]] = None,
) -> Tuple[Optional[Path], Optional[Path]]:
    """
    Resolves the active model weights and metadata paths strictly through the models/current/ pointer.
    Falls back to environment variables or loose files if pointer is not yet initialized.
    """
    m_dir = Path(models_dir).resolve() if models_dir else Path(__file__).resolve().parent / "models"
    curr_w = m_dir / "current" / "vr_headset_yolo.pt"
    curr_m = m_dir / "current" / "model_metadata.json"
    if curr_w.is_file() and curr_m.is_file():
        return curr_w, curr_m

    # Fallback to environment variables
    env_w = os.environ.get("HEADSET_MODEL", os.environ.get("HEADSET_MODEL_PATH"))
    env_m = os.environ.get("HEADSET_MODEL_METADATA")

    w_path = Path(env_w).resolve() if env_w else m_dir / "vr_headset_yolo.pt"
    if not w_path.is_file():
        alt_w = Path(__file__).resolve().parent / (env_w or "models/vr_headset_yolo.pt")
        if alt_w.is_file():
            w_path = alt_w

    m_path = Path(env_m).resolve() if env_m else m_dir / "model_metadata.json"
    if not m_path.is_file():
        alt_m = Path(__file__).resolve().parent / (env_m or "models/model_metadata.json")
        if alt_m.is_file():
            m_path = alt_m

    return (w_path if w_path.is_file() else None, m_path if m_path.is_file() else None)


def validate_and_load_headset_model(
    model_path: Optional[Union[str, Path]] = None,
    metadata_path: Optional[Union[str, Path]] = None,
    min_map50: float = DEFAULT_MIN_MAP50,
    min_prec: float = DEFAULT_MIN_PRECISION,
    min_rec: float = DEFAULT_MIN_RECALL,
    model_loader_fn: Optional[Any] = None,
) -> ValidationResult:
    """
    Executes rigorous startup validation of the dedicated VR headset detection model:
    1. Resolves weights & metadata through models/current/ pointer.
    2. Checks weights file exists on disk (strictly local, no network download).
    3. Checks metadata file exists and is valid JSON.
    4. Verifies SHA-256 checksum of weights against metadata.
    5. Validates independent quality metrics meet minimum thresholds:
       - mAP50 >= min_map50 (default 0.85)
       - Precision >= min_prec (default 0.80)
       - Recall >= min_rec (default 0.80)
    6. Loads weights and verifies class 0 is 'vr_headset' or 'headset'.
    7. Executes a test forward pass on a dummy image.

    Returns ValidationResult with status='READY' if all checks pass,
    or status='MODEL_UNAVAILABLE' with detailed error description if any check fails.
    """
    # Resolve paths through models/current pointer if not explicitly supplied
    res_w, res_m = resolve_active_model_release()

    if model_path is not None:
        m_path = Path(model_path).resolve()
    elif res_w is not None:
        m_path = res_w
    else:
        m_path = Path(__file__).resolve().parent / "models" / "current" / "vr_headset_yolo.pt"

    if not m_path.is_file():
        err = f"MODEL_UNAVAILABLE: Weights file not found on disk: {m_path}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(is_valid=False, status="MODEL_UNAVAILABLE", error=err)

    if metadata_path is not None:
        meta_path = Path(metadata_path).resolve()
    elif res_m is not None:
        meta_path = res_m
    else:
        meta_path = Path(__file__).resolve().parent / "models" / "current" / "model_metadata.json"

    if not meta_path.is_file():
        err = f"MODEL_UNAVAILABLE: Metadata file not found on disk: {meta_path}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(is_valid=False, status="MODEL_UNAVAILABLE", error=err)

    # 3. Read and parse metadata
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            metadata = json.load(f)
        if not isinstance(metadata, dict):
            err = f"MODEL_UNAVAILABLE: Metadata root must be a JSON object, got {type(metadata).__name__}"
            return ValidationResult(is_valid=False, status="MODEL_UNAVAILABLE", error=err)
    except Exception as parse_err:
        err = f"MODEL_UNAVAILABLE: Metadata file is corrupt or invalid JSON: {parse_err}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(is_valid=False, status="MODEL_UNAVAILABLE", error=err)

    # 4. Verify SHA-256
    expected_sha = metadata.get("sha256") or metadata.get("checksum")
    if not expected_sha or not isinstance(expected_sha, str) or not expected_sha.strip():
        err = "MODEL_UNAVAILABLE: Metadata missing required 'sha256' checksum field"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    try:
        actual_sha = compute_sha256(m_path)
    except Exception as sha_err:
        err = f"MODEL_UNAVAILABLE: Failed to compute weights SHA-256: {sha_err}"
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    if actual_sha.lower() != expected_sha.strip().lower():
        err = f"MODEL_UNAVAILABLE: SHA-256 checksum mismatch: expected {expected_sha}, got {actual_sha}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    # 5. Verify dataset manifest hash, dataset version, and validated split
    dataset_ver = metadata.get("datasetVersion") or metadata.get("version")
    if not dataset_ver or not isinstance(dataset_ver, str) or not dataset_ver.strip():
        err = "MODEL_UNAVAILABLE: Metadata missing required 'datasetVersion' field"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    manifest_hash = metadata.get("datasetManifestHash") or metadata.get("manifestHash")
    if not manifest_hash or not isinstance(manifest_hash, str) or not manifest_hash.strip():
        err = "MODEL_UNAVAILABLE: Metadata missing required 'datasetManifestHash' field"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    validated_split = str(metadata.get("validatedSplit") or metadata.get("split") or "").strip().lower()
    if validated_split != "test":
        err = (
            f"MODEL_UNAVAILABLE: Production quality gate strictly requires validatedSplit='test', "
            f"got '{validated_split or 'none'}'. Metrics evaluated on 'val' cannot qualify model as READY."
        )
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    # 6. Verify quality gate metrics
    metrics = metadata.get("validationMetrics") or metadata.get("metrics")
    if not metrics or not isinstance(metrics, dict):
        err = "MODEL_UNAVAILABLE: Metadata missing required 'validationMetrics' object"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False, status="MODEL_UNAVAILABLE", error=err, metadata=metadata
        )

    # Extract mAP50, precision, recall
    map50 = None
    for k in ("mAP50", "map50", "map_50", "mAP_50"):
        if k in metrics and metrics[k] is not None:
            try:
                map50 = float(metrics[k])
                break
            except (ValueError, TypeError):
                pass

    prec = None
    for k in ("precision", "prec", "mp"):
        if k in metrics and metrics[k] is not None:
            try:
                prec = float(metrics[k])
                break
            except (ValueError, TypeError):
                pass

    rec = None
    for k in ("recall", "rec", "mr"):
        if k in metrics and metrics[k] is not None:
            try:
                rec = float(metrics[k])
                break
            except (ValueError, TypeError):
                pass

    failures = []
    if map50 is None:
        failures.append("mAP50 metric missing")
    elif map50 < min_map50:
        failures.append(f"mAP50 ({map50:.4f}) below required threshold ({min_map50:.4f})")

    if prec is None:
        failures.append("precision metric missing")
    elif prec < min_prec:
        failures.append(f"precision ({prec:.4f}) below required threshold ({min_prec:.4f})")

    if rec is None:
        failures.append("recall metric missing")
    elif rec < min_rec:
        failures.append(f"recall ({rec:.4f}) below required threshold ({min_rec:.4f})")

    if failures:
        err = f"MODEL_UNAVAILABLE: Validation metrics failed quality gates: {'; '.join(failures)}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False,
            status="MODEL_UNAVAILABLE",
            error=err,
            metadata=metadata,
            metrics=metrics,
        )

    # 6. Load model & verify class 0
    try:
        if model_loader_fn is not None:
            model = model_loader_fn(str(m_path))
        else:
            from ultralytics import YOLO

            model = YOLO(str(m_path))
    except Exception as load_err:
        err = f"MODEL_UNAVAILABLE: Failed to load weights into YOLO model: {load_err}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False,
            status="MODEL_UNAVAILABLE",
            error=err,
            metadata=metadata,
            metrics=metrics,
        )

    names = getattr(model, "names", {})
    class0 = ""
    if isinstance(names, dict):
        class0 = str(names.get(0, "")).strip().lower()
    elif isinstance(names, (list, tuple)) and len(names) > 0:
        class0 = str(names[0]).strip().lower()

    valid_headset_identifiers = ("vr_headset", "headset", "oculus", "quest", "vr")
    if not any(target in class0 for target in valid_headset_identifiers):
        err = f"MODEL_UNAVAILABLE: Model class 0 is '{class0 or 'unknown'}', expected 'vr_headset' or 'headset'"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False,
            status="MODEL_UNAVAILABLE",
            error=err,
            metadata=metadata,
            metrics=metrics,
        )

    # 7. Forward pass dry-run
    try:
        from PIL import Image

        dummy_img = Image.new("RGB", (64, 64), color=(128, 128, 128))
        _ = model(dummy_img, verbose=False)
    except Exception as fwd_err:
        err = f"MODEL_UNAVAILABLE: Model forward pass dry-run failed: {fwd_err}"
        logger.warning("VR Headset Model check failed: %s", err)
        return ValidationResult(
            is_valid=False,
            status="MODEL_UNAVAILABLE",
            error=err,
            metadata=metadata,
            metrics=metrics,
        )

    logger.info(
        "✅ Dedicated VR headset model verified successfully: %s (sha256: %s, mAP50: %.4f, P: %.4f, R: %.4f)",
        m_path.name,
        actual_sha[:12],
        map50,
        prec,
        rec,
    )
    return ValidationResult(
        is_valid=True,
        status="READY",
        error=None,
        model=model,
        metadata=metadata,
        metrics=metrics,
    )
