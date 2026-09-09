# QuestControl VR Headset: Frame Extraction & Annotation Protocol

> [!IMPORTANT]
> **Production AI Status**:
> The service is currently in the fail-safe **`MODEL_UNAVAILABLE`** state.
> The service **strictly refuses** synthetic drawings, untrained YOLO heads, or unverified weights.
> Genuine **`READY`** status requires real annotated camera frames, training on the real dataset, and validation passing all quality gates on an independent `--split test`.

---

## 1. Frame Quantity & Scenario Requirements

To achieve reliable generalization across day and IR night-vision modes without false positives or missed detections, the minimum recommended dataset comprises **350–500 real camera frames** distributed across independent recording sessions.

### Dataset Split Distribution (Strictly Grouped by Video Session)

| Split | Target Percentage | Target Frame Count | Purpose | Leakage Rule |
| :--- | :---: | :---: | :--- | :--- |
| **Train** (`train/`) | **70%** | **250 – 350** | Supervised YOLO fine-tuning | Never share sessions with `val` or `test` |
| **Validation** (`val/`) | **15%** | **50 – 75** | Hyperparameter & early-stopping check | Never share sessions with `train` or `test` |
| **Production Test** (`test/`) | **15%** | **50 – 75** | Independent Quality Gate ($mAP_{50} \ge 0.85$) | Strictly independent camera sessions |

### Scenario Coverage Matrix

| Scenario Category | Minimum Frames | Specific Requirements |
| :--- | :---: | :--- |
| **1. Charging Table / Base** | 80 – 120 | 2 to 6 headsets docked side-by-side on the table, power cables plugged in, partial boundary overlaps between visors. |
| **2. Floor Mats (Zones 1–3)** | 120 – 160 | Single and multiple headsets resting inside black floor square mats; visor face-up, face-down, on its side, strap visible/slack. |
| **3. Outside Zones (Floor/Hallway)** | 60 – 90 | Headsets placed or dropped on open room floor, carpet, near doorways, under table legs. |
| **4. Infrared (IR) Night Mode** | 100 – 140 | Monochrome night-vision stream from Tuya cameras with IR illuminators active (different contrast and specular highlights on visor glass). |
| **5. Partial Occlusions** | 40 – 60 | Operator/guest walking past or standing near headset, hands reaching for headset, cable dangling across front plate. |
| **6. Negative Samples (Background)** | 30 – 50 | Empty room, empty charging table, empty floor mats, visitors without headsets, bags/controllers (prevents false-positive detections). Empty `.txt` label file for each negative frame. |

---

## 2. Automated Frame Extraction Tool

Use `apps/ai-service/scripts/extract_dataset_frames.py` to extract non-redundant frames from video recordings or live RTSP streams.

### Option A: Extract from a Folder of Video Recordings
Place camera MP4/MKV video files into a staging folder (e.g., `~/Desktop/vr_recordings/`):
```bash
python3 apps/ai-service/scripts/extract_dataset_frames.py \
  --source ~/Desktop/vr_recordings/ \
  --output-dir apps/ai-service/dataset/images \
  --split auto \
  --camera-id cam_main \
  --interval-sec 2.0 \
  --max-frames 60 \
  --min-diff 0.02
```

### Option B: Capture from a Live Camera Stream (RTSP / HTTP)
```bash
# Capture 50 frames from table preset in day mode
python3 apps/ai-service/scripts/extract_dataset_frames.py \
  --source "rtsp://admin:password@192.168.1.100:554/live/ch0" \
  --output-dir apps/ai-service/dataset/images \
  --split train \
  --camera-id cam01 \
  --session-id sess_table_day \
  --preset table \
  --lighting day \
  --interval-sec 3.0 \
  --max-frames 50

# Capture 50 frames from floor preset in IR mode
python3 apps/ai-service/scripts/extract_dataset_frames.py \
  --source "rtsp://admin:password@192.168.1.100:554/live/ch0" \
  --output-dir apps/ai-service/dataset/images \
  --split train \
  --camera-id cam01 \
  --session-id sess_floor_ir \
  --preset floor \
  --lighting ir \
  --interval-sec 3.0 \
  --max-frames 50
```

### Session Naming Convention
Extracted frames are automatically named:
`{camera_id}_{session_id}_{preset}_{lighting}_f{index:04d}.jpg`
*(e.g., `cam01_sess01_table_day_f0001.jpg`)*.

---

## 3. Annotation Guidelines

### Recommended Annotation Tools
- **CVAT (Computer Vision Annotation Tool)**: [cvat.ai](https://www.cvat.ai) (Export: `YOLO 1.1`).
- **Label Studio**: Local open-source (`pip install label-studio`).
- **Roboflow**: (Offline or Cloud export in `YOLOv8/YOLO11` format).

### Labeling Rules
1. **Single Class**:
   - `0`: `vr_headset`
2. **Bounding Box Scope**:
   - Include the **entire headset body**: the front visor, facial interface padding, and rigid strap mount.
   - For soft fabric headstraps: include the strap if taut, but prioritize tightly boxing the rigid visor and side arms.
   - For closely docked headsets on the charging table: draw **separate distinct bounding boxes** for each individual headset, even if they touch.
3. **Negative Samples**:
   - Create an empty `.txt` file for frames where no VR headset is present (e.g. `cam01_sess99_empty_f0001.txt` with 0 bytes).

### Target File Placement
Images and matching text label files must be placed side-by-side in matching folders:
```
apps/ai-service/dataset/
├── dataset.yaml
├── images/
│   ├── train/ (e.g. cam01_sess01_table_day_f0001.jpg)
│   ├── val/   (e.g. cam01_sess05_table_ir_f0001.jpg)
│   └── test/  (e.g. cam02_sess01_center_day_f0001.jpg)
└── labels/
    ├── train/ (e.g. cam01_sess01_table_day_f0001.txt)
    ├── val/   (e.g. cam01_sess05_table_ir_f0001.txt)
    └── test/  (e.g. cam02_sess01_center_day_f0001.txt)
```

---

## 4. Model Training & Quality Gate Verification

Once annotations are saved:

### Step 1: Run Training Pipeline
```bash
python3 apps/ai-service/scripts/train_headset_model.py \
  --epochs 50 \
  --batch 8 \
  --imgsz 640
```
This automatically:
- Checks camera-session split isolation.
- Fine-tunes YOLO11n on local device.
- Exports `models/vr_headset_yolo.pt`.
- Computes SHA-256 and initial training metadata.

### Step 2: Run Production Quality Gate Validation
```bash
python3 apps/ai-service/scripts/validate_headset_model.py \
  --split test \
  --min-map 0.85 \
  --min-precision 0.80 \
  --min-recall 0.80
```
This evaluates the model on the independent `test` split, computes the `datasetManifestHash`, and updates `model_metadata.json`.

### Step 3: Run Provisioning Verification
```bash
python3 apps/ai-service/scripts/provision_headset_model.py
```
When all gates pass, `HEADSET_MODEL_STATUS` transitions to **`READY`**, activating real-time tracking in API and UI.
