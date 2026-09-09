#!/usr/bin/env python3
"""
QuestControl VR Headset Detection Model Training Pipeline

Responsible for:
1. Validating dataset integrity with camera-session grouping to prevent temporal leakage between train/val/test.
2. Fine-tuning YOLO11n on the annotated VR headset dataset.
3. Exporting the best checkpoint to models/vr_headset_yolo.pt.
4. Calculating and recording the SHA-256 checksum and training metadata into models/model_metadata.json.

Licensed under GNU AGPL-3.0.
"""

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("questcontrol.ai.train")

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
DATASET_DIR = AI_SERVICE_DIR / "dataset"
MODELS_DIR = AI_SERVICE_DIR / "models"


if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from model_validator import prevent_ultralytics_network_downloads

prevent_ultralytics_network_downloads()


def compute_sha256(filepath: Path) -> str:
    """Calculates SHA-256 checksum of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def validate_session_splits(dataset_dir: Path, smoke_test_files: Set[str]) -> Dict[str, List[str]]:
    """
    Validates that:
    1. Images are split across train, val, and test partitions.
    2. Video sessions / camera streams do not leak across train and val/test splits.
    3. Smoke test frames are strictly excluded from the training split.
    """
    splits = ["train", "val", "test"]
    split_images: Dict[str, List[str]] = {s: [] for s in splits}
    session_to_split: Dict[str, str] = {}

    for s in splits:
        img_dir = dataset_dir / "images" / s
        if not img_dir.exists():
            continue
        for p in img_dir.glob("*.*"):
            if p.suffix.lower() in (".jpg", ".jpeg", ".png"):
                filename = p.name
                split_images[s].append(filename)

                # Rule: Smoke test frames must NOT be in training split
                if s == "train" and filename in smoke_test_files:
                    raise ValueError(
                        f"CRITICAL LEAKAGE: Smoke test frame '{filename}' detected in training split! Must be excluded."
                    )

                # Extract camera/session identifier from naming convention (e.g. cam01_sess02_frame001.jpg)
                parts = filename.split("_")
                session_id = f"{parts[0]}_{parts[1]}" if len(parts) >= 2 else parts[0]

                if session_id in session_to_split and session_to_split[session_id] != s:
                    prev = session_to_split[session_id]
                    raise ValueError(
                        f"DATASET LEAKAGE: Session '{session_id}' has frames in both '{prev}' and '{s}' splits! "
                        "Adjacent frames from the same camera/video session must be strictly assigned to exactly one split (train, val, or test)."
                    )
                session_to_split[session_id] = s

    if not split_images["train"]:
        raise ValueError(
            "DATASET_EMPTY / DATASET_REQUIRED: No training images found in dataset/images/train/. "
            "Real camera dataset must be collected and annotated before training can commence."
        )

    return split_images


def train_model(
    dataset_yaml: Path,
    epochs: int = 50,
    batch_size: int = 8,
    img_size: int = 640,
    base_model: str = "yolo11n.pt",
    output_dir: Path = MODELS_DIR,
) -> Path:
    """Executes Ultralytics YOLO fine-tuning on the VR headset dataset."""
    try:
        from ultralytics import YOLO
    except ImportError:
        raise RuntimeError("TRAINING_UNAVAILABLE: Ultralytics not installed. Install via: pip install ultralytics torch torchvision")

    base_path = Path(base_model)
    if not base_path.is_file():
        # Check relative to models dir
        alt_base = MODELS_DIR / base_model
        if alt_base.is_file():
            base_path = alt_base
        else:
            raise FileNotFoundError(
                f"TRAINING_UNAVAILABLE: Base YOLO weights '{base_model}' not found on disk! "
                "Air-gapped offline mode active: remote download blocked. Pre-bake or supply base weights first."
            )

    logger.info("Initializing base YOLO model from local file: %s", base_path)
    model = YOLO(str(base_path))

    runs_dir = AI_SERVICE_DIR / "runs" / "train"
    runs_dir.mkdir(parents=True, exist_ok=True)

    logger.info(
        "Starting fine-tuning: epochs=%d, batch=%d, imgsz=%d, dataset=%s",
        epochs,
        batch_size,
        img_size,
        dataset_yaml,
    )

    results = model.train(
        data=str(dataset_yaml),
        epochs=epochs,
        batch=batch_size,
        imgsz=img_size,
        project=str(runs_dir),
        name="vr_headset_run",
        exist_ok=True,
        patience=12,
        save=True,
        verbose=True,
        # Domain-adapted augmentations (robustness for IR night-vision, camera angles & occlusions)
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
        degrees=10.0,
        scale=0.5,
        fliplr=0.5,
        mosaic=1.0,
    )

    # Locate best.pt
    save_dir = getattr(results, "save_dir", runs_dir / "vr_headset_run")
    best_pt = Path(save_dir) / "weights" / "best.pt"
    if not best_pt.exists():
        best_pt = Path(save_dir) / "best.pt"

    if not best_pt.exists():
        raise FileNotFoundError(f"Training completed but best.pt checkpoint was not found in {save_dir}")

    output_dir.mkdir(parents=True, exist_ok=True)
    target_weights = output_dir / "vr_headset_yolo.pt"
    shutil.copy2(best_pt, target_weights)
    logger.info("Successfully exported best model checkpoint to: %s", target_weights)

    # Calculate SHA-256
    sha256_hash = compute_sha256(target_weights)
    logger.info("Model SHA-256: %s", sha256_hash)

    metadata = {
        "modelName": "vr_headset_yolo.pt",
        "sha256": sha256_hash,
        "baseModel": base_model,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "datasetVersion": "v1.0.0",
        "hyperparameters": {
            "epochs": epochs,
            "batchSize": batch_size,
            "imgSize": img_size,
            "patience": 12,
            "optimizer": "auto",
        },
        "targetClass": {0: "vr_headset"},
    }

    metadata_path = output_dir / "model_metadata.json"
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
    logger.info("Saved model metadata to: %s", metadata_path)

    return target_weights


def main():
    parser = argparse.ArgumentParser(description="Train VR Headset YOLO Detection Model")
    parser.add_argument("--dataset", type=str, default=str(DATASET_DIR / "dataset.yaml"), help="Path to dataset.yaml")
    parser.add_argument("--epochs", type=int, default=50, help="Number of training epochs")
    parser.add_argument("--batch", type=int, default=8, help="Batch size")
    parser.add_argument("--imgsz", type=int, default=640, help="Image size")
    parser.add_argument("--base", type=str, default="yolo11n.pt", help="Base YOLO checkpoint")
    args = parser.parse_args()

    smoke_test_files = {
        "frame_charging_base.jpg",
        "frame_work_zones.jpg",
        "frame_outside_zones.jpg",
    }

    dataset_path = Path(args.dataset).resolve()
    if not dataset_path.exists():
        logger.error("Dataset YAML not found at: %s", dataset_path)
        sys.exit(1)

    # Validate leakage and smoke test isolation
    logger.info("Validating dataset splits and session boundaries...")
    try:
        validate_session_splits(dataset_path.parent, smoke_test_files)
        logger.info("Dataset splits verified: clean camera-session grouping, no smoke-test leakage.")
    except ValueError as val_err:
        logger.error("Dataset validation halted: %s", val_err)
        sys.exit(1)

    train_model(
        dataset_yaml=dataset_path,
        epochs=args.epochs,
        batch_size=args.batch,
        img_size=args.imgsz,
        base_model=args.base,
    )


if __name__ == "__main__":
    main()
