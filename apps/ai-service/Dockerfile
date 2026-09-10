FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    gcc \
    g++ \
    libffi-dev \
    libssl-dev \
    libsrtp2-dev \
    libavformat-dev \
    libavcodec-dev \
    libavdevice-dev \
    libavutil-dev \
    libswscale-dev \
    libswresample-dev \
    libavfilter-dev \
    libopus-dev \
    libvpx-dev \
    libgl1 \
    libglib2.0-0 \
    fonts-dejavu-core \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# Ultralytics loads Arial.ttf for its own reports even when plots are disabled.
# Provide a compatible local font so air-gapped training never attempts a download.
RUN mkdir -p /root/.config/Ultralytics && cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /root/.config/Ultralytics/Arial.ttf
# Fail the image build if the exact runtime needed by Tuya WebRTC is absent.
RUN python -c "import aiortc, av; print('aiortc', aiortc.__version__, 'av', av.__version__)"

RUN mkdir -p models /opt/models/base
COPY vlm.py receiver.py server.py model_validator.py entrypoint.sh ./
COPY activity/ ./activity/
COPY models/ ./models/
COPY scripts/ ./scripts/
COPY dataset/ ./dataset/
RUN chmod +x entrypoint.sh

# Pre-bake detector and text-encoder weights. Runtime is strictly offline.
ARG BAKE_GENERAL_YOLO=true
ARG YOLO11N_SHA256="0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1"
ARG YOLO_WORLD_SHA256="9b2c17ab6124a913e9b3a5c170617920d91b0f01111a8479da69f00e2cf27792"
ARG CLIP_VIT_B32_SHA256="40d365715913c9da98579312b702a82c18be219cc2a73407c4526f58eba950af"
RUN set -e; \
    if [ "$BAKE_GENERAL_YOLO" = "true" ]; then \
      curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.pt -o /opt/models/base/yolo11n.pt && \
      echo "${YOLO11N_SHA256}  /opt/models/base/yolo11n.pt" | sha256sum -c - && \
      cp /opt/models/base/yolo11n.pt /app/models/yolo11n.pt && \
      curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 180 https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8s-worldv2.pt -o /opt/models/base/yolov8s-worldv2.pt && \
      echo "${YOLO_WORLD_SHA256}  /opt/models/base/yolov8s-worldv2.pt" | sha256sum -c - && \
      cp /opt/models/base/yolov8s-worldv2.pt /app/models/yolov8s-worldv2.pt && \
      mkdir -p /app/weights/clip && \
      curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 240 https://openaipublic.azureedge.net/clip/models/40d365715913c9da98579312b702a82c18be219cc2a73407c4526f58eba950af/ViT-B-32.pt -o /app/weights/clip/ViT-B-32.pt && \
      echo "${CLIP_VIT_B32_SHA256}  /app/weights/clip/ViT-B-32.pt" | sha256sum -c; \
    fi

ENV PORT=8088 \
    PYTHONUNBUFFERED=1 \
    YOLO_MODEL=/app/models/yolo11n.pt \
    YOLO_WORLD_MODEL=/app/models/yolov8s-worldv2.pt \
    HEADSET_MODEL=/app/models/current/vr_headset_yolo.pt \
    HEADSET_MODEL_METADATA=/app/models/current/model_metadata.json \
    YOLO_OFFLINE=true \
    ULTRALYTICS_OFFLINE=1 \
    ULTRALYTICS_AUTOINSTALL=0

EXPOSE 8088

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8088/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "server.py"]
