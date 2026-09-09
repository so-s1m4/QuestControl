"""
QuestControl Activity Intelligence - Core Engine
Coordinates tracking, pose estimation, temporal action classifiers, and PTZ state awareness.
"""

from datetime import datetime, timezone
import logging
import time
from typing import Any, Dict, List, Optional, Set

from activity.base import ActivityEvent, PersonPose, TrackedPerson
from activity.person_tracker import YoloPersonTracker
from activity.pose_estimator import LocalPoseEstimator
from activity.registry import ActivityPluginRegistry

logger = logging.getLogger("questcontrol.ai.activity.engine")


class ActivityIntelligenceEngine:
    def __init__(
        self,
        tracker: Optional[YoloPersonTracker] = None,
        pose_estimator: Optional[LocalPoseEstimator] = None,
        registry: Optional[ActivityPluginRegistry] = None,
    ):
        self.tracker = tracker or YoloPersonTracker()
        self.pose_estimator = pose_estimator or LocalPoseEstimator()
        self.registry = registry or ActivityPluginRegistry()

        # PTZ State tracking: camera_id -> bool
        self._moving_cameras: Dict[str, bool] = {}
        # PTZ Settle timestamps: camera_id -> timestamp (epoch seconds)
        self._settled_at: Dict[str, float] = {}
        # Current preset per camera: camera_id -> preset_name
        self._current_presets: Dict[str, str] = {}
        # Last observed frame timestamp per camera (epoch seconds) to reject stale frames
        self._last_frame_timestamps: Dict[str, float] = {}

    def set_camera_moving(
        self,
        camera_id: str,
        is_moving: bool,
        preset: Optional[str] = None,
        settle_delay_sec: float = 1.2,
    ) -> None:
        """
        Notifies engine of PTZ movement state.
        Temporal buffers are immediately reset during movement.
        """
        now = time.time()
        self._moving_cameras[camera_id] = bool(is_moving)
        if preset:
            self._current_presets[camera_id] = preset

        if is_moving:
            self.registry.reset_camera(camera_id)
            logger.debug("Camera %s is moving; temporal buffers reset", camera_id)
        else:
            self._settled_at[camera_id] = now + max(0.0, float(settle_delay_sec))
            logger.debug("Camera %s stopped; settling until t=%.2f", camera_id, self._settled_at[camera_id])

    def get_health(self) -> Dict[str, Any]:
        pose_status = self.pose_estimator.get_status()
        plugins_health = self.registry.get_all_health()
        enabled_count = sum(1 for p in plugins_health if p.get("enabled"))
        return {
            "poseEstimatorStatus": pose_status,
            "poseEstimatorAvailable": self.pose_estimator.is_available(),
            "plugins": plugins_health,
            "enabledPluginsCount": enabled_count,
        }

    def process_frame(
        self,
        camera_id: str,
        image_bytes: bytes,
        timestamp_epoch: Optional[float] = None,
        room_id: Optional[str] = None,
        preset_name: Optional[str] = None,
        synthetic_poses: Optional[List[PersonPose]] = None,
        synthetic_people: Optional[List[TrackedPerson]] = None,
        enabled_action_types: Optional[Set[str]] = None,
    ) -> Dict[str, Any]:
        """
        Processes a video frame for behavioral activity.
        Enforces PTZ settlement and fresh timestamp checks.
        """
        now = time.time()
        t_epoch = float(timestamp_epoch) if timestamp_epoch is not None else now
        preset = preset_name or self._current_presets.get(camera_id, "default")

        # 1. Check if camera is actively moving or currently settling
        is_moving = self._moving_cameras.get(camera_id, False)
        settled_until = self._settled_at.get(camera_id, 0.0)
        is_settling = now < settled_until

        if is_moving or is_settling:
            logger.debug("Skipping activity inference for camera %s (moving=%s, settling=%s)", camera_id, is_moving, is_settling)
            return {
                "cameraId": camera_id,
                "roomId": room_id,
                "presetName": preset,
                "timestamp": datetime.fromtimestamp(t_epoch, tz=timezone.utc).isoformat(),
                "status": "CAMERA_MOVING",
                "events": [],
                "peopleCount": 0,
                "poses": [],
            }

        # 2. Check for stale or non-monotonic frame timestamp
        last_t = self._last_frame_timestamps.get(camera_id, 0.0)
        if timestamp_epoch is not None and t_epoch <= last_t:
            logger.warning("Rejected stale or backwards frame timestamp for camera %s (t=%.3f <= last=%.3f)", camera_id, t_epoch, last_t)
            return {
                "cameraId": camera_id,
                "roomId": room_id,
                "presetName": preset,
                "timestamp": datetime.fromtimestamp(t_epoch, tz=timezone.utc).isoformat(),
                "status": "FRAME_STALE",
                "events": [],
                "peopleCount": 0,
                "poses": [],
            }
        self._last_frame_timestamps[camera_id] = t_epoch

        # 3. Check pose model availability (unless synthetic test poses are provided)
        if synthetic_poses is None and not self.pose_estimator.is_available():
            pose_status = self.pose_estimator.get_status()
            return {
                "cameraId": camera_id,
                "roomId": room_id,
                "presetName": preset,
                "timestamp": datetime.fromtimestamp(t_epoch, tz=timezone.utc).isoformat(),
                "status": pose_status,
                "error": getattr(self.pose_estimator, "error", None) or f"{pose_status}: Pose model unavailable",
                "events": [],
                "peopleCount": 0,
                "poses": [],
            }

        # 4. Track people and estimate poses
        if synthetic_poses is not None:
            poses = synthetic_poses
            people_count = len(poses)
        else:
            if synthetic_people is not None:
                tracked = synthetic_people
            else:
                tracked = self.tracker.track_people(image_bytes, camera_id=camera_id)
            people_count = len(tracked)
            poses = self.pose_estimator.estimate_poses(image_bytes, tracked_people=tracked)

        # 5. Run temporal plugins
        events = self.registry.process_frame(
            camera_id=camera_id,
            room_id=room_id,
            preset_name=preset,
            poses=poses,
            timestamp=t_epoch,
            is_camera_moving=False,
            enabled_action_types=enabled_action_types,
        )

        return {
            "cameraId": camera_id,
            "roomId": room_id,
            "presetName": preset,
            "timestamp": datetime.fromtimestamp(t_epoch, tz=timezone.utc).isoformat(),
            "status": "READY",
            "events": [e.to_dict() for e in events],
            "peopleCount": people_count,
            "posesCount": len(poses),
        }
