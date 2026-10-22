#!/usr/bin/env bash
# New-machine entry point: check the tools, clone the harness, run vault setup.
set -euo pipefail

vault="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
harness="$(dirname "$vault")/pi-plan-dispatch-phase1"

fail() {
	echo "bootstrap: $*" >&2
	exit 1
}

# One top-level value of harness.json, read without a dependency.
read_harness() {
	node -e 'const fs = require("node:fs"); const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(v[process.argv[2]]));' "$vault/harness.json" "$1"
}

command -v node >/dev/null 2>&1 || fail "node not found"
command -v git >/dev/null 2>&1 || fail "git not found"

min_node="$(read_harness min_node)"
node_major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0]);')"
[ "$node_major" -ge "$min_node" ] || fail "node $node_major is older than this vault needs ($min_node)"

harness_repo="$(read_harness harness_repo)"
[ -n "$harness_repo" ] || fail "harness_repo is missing from harness.json"

if [ ! -d "$harness" ]; then
	git clone "$harness_repo" "$harness"
fi

# The dispatcher folder is passed in: on a new machine Pi and the skill are not
# registered yet, so the CLI has no other way to find it.
#   PI_PLAN_DISPATCH_DIR=<harness>/pi-plan-dispatch node <harness>/dispatch-plan/vault.mjs setup --path <vault>
vault_cli="$harness/dispatch-plan/vault.mjs"
[ -f "$vault_cli" ] || fail "$vault_cli is missing; the harness clone looks broken"
PI_PLAN_DISPATCH_DIR="$harness/pi-plan-dispatch" node "$vault_cli" setup --path "$vault"

cat <<EOF

Done. What is left to do by hand:

1. Log Pi into OpenCode Go, with the login flow of that provider.
2. Register the extension package in ~/.pi/agent/settings.json: add
   $harness/pi-plan-dispatch to the "packages" array, then restart Pi.
3. Install the Obsidian skills plugin, inside Claude Code:
     /plugin marketplace add kepano/obsidian-skills
     /plugin install obsidian@obsidian-skills
4. Optional: install Graphify (PyPI package graphifyy, CLI graphify) to
   explore codebases.
EOF
