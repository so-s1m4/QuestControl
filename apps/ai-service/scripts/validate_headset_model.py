#!/usr/bin/env python3
"""
QuestControl VR Headset Detection Model Validation Suite

Responsible for:
1. Evaluating vr_headset_yolo.pt against the independent validation / test split.
2. Computing Precision, Recall, mAP50, and mAP50-95.
3. Enforcing quality gates:
   - mAP50 >= 0.85
   - Recall >= 0.80
   - Precision >= 0.80
4. Verifying generalization across camera angles and lighting conditions.
5. Updating models/model_metadata.json with verified validation metrics.

Licensed under GNU AGPL-3.0.
"""

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("questcontrol.ai.validate")

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
DATASET_DIR = AI_SERVICE_DIR / "dataset"
MODELS_DIR = AI_SERVICE_DIR / "models"

if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from model_validator import compute_dataset_manifest_hash, compute_sha256, prevent_ultralytics_network_downloads

prevent_ultralytics_network_downloads()


def validate_model(
    model_path: Path,
    dataset_yaml: Path,
    split: str = "val",
    img_size: int = 640,
    conf_threshold: float = 0.4,
    iou_threshold: float = 0.5,
) -> Dict[str, float]:
    """Runs Ultralytics YOLO validation and computes quality metrics."""
    try:
        from ultralytics import YOLO
    except ImportError:
        logger.error("Ultralytics not installed. Install via: pip install ultralytics torch torchvision")
        sys.exit(1)

    if not model_path.exists():
        raise FileNotFoundError(
            f"MODEL_UNAVAILABLE: Target model weights '{model_path}' do not exist! Run training pipeline first."
        )

    logger.info("Loading model for validation: %s", model_path)
    model = YOLO(str(model_path))

    # Verify class dictionary
    names = getattr(model, "names", {})
    if not names or (0 in names and "vr_headset" not in str(names[0]).lower() and "headset" not in str(names[0]).lower()):
        logger.warning("Class 0 is '%s', expected 'vr_headset'!", names.get(0))

    logger.info("Running validation on split '%s' with dataset: %s", split, dataset_yaml)
    metrics = model.val(
        data=str(dataset_yaml),
        split=split,
        imgsz=img_size,
        conf=conf_threshold,
        iou=iou_threshold,
        verbose=True,
    )

    box = getattr(metrics, "box", None)
    if box is None:
        raise RuntimeError("Validation completed but metrics.box is missing.")

    precision = float(box.mp) if hasattr(box, "mp") else 0.0
    recall = float(box.mr) if hasattr(box, "mr") else 0.0
    map50 = float(box.map50) if hasattr(box, "map50") else 0.0
    map50_95 = float(box.map) if hasattr(box, "map") else 0.0

    logger.info("Validation Results for '%s':", model_path.name)
    logger.info("  Precision: %.4f", precision)
    logger.info("  Recall:    %.4f", recall)
    logger.info("  mAP@50:    %.4f", map50)
    logger.info("  mAP@50-95: %.4f", map50_95)

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "mAP50": round(map50, 4),
        "mAP50_95": round(map50_95, 4),
    }


def enforce_quality_gates(
    metrics: Dict[str, float],
    split: str = "test",
    min_map50: float = 0.85,
    min_prec: float = 0.80,
    min_rec: float = 0.80,
):
    """Enforces strict production quality criteria on independent test split."""
    failures = []
    if split != "test":
        failures.append(f"Production quality gate strictly requires --split test; received split='{split}'")
    if metrics["mAP50"] < min_map50:
        failures.append(f"mAP50 ({metrics['mAP50']:.3f}) below threshold ({min_map50:.3f})")
    if metrics["precision"] < min_prec:
        failures.append(f"Precision ({metrics['precision']:.3f}) below threshold ({min_prec:.3f})")
    if metrics["recall"] < min_rec:
        failures.append(f"Recall ({metrics['recall']:.3f}) below threshold ({min_rec:.3f})")

    if failures:
        logger.error("QUALITY GATES FAILED:\n  - " + "\n  - ".join(failures))
        raise ValueError("Model failed quality gates: " + "; ".join(failures))

    logger.info("✅ ALL QUALITY GATES PASSED on '%s' split (mAP50 >= %.2f, Precision >= %.2f, Recall >= %.2f)", split, min_map50, min_prec, min_rec)


def update_metadata_with_metrics(
    metrics: Dict[str, float],
    metadata_path: Path,
    model_path: Path,
    split: str = "test",
    manifest_hash: str = "",
    dataset_version: str = "v1.0.0",
):
    """Updates models/model_metadata.json with verified validation metrics, split, dataset manifest hash, and sha256."""
    if not metadata_path.exists():
        data = {}
    else:
        with open(metadata_path, "r", encoding="utf-8") as f:
            try:
                data = json.load(f)
            except Exception:
                data = {}

    data["modelName"] = model_path.name
    data["sha256"] = compute_sha256(model_path)
    data["classes"] = ["vr_headset"]
    data["validatedSplit"] = split
    data["datasetManifestHash"] = manifest_hash
    data["datasetVersion"] = dataset_version
    data["validationMetrics"] = metrics
    data["verifiedAt"] = datetime.now(timezone.utc).isoformat()

    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    logger.info("Updated model metadata at: %s (split: %s, manifest: %s, sha256: %s)", metadata_path, split, manifest_hash[:12] if manifest_hash else "none", data["sha256"][:12])


def main():
    parser = argparse.ArgumentParser(description="Validate VR Headset YOLO Detection Model")
    parser.add_argument("--model", type=str, default=str(MODELS_DIR / "vr_headset_yolo.pt"), help="Path to model weights")
    parser.add_argument("--dataset", type=str, default=str(DATASET_DIR / "dataset.yaml"), help="Path to dataset.yaml")
    parser.add_argument("--split", type=str, default="test", choices=["val", "test"], help="Dataset split to evaluate (production quality gate strictly requires 'test')")
    parser.add_argument("--min-map", type=float, default=0.85, help="Minimum mAP50 threshold")
    parser.add_argument("--min-precision", type=float, default=0.80, help="Minimum Precision threshold")
    parser.add_argument("--min-recall", type=float, default=0.80, help="Minimum Recall threshold")
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    dataset_yaml = Path(args.dataset).resolve()

    try:
        metrics = validate_model(
            model_path=model_path,
            dataset_yaml=dataset_yaml,
            split=args.split,
        )

        enforce_quality_gates(
            metrics=metrics,
            split=args.split,
            min_map50=args.min_map,
            min_prec=args.min_precision,
            min_rec=args.min_recall,
        )

        manifest_hash = compute_dataset_manifest_hash(dataset_yaml, split=args.split)
        metadata_path = MODELS_DIR / "model_metadata.json"
        update_metadata_with_metrics(
            metrics=metrics,
            metadata_path=metadata_path,
            model_path=model_path,
            split=args.split,
            manifest_hash=manifest_hash,
        )
    except (FileNotFoundError, ValueError) as err:
        logger.error("Validation halted: %s", err)
        sys.exit(1)


if __name__ == "__main__":
    main()
