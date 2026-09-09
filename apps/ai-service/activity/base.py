"""
QuestControl Activity Intelligence - Base Contracts & Data Structures
Extensible foundation for local behavioral analysis and temporal action classification.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union
import uuid


@dataclass
class TrackedPerson:
    track_id: int
    bbox: Dict[str, float]  # {"x": float, "y": float, "width": float, "height": float} normalized [0, 1]
    confidence: float
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class Keypoint:
    name: str
    x: float  # normalized [0, 1]
    y: float  # normalized [0, 1]
    confidence: float


@dataclass
class PersonPose:
    track_id: int
    keypoints: Dict[str, Keypoint]  # e.g. {"nose": ..., "left_wrist": ..., "right_wrist": ..., ...}
    bbox: Dict[str, float]
    confidence: float
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass
class ActivityEvent:
    action_type: str  # e.g. "HELP_REQUESTED", "FALL_DETECTED", "PROHIBITED_ZONE_ENTRY"
    sub_type: str     # e.g. "HAND_WAVE"
    camera_id: str
    confidence: float
    reason: str
    evidence: Dict[str, Any]
    event_id: str = field(default_factory=lambda: f"act_ev_{uuid.uuid4().hex[:12]}")
    room_id: Optional[str] = None
    preset_name: Optional[str] = None
    track_id: Optional[int] = None
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    status: str = "CONFIRMED"  # "CONFIRMED", "ACTIVE", "RECOVERED", "DISMISSED"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.event_id,
            "actionType": self.action_type,
            "subType": self.sub_type,
            "cameraId": self.camera_id,
            "roomId": self.room_id,
            "presetName": self.preset_name,
            "trackId": self.track_id,
            "timestamp": self.timestamp,
            "confidence": round(self.confidence, 3),
            "reason": self.reason,
            "evidence": self.evidence,
            "status": self.status,
        }


class PersonTrackerAdapter(ABC):
    @abstractmethod
    def track_people(
        self,
        image_bytes: bytes,
        camera_id: str,
        conf_threshold: float = 0.25,
    ) -> List[TrackedPerson]:
        pass


class PoseEstimatorAdapter(ABC):
    @abstractmethod
    def is_available(self) -> bool:
        pass

    @abstractmethod
    def get_status(self) -> str:
        pass

    @abstractmethod
    def estimate_poses(
        self,
        image_bytes: bytes,
        tracked_people: List[TrackedPerson],
        conf_threshold: float = 0.25,
    ) -> List[PersonPose]:
        pass


class TemporalActionClassifier(ABC):
    @abstractmethod
    def process_frame(
        self,
        camera_id: str,
        room_id: Optional[str],
        preset_name: Optional[str],
        poses: List[PersonPose],
        timestamp: float,
        is_camera_moving: bool,
    ) -> List[ActivityEvent]:
        pass

    @abstractmethod
    def reset_camera(self, camera_id: str) -> None:
        pass


class ActivityPlugin(ABC):
    @property
    @abstractmethod
    def action_type(self) -> str:
        pass

    @property
    @abstractmethod
    def version(self) -> str:
        pass

    @property
    @abstractmethod
    def enabled(self) -> bool:
        pass

    @enabled.setter
    @abstractmethod
    def enabled(self, value: bool) -> None:
        pass

    @abstractmethod
    def get_health(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    def process_frame(
        self,
        camera_id: str,
        room_id: Optional[str],
        preset_name: Optional[str],
        poses: List[PersonPose],
        timestamp: float,
        is_camera_moving: bool,
    ) -> List[ActivityEvent]:
        pass

    @abstractmethod
    def reset_camera(self, camera_id: str) -> None:
        pass
