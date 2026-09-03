#!/usr/bin/env bash
set -euo pipefail

# This script runs on your MacBook.
# It connects to the Raspberry Pi via `ssh pi` and installs everything needed to
# compile and upload sketches to an Arduino Mega 2560 connected to the Pi via USB.
# It also creates /home/escapers/pi_upload.sh on the Pi.

SSH_HOST="pi"
PI_USER="escapers"

echo "[setup] Connecting to ${SSH_HOST}..."

ssh "${SSH_HOST}" bash -s <<'EOF'
set -euo pipefail

PI_USER="escapers"
HOME_DIR="/home/${PI_USER}"

# Robust download helper (forces IPv4, adds timeouts, and returns non-zero on failure)
fetch() {
  # usage: fetch <url> <output_path>
  local url="$1"
  local out="$2"
  curl -4fL --connect-timeout 3 --max-time 20 -o "$out" "$url"
}

# --- Work around common apt issues on trixie / IPv6-only failures ---
# Force apt to use IPv4 (some networks have broken IPv6 routing)
if [ ! -f /etc/apt/apt.conf.d/99force-ipv4 ]; then
  echo "[setup] Forcing apt to use IPv4..."
  echo 'Acquire::ForceIPv4 "true";' | sudo tee /etc/apt/apt.conf.d/99force-ipv4 >/dev/null
fi

# Temporarily disable repos that often break apt update on trixie.
# We do NOT need these repos for curl/unzip/inotify-tools.
DISABLED_LISTS=()
DISABLED_SOURCES_LIST=""
OS_CODENAME="$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-}")"
if [ "${OS_CODENAME}" = "trixie" ]; then
  # Disable any sources.list.d entries that reference Docker or Raspberry Pi archives.
  for f in /etc/apt/sources.list.d/*.list; do
    [ -f "$f" ] || continue
    if grep -Eq "download\.docker\.com|archive\.raspberrypi\.com" "$f"; then
      echo "[setup] Temporarily disabling $f (not needed for this setup)..."
      sudo mv "$f" "${f}.disabled-by-setup-pi-mega" || true
      DISABLED_LISTS+=("${f}.disabled-by-setup-pi-mega")
    fi
  done

  # Some images put the Raspberry Pi repo in /etc/apt/sources.list (not in sources.list.d)
  if grep -q "archive.raspberrypi.com" /etc/apt/sources.list 2>/dev/null; then
    echo "[setup] Temporarily commenting out archive.raspberrypi.com in /etc/apt/sources.list (not needed for this setup)..."
    DISABLED_SOURCES_LIST="/etc/apt/sources.list.disabled-by-setup-pi-mega"
    sudo cp /etc/apt/sources.list "${DISABLED_SOURCES_LIST}"
    sudo sed -i 's/^\s*deb\s\+\(.*archive\.raspberrypi\.com.*\)$/# disabled-by-setup-pi-mega deb \1/' /etc/apt/sources.list
  fi
fi

restore_disabled_lists() {
  for df in "${DISABLED_LISTS[@]:-}"; do
    orig="${df%.disabled-by-setup-pi-mega}"
    if [ -f "$df" ]; then
      echo "[setup] Restoring $orig"
      sudo mv "$df" "$orig" || true
    fi
  done

  if [ -n "${DISABLED_SOURCES_LIST:-}" ] && [ -f "${DISABLED_SOURCES_LIST}" ]; then
    echo "[setup] Restoring /etc/apt/sources.list"
    sudo cp "${DISABLED_SOURCES_LIST}" /etc/apt/sources.list || true
    sudo rm -f "${DISABLED_SOURCES_LIST}" || true
  fi
}
trap restore_disabled_lists EXIT

echo "[setup] Installing OS packages..."
set +e
sudo apt update
APT_RC=$?
set -e
if [ $APT_RC -ne 0 ]; then
  echo "[setup] apt update failed (rc=${APT_RC}). Showing active sources for debugging:" >&2
  (grep -R "^[^#]" /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true) >&2

  # If deb.debian.org (Fastly) is blocked, switch to a country mirror.
  if grep -R "deb\.debian\.org" -n /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null | grep -qiE "no route to host|unable to connect|failed"; then
    : # (keep for safety; grep above may not match apt output)
  fi

  if ! curl -4fsSL --max-time 3 http://deb.debian.org/debian/ >/dev/null 2>&1; then
    echo "[setup] deb.debian.org seems unreachable from this network. Switching to ftp.at.debian.org mirror..." >&2
    sudo sed -i 's|http://deb\.debian\.org/debian|http://ftp.at.debian.org/debian|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true
    sudo sed -i 's|http://security\.debian\.org/debian-security|http://ftp.at.debian.org/debian-security|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true
  fi

  echo "[setup] Retrying apt update once..." >&2
  sudo apt update
fi
sudo apt install -y curl unzip inotify-tools

# --- Install arduino-cli globally if missing ---
if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "[setup] Installing arduino-cli..."

  # Prefer direct download from Arduino CDN (works even when GitHub is blocked)
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64) CLI_ARCH="Linux_ARM64";;
    armv7l|armv7*) CLI_ARCH="Linux_ARMv7";;
    armv6l|armv6*) CLI_ARCH="Linux_ARMv6";;
    *) echo "[setup] Unsupported arch for arduino-cli: $ARCH"; exit 1;;
  esac

  TMP_TGZ="/tmp/arduino-cli.tgz"
  if fetch "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_${CLI_ARCH}.tar.gz" "$TMP_TGZ"; then
    mkdir -p /tmp/arduino-cli-extract
    tar -xzf "$TMP_TGZ" -C /tmp/arduino-cli-extract
    rm -f "$TMP_TGZ"
    sudo mv /tmp/arduino-cli-extract/arduino-cli /usr/local/bin/arduino-cli
    sudo chmod +x /usr/local/bin/arduino-cli
    rm -rf /tmp/arduino-cli-extract
  else
    echo "[setup] ERROR: Could not download arduino-cli from downloads.arduino.cc" >&2
    echo "[setup] Check Pi outbound network/DNS or firewall. Aborting." >&2
    exit 1
  fi
fi

# Remove any old user-local arduino-cli to avoid confusion
rm -f "${HOME_DIR}/.local/bin/arduino-cli" 2>/dev/null || true

echo "[setup] arduino-cli version:"
arduino-cli version

echo "[setup] Initializing arduino-cli config..."
arduino-cli config init >/dev/null 2>&1 || true
arduino-cli core update-index

echo "[setup] Installing Arduino AVR core..."
arduino-cli core install arduino:avr

echo "[setup] Installing Adafruit PWM Servo Driver Library v1.0.4..."
arduino-cli lib update-index

# Enforce exact version 1.0.4 by installing from a zip (GitHub may be blocked on some networks)
TMP_ZIP="/tmp/adafruit_pwm_servo_driver_1.0.4.zip"
set +e
fetch "https://github.com/adafruit/Adafruit-PWM-Servo-Driver-Library/archive/refs/tags/1.0.4.zip" "${TMP_ZIP}"
DL_RC=$?
if [ $DL_RC -ne 0 ]; then
  # Alternate GitHub endpoint
  fetch "https://codeload.github.com/adafruit/Adafruit-PWM-Servo-Driver-Library/zip/refs/tags/1.0.4" "${TMP_ZIP}"
  DL_RC=$?
fi
set -e

if [ $DL_RC -eq 0 ]; then
  arduino-cli lib install --zip-path "${TMP_ZIP}"
  rm -f "${TMP_ZIP}"
else
  echo "[setup] WARNING: Could not download Adafruit PWM Servo Driver Library v1.0.4 zip (GitHub blocked?)." >&2
  echo "[setup] Trying Library Manager install without forcing the exact version..." >&2
  arduino-cli lib install "Adafruit PWM Servo Driver Library" || true
fi

echo "[setup] Checking installed library version (name line):"
arduino-cli lib list | grep -i "Adafruit PWM Servo Driver" || true

echo "[setup] Adding user to dialout (serial port access)..."
sudo usermod -aG dialout "${PI_USER}" || true

# --- Create Pi-side uploader script ---
PI_UPLOAD="${HOME_DIR}/pi_upload.sh"

cat > "${PI_UPLOAD}" <<'PIEOF'
#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --sketchdir /path/to/sketchdir [--port /dev/ttyACM0]"
}

SKETCHDIR=""
PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sketchdir) SKETCHDIR="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown arg: $1"; usage; exit 2;;
  esac
done

if [[ -z "${SKETCHDIR}" ]]; then
  echo "ERROR: --sketchdir is required"
  usage
  exit 2
fi

if [[ ! -d "${SKETCHDIR}" ]]; then
  echo "ERROR: Sketch directory not found: ${SKETCHDIR}"
  exit 2
fi

if [[ -n "${PORT}" ]] && { [[ ! "${PORT}" =~ ^/dev/[A-Za-z0-9._/-]+$ ]] || [[ "${PORT}" == *".."* ]]; }; then
  echo "ERROR: Invalid serial port: ${PORT}"
  exit 2
fi

# Arduino Mega 2560 FQBN
FQBN="arduino:avr:mega"

# Detect Mega 2560 port if not specified
if [[ -z "${PORT}" ]]; then
  PORT="$(arduino-cli board list 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /mega 2560/ {print $1; exit}')"
fi

# Fallback
if [[ -z "${PORT}" ]]; then
	PORT="/dev/ttyACM0"
fi

echo "[pi_upload] Using PORT=${PORT}"
echo "[pi_upload] Using FQBN=${FQBN}"

# Stop the room server to release the serial port while flashing. Always restore
# it on exit, including compilation or upload failures.
SERVICE_WAS_ACTIVE=0
if systemctl is-active --quiet node-server.service; then
  SERVICE_WAS_ACTIVE=1
fi
restore_node_server() {
  if [[ "${SERVICE_WAS_ACTIVE}" -eq 1 ]]; then
    echo "[pi_upload] Starting node-server.service..."
    sudo systemctl start node-server.service 2>/dev/null || true
  fi
}
trap restore_node_server EXIT

echo "[pi_upload] Stopping node-server.service (if running)..."
sudo systemctl stop node-server.service 2>/dev/null || true
sleep 1

echo "[pi_upload] Compiling ${SKETCHDIR} ..."
arduino-cli compile --fqbn "${FQBN}" "${SKETCHDIR}"

echo "[pi_upload] Uploading..."
arduino-cli upload -p "${PORT}" --fqbn "${FQBN}" "${SKETCHDIR}"

echo "[pi_upload] Done."
PIEOF

chmod +x "${PI_UPLOAD}"

# Allow escapers to control node-server.service without password
sudo mkdir -p /etc/sudoers.d
sudo bash -c 'echo "escapers ALL=(ALL) NOPASSWD: /bin/systemctl stop node-server.service, /bin/systemctl start node-server.service" > /etc/sudoers.d/node-server'
sudo chmod 440 /etc/sudoers.d/node-server

echo "[setup] Created ${PI_UPLOAD}"
echo "[setup] Done. NOTE: dialout group change may require re-login on the Pi for full effect."
EOF

echo "[setup] Completed on Pi."
