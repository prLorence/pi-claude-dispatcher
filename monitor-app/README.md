# Pi monitor app

A native macOS app that shows the same board as the Bun monitor in `monitor/`: one row per task with the implementer lane and the pair-reviewer lane side by side, plus a live transcript of the selected lane. It runs in its own window and Dock icon, with no browser tab, no Bun process and no container to start.

The Go backend is a port of the monitor's server logic. The client is a copy of the monitor's React 19 client; only its data layer and its Add and Remove repo controls differ. `wails build` packages both into one unsigned `.app`.

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

Without flags, the app reads the saved list at `~/.config/pi-monitor/repos.json`, a JSON array of `{"name": "...", "path": "..."}` objects. A missing or damaged file means an empty list, never a crash.

The window has an Add repo control that opens the native folder picker. A chosen folder is accepted when it is named `.plans` or contains one of `traces`, `running`, `done`, `inbox` or `sessions`; when it holds a `.plans` subfolder, that one is used; otherwise the window shows a message and nothing changes. A cancelled dialog changes nothing. The chosen folder is saved to the repo list.

A Remove control is offered on every repo. Removing a saved repo deletes it from the list. Removing a repo that came from a `--plans` flag, or one whose name is unknown, only shows a message and changes nothing.

Repo modes:

- With any `--plans` flag, only the flag repos are shown. The saved list is not read and not changed, and Add repo answers `repos come from --plans flags`.
- Without flags, the saved list is the source. Add and Remove change it.
- A cancelled folder dialog returns an empty message and changes nothing.

## What it does not show

The app reads only the configured plans folders and the session files those plans reference. A session file whose real path leaves the plans folder through a symlink is deliberately not listed, counted or read. The Bun monitor follows symlinks and would show that file; the app is stricter on purpose. Plans in a fixture without such a symlink look the same in both.

The app never writes inside a `.plans` folder. The repo list is the only file it writes, and it writes it atomically (a temporary file, then a rename).

Live updates do not use a server. The Go side samples every configured repo's signature every 500 milliseconds, the same rule as the Bun monitor, and emits one `change` event when any signature moves and one when the window starts. The client re-fetches the board, and an open transcript re-fetches with its `after` cursor. Nothing listens on a port and the app makes no network call.

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
- `app.go`: the binding surface (`State`, `Session`, `AddRepo`, `RemoveRepo`), the `--plans` flags, the repo list path and the 500 ms change poll.
- `wails.json`: the Wails v2 build config: app name, output name and the client install and build commands.
- `go.mod`, `go.sum`: module `pi-monitor`, Go 1.26, Wails v2 and its dependencies. The `internal` packages use the standard library only.
- `internal/model`: the Go structs for the shared types, with the same JSON names, and the shared ISO-8601 time parser.
- `internal/fsx`: the path checks, including the symlink containment the Bun server does not do.
- `internal/plans`: plan parsing, trace event reading and plan selection.
- `internal/sessions`: session file listing, the Pi transcript parser and its `after` cursor, and session summaries.
- `internal/lanes`: lane states, attempts, stall detection and the plan view.
- `internal/decider`: the decider effort and audit views.
- `internal/repos`: repo naming and resolution, the saved repo list and the Add and Remove repo modes.
- `internal/state`: the repo and monitor state builders.
- `internal/watch`: the repo change signature.
- `internal/service`: the in-process replacement for the HTTP server: board state, session pages and the change poll.
- `frontend/`: the React client copy, the shared types, the committed `wailsjs` bindings and the client tests.
- `parity/`: the golden-file parity test.
- `tools/golden.ts`: the golden generator.
- `testdata/`: the fixture trees, the golden JSON and the manifest.
