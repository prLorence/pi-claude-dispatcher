#!/bin/sh
# Container smoke test for the pi-monitor image. Run from monitor/.
set -eu

IMAGE=pi-monitor-smoke
NAME=pi-monitor-smoke
PORT=4399
BASE=http://127.0.0.1:4399
SMOKE_DIR=$(pwd)/.smoke
PLANS=$SMOKE_DIR/plans

fail() {
  echo "smoke failed: $1" >&2
  exit 1
}

cleanup() {
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT INT TERM

[ -f package.json ] || fail "run this script from monitor/"

podman build -t "$IMAGE" . || fail "podman build"

cleanup
mkdir -p "$PLANS/traces" "$PLANS/running" "$PLANS/done" "$PLANS/sessions/p1"

cat > "$PLANS/running/p1.md" <<'PLAN'
---
id: p1
trace: p1
round: 1
status: ready
---

## Context

Smoke fixture.

## task: t1
files: x
depends_on: []
pair: review

Body line.
PLAN

cat > "$PLANS/traces/p1.jsonl" <<'TRACE'
{"v":1,"ts":"2026-10-23T00:00:00.000Z","trace":"p1","plan":"p1","actor":"worker","kind":"task.start","task":"t1","attempt":1,"data":{"model":"m","session_id":"p1.t1.a1"}}
TRACE

cat > "$PLANS/sessions/p1/2026-10-23T00-00-00-000Z_p1.t1.a1.jsonl" <<'SESSION'
{"type":"session","version":3,"id":"p1.t1.a1","timestamp":"2026-10-23T00:00:00.000Z","cwd":"/plans"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-10-23T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"smoke reply"}],"stopReason":"stop","usage":{"input":10,"output":5,"cost":{"total":0.001}}}}
SESSION

chmod -R a+rX "$PLANS"

podman run -d --rm --name "$NAME" \
  -p "127.0.0.1:$PORT:4317" \
  -v "$PLANS:/plans:ro" \
  "$IMAGE" || fail "podman run"

i=0
while [ "$i" -lt 30 ]; do
  if curl -fs "$BASE/api/state" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 30 ] || fail "server did not answer on $BASE within 30 s"

state=$(curl -fs "$BASE/api/state") || fail "GET /api/state"
printf '%s' "$state" | grep -q '"p1"' || fail "/api/state does not contain the plan id"

html=$(curl -fs "$BASE/") || fail "GET /"
printf '%s' "$html" | grep -q 'Pi monitor' || fail "/ does not serve the monitor HTML"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/state") || fail "POST /api/state"
[ "$code" = "405" ] || fail "POST /api/state returned $code, expected 405"

code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$BASE/api/state") || fail "evil Host"
[ "$code" = "403" ] || fail "foreign Host returned $code, expected 403"

if podman exec -u 0 "$NAME" sh -c 'touch /plans/x' >/dev/null 2>&1; then
  fail "the /plans mount is writable"
fi

echo "smoke ok"
