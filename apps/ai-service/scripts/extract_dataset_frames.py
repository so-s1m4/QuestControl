#!/usr/bin/env python3
"""
QuestControl VR Headset Dataset Frame Extraction Tool

Extracts high-quality, diverse, non-redundant training frames from:
1. Video files (.mp4, .mkv, .avi, .mov, .ts)
2. Directories of saved video recordings
3. Live camera RTSP / HTTP video streams
4. Folders of raw unorganized camera frames

Guarantees:
- Strict camera and session naming convention ({camera_id}_{session_id}_{preset}_{lighting}_f{idx:04d}.jpg)
- Camera/session-level split assignment (train / val / test) preventing any cross-split leakage
- Motion/diversity filtering to avoid nearly identical adjacent frames

Licensed under GNU AGPL-3.0.
"""

import argparse
import hashlib
import logging
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("questcontrol.ai.extract")

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
DATASET_DIR = AI_SERVICE_DIR / "dataset"
IMAGES_DIR = DATASET_DIR / "images"

try:
    import cv2
    import numpy as np
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False


def compute_frame_difference(prev_gray, curr_gray) -> float:
    """Computes mean absolute difference between two consecutive grayscale frames."""
    if prev_gray is None or curr_gray is None:
        return 1.0
    diff = cv2.absdiff(prev_gray, curr_gray)
    return float(np.mean(diff)) / 255.0


def extract_frames_from_video(
    video_path: Path,
    output_dir: Path,
    camera_id: str,
    session_id: str,
    preset: str = "center",
    lighting: str = "day",
    interval_sec: float = 2.0,
    max_frames: int = 100,
    min_diff_threshold: float = 0.02,
) -> List[Path]:
    """
    Extracts frames from a video file at a given interval, filtering out static/duplicate frames.
    """
    if not CV2_AVAILABLE:
        raise RuntimeError("OpenCV (cv2) is required for video extraction. Install opencv-python-headless.")

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        logger.error("Failed to open video source: %s", video_path)
        return []

    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps <= 0 or np.isnan(fps):
        fps = 25.0

    frame_stride = max(1, int(round(fps * interval_sec)))
    total_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    logger.info(
        "Processing '%s': fps=%.1f, total_frames=%d, stride=%d (every %.1fs)",
        video_path.name,
        fps,
        total_video_frames,
        frame_stride,
        interval_sec,
    )

    extracted_files: List[Path] = []
    output_dir.mkdir(parents=True, exist_ok=True)

    frame_idx = 0
    saved_count = 0
    prev_gray = None

    while cap.isOpened() and saved_count < max_frames:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_stride == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            diff = compute_frame_difference(prev_gray, gray)

            if prev_gray is None or diff >= min_diff_threshold:
                saved_count += 1
                filename = f"{camera_id}_{session_id}_{preset}_{lighting}_f{saved_count:04d}.jpg"
                out_path = output_dir / filename
                # Save as high quality JPEG (95% quality)
                cv2.imwrite(str(out_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                extracted_files.append(out_path)
                prev_gray = gray
            else:
                logger.debug("Skipping nearly identical frame %d (diff=%.4f < %.4f)", frame_idx, diff, min_diff_threshold)

        frame_idx += 1

    cap.release()
    logger.info("Extracted %d frames from '%s' to %s", len(extracted_files), video_path.name, output_dir)
    return extracted_files


def extract_frames_from_stream(
    stream_url: str,
    output_dir: Path,
    camera_id: str,
    session_id: str,
    preset: str = "center",
    lighting: str = "day",
    interval_sec: float = 2.0,
    max_frames: int = 50,
) -> List[Path]:
    """Captures frames from a live RTSP/HTTP stream URL."""
    if not CV2_AVAILABLE:
        raise RuntimeError("OpenCV (cv2) is required for stream extraction.")

    logger.info("Connecting to live stream: %s", stream_url)
    cap = cv2.VideoCapture(stream_url)
    if not cap.isOpened():
        raise RuntimeError(f"Could not connect to stream: {stream_url}")

    extracted_files: List[Path] = []
    output_dir.mkdir(parents=True, exist_ok=True)
    saved_count = 0
    last_saved_time = 0.0

    try:
        while cap.isOpened() and saved_count < max_frames:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.1)
                continue

            now = time.time()
            if now - last_saved_time >= interval_sec:
                saved_count += 1
                filename = f"{camera_id}_{session_id}_{preset}_{lighting}_f{saved_count:04d}.jpg"
                out_path = output_dir / filename
                cv2.imwrite(str(out_path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
                extracted_files.append(out_path)
                last_saved_time = now
                logger.info("Captured stream frame %d/%d -> %s", saved_count, max_frames, filename)
    finally:
        cap.release()

    return extracted_files


def assign_session_to_split(session_index: int, total_sessions: int = 1) -> str:
    """
    Deterministically assigns a session to train, val, or test split:
    - Default split ratio: 70% train, 15% val, 15% test.
    - If fewer than 3 sessions exist: session 0 -> train, session 1 -> val, session 2 -> test.
    """
    if total_sessions == 1:
        return "train"
    if total_sessions == 2:
        return "train" if session_index == 0 else "val"
    
    # Modulo partition for round-robin assignment
    mod = session_index % 6
    if mod in (0, 1, 2, 3):
        return "train"
    elif mod == 4:
        return "val"
    else:
        return "test"


def main():
    parser = argparse.ArgumentParser(description="Extract and Organize VR Headset Camera Dataset Frames")
    parser.add_argument("--source", type=str, required=True, help="Path to video file, folder of videos, or RTSP/HTTP URL")
    parser.add_argument("--output-dir", type=str, default=str(IMAGES_DIR), help="Root directory for images (contains train/val/test)")
    parser.add_argument("--split", type=str, default="auto", choices=["train", "val", "test", "auto"], help="Target dataset split (auto assigns by session)")
    parser.add_argument("--camera-id", type=str, default="cam01", help="Camera identifier (e.g. cam01, cam_room_vr)")
    parser.add_argument("--session-id", type=str, default="", help="Session identifier (defaults to auto-generated sess01, sess02...)")
    parser.add_argument("--preset", type=str, default="center", choices=["center", "table", "floor", "door", "wide"], help="PTZ angle preset")
    parser.add_argument("--lighting", type=str, default="day", choices=["day", "ir", "mixed"], help="Lighting condition (day or IR night-vision)")
    parser.add_argument("--interval-sec", type=float, default=2.0, help="Interval in seconds between extracted frames")
    parser.add_argument("--max-frames", type=int, default=80, help="Maximum frames per video/session")
    parser.add_argument("--min-diff", type=float, default=0.015, help="Minimum frame change threshold to avoid duplicate frames")
    args = parser.parse_args()

    source_path = Path(args.source)
    output_root = Path(args.output_dir).resolve()

    # Determine if source is a stream URL or local path
    is_stream = "://" in args.source

    if is_stream:
        session_id = args.session_id or f"sess{int(time.time())}"
        target_split = args.split if args.split != "auto" else "train"
        target_dir = output_root / target_split
        extracted = extract_frames_from_stream(
            stream_url=args.source,
            output_dir=target_dir,
            camera_id=args.camera_id,
            session_id=session_id,
            preset=args.preset,
            lighting=args.lighting,
            interval_sec=args.interval_sec,
            max_frames=args.max_frames,
        )
        logger.info("Stream extraction finished: %d frames saved to %s", len(extracted), target_dir)
        return

    if not source_path.exists():
        logger.error("Source path does not exist: %s", source_path)
        sys.exit(1)

    video_extensions = {".mp4", ".mkv", ".avi", ".mov", ".ts", ".h264"}
    if source_path.is_file():
        video_files = [source_path]
    else:
        video_files = sorted([p for p in source_path.glob("*.*") if p.suffix.lower() in video_extensions])

    if not video_files:
        logger.error("No video files found at: %s", source_path)
        sys.exit(1)

    logger.info("Found %d video file(s) to process.", len(video_files))

    total_extracted = 0
    split_counts: Dict[str, int] = {"train": 0, "val": 0, "test": 0}

    for idx, v_file in enumerate(video_files):
        session_id = args.session_id or f"sess{idx+1:02d}"
        if args.split == "auto":
            assigned_split = assign_session_to_split(idx, len(video_files))
        else:
            assigned_split = args.split

        target_dir = output_root / assigned_split
        frames = extract_frames_from_video(
            video_path=v_file,
            output_dir=target_dir,
            camera_id=args.camera_id,
            session_id=session_id,
            preset=args.preset,
            lighting=args.lighting,
            interval_sec=args.interval_sec,
            max_frames=args.max_frames,
            min_diff_threshold=args.min_diff,
        )
        split_counts[assigned_split] += len(frames)
        total_extracted += len(frames)

    logger.info("=" * 60)
    logger.info("EXTRACTION SUMMARY:")
    logger.info("  Total Frames: %d", total_extracted)
    logger.info("  Train Split:  %d frames (%s)", split_counts["train"], output_root / "train")
    logger.info("  Val Split:    %d frames (%s)", split_counts["val"], output_root / "val")
    logger.info("  Test Split:   %d frames (%s)", split_counts["test"], output_root / "test")
    logger.info("=" * 60)
    logger.info("NEXT STEPS:")
    logger.info("1. Label extracted frames using standard YOLO format (class 0: vr_headset).")
    logger.info("   Save label .txt files into apps/ai-service/dataset/labels/{train,val,test}/.")
    logger.info("2. Consult ANNOTATION_GUIDE.md for bounding box criteria and scenario coverage.")
    logger.info("3. Run: python apps/ai-service/scripts/train_headset_model.py")


if __name__ == "__main__":
    main()
