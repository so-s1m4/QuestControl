"""
QuestControl Activity Intelligence - Local Pose Estimator Adapter
Strictly offline, air-gapped pose estimation. No cloud APIs, no biometric storage.
"""

import io
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image

from activity.base import Keypoint, PersonPose, PoseEstimatorAdapter, TrackedPerson

logger = logging.getLogger("questcontrol.ai.activity.pose")

COCO_KEYPOINT_NAMES = [
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
]


class LocalPoseEstimator(PoseEstimatorAdapter):
    def __init__(
        self,
        model_path: Optional[str] = None,
        model_override: Optional[Any] = None,
    ):
        self.model_override = model_override
        self.model = None
        self.status = "POSE_MODEL_UNAVAILABLE"
        self.error: Optional[str] = None

        if model_override is not None:
            self.model = model_override
            self.status = "READY"
            return

        self._load_local_model(model_path)

    def _load_local_model(self, model_path: Optional[str] = None) -> None:
        target_path = model_path or os.environ.get("POSE_MODEL_PATH", "models/yolo11n-pose.pt")
        target_file = Path(target_path).resolve()

        if not target_file.is_file():
            # Check relative to ai-service directory
            alt_dir = Path(__file__).resolve().parent.parent / target_path
            if alt_dir.is_file():
                target_file = alt_dir

        if not target_file.is_file():
            baked_base = Path("/opt/models/base/yolo11n-pose.pt")
            if baked_base.is_file():
                target_file = baked_base

        if not target_file.is_file():
            self.status = "POSE_MODEL_UNAVAILABLE"
            self.error = (
                f"POSE_MODEL_UNAVAILABLE: Pose model weights not found at '{target_file}'. "
                "Air-gapped mode active: skipping remote download. Pose estimation disabled."
            )
            logger.info(self.error)
            return

        try:
            from ultralytics import YOLO
            self.model = YOLO(str(target_file))
            self.status = "READY"
            self.error = None
            logger.info("✅ Loaded local pose model from %s", target_file)
        except Exception as e:
            self.status = "POSE_MODEL_UNAVAILABLE"
            self.error = f"POSE_MODEL_UNAVAILABLE: Failed loading pose model: {e}"
            logger.warning(self.error)

    def is_available(self) -> bool:
        return self.status == "READY" and self.model is not None

    def get_status(self) -> str:
        return self.status

    def estimate_poses(
        self,
        image_bytes: bytes,
        tracked_people: List[TrackedPerson],
        conf_threshold: float = 0.25,
    ) -> List[PersonPose]:
        if not self.is_available():
            return []

        if not image_bytes or not tracked_people:
            return []

        poses: List[PersonPose] = []
        try:
            pil_img = Image.open(io.BytesIO(image_bytes))
            width, height = pil_img.size

            results = self.model(pil_img, conf=conf_threshold, verbose=False)
            if not results:
                return []

            r = results[0]
            if not hasattr(r, "keypoints") or r.keypoints is None:
                return []

            kpts_data = r.keypoints.data.cpu().numpy() if hasattr(r.keypoints.data, "cpu") else r.keypoints.data
            boxes_data = r.boxes.xyxy.cpu().numpy() if hasattr(r.boxes, "xyxy") and hasattr(r.boxes.xyxy, "cpu") else getattr(r.boxes, "xyxy", [])

            for p_idx, kpts in enumerate(kpts_data):
                pose_kpts: Dict[str, Keypoint] = {}
                for k_idx, kp in enumerate(kpts):
                    if k_idx >= len(COCO_KEYPOINT_NAMES):
                        break
                    kx, ky = float(kp[0]), float(kp[1])
                    kconf = float(kp[2]) if len(kp) > 2 else 0.5
                    name = COCO_KEYPOINT_NAMES[k_idx]
                    pose_kpts[name] = Keypoint(
                        name=name,
                        x=max(0.0, min(1.0, round(kx / width, 4))),
                        y=max(0.0, min(1.0, round(ky / height, 4))),
                        confidence=round(kconf, 3),
                    )

                # Find matching tracked person by bbox center distance
                box_xyxy = boxes_data[p_idx] if p_idx < len(boxes_data) else [0, 0, width, height]
                p_cx = (box_xyxy[0] + box_xyxy[2]) / (2.0 * width)
                p_cy = (box_xyxy[1] + box_xyxy[3]) / (2.0 * height)

                best_track_id = p_idx + 1
                best_dist = 999.0
                best_bbox = {"x": p_cx - 0.1, "y": p_cy - 0.2, "width": 0.2, "height": 0.4}
                for tp in tracked_people:
                    tcx = tp.bbox["x"] + tp.bbox["width"] / 2.0
                    tcy = tp.bbox["y"] + tp.bbox["height"] / 2.0
                    dist = (tcx - p_cx) ** 2 + (tcy - p_cy) ** 2
                    if dist < best_dist:
                        best_dist = dist
                        best_track_id = tp.track_id
                        best_bbox = tp.bbox

                poses.append(
                    PersonPose(
                        track_id=best_track_id,
                        keypoints=pose_kpts,
                        bbox=best_bbox,
                        confidence=round(float(getattr(r.boxes.conf[p_idx], "item", lambda: 0.8)()), 3) if hasattr(r.boxes, "conf") and len(r.boxes.conf) > p_idx else 0.8,
                    )
                )

        except Exception as exc:
            logger.warning("Pose estimation runtime error: %s", exc)

        return poses
