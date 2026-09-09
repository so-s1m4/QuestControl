# Model Weights Licensing & Attribution

## Base Model Attribution
- **Architecture**: YOLO11-nano (`yolo11n.pt`)
- **Author / Upstream**: Ultralytics Inc. (<https://github.com/ultralytics/ultralytics>)
- **Upstream License**: GNU Affero General Public License v3.0 (AGPL-3.0)

## Derivative Model
- **Model Name**: `vr_headset_yolo.pt`
- **Domain**: VR Headset Detection for QuestControl CRM
- **Target Class**: `0: vr_headset`
- **Training Pipeline**: `apps/ai-service/scripts/train_headset_model.py`
- **Validation Pipeline**: `apps/ai-service/scripts/validate_headset_model.py`

## Compliance Statement
In accordance with the requirements of the GNU Affero General Public License v3.0:
1. All training scripts, validation suites, and network interface code for this service are provided in this repository under AGPL-3.0.
2. The model weights are designated for internal on-premises CRM operation.
3. Upstream copyright notices and licenses are preserved.
