# QuestControl VR Headset Dataset Specification

## 1. Directory Structure
```
dataset/
├── dataset.yaml
├── images/
│   ├── train/    # Training frames from cameras
│   ├── val/      # Validation frames from separate camera sessions
│   └── test/     # Test frames from independent sessions/angles
└── labels/
    ├── train/    # YOLO annotations (.txt matching image names)
    ├── val/
    └── test/
```

## 2. Data Collection & Annotation Requirements
1. **Camera Modes & Lighting**:
   - Day / ambient room lighting.
   - Infrared (IR) night-vision monochrome mode (Tuya camera night mode).
2. **Preset Angles**:
   - Wide view, left_room preset, right_room preset, entrance, table close-up.
3. **Physical Layout Scenarios**:
   - Charging dock on the right table with multiple docked headsets (partial edge overlap, cables).
   - Floor square mats (`zone_1`, `zone_2`, `zone_3`) with headsets in center and near edges.
   - Walkway / open floor with headsets dropped outside designated zones.
   - Diverse orientations: visor face-up, face-down, on its side, strap visible/collapsed.
   - Occlusions: people walking past, partial furniture occlusion.
4. **Annotation Format**:
   - Class ID: `0` (`vr_headset`)
   - YOLO normalized coordinates: `<class_id> <x_center> <y_center> <width> <height>` (values in `[0.0, 1.0]`).

## 3. Leakage Prevention Rules
- Frames must follow session-based naming: `cam<ID>_sess<SESSION_ID>_f<FRAME_INDEX>.jpg`.
- All frames belonging to a single recording session (`cam<ID>_sess<SESSION_ID>`) must reside in either `train`, `val`, or `test`.
- Adjacent frames from the same video clip must **never** be split across train and val/test.
- Dedicated end-to-end smoke test evaluation frames must be kept outside `train`, `val`, and `test` to serve as a pure blind evaluation.
