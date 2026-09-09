#!/usr/bin/env python3
"""
QuestControl VR Headset Model Provisioning & Integrity Checker

Responsible strictly for:
1. Checking existence of trained weights (models/vr_headset_yolo.pt).
2. Verifying SHA-256 integrity against models/model_metadata.json.
3. Performing a test forward pass to confirm model integrity.
4. Returning MODEL_UNAVAILABLE status if weights are missing or corrupt.

Licensed under GNU AGPL-3.0.
"""

import argparse
import hashlib
import json
import logging
import sys
from pathlib import Path
from typing import Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("questcontrol.ai.provision")

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
MODELS_DIR = AI_SERVICE_DIR / "models"


# Ensure ai-service root is in sys.path
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from model_validator import compute_sha256, prevent_ultralytics_network_downloads, validate_and_load_headset_model

prevent_ultralytics_network_downloads()


def check_model_integrity(model_path: Path, metadata_path: Path) -> Tuple[bool, str]:
    """
    Verifies that the trained model exists, matches recorded SHA-256, contains vr_headset class,
    meets validation quality gates (mAP50 >= 0.85, P >= 0.80, R >= 0.80), and executes forward pass cleanly.
    Returns (is_ready, message_or_status).
    """
    res = validate_and_load_headset_model(model_path=model_path, metadata_path=metadata_path)
    if res.is_valid and res.status == "READY":
        return True, "READY"
    err = res.error or "Failed validation checks"
    if not err.startswith("MODEL_UNAVAILABLE"):
        err = f"MODEL_UNAVAILABLE: {err}"
    return False, err


def main():
    parser = argparse.ArgumentParser(description="Verify VR Headset Model Integrity")
    parser.add_argument("--model", type=str, default=str(MODELS_DIR / "vr_headset_yolo.pt"), help="Path to model weights")
    parser.add_argument("--metadata", type=str, default=str(MODELS_DIR / "model_metadata.json"), help="Path to metadata")
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    metadata_path = Path(args.metadata).resolve()

    ready, msg = check_model_integrity(model_path, metadata_path)
    if ready:
        logger.info("✅ Model status: READY. %s is verified and ready for deployment.", model_path.name)
        sys.exit(0)
    else:
        logger.error("❌ Model status: %s", msg)
        sys.exit(1)


if __name__ == "__main__":
    main()
