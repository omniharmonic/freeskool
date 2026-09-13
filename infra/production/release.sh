#!/usr/bin/env bash
# Release whatever commit /opt/freeskool is on: pull, back up, rebuild images, restart, check health.
# Postgres and the PDS keep running; only appview + web are rebuilt and recreated.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
C="docker compose --env-file infra/production/.env -f infra/production/compose.yml"
BEFORE=$(git rev-parse --short HEAD)
git pull --ff-only
echo "== $BEFORE -> $(git rev-parse --short HEAD)"
"$ROOT/infra/production/backup.sh"
$C config --quiet
$C build appview web
$C up -d
echo "== waiting for health"
n=0
until curl -fsS -m 10 "https://${WEB_HOST:-$(grep '^WEB_HOST=' infra/production/.env | cut -d= -f2)}/api/health" >/dev/null 2>&1 || [ $n -ge 30 ]; do n=$((n+1)); sleep 5; done
curl -sS -m 10 "https://$(grep '^WEB_HOST=' infra/production/.env | cut -d= -f2)/api/health"; echo
docker image prune -f >/dev/null
echo "== released $(git rev-parse --short HEAD)"
