#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_ROOT=/opt/quest-control-room-agent
RELEASES_DIR=${INSTALL_ROOT}/releases
CURRENT_LINK=${INSTALL_ROOT}/current
CONFIG_FILE=/etc/quest-control/room-agent.env
SERVICE_FILE=/etc/systemd/system/quest-room-agent.service
SERVICE_BACKUP=/etc/systemd/system/quest-room-agent.service.before-auto-update

[[ ${EUID} -eq 0 ]] || { echo "Run with sudo"; exit 1; }
[[ -r ${CONFIG_FILE} ]] || { echo "Missing ${CONFIG_FILE}"; exit 1; }
for file in update-room-agent.sh quest-room-agent.service quest-room-agent-update.service quest-room-agent-update.timer; do
  [[ -r ${SOURCE_DIR}/${file} ]] || { echo "Missing ${file}"; exit 1; }
done

id quest-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/quest-control-agent --create-home --shell /usr/sbin/nologin quest-agent
usermod -a -G audio quest-agent
install -d -m 0755 "${INSTALL_ROOT}" "${RELEASES_DIR}" /var/lib/quest-control-agent

if [[ ! -L ${CURRENT_LINK} ]]; then
  [[ -r ${INSTALL_ROOT}/package.json && -r ${INSTALL_ROOT}/src/index.js ]] || { echo "Legacy room-agent installation not found"; exit 1; }
  LEGACY_VERSION=$(node -p "require('${INSTALL_ROOT}/package.json').version")
  [[ ${LEGACY_VERSION} =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || LEGACY_VERSION=legacy-$(date +%Y%m%d%H%M%S)
  LEGACY_RELEASE=${RELEASES_DIR}/${LEGACY_VERSION}
  if [[ ! -d ${LEGACY_RELEASE} ]]; then
    install -d -m 0755 "${LEGACY_RELEASE}"
    cp -a "${INSTALL_ROOT}/package.json" "${INSTALL_ROOT}/package-lock.json" "${INSTALL_ROOT}/src" "${LEGACY_RELEASE}/"
    [[ ! -d ${INSTALL_ROOT}/node_modules ]] || cp -a "${INSTALL_ROOT}/node_modules" "${LEGACY_RELEASE}/node_modules"
  fi
  ln -sfn "${LEGACY_RELEASE}" "${CURRENT_LINK}"
fi

[[ ! -f ${SERVICE_FILE} || -f ${SERVICE_BACKUP} ]] || cp -a "${SERVICE_FILE}" "${SERVICE_BACKUP}"
install -m 0755 "${SOURCE_DIR}/update-room-agent.sh" /usr/local/sbin/quest-room-agent-update
install -m 0644 "${SOURCE_DIR}/quest-room-agent.service" "${SERVICE_FILE}"
install -m 0644 "${SOURCE_DIR}/quest-room-agent-update.service" /etc/systemd/system/quest-room-agent-update.service
install -m 0644 "${SOURCE_DIR}/quest-room-agent-update.timer" /etc/systemd/system/quest-room-agent-update.timer

systemctl daemon-reload
systemctl restart quest-room-agent.service
for _ in {1..15}; do
  sleep 1
  if systemctl is-active --quiet quest-room-agent.service && journalctl -u quest-room-agent.service --since '-20 seconds' --no-pager | grep -q 'Connected to QuestControl'; then
    systemctl enable --now quest-room-agent-update.timer
    systemctl start quest-room-agent-update.service
    systemctl is-active --quiet quest-room-agent.service
    systemctl is-active --quiet quest-room-agent-update.timer
    echo "Automatic room-agent updates are active"
    exit 0
  fi
done

echo "Migrated service failed health-check; restoring previous unit" >&2
if [[ -f ${SERVICE_BACKUP} ]]; then
  cp -a "${SERVICE_BACKUP}" "${SERVICE_FILE}"
  systemctl daemon-reload
  systemctl restart quest-room-agent.service
fi
exit 1
