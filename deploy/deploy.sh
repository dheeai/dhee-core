#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${1:-}"
IMAGE_URI="${2:-}"
TARGET_ENV_FILE="${3:-}"

if [[ -z "${SERVICE_NAME}" || -z "${IMAGE_URI}" || -z "${TARGET_ENV_FILE}" ]]; then
  echo "Usage: ./deploy.sh <service-name> <image-uri> <target-env-file>" >&2
  exit 1
fi

if [[ "${SERVICE_NAME}" != "dhee-core-prod" && "${SERVICE_NAME}" != "dhee-core-dev" ]]; then
  echo "Unsupported service name: ${SERVICE_NAME}" >&2
  exit 1
fi

if [[ ! -f "${TARGET_ENV_FILE}" ]]; then
  echo "Missing env file: ${TARGET_ENV_FILE}" >&2
  exit 1
fi

if [[ ! -f ".env.prod" || ! -f ".env.dev" ]]; then
  echo "Both .env.prod and .env.dev must exist before deploying." >&2
  exit 1
fi

if [[ "${SERVICE_NAME}" == "dhee-core-prod" ]]; then
  export PROD_IMAGE="${IMAGE_URI}"
else
  export DEV_IMAGE="${IMAGE_URI}"
fi

# Pull and restart only the target app service to avoid forcing the sibling branch service.
# --force-recreate: env_file (.env.dev / .env.prod) is only applied on container create; without this,
# redeploys that reuse the same image tag (e.g. re-run workflow, same SHA) would leave stale env.
docker compose -f docker-compose.yml pull "${SERVICE_NAME}"
docker compose -f docker-compose.yml up -d --no-deps --force-recreate "${SERVICE_NAME}"

# Ensure reverse proxy is running even on first boot.
docker compose -f docker-compose.yml up -d nginx
docker compose -f docker-compose.yml ps
