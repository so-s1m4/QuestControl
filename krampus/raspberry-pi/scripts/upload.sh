#!/usr/bin/env bash
set -euo pipefail

# This script runs on your MacBook.
# It copies a local .ino file to the Raspberry Pi and triggers compile+upload on the Pi.
# Connection must work via: `ssh pi`

SSH_HOST="pi"
PI_USER="escapers"
REMOTE_BASE="/home/${PI_USER}/uploads"

usage() {
  echo 'Usage: ./upload.sh --path "/absolute/path/to/sketch.ino" [--port "/dev/ttyACM0"]'
}

PATH_INO=""
PORT="/dev/ttyACM0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) PATH_INO="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 2;;
  esac
done

if [[ -z "${PATH_INO}" ]]; then
  echo "ERROR: --path is required"
  usage
  exit 2
fi

if [[ ! -f "${PATH_INO}" ]]; then
  echo "ERROR: File not found: ${PATH_INO}"
  exit 2
fi

if [[ "${PATH_INO}" != *.ino ]]; then
  echo "ERROR: --path must point to an Arduino .ino sketch, not: ${PATH_INO}"
  exit 2
fi

if [[ ! "${PORT}" =~ ^/dev/[A-Za-z0-9._/-]+$ ]] || [[ "${PORT}" == *".."* ]]; then
  echo "ERROR: Invalid serial port: ${PORT}"
  exit 2
fi

# Arduino requires sketch folder name == .ino name
BASENAME="$(basename "${PATH_INO}")"          # foo.ino
NAME="${BASENAME%.ino}"                       # foo

REMOTE_DIR="${REMOTE_BASE}/${NAME}"

echo "[upload] Preparing remote dir: ${REMOTE_DIR}"
ssh "${PI_USER}@${SSH_HOST}" "mkdir -p '${REMOTE_DIR}'"

echo "[upload] Copying ${PATH_INO} -> ${SSH_HOST}:${REMOTE_DIR}/${NAME}.ino"
scp "${PATH_INO}" "${PI_USER}@${SSH_HOST}:${REMOTE_DIR}/${NAME}.ino"

echo "[upload] Building + uploading on Pi (port: ${PORT})..."
ssh "${PI_USER}@${SSH_HOST}" "/home/${PI_USER}/pi_upload.sh --sketchdir '${REMOTE_DIR}' --port '${PORT}'"

echo "[upload] ✅ Done."
