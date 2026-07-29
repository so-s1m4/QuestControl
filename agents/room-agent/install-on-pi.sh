#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Запустите установщик через sudo: sudo ./install-on-pi.sh"
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/quest-control-room-agent"
CONFIG_DIR="/etc/quest-control"
CONFIG_FILE="${CONFIG_DIR}/room-agent.env"
SERVICE_FILE="/etc/systemd/system/quest-room-agent.service"
BACKUP_DIR="/var/backups/quest-control-agent"

prompt() {
  local variable_name="$1" label="$2" default_value="${3:-}" secret="${4:-false}" value
  if [[ -n "${!variable_name:-}" ]]; then return; fi
  if [[ "${secret}" == "true" ]]; then
    read -r -s -p "${label}: " value
    echo
  else
    read -r -p "${label}${default_value:+ [${default_value}]}: " value
  fi
  printf -v "${variable_name}" '%s' "${value:-${default_value}}"
}

if [[ -f "${CONFIG_FILE}" ]]; then
  echo "Найдена существующая конфигурация ${CONFIG_FILE}."
  read -r -p "Сохранить её без изменений? [Y/n]: " KEEP_CONFIG
  KEEP_CONFIG="${KEEP_CONFIG:-Y}"
else
  KEEP_CONFIG="n"
fi

if [[ ! "${KEEP_CONFIG}" =~ ^[Yy]$ ]]; then
  prompt VPS_URL "Публичный URL QuestControl (например https://crm.example.com)"
  prompt AGENT_ID "Agent ID" "krampus-poelten"
  prompt AGENT_TOKEN "Одноразовый agent token" "" true
  prompt ROOM_ID "UUID комнаты Krampus"
  prompt LOCAL_ORIGINS "Origin локального Krampus API" "http://127.0.0.1:3000"
  prompt COMMAND_API "Базовый URL локального command API" "http://127.0.0.1:3000/api"
  prompt AUDIO_PLAYER "Аудиоплеер (ffplay или mpv)" "ffplay"
  prompt AUDIO_DEVICE "ALSA/mpv audio device; пусто = default" ""

  [[ "${ROOM_ID}" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "ROOM_ID должен быть UUID."; exit 1; }
  [[ "${AUDIO_PLAYER}" == "ffplay" || "${AUDIO_PLAYER}" == "mpv" ]] || { echo "AUDIO_PLAYER: только ffplay или mpv."; exit 1; }
  for value in "${VPS_URL}" "${AGENT_ID}" "${AGENT_TOKEN}" "${ROOM_ID}" "${LOCAL_ORIGINS}" "${COMMAND_API}" "${AUDIO_DEVICE}"; do
    [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] || { echo "Переносы строк в конфигурации запрещены."; exit 1; }
  done
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl ffmpeg alsa-utils
if [[ "${AUDIO_PLAYER:-ffplay}" == "mpv" ]]; then apt-get install -y mpv; fi

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR="$(node -p 'process.versions.node.split(`.`)[0]')"; fi
if (( NODE_MAJOR < 20 )); then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

id quest-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/quest-control-agent --create-home --shell /usr/sbin/nologin quest-agent
usermod -a -G audio quest-agent
install -d -m 0755 "${INSTALL_DIR}" "${CONFIG_DIR}" "${BACKUP_DIR}"

if [[ -f "${CONFIG_FILE}" ]]; then
  cp -a "${CONFIG_FILE}" "${BACKUP_DIR}/room-agent.env.$(date +%Y%m%d-%H%M%S)"
fi

install -m 0644 "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/package-lock.json" "${INSTALL_DIR}/"
install -d -m 0755 "${INSTALL_DIR}/src"
install -m 0644 "${SOURCE_DIR}/src/index.js" "${INSTALL_DIR}/src/index.js"
cd "${INSTALL_DIR}"
npm ci --omit=dev

if [[ ! "${KEEP_CONFIG}" =~ ^[Yy]$ ]]; then
  umask 077
  {
    printf 'VPS_URL=%s\n' "${VPS_URL}"
    printf 'AGENT_ID=%s\n' "${AGENT_ID}"
    printf 'AGENT_TOKEN=%s\n' "${AGENT_TOKEN}"
    printf 'ROOM_ID=%s\n' "${ROOM_ID}"
    printf 'LOCAL_ORIGINS=%s\n' "${LOCAL_ORIGINS}"
    printf 'ALLOWED_COMMANDS=status,start_game,pause_game,reset_room,send_hint,add_time,end_game\n'
    printf 'COMMAND_API=%s\n' "${COMMAND_API}"
    printf 'HEARTBEAT_MS=15000\nREQUEST_TIMEOUT_MS=5000\n'
    printf 'AUDIO_PLAYER=%s\n' "${AUDIO_PLAYER}"
    printf 'AUDIO_DEVICE=%s\n' "${AUDIO_DEVICE}"
  } > "${CONFIG_FILE}"
fi
chown root:root "${CONFIG_FILE}"
chmod 0600 "${CONFIG_FILE}"

install -m 0644 "${SOURCE_DIR}/quest-room-agent.service" "${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable --now quest-room-agent
sleep 2
systemctl --no-pager --full status quest-room-agent || {
  echo
  echo "Agent не запустился. Последние сообщения:"
  journalctl -u quest-room-agent -n 50 --no-pager
  exit 1
}

echo
echo "QuestControl Room Agent установлен."
echo "Логи: sudo journalctl -u quest-room-agent -f"
echo "Проверка звука: sudo -u quest-agent aplay /usr/share/sounds/alsa/Front_Center.wav"
