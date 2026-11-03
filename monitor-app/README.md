# Pi monitor app

A native macOS app that shows the same board as the Bun monitor in `monitor/`: a master-detail window with a list of repos, plans, tasks and, when enabled, coding-agent sessions on the left, and the selected transcript on the right, with code shown as highlighted blocks. It runs in its own window and Dock icon, with no browser tab, no Bun process and no container to start.

The Go backend is a port of the monitor's server logic. The client is a copy of the monitor's React 19 client; only its data layer differs, plus the two-pane layout, the Settings panel, the Agents list and the code highlighting. `wails build` packages both into one unsigned `.app`.

The Bun monitor in `monitor/` is not changed or replaced: it keeps working exactly as before. The app is the Mac view of the same read-only data.

## Prerequisites

- Go 1.26.
- The Xcode command-line tools, for the macOS toolchain: `xcode-select --install`.
- Bun, for the client build and its tests.
- The Wails v2 CLI, installed once by hand, because `wails` is a build tool and not a module dependency:

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

Make sure the Go bin folder (print it with `go env GOPATH`, then append `/bin`) is on `PATH`. `wails doctor` reports what else is missing.

## Develop

From `monitor-app/`:

```sh
wails dev
```

This runs the client install (`bun install`) and build (`bun run build`) through `wails.json`, starts the Go side and opens a window with live reload. The window title is "Pi monitor".

## The window

The window is two panes. The left one is about 340 px wide and scrolls on its own: per repo a header, then its plan with one compact row per task and a state chip for each implementer and reviewer attempt, then an Agents group when the Agents list has sessions for that repo. An idle repo starts collapsed, an active one starts expanded, and a click toggles it. The right pane takes the rest of the width and scrolls on its own: a header line for the selected task or session (model, thinking level, tokens, cost and state, plus the working folder for a session), then the transcript with its auto-follow and its "No output yet" and error states. With nothing selected it says what to click. Below a window width of 900 px the panes stack, the list on top.

The header holds the title, the Settings control and the repo controls. The Settings panel repeats the added repos with Add and Remove.

## Agent sessions

The Settings panel has two toggles, "omp sessions" and "Pi sessions", and a scope choice, "Added repos only" or "All sessions". Both toggles default to off and the scope defaults to Added repos only, so the app reads no agent folder until the user turns one on. A save takes effect on the next `change` event, which the app emits immediately. The settings are saved at `~/.config/pi-monitor/settings.json` with mode 0600, readable by the user only; a folder the app has to create for it is mode 0700, and a missing or damaged file reads as the defaults.

With a toggle on, the app reads only `.jsonl` files directly inside the first-level session folders of `~/.omp/agent/sessions` and `~/.pi/agent/sessions`: never a deeper folder, never a symlink whose real path leaves the root, and never a file over 64 MB. The read is read-only: the app writes nothing into either agent folder and never logs session text. A session is named by its first line, which holds its working folder. In the default Added repos only scope it is listed only when that folder is an added repo's root or inside it, and a session outside every added repo is opened for that first line only and never shown. All sessions lists every session, under its matching repo when one matches and otherwise under the last two parts of its working folder, in an "Other sessions" section. Each repo's Agents group shows at most 50 sessions per agent, newest first for each agent, with a badge for `omp` or `pi`, the title, the model, a live marker, the cost and the time since the last change. Opening one shows its transcript in the right pane.

## Test

The Go packages are plain standard-library code with no Wails import, so they test and build without the Wails CLI:

```sh
cd monitor-app
go test ./...
go vet ./...
gofmt -l .        # prints nothing when the code is formatted
go build ./...    # compiles the shell; the CLI is only needed to bundle the app
```

The client tests run with Bun, with the Go bindings mocked:

```sh
cd monitor-app/frontend
bun install
bun test
```

The parity test rebuilds the fixture trees from `testdata/manifest.json` and compares the Go state and session pages with the committed golden JSON:

```sh
cd monitor-app
go test ./parity/
```

## Build

From `monitor-app/`:

```sh
wails build
```

The app lands at `build/bin/pi-monitor.app` (the folder and the name come from `wails.json`, and `build/bin` is gitignored). The build is unsigned and targets the host architecture, macOS arm64 on this machine.

`wails build` also regenerates the bindings under `frontend/wailsjs` from the Go binding surface and runs the frontend install (`bun install`) before the build. `frontend/package.json.md5` records the dependency state of the last install; the new `highlight.js` dependency left it stale, so `wails build`, or `bun install` in `frontend/`, refreshes it.

The first launch of an unsigned app is blocked by Gatekeeper. In Finder, right-click the app and choose Open, then confirm. Later launches work normally. Copying the app to another Mac repeats this first-launch step.

## Configuring the repos

The repos come from one of two sources, and flags win.

`--plans [name=]<path>` flags are repeated once per repo and are not saved:

```sh
./build/bin/pi-monitor.app/Contents/MacOS/pi-monitor \
  --plans pi-plan-dispatch=../.plans \
  --plans dfph-app=../dfph-app/.plans
```

The naming and ordering rules are the Bun monitor's: the part before the first `=` is a name only when it matches `^[\w.-]+$` and a path follows; a default name is the folder name, or the parent folder's name for a path ending in `.plans`; every default name is sanitised; duplicates get `-2`, `-3`. At most 24 repos; extra ones are ignored with the message `N more repos ignored (limit 24)`. A folder that does not exist is still a repo, with its own message, and never stops the others.

Without flags, the app reads the saved list at `~/.config/pi-monitor/repos.json`, a JSON array of `{"name": "...", "path": "..."}` objects. A missing or damaged file means an empty list, never a crash. The app writes the saved list with mode 0600, readable by the user only, and a folder it has to create for it with mode 0700; an existing file written by an earlier version with wider permissions is fixed the next time the list is saved.

The window has an Add repo control that opens the native folder picker. A chosen folder is accepted when it is named `.plans` or contains one of `traces`, `running`, `done`, `inbox` or `sessions`; when it holds a `.plans` subfolder, that one is used; otherwise the window shows a message and nothing changes. A cancelled dialog changes nothing. The chosen folder is saved to the repo list.

A Remove control is offered on every repo. Removing a saved repo deletes it from the list. Removing a repo that came from a `--plans` flag, or one whose name is unknown, only shows a message and changes nothing.

Repo modes:

- With any `--plans` flag, only the flag repos are shown. The saved list is not read and not changed, and Add repo answers `repos come from --plans flags`.
- Without flags, the saved list is the source. Add and Remove change it.
- A cancelled folder dialog returns an empty message and changes nothing.

## What it does not show

The app reads only the configured plans folders, the session files those plans reference and, when an agent toggle is on, the two agent session folders described above. A session file whose real path leaves a plans folder through a symlink is deliberately not listed, counted or read. The Bun monitor follows symlinks and would show that file; the app is stricter on purpose. Plans in a fixture without such a symlink look the same in both.

The app never writes inside a `.plans` folder. The repo list and the settings file are the only files it writes, and it writes both atomically (a temporary file, then a rename).

Live updates do not use a server. The Go side samples every configured repo's signature every 500 milliseconds, the same rule as the Bun monitor, and emits one `change` event when any signature moves, when the settings are saved and when the window starts. With a session toggle on, the signature also covers the session files of the enabled roots that changed in the last 24 hours and the newest ten of each root, so a new or growing session also fires the event. The client re-fetches the board and the Agents list, and an open transcript re-fetches with its `after` cursor. Nothing listens on a port and the app makes no network call.

## Code blocks and highlighting

A transcript shows tool code as blocks: an edit as a diff, a write or read result as a file body, and a bash call as a command; fenced code in assistant text is split out as its own block. The client highlights them with `highlight.js`, exact-pinned at version 11.11.1 in `frontend/package.json` and bundled into the app, with a language subset (TypeScript, JavaScript, Go, JSON, Markdown, Bash, CSS, HTML and XML, YAML, Python, Rust, SQL and diff). The language comes from the file extension or from the block kind, a command being Bash; an unknown extension or a block over 40 000 characters is shown as plain text. The library is bundled, so highlighting needs no network at run time.

## Golden files

The TypeScript server in `monitor/` is the oracle. `tools/golden.ts` imports it and `monitor/test/fixture.ts` (read only), builds the fixture trees, asks the TypeScript server for the state and session pages and writes the results under `testdata/`:

```sh
cd monitor-app
bun run tools/golden.ts
```

That writes `testdata/trees/` (the fixture plans folders), `testdata/golden/` (the TypeScript output) and `testdata/manifest.json` (the folders, files, modes, mtimes and session requests that git cannot store). The run is deterministic; running it twice gives identical files.

To check the committed files without writing them:

```sh
cd monitor-app
bun run tools/golden.ts --check
```

It regenerates into a temporary folder and exits non-zero on any difference, printing the paths that differ. Regenerate after changing the fixtures or the TypeScript server, never to make a failing Go parity test pass: the parity test is meant to catch a Go rule that drifted from the TypeScript.

## Layout

- `main.go`: the Wails shell. It creates the window, embeds the built client from `frontend/dist` and registers the bindings.
- `app.go`: the binding surface (`State`, `Session`, `AddRepo`, `RemoveRepo`, `Settings`, `SetSettings`, `Agents`, `AgentSession`), the `--plans` flags, the repo list and settings paths and the 500 ms change poll.
- `wails.json`: the Wails v2 build config: app name, output name and the client install and build commands.
- `go.mod`, `go.sum`: module `pi-monitor`, Go 1.26, Wails v2 and its dependencies. The `internal` packages use the standard library only.
- `internal/model`: the Go structs for the shared types, with the same JSON names, the shared ISO-8601 time parser and the optional `CodeBlock` of a transcript entry.
- `internal/fsx`: the path checks, including the symlink containment the Bun server does not do.
- `internal/plans`: plan parsing, trace event reading and plan selection.
- `internal/sessions`: session file listing, the Pi and omp transcript parsers, the `after` cursor, session summaries and the first-line session headers.
- `internal/agents`: the read-only listing and summarising of omp and Pi sessions under a `home`, with its per-file cache and cheap change signature.
- `internal/settings`: the settings struct and the safe-write store for `settings.json`.
- `internal/lanes`: lane states, attempts, stall detection and the plan view.
- `internal/decider`: the decider effort and audit views.
- `internal/repos`: repo naming and resolution, the saved repo list and the Add and Remove repo modes.
- `internal/state`: the repo and monitor state builders.
- `internal/watch`: the repo change signature.
- `internal/service`: the in-process replacement for the HTTP server: board state, session pages, agent sessions, the settings check and the change poll.
- `frontend/`: the React client copy with its `highlight.js` dependency, the shared types, the committed `wailsjs` bindings and the client tests.
- `parity/`: the golden-file parity test.
- `tools/golden.ts`: the golden generator.
- `testdata/`: the fixture trees, the golden JSON and the manifest.

## Styling

The CSS lives in `monitor-app/frontend/src/client/` as `tokens.css`, `base.css`, `chrome.css`, `plan.css`, `tasks.css`, `detail.css`, `transcript.css` and `code.css`, linked from `index.html` in that order. Every colour, size, radius, spacing, type and motion value comes from the custom properties of `tokens.css`, so a change of look starts there. Dark is the default and light follows the system through `prefers-color-scheme`.
