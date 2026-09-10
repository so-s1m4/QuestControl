#!/bin/sh
set -e

# Restore baked base YOLO model if volume mount masked it
if [ ! -f /app/models/yolo11n.pt ] && [ -f /opt/models/base/yolo11n.pt ]; then
  echo "[ai-service] Restoring baked base yolo11n.pt model to /app/models/yolo11n.pt..."
  cp /opt/models/base/yolo11n.pt /app/models/yolo11n.pt
fi

if [ ! -f /app/models/yolov8s-worldv2.pt ] && [ -f /opt/models/base/yolov8s-worldv2.pt ]; then
  echo "[ai-service] Restoring baked YOLO-World model to /app/models/yolov8s-worldv2.pt..."
  cp /opt/models/base/yolov8s-worldv2.pt /app/models/yolov8s-worldv2.pt
fi

exec "$@"
