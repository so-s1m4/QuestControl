"""
QuestControl Activity Intelligence - Person Tracker Adapter
Associates persons across video frames using ByteTrack.
"""

import io
import logging
from typing import Any, Dict, List, Optional
from PIL import Image

from activity.base import PersonTrackerAdapter, TrackedPerson

logger = logging.getLogger("questcontrol.ai.activity.tracker")


class YoloPersonTracker(PersonTrackerAdapter):
    def __init__(self, yolo_model: Optional[Any] = None):
        self.yolo_model = yolo_model

    def track_people(
        self,
        image_bytes: bytes,
        camera_id: str,
        conf_threshold: float = 0.25,
    ) -> List[TrackedPerson]:
        if self.yolo_model is None or not image_bytes:
            return []

        people: List[TrackedPerson] = []
        try:
            pil_img = Image.open(io.BytesIO(image_bytes))
            width, height = pil_img.size
            results = self.yolo_model.track(
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
                        xyxy = box.xyxy[0].tolist() if hasattr(box.xyxy[0], "tolist") else list(box.xyxy[0])
                        conf = float(box.conf[0])
                        track_id = int(box.id[0]) if box.id is not None else (i + 1)
                        x_norm = max(0.0, min(1.0, round(xyxy[0] / width, 4)))
                        y_norm = max(0.0, min(1.0, round(xyxy[1] / height, 4)))
                        w_norm = max(0.0, min(1.0, round((xyxy[2] - xyxy[0]) / width, 4)))
                        h_norm = max(0.0, min(1.0, round((xyxy[3] - xyxy[1]) / height, 4)))
                        people.append(
                            TrackedPerson(
                                track_id=track_id,
                                bbox={"x": x_norm, "y": y_norm, "width": w_norm, "height": h_norm},
                                confidence=round(conf, 2),
                            )
                        )
        except Exception as exc:
            logger.warning("YOLO tracking error for camera %s: %s", camera_id, exc)

        return people
