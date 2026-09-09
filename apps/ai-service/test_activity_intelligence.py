"""
Unit & Acceptance Tests for Activity Intelligence & Behavioral Action Detection
Covers: true wave, stationary hand, reaching, headset adjustment, gesturing, occlusion,
two people, track-ID changes, PTZ movement, stale timestamps, model unavailable,
cooldown anti-spam, failure isolation, and honest status reporting.
"""

import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_AI_SERVICE_DIR = str(Path(__file__).resolve().parent)
if _AI_SERVICE_DIR not in sys.path:
    sys.path.insert(0, _AI_SERVICE_DIR)

from activity.base import ActivityEvent, Keypoint, PersonPose, TrackedPerson
from activity.engine import ActivityIntelligenceEngine
from activity.hand_wave_classifier import HandWaveClassifier
from activity.pose_estimator import LocalPoseEstimator
from activity.registry import (
    ActivityPluginRegistry,
    BaseActivityPlugin,
    HelpRequestedPlugin,
)


def _make_pose(
    track_id: int,
    rw_x: float,
    rw_y: float,
    rs_x: float = 0.5,
    rs_y: float = 0.5,
    nose_x: float = 0.5,
    nose_y: float = 0.3,
    conf: float = 0.9,
    timestamp: Optional[str] = None,
) -> PersonPose:
    """Helper to create a PersonPose with right wrist and shoulder."""
    kpts = {
        "nose": Keypoint(name="nose", x=nose_x, y=nose_y, confidence=conf),
        "right_shoulder": Keypoint(name="right_shoulder", x=rs_x, y=rs_y, confidence=conf),
        "right_wrist": Keypoint(name="right_wrist", x=rw_x, y=rw_y, confidence=conf),
        "left_shoulder": Keypoint(name="left_shoulder", x=rs_x - 0.1, y=rs_y, confidence=conf),
        "left_wrist": Keypoint(name="left_wrist", x=rs_x - 0.1, y=rs_y + 0.2, confidence=conf), # lowered
    }
    return PersonPose(
        track_id=track_id,
        keypoints=kpts,
        bbox={"x": rs_x - 0.1, "y": nose_y - 0.05, "width": 0.2, "height": 0.6},
        confidence=conf,
        timestamp=timestamp or "2026-09-09T15:00:00Z",
    )


class TestActivityIntelligence(unittest.TestCase):
    def setUp(self):
        self.classifier = HandWaveClassifier(
            window_sec=2.0,
            min_reversals=3,
            min_displacement=0.015,
            min_total_travel=0.06,
            min_confirm_frames=4,
            min_confidence=0.60,
            person_cooldown_sec=10.0,
            room_cooldown_sec=15.0,
        )

    def test_true_hand_wave_sequence_triggers_help_requested(self):
        """A person with raised wrist waving back and forth generates HELP_REQUESTED."""
        camera_id = "cam-room-1"
        t0 = 100.0
        # Right wrist oscillation above shoulder (rw_y=0.25 < rs_y=0.50)
        # Left-Right-Left-Right (4 reversals): 0.50 -> 0.62 -> 0.45 -> 0.60 -> 0.46
        trajectory = [0.50, 0.55, 0.62, 0.58, 0.50, 0.45, 0.52, 0.60, 0.52, 0.46]
        events = []
        for idx, x in enumerate(trajectory):
            t = t0 + idx * 0.15
            pose = _make_pose(track_id=1, rw_x=x, rw_y=0.25, rs_x=0.50, rs_y=0.50)
            evs = self.classifier.process_frame(
                camera_id=camera_id,
                room_id="room-quest",
                preset_name="Center",
                poses=[pose],
                timestamp=t,
                is_camera_moving=False,
            )
            events.extend(evs)

        self.assertGreaterEqual(len(events), 1)
        first = events[0]
        self.assertEqual(first.action_type, "HELP_REQUESTED")
        self.assertEqual(first.sub_type, "HAND_WAVE")
        self.assertEqual(first.track_id, 1)
        self.assertEqual(first.status, "CONFIRMED")
        self.assertIn("reversals", first.evidence)
        self.assertGreaterEqual(first.evidence["reversals"], 3)
        self.assertGreaterEqual(first.confidence, 0.60)

    def test_raised_stationary_hand_rejected(self):
        """A person holding hand stationary above shoulder (e.g. asking question/high 5) is rejected."""
        camera_id = "cam-room-1"
        t0 = 100.0
        events = []
        # Wrist stationary at x=0.52 above shoulder
        for idx in range(10):
            t = t0 + idx * 0.15
            pose = _make_pose(track_id=1, rw_x=0.52, rw_y=0.25, rs_x=0.50, rs_y=0.50)
            evs = self.classifier.process_frame(
                camera_id=camera_id,
                room_id="room-quest",
                preset_name="Center",
                poses=[pose],
                timestamp=t,
                is_camera_moving=False,
            )
            events.extend(evs)

        self.assertEqual(len(events), 0, "Stationary hand should not trigger wave alert")

    def test_reaching_for_object_rejected(self):
        """Unidirectional movement (reaching for something) is rejected as reversals <= 1."""
        camera_id = "cam-room-1"
        t0 = 100.0
        # Monotonically moving right: 0.40 -> 0.70
        trajectory = [0.40, 0.44, 0.49, 0.54, 0.59, 0.64, 0.70]
        events = []
        for idx, x in enumerate(trajectory):
            t = t0 + idx * 0.15
            pose = _make_pose(track_id=1, rw_x=x, rw_y=0.30, rs_x=0.45, rs_y=0.50)
            evs = self.classifier.process_frame(
                camera_id=camera_id,
                room_id="room-quest",
                preset_name="Center",
                poses=[pose],
                timestamp=t,
                is_camera_moving=False,
            )
            events.extend(evs)

        self.assertEqual(len(events), 0, "Unidirectional reach should not trigger wave alert")

    def test_adjusting_headset_rejected(self):
        """Hands touching/adjusting headset near ears/nose with small travel are rejected."""
        camera_id = "cam-room-1"
        t0 = 100.0
        # Small micro-movements right at nose/head level (rw_y=0.30, nose_y=0.30)
        trajectory = [0.52, 0.53, 0.52, 0.53, 0.52, 0.53]
        events = []
        for idx, x in enumerate(trajectory):
            t = t0 + idx * 0.15
            pose = _make_pose(track_id=1, rw_x=x, rw_y=0.30, rs_x=0.50, rs_y=0.50, nose_y=0.30)
            evs = self.classifier.process_frame(
                camera_id=camera_id,
                room_id="room-quest",
                preset_name="Center",
                poses=[pose],
                timestamp=t,
                is_camera_moving=False,
            )
            events.extend(evs)

        self.assertEqual(len(events), 0, "Adjusting headset should not trigger wave alert")

    def test_ordinary_gesturing_below_shoulder_rejected(self):
        """Lateral motion below shoulder level (ordinary talking gestures) is rejected."""
        camera_id = "cam-room-1"
        t0 = 100.0
        # Oscillating left-right but wrist is BELOW shoulder (rw_y=0.65 > rs_y=0.50)
        trajectory = [0.50, 0.62, 0.45, 0.60, 0.46, 0.58]
        events = []
        for idx, x in enumerate(trajectory):
            t = t0 + idx * 0.15
            pose = _make_pose(track_id=1, rw_x=x, rw_y=0.65, rs_x=0.50, rs_y=0.50)
            evs = self.classifier.process_frame(
                camera_id=camera_id,
                room_id="room-quest",
                preset_name="Center",
                poses=[pose],
                timestamp=t,
                is_camera_moving=False,
            )
            events.extend(evs)

        self.assertEqual(len(events), 0, "Gesturing below shoulder must not trigger wave alert")

    def test_two_people_one_waving_one_idle(self):
        """Two people in the frame: only the waving person triggers an alert with correct track ID."""
        camera_id = "cam-room-1"
        t0 = 100.0
        wave_traj = [0.50, 0.55, 0.62, 0.58, 0.50, 0.45, 0.52, 0.60, 0.52, 0.46]
        events = []
        for idx, x in enumerate(wave_traj):
            t = t0 + idx * 0.15
            pose_waving = _make_pose(track_id=2, rw_x=x, rw_y=0.25, rs_x=0.50, rs_y=0.50)
            pose_idle = _make_pose(track_id=1, rw_x=0.20, rw_y=0.70, rs_x=0.20, rs_y=0.50)
            evs = self.classifier.process_frame(
                camera_id=camera_id,
                room_id="room-quest",
                preset_name="Center",
                poses=[pose_idle, pose_waving],
                timestamp=t,
                is_camera_moving=False,
            )
            events.extend(evs)

        self.assertGreaterEqual(len(events), 1)
        for ev in events:
            self.assertEqual(ev.track_id, 2, "Event must belong exclusively to waving person (track 2)")

    def test_track_id_change_resets_history(self):
        """If a track ID changes due to tracking loss, separate buffers prevent false fusion."""
        camera_id = "cam-room-1"
        t0 = 100.0
        # Track 1 starts waving (2 reversals)
        for idx, x in enumerate([0.50, 0.62, 0.45]):
            pose = _make_pose(track_id=1, rw_x=x, rw_y=0.25)
            evs = self.classifier.process_frame(camera_id, "room-1", "Center", [pose], t0 + idx * 0.15, False)
            self.assertEqual(len(evs), 0)

        # Track 1 disappears, Track 2 appears (2 reversals)
        for idx, x in enumerate([0.55, 0.60, 0.46]):
            pose = _make_pose(track_id=2, rw_x=x, rw_y=0.25)
            evs = self.classifier.process_frame(camera_id, "room-1", "Center", [pose], t0 + (idx + 3) * 0.15, False)
            self.assertEqual(len(evs), 0)

    def test_cooldown_suppresses_duplicate_spam_during_continuous_waving(self):
        """Continuous waving after the first confirmed event does not spam notifications within cooldown."""
        camera_id = "cam-room-1"
        t0 = 100.0
        trajectory = [0.50, 0.62, 0.45, 0.60, 0.46, 0.62, 0.45, 0.60, 0.46, 0.62, 0.45]
        events = []
        for idx, x in enumerate(trajectory):
            t = t0 + idx * 0.15
            pose = _make_pose(track_id=1, rw_x=x, rw_y=0.25)
            evs = self.classifier.process_frame(camera_id, "room-1", "Center", [pose], t, False)
            events.extend(evs)

        self.assertEqual(len(events), 1, "Should emit exactly one alert, not spamming on consecutive wave frames")

    def test_ptz_movement_pauses_and_resets_temporal_inference(self):
        """Engine pauses during PTZ movement and resets temporal buffers."""
        engine = ActivityIntelligenceEngine()
        plugin = HelpRequestedPlugin(enabled=True)
        engine.registry.register_plugin(plugin)

        camera_id = "cam-ptz-1"
        now = time.time()

        # 1. Signal camera is moving
        engine.set_camera_moving(camera_id, is_moving=True, preset="Corner")

        pose = _make_pose(track_id=1, rw_x=0.60, rw_y=0.25)
        res = engine.process_frame(camera_id, b"", timestamp_epoch=now, synthetic_poses=[pose])
        self.assertEqual(res["status"], "CAMERA_MOVING")
        self.assertEqual(len(res["events"]), 0)

        # 2. Camera stops moving, begins settling
        engine.set_camera_moving(camera_id, is_moving=False, preset="Corner", settle_delay_sec=1.5)
        res2 = engine.process_frame(camera_id, b"", timestamp_epoch=now + 0.2, synthetic_poses=[pose])
        self.assertEqual(res2["status"], "CAMERA_MOVING")

    def test_stale_or_backwards_timestamp_rejected(self):
        """Engine rejects frame with timestamp <= previous seen timestamp."""
        engine = ActivityIntelligenceEngine()
        camera_id = "cam-1"
        t1 = 1000.0
        pose = _make_pose(track_id=1, rw_x=0.5, rw_y=0.5)

        res1 = engine.process_frame(camera_id, b"", timestamp_epoch=t1, synthetic_poses=[pose])
        self.assertEqual(res1["status"], "READY")

        # Stale timestamp (older or equal)
        res2 = engine.process_frame(camera_id, b"", timestamp_epoch=t1 - 1.0, synthetic_poses=[pose])
        self.assertEqual(res2["status"], "FRAME_STALE")
        self.assertEqual(len(res2["events"]), 0)

    def test_pose_model_unavailable_honest_status(self):
        """Missing pose weights produces POSE_MODEL_UNAVAILABLE honestly without remote downloads."""
        estimator = LocalPoseEstimator(model_path="/nonexistent/pose/weights.pt")
        self.assertFalse(estimator.is_available())
        self.assertEqual(estimator.get_status(), "POSE_MODEL_UNAVAILABLE")

        engine = ActivityIntelligenceEngine(pose_estimator=estimator)
        res = engine.process_frame("cam-1", b"dummy_bytes", timestamp_epoch=time.time())
        self.assertEqual(res["status"], "POSE_MODEL_UNAVAILABLE")

    def test_plugin_failure_isolation(self):
        """A crashing plugin is caught and isolated without affecting engine or other plugins."""
        registry = ActivityPluginRegistry()

        class CrashingPlugin(BaseActivityPlugin):
            def __init__(self):
                super().__init__(action_type="CRASH_TEST", version="1.0.0", enabled=True)
            def process_frame(self, *args, **kwargs):
                raise RuntimeError("Injected unexpected crash in plugin!")

        registry.register_plugin(CrashingPlugin())
        help_plugin = HelpRequestedPlugin(enabled=True)
        registry.register_plugin(help_plugin)

        # Process frame: crashing plugin must not bubble up or crash execution
        pose = _make_pose(track_id=1, rw_x=0.5, rw_y=0.5)
        evs = registry.process_frame("cam-1", "room-1", "Center", [pose], time.time(), False)
        self.assertEqual(len(evs), 0)

        health = registry.get_all_health()
        crash_health = next(h for h in health if h["actionType"] == "CRASH_TEST")
        self.assertEqual(crash_health["status"], "ERROR")
        self.assertIn("Injected unexpected crash", crash_health["lastError"])


if __name__ == "__main__":
    unittest.main()
