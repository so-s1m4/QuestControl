"""
QuestControl Activity Intelligence - Temporal Hand Wave / Help Requested Classifier
Strictly temporal multi-frame confirmation with hysteresis, noise filtering, and anti-spam cooldowns.
"""

from collections import deque
import logging
import math
import time
from typing import Any, Dict, List, Optional, Tuple

from activity.base import ActivityEvent, PersonPose, TemporalActionClassifier

logger = logging.getLogger("questcontrol.ai.activity.hand_wave")


class HandWaveClassifier(TemporalActionClassifier):
    def __init__(
        self,
        window_sec: float = 1.5,          # Window duration (1.0 to 3.0s)
        min_reversals: int = 3,           # Min direction reversals (e.g. L->R->L->R)
        min_displacement: float = 0.015,  # Min step displacement to filter jitter
        min_total_travel: float = 0.06,   # Min accumulated horizontal travel
        min_confirm_frames: int = 4,      # Min frames with raised moving wrist
        min_confidence: float = 0.60,     # Min average confidence threshold
        person_cooldown_sec: float = 30.0,# Cooldown per person track
        room_cooldown_sec: float = 60.0,  # Cooldown per room
    ):
        self.window_sec = max(1.0, min(3.0, float(window_sec)))
        self.min_reversals = int(min_reversals)
        self.min_displacement = float(min_displacement)
        self.min_total_travel = float(min_total_travel)
        self.min_confirm_frames = int(min_confirm_frames)
        self.min_confidence = float(min_confidence)
        self.person_cooldown_sec = float(person_cooldown_sec)
        self.room_cooldown_sec = float(room_cooldown_sec)

        # Per-camera track history: camera_id -> track_id -> deque of observations
        # Observation: {"t": float, "lw": (x,y,c), "rw": (x,y,c), "ls": (x,y,c), "rs": (x,y,c), "head": (x,y)}
        self._histories: Dict[str, Dict[int, deque]] = {}

        # Cooldown trackers:
        # (camera_id, track_id) -> last_event_time
        self._last_person_alert: Dict[Tuple[str, int], float] = {}
        # room_or_cam_key -> last_event_time
        self._last_room_alert: Dict[str, float] = {}

    def reset_camera(self, camera_id: str) -> None:
        """Clears temporal state when PTZ moves or settles."""
        if camera_id in self._histories:
            self._histories[camera_id].clear()
        logger.debug("Reset temporal hand wave history for camera %s", camera_id)

    def process_frame(
        self,
        camera_id: str,
        room_id: Optional[str],
        preset_name: Optional[str],
        poses: List[PersonPose],
        timestamp: float,
        is_camera_moving: bool,
    ) -> List[ActivityEvent]:
        # PTZ Correctness: If camera is moving, pause and clear history
        if is_camera_moving:
            self.reset_camera(camera_id)
            return []

        if camera_id not in self._histories:
            self._histories[camera_id] = {}

        cam_hist = self._histories[camera_id]
        events: List[ActivityEvent] = []

        # Current frame track IDs
        current_track_ids = {p.track_id for p in poses}

        # Expire old tracks (> 4 seconds of inactivity)
        expired_ids = [tid for tid, dq in cam_hist.items() if dq and (timestamp - dq[-1]["t"] > 4.0)]
        for tid in expired_ids:
            del cam_hist[tid]

        room_key = room_id or camera_id

        for pose in poses:
            tid = pose.track_id
            if tid not in cam_hist:
                cam_hist[tid] = deque(maxlen=60)

            kpts = pose.keypoints
            lw = kpts.get("left_wrist")
            rw = kpts.get("right_wrist")
            ls = kpts.get("left_shoulder")
            rs = kpts.get("right_shoulder")
            nose = kpts.get("nose")

            obs = {
                "t": timestamp,
                "lw": (lw.x, lw.y, lw.confidence) if lw else (0.0, 0.0, 0.0),
                "rw": (rw.x, rw.y, rw.confidence) if rw else (0.0, 0.0, 0.0),
                "ls": (ls.x, ls.y, ls.confidence) if ls else (0.0, 0.0, 0.0),
                "rs": (rs.x, rs.y, rs.confidence) if rs else (0.0, 0.0, 0.0),
                "nose": (nose.x, nose.y, nose.confidence) if nose else (0.0, 0.0, 0.0),
                "pose_conf": pose.confidence,
            }
            cam_hist[tid].append(obs)

            # Analyze temporal sequence for this person
            dq = cam_hist[tid]
            # Filter observations to window [timestamp - self.window_sec, timestamp]
            win_obs = [o for o in dq if (timestamp - o["t"]) <= self.window_sec]
            if len(win_obs) < self.min_confirm_frames:
                continue

            # Check right arm then left arm
            is_wave, arm_name, evidence, conf, reason = self._evaluate_hand_wave(win_obs)
            if not is_wave:
                continue

            # Anti-spam cooldown check:
            # Check room-level cooldown
            last_room_t = self._last_room_alert.get(room_key, 0.0)
            if (timestamp - last_room_t) < self.room_cooldown_sec:
                logger.debug("Suppressing HAND_WAVE alert for room %s (room cooldown active)", room_key)
                continue

            # Check person-level cooldown
            person_key = (camera_id, tid)
            last_person_t = self._last_person_alert.get(person_key, 0.0)
            if (timestamp - last_person_t) < self.person_cooldown_sec:
                logger.debug("Suppressing HAND_WAVE alert for track %d (person cooldown active)", tid)
                continue

            # Cooldown passed: fire event!
            self._last_room_alert[room_key] = timestamp
            self._last_person_alert[person_key] = timestamp

            ev = ActivityEvent(
                action_type="HELP_REQUESTED",
                sub_type="HAND_WAVE",
                camera_id=camera_id,
                room_id=room_id,
                preset_name=preset_name,
                track_id=tid,
                confidence=conf,
                reason=reason,
                evidence=evidence,
                status="CONFIRMED",
            )
            events.append(ev)
            logger.info("🚨 Generated HELP_REQUESTED (HAND_WAVE) event: %s on camera %s (track %d)", reason, camera_id, tid)

        return events

    def _evaluate_hand_wave(self, win_obs: List[Dict[str, Any]]) -> Tuple[bool, str, Dict[str, Any], float, str]:
        """
        Evaluates whether observations within window represent a confirmed hand wave.
        Returns: (is_wave, arm_name, evidence_dict, confidence, reason)
        """
        # Test right arm first, then left arm
        for arm_name, wrist_key, shoulder_key in [("right", "rw", "rs"), ("left", "lw", "ls")]:
            valid_points = []
            for o in win_obs:
                wx, wy, wc = o[wrist_key]
                sx, sy, sc = o[shoulder_key]
                # Condition 1: wrist must be raised above shoulder
                # In image coordinates, y=0 is top, y=1 is bottom -> wrist above shoulder means wy < sy
                if wc >= 0.35 and sc >= 0.35 and wy < sy:
                    valid_points.append({
                        "t": o["t"],
                        "x": wx,
                        "y": wy,
                        "c": wc,
                        "nose": o["nose"],
                    })

            if len(valid_points) < self.min_confirm_frames:
                continue

            # Check for headset adjusting false positive:
            # If wrist is stationary near head/nose/ears, reject
            nose_pts = [p["nose"] for p in valid_points if p["nose"][2] > 0.3]
            if nose_pts:
                avg_nose_y = sum(n[1] for n in nose_pts) / len(nose_pts)
                avg_wrist_y = sum(p["y"] for p in valid_points) / len(valid_points)
                # If wrist is right around nose/head level, ensure high lateral motion
                near_head = abs(avg_wrist_y - avg_nose_y) < 0.08
            else:
                near_head = False

            # Compute horizontal movement trajectory & reversals
            xs = [p["x"] for p in valid_points]
            ts = [p["t"] for p in valid_points]
            max_x = max(xs)
            min_x = min(xs)
            total_range = max_x - min_x

            # Reject stationary raised hand (e.g. asking a question, high five, holding object)
            if total_range < 0.035:
                continue

            reversals = 0
            current_dir = 0  # +1: moving right, -1: moving left
            extremum = xs[0]
            total_travel = 0.0

            for i in range(1, len(xs)):
                dx = xs[i] - xs[i - 1]
                total_travel += abs(dx)

                if current_dir == 0:
                    if (xs[i] - extremum) >= self.min_displacement:
                        current_dir = 1
                        extremum = xs[i]
                    elif (extremum - xs[i]) >= self.min_displacement:
                        current_dir = -1
                        extremum = xs[i]
                elif current_dir == 1:
                    if xs[i] > extremum:
                        extremum = xs[i]
                    elif (extremum - xs[i]) >= self.min_displacement:
                        # Reversal from rightward to leftward
                        reversals += 1
                        current_dir = -1
                        extremum = xs[i]
                elif current_dir == -1:
                    if xs[i] < extremum:
                        extremum = xs[i]
                    elif (xs[i] - extremum) >= self.min_displacement:
                        # Reversal from leftward to rightward
                        reversals += 1
                        current_dir = 1
                        extremum = xs[i]

            # False positive rejection:
            # 1. Unidirectional reaching for an object: reversals <= 1
            if reversals < self.min_reversals:
                continue

            # 2. Total accumulated travel must show real continuous waving
            if total_travel < self.min_total_travel:
                continue

            # 3. If near head (adjusting headset), require extra travel so small movements don't trigger
            if near_head and total_travel < (self.min_total_travel * 1.3):
                continue

            duration = ts[-1] - ts[0]
            if duration <= 0:
                duration = self.window_sec

            avg_conf = sum(p["c"] for p in valid_points) / len(valid_points)
            conf = min(0.98, max(0.60, round(avg_conf * 0.7 + min(reversals, 5) * 0.06, 3)))
            if conf < self.min_confidence:
                continue

            evidence = {
                "arm": arm_name,
                "reversals": reversals,
                "durationSec": round(duration, 2),
                "totalTravel": round(total_travel, 3),
                "horizontalRange": round(total_range, 3),
                "sampleCount": len(valid_points),
                "avgKeypointConf": round(avg_conf, 3),
                "trajectory": [{"t": round(p["t"], 2), "x": round(p["x"], 3), "y": round(p["y"], 3)} for p in valid_points],
            }
            reason = f"Lateral hand wave detected ({reversals} reversals, travel={total_travel:.2f}, {duration:.1f}s)"
            return True, arm_name, evidence, conf, reason

        return False, "", {}, 0.0, ""
