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

# Pre-bake general YOLO model at build time with SHA-256 verification (strictly offline at runtime)
ARG BAKE_GENERAL_YOLO=true
ARG YOLO11N_SHA256="0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1"
RUN set -e; \
    if [ "$BAKE_GENERAL_YOLO" = "true" ]; then \
      curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo11n.pt -o /opt/models/base/yolo11n.pt && \
      echo "${YOLO11N_SHA256}  /opt/models/base/yolo11n.pt" | sha256sum -c - && \
      cp /opt/models/base/yolo11n.pt /app/models/yolo11n.pt; \
    fi

ENV PORT=8088 \
    PYTHONUNBUFFERED=1 \
    YOLO_MODEL=/app/models/yolo11n.pt \
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
