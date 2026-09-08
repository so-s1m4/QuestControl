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
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY vlm.py receiver.py server.py ./

ENV PORT=8088 \
    PYTHONUNBUFFERED=1

EXPOSE 8088

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8088/health || exit 1

CMD ["python", "server.py"]
