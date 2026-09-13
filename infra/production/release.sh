#!/usr/bin/env bash
# Pull, back up, rebuild only the application, then verify the new release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
C=(docker compose --env-file infra/production/.env -f infra/production/compose.yml)
BEFORE=$(git rev-parse --short HEAD)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked changes present; preserve them before releasing." >&2
  exit 1
fi
git pull --ff-only
echo "== $BEFORE -> $(git rev-parse --short HEAD)"
"$ROOT/infra/production/backup.sh"
"${C[@]}" config --quiet
# Keep the previously running images available for rollback; never prune them here.
for service in appview web; do
  container=$("${C[@]}" ps -q "$service")
  if [ -n "$container" ]; then
    image=$(docker inspect --format '{{.Image}}' "$container")
    docker tag "$image" "freeschool-$service:rollback-$BEFORE"
  fi
done
"${C[@]}" build appview web
"${C[@]}" up -d --no-deps appview web
HOST=$(sed -n 's/^WEB_HOST=//p' infra/production/.env)
echo "== waiting for health"
for attempt in {1..30}; do
  if curl -fsS -m 10 "https://$HOST/api/health" | python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h.get("status")=="ok" and h.get("school") is True and all(v=="ok" for v in h.get("checks",{}).values()) else 1)' 2>/dev/null; then
    echo "== released $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 5
done
echo "Release health check failed; retained rollback images are tagged rollback-$BEFORE." >&2
exit 1
