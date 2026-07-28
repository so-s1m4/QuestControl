#!/bin/sh
set -eu

ENV_FILE="${PORTAINER_DEPLOY_ENV:-/etc/quest-control/portainer-deploy.env}"

if [ ! -r "$ENV_FILE" ]; then
  echo "Cannot read $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

if [ -z "${PORTAINER_WEBHOOK_URL:-}" ]; then
  echo "PORTAINER_WEBHOOK_URL is not configured" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --request POST \
  --max-time 60 \
  "$PORTAINER_WEBHOOK_URL"

echo "Portainer redeploy requested."
