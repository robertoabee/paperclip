#!/usr/bin/env bash
set -euo pipefail
image=${1:?Supply the locally built test image}
name="paperclip-ci-${RANDOM}-$$"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# No host mounts, named volumes, published ports, external network or secrets.
docker run -d --name "$name" --network none \
  --tmpfs /paperclip:rw,exec,uid=1000,gid=1000,size=1g \
  -e HOST=127.0.0.1 \
  -e PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  -e PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  -e PAPERCLIP_ANNOUNCEMENTS_ENABLED=false \
  -e HEARTBEAT_SCHEDULER_ENABLED=false "$image" >/dev/null
probe() {
  for attempt in $(seq 1 120); do
    if docker exec "$name" node --input-type=module -e '
      const h = await fetch("http://127.0.0.1:3100/api/health");
      if (!h.ok) process.exit(1);
      const c = await fetch("http://127.0.0.1:3100/api/companies");
      if (!c.ok || JSON.stringify(await c.json()) !== "[]") process.exit(1);
      const ui = await fetch("http://127.0.0.1:3100/");
      if (!ui.ok || !(await ui.text()).includes("<html")) process.exit(1);
    ' 2>/dev/null; then return 0; fi
    sleep 2
  done
  docker logs --tail 100 "$name"
  return 1
}
probe
docker restart "$name" >/dev/null
probe
docker exec -i "$name" node --input-type=module < "$(dirname "$0")/fork-hermes-runtime-smoke.mjs"
# Confirm the running image is exactly the candidate, rather than a mutable tag.
test "$(docker inspect "$name" --format '{{.Image}}')" = "$(docker image inspect "$image" --format '{{.Id}}')"
printf 'PASS: health, empty companies, UI, restart, image identity; network=none; tmpfs only\n'
