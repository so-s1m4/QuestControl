#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE=/etc/quest-control/room-agent.env
INSTALL_ROOT=/opt/quest-control-room-agent
RELEASES_DIR=${INSTALL_ROOT}/releases
CURRENT_LINK=${INSTALL_ROOT}/current
SERVICE=quest-room-agent.service

[[ ${EUID} -eq 0 ]] || { echo "Run as root"; exit 1; }
[[ -r ${CONFIG_FILE} ]] || { echo "Missing ${CONFIG_FILE}"; exit 1; }
set -a
source "${CONFIG_FILE}"
set +a

UPDATE_BASE=${VPS_URL/wss:/https:}
UPDATE_BASE=${UPDATE_BASE/ws:/http:}
UPDATE_BASE=${UPDATE_BASE%/agent}
TEMP_DIR=$(mktemp -d /tmp/quest-room-agent-update.XXXXXX)
trap 'rm -rf "${TEMP_DIR}"' EXIT

curl -fsS --retry 3 --connect-timeout 10 --max-time 60 \
  -H "x-agent-id: ${AGENT_ID}" -H "authorization: Bearer ${AGENT_TOKEN}" \
  "${UPDATE_BASE}/api/agent-updates/room-agent/latest?channel=stable" -o "${TEMP_DIR}/manifest.json"

VERSION=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).version" "${TEMP_DIR}/manifest.json")
SHA256=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).sha256" "${TEMP_DIR}/manifest.json")
DOWNLOAD_URL=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).downloadUrl" "${TEMP_DIR}/manifest.json")
INSTALLED=$(node -p "try{require('${CURRENT_LINK}/package.json').version}catch{try{require('${INSTALL_ROOT}/package.json').version}catch{''}}")
[[ ${VERSION} =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || { echo "Invalid release version"; exit 1; }
[[ ${SHA256} =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid release checksum"; exit 1; }
[[ ${DOWNLOAD_URL} == /api/agent-updates/room-agent/download ]] || { echo "Invalid download URL"; exit 1; }
[[ ${VERSION} != "${INSTALLED}" ]] || { echo "Room-agent ${VERSION} is current"; exit 0; }

curl -fsS --retry 3 --connect-timeout 10 --max-time 120 \
  -H "x-agent-id: ${AGENT_ID}" -H "authorization: Bearer ${AGENT_TOKEN}" \
  "${UPDATE_BASE}${DOWNLOAD_URL}" -o "${TEMP_DIR}/release.tar.gz"
echo "${SHA256}  ${TEMP_DIR}/release.tar.gz" | sha256sum --check --status

TARGET=${RELEASES_DIR}/${VERSION}
[[ ! -e ${TARGET} ]] || { echo "Release directory already exists: ${TARGET}"; exit 1; }
install -d -m 0755 "${RELEASES_DIR}" "${TARGET}"
tar -xzf "${TEMP_DIR}/release.tar.gz" -C "${TARGET}"
[[ -r ${TARGET}/package.json && -r ${TARGET}/src/index.js && -d ${TARGET}/node_modules ]] || { echo "Incomplete release archive"; exit 1; }
chown -R root:root "${TARGET}"

PREVIOUS=$(readlink -f "${CURRENT_LINK}" 2>/dev/null || true)
ln -sfn "${TARGET}" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
systemctl restart "${SERVICE}"

for _ in {1..15}; do
  sleep 1
  if systemctl is-active --quiet "${SERVICE}" && journalctl -u "${SERVICE}" --since '-20 seconds' --no-pager | grep -q 'Connected to QuestControl'; then
    echo "Updated room-agent ${INSTALLED:-unknown} -> ${VERSION}"
    find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d ! -path "${TARGET}" ! -path "${PREVIOUS}" -mtime +14 -exec rm -rf -- {} +
    exit 0
  fi
done

echo "Health-check failed; rolling back" >&2
if [[ -n ${PREVIOUS} && -d ${PREVIOUS} ]]; then
  ln -sfn "${PREVIOUS}" "${CURRENT_LINK}.next"
  mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
  systemctl restart "${SERVICE}"
fi
exit 1
