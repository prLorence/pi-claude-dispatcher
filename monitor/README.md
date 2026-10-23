# Pi monitor

A read-only local web app that shows one plan of the pi-plan-dispatch flow on one screen. It shows one row per task with the implementer lane and the pair-reviewer lane side by side, plus a live transcript of the selected lane. It never writes to the plans directory and never changes a plan.

Runtime is Bun. The server uses `Bun.serve`, the client is React 19 with TypeScript bundled by `bun build`.

## Run with a container

From the repository root, with the plans directory you want to watch:

```sh
podman build -t pi-monitor monitor
podman run --rm -p 127.0.0.1:4317:4317 -v "$PWD/.plans:/plans:ro" pi-monitor
```

open http://127.0.0.1:4317 . The plans directory is mounted read-only at `/plans`; the container runs as the `bun` user. The image binds `0.0.0.0` inside the container only because the published port is bound to loopback on the host.

The same `Dockerfile` works with `docker build`; it uses no BuildKit-only syntax.

## Run without a container

```sh
cd monitor
bun install
bun run build
bun run start
```

`bun run start` reads `PLANS_DIR` or `--plans` (default `./.plans`), `PORT` or `--port` (default `4317`), `HOST` or `--host` (default `127.0.0.1`) and `STATIC_DIR` or `--static` (default `dist` next to `package.json`). For example:

```sh
bun run start --plans ../.plans --port 4400
```

## What the screen shows

- A header with the plan id, the plan state, the done and total task count, and the gate.
- One row per task in plan order: the task id, the role, a `waits for X` note while a dependency is not done, and a `skipped` badge when the plan is no longer running and the task has no events.
- Two lane cells per row: the implementer on the left and the pair reviewer on the right. A task without `pair:` shows a dash in the reviewer cell.
- A lane cell shows the state badge, the attempt label (`a1`, `a2`, ... for the implementer, `r1`, `r2`, ... for review rounds) with a small switcher when there is more than one attempt, the model, the elapsed time, the tokens, the cost, the last tool line and, for a reviewer, the verdict and the findings count. A failed review is marked with its own badge.
- Below the board, a transcript panel shows the selected attempt's Pi session as a live tail. It follows the newest entry until you scroll up.

A lane is `stalled` when its session file has not changed for 30 seconds while the plan is still running. The server polls the files every 500 ms because a bind mount may not deliver file events, and it pushes a change over Server-Sent Events when the file signature moves.

## Notes

- The monitor is read-only: it serves the plans directory and the sessions, and nothing else.
- Loopback only. The Host header check compares the hostname and accepts only `localhost`, `127.0.0.1` and `[::1]`, so a foreign Host is refused with 403. Any method other than GET or HEAD is refused with 405.
- The mount is read-only, and the server never opens a file for writing.
- The 500 ms poll is deliberate: a bind mount may not report file events, so polling is the reliable signal.
- `sh scripts/smoke.sh` is the container check. It builds the image, starts a container against a temporary fixture under `monitor/.smoke/plans`, checks the state API, the HTML, the 405 and 403 guards and the read-only mount, then removes the fixture and the container.

## Files

- `Dockerfile`: two stages, `build` builds the client, the slim runtime stage serves it.
- `.dockerignore`: keeps `node_modules`, `dist`, `.smoke`, log files and `.git` out of the build context.
- `scripts/smoke.sh`: the container smoke test described above.
- `src/`: the server, the shared types and the client.
- `test/fixture.ts`: helpers that build fake plans trees for the tests.
