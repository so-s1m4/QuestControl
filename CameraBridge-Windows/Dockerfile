# Headless API + RTSP engine. No VLC, no desktop GUI.
# syntax=docker/dockerfile:1

FROM golang:1.23-bookworm AS engine
WORKDIR /src
COPY vendor/tuya-ipc-terminal/go.mod vendor/tuya-ipc-terminal/go.sum ./
RUN go mod download
COPY vendor/tuya-ipc-terminal/ ./
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/tuya-ipc-terminal .

FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin bridge

WORKDIR /app
COPY requirements-docker.txt /app/requirements-docker.txt
RUN pip install --no-cache-dir -r /app/requirements-docker.txt

COPY src /app/src
COPY web /app/web
COPY --from=engine /out/tuya-ipc-terminal /app/bin/tuya-ipc-terminal
RUN chmod 755 /app/bin/tuya-ipc-terminal \
    && mkdir -p /data/tuya-rtsp-bridge /config/tuya-rtsp-bridge \
    && chown -R bridge:bridge /app /data /config

ENV TUYA_BRIDGE_ROOT=/app \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config \
    PATH="/app/bin:${PATH}"

USER bridge
EXPOSE 8787 8554
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/state', timeout=3)"

WORKDIR /data/tuya-rtsp-bridge
CMD ["python", "-u", "/app/src/server.py"]
