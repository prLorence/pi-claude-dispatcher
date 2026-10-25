# Pi monitor

A read-only local web app that shows the plans of the pi-plan-dispatch flow for several repos on one screen. It shows one row per task with the implementer lane and the pair-reviewer lane side by side, plus a live transcript of the selected lane. It never writes to the plans directories and never changes a plan.

Runtime is Bun. The server uses `Bun.serve`, the client is React 19 with TypeScript bundled by `bun build`.

## Run with a container

From the repository root, with one plans directory mounted per repo as a subfolder of `/plans`:

```sh
podman build -t pi-monitor monitor
podman run --rm -p 127.0.0.1:4317:4317 \
  -v <repo-a>/.plans:/plans/repo-a:ro \
  -v <repo-b>/.plans:/plans/repo-b:ro \
  pi-monitor
```

open http://127.0.0.1:4317 . The image sets `PLANS_ROOT=/plans`, so every immediate subfolder of `/plans` is one repo, named after the folder.

The single mount still works, because a plans root that itself contains one of `traces`, `running`, `done`, `inbox` or `sessions` is read as one repo:

```sh
podman run --rm -p 127.0.0.1:4317:4317 -v "$PWD/.plans:/plans:ro" pi-monitor
```

The plans directories are mounted read-only; the container runs as the `bun` user. The image binds `0.0.0.0` inside the container only because the published port is bound to loopback on the host.

The same `Dockerfile` works with `docker build`; it uses no BuildKit-only syntax.

## Run without a container

```sh
cd monitor
bun install
bun run build
bun run start
```

`bun run start` reads `PORT` or `--port` (default `4317`), `HOST` or `--host` (default `127.0.0.1`) and `STATIC_DIR` or `--static` (default `dist` next to `package.json`), plus the repo list described below.

## Configuring the repos

The repos come from a configured list; nothing is scanned. Precedence, first match wins:

- `--plans [name=]<path>`, repeated once per repo.
- `PLANS_DIRS`, a path-separator list (`:` on Unix, `;` on Windows) of `[name=]<path>` specs.
- `--plans-root <dir>` or `PLANS_ROOT`, whose immediate subfolders are the repos. This is the container convention above.
- `PLANS_DIR` or `--plans <path>` as one repo (default `./.plans`).

For example:

```sh
bun run start --plans pi-plan-dispatch=../.plans --plans dfph-app=/work/dfph-app/.plans --port 4400
```

Naming and ordering:

- A spec is `[name=]<path>`. The part before the first `=` is a name only when it matches `^[\w.-]+$` and a path follows; otherwise the whole text is a path. An explicit `name=` that does not match means the whole text is a path, not a name.
- The default name of a path is its folder name, or the parent folder's name when the path ends in `.plans`, or its own name for a root subfolder.
- Every default name is sanitised: each character outside `[\w.-]` becomes `-`, and an empty result (a path of `/`, a `.plans` directly under `/`) becomes `repo`.
- Duplicate names get `-2`, `-3`, and so on.
- At most 24 repos. Extra ones are ignored and the screen shows a message such as `N more repos ignored (limit 24)`.
- A folder that does not exist is still a repo, with its own message on the screen; it never stops the others.

Each repo shows its plan in `running/`, else its latest finished plan. Active repos come first, the most recently started on top, then idle repos by last activity, newest first.

## What the screen shows

- Every active repo as a stacked section: a header with the repo name, an `active` marker and the plan header, then its board.
- Every idle repo as a one-line strip with its name, latest plan id, state and gate. Clicking the strip expands it into the same section; clicking again collapses it. Active repos start expanded and idle repos collapsed, and the choice is kept while the page is open.
- A plan header with the plan id, the plan state, the done and total task count, and the gate.
- One row per task in plan order: the task id, the role, a `waits for X` note while a dependency is not done, and a `skipped` badge when the plan is no longer running and the task has no events.
- Two lane cells per row: the implementer on the left and the pair reviewer on the right. A task without `pair:` shows a dash in the reviewer cell.
- A lane cell shows the state badge, the attempt label (`a1`, `a2`, ... for the implementer, `r1`, `r2`, ... for review rounds) with a small switcher when there is more than one attempt, the model, the elapsed time, the tokens, the cost, the last tool line and, for a reviewer, the verdict and the findings count. A failed review is marked with its own badge.
- The decider's suggestion next to what ran. A task whose trace has a `decision.effort` event shows `decider: <suggested> - ran: <level or ->` in its implementer lane, highlighted when the two differ and plain when they match. A plan whose trace has a `decision.audit` event shows `decider audit: <proposal> (<aggregate>)` in its header, with the per-finding values in a tooltip. Nothing is shown for a repo without `decision.*` events, which only `full` repos get, because the decider sends text only from those.
- Below the boards, one shared transcript panel shows the selected attempt's Pi session as a live tail. It follows the newest entry until you scroll up. Selecting a lane in any repo moves the panel to that repo.

A lane is `stalled` when its session file has not changed for 30 seconds while the plan is still running. The server polls every configured repo every 500 ms because a bind mount may not deliver file events, and it pushes a change over Server-Sent Events when any repo's signature moves.

## Notes

- The monitor is read-only: it serves the configured plans directories and the sessions, and nothing else. Only the configured repos are visible.
- Loopback only. The Host header check compares the hostname and accepts only `localhost`, `127.0.0.1` and `[::1]`, so a foreign Host is refused with 403. Any method other than GET or HEAD is refused with 405.
- The mounts are read-only, and the server never opens a file for writing.
- A repo name from the session URL is looked up in the configured names and the path is built from the configured directory, never from the URL. An unknown repo gives 404, and the plan and session ids are checked with `^[\w.-]+$` (400 otherwise).
- The 500 ms poll is deliberate: a bind mount may not report file events, so polling is the reliable signal. The poll cost stays bounded by the 24-repo cap.
- `sh scripts/smoke.sh` is the container check. It builds the image, starts a container against a temporary two-repo fixture under `monitor/.smoke/plans` (`repo-a` and `repo-b`) mounted at `/plans`, checks that the state API lists both repos, that a session route answers 200 and an unknown repo 404, plus the HTML, the 405 and 403 guards and the read-only mount, then removes the fixture and the container. It needs a working podman host share, so it is a manual check.

## Files

- `Dockerfile`: two stages, `build` builds the client, the slim runtime stage serves it with `PLANS_ROOT=/plans`.
- `.dockerignore`: keeps `node_modules`, `dist`, `.smoke`, log files and `.git` out of the build context.
- `scripts/smoke.sh`: the container smoke test described above.
- `src/`: the server, the shared types and the client.
- `test/fixture.ts`: helpers that build fake plans trees for the tests.
