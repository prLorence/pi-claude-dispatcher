# Rollback

One file is touched: `~/.dsh/profiles/desktop/cordis.patch.yml`. Two purely
additive edits — the `mistral-subscription:` provider block and one
`allowedModels` entry. Nothing existing is deleted or reordered.

## Backups taken before the edit

| Where | What |
|---|---|
| `~/.dsh/backups/cordis.patch.yml.20261106-233916.before-mistral` | Full copy, taken before any edit |
| `~/.dsh/profiles/desktop/cordis.patch.yml.bak-1793966369` | The app's own backup from its last rewrite |

Baseline checksum (sha256 of the file before the edit):
`b60e3b282215afaa2ee77a30aaed423494647bd986b4964ced85b7cf60a84e45`

## Validate BEFORE any restart

Never restart with an unparsed file. Run this first:

```sh
python3 - <<'PY'
import yaml
d = yaml.safe_load(open("/Users/phetoush/.dsh/profiles/desktop/cordis.patch.yml"))
print("entries:", len(d))
for e in d:
    if e.get("id") == "llm-pi-ai":
        print("providers:", list(e["config"]["providers"].keys()))
    if e.get("id") == "subagent-model-selection-settings":
        print("allowedModels:", len(e["config"]["allowedModels"]))
PY
```

Expect the providers list to include `mistral-subscription` and `allowedModels`
to be one longer than before. If this script errors, the file is broken — go to
step 1 before launching the app.

## Step 1: DSH will not start at all

The app rewrites this file on boot, so a syntax error is the most likely cause.

```sh
pkill -f "DeepSeek Harness"   # only if the app is wedged rather than closed
cp ~/.dsh/backups/cordis.patch.yml.20261106-233916.before-mistral \
   ~/.dsh/profiles/desktop/cordis.patch.yml
shasum -a 256 ~/.dsh/profiles/desktop/cordis.patch.yml   # must match baseline
open -a "DeepSeek Harness"
```

## Step 2: DSH starts but the Mistral route errors

Remove only the two added blocks, leaving everything else intact:

```sh
python3 - <<'PY'
import io, re
p = "/Users/phetoush/.dsh/profiles/desktop/cordis.patch.yml"
s = io.open(p, encoding="utf-8").read()
s = re.sub(r"\n      mistral-subscription:\n(?:        .*\n|          .*\n)+", "\n", s)
s = s.replace("      - provider: mistral-subscription\n        model: zai-glm-5-3\n", "")
io.open(p, "w", encoding="utf-8").write(s)
PY
```

Then restart DSH and re-run the validation snippet: `mistral-subscription`
should be gone from the providers list and `allowedModels` back to its old
length.

## Step 3: revert to the app's own last-known-good

```sh
cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-1793966369 \
   ~/.dsh/profiles/desktop/cordis.patch.yml
```

Guaranteed loadable, but possibly older than the baseline if the profile was
edited after that backup was written.

## The DSH web UI

The web UI reads the same profile. If the app boots but the route misbehaves,
inspect the plugin and model lists there without touching the file. The UI
cannot restore a file that fails to parse — the app will not boot to serve it —
so for that case use step 1.

## What rollback does NOT undo

- The `dsh-mistral-subscription/` package stays in the repo. It is inert without
  the profile entry; leaving it costs nothing.
- The credential record `llp-pi-ai/mistral-subscription` (if a sign-in already
  happened) stays in the credential store. Sign out through the UI or delete the
  record to remove it.
- Nothing in the plan commits to git, so no commit needs reverting.

---

## Applied state (2026-11-07)

The orchestrator applied the edit on 2026-11-07 at ~12:22 local. The applied
diff is exactly the two blocks above. A fresh pre-edit backup was taken first:

- `~/.dsh/backups/cordis.patch.yml.20261107-122032.before-mistral-apply`
  (sha256 `3195caf20942eabe…`, 11 entries, allowedModels 6)

The rollback steps above work unchanged against this backup. Note the two
earlier documented references to `.bak-1793966369` and the original baseline
checksum remain valid historical fallbacks.

**A restart of the DSH app is still required** for the route and allowlist to
load.


---

## Plugin mounting (2026-11-07)

The profile edit alone is not enough: the sign-in flow is registered by the
plugin package, which mounts through the profile manifest, not the patch file.
The following were applied after the route edit:

1. Symlink:
   `~/.dsh/profiles/desktop/node_modules/@pi-harness/dsh-plugin-mistral-subscription`
   -> `/Users/phetoush/Documents/repos/agent-dispatcher/dsh-mistral-subscription`
2. `~/.dsh/profiles/desktop/package.json`: dependency entry (link:) and a bundle
   entry under `dsh.profile.bundles` (now 16).
3. Backup of the pre-edit manifest:
   `~/.dsh/backups/package.json.20261107-122700.before-mistral` (name is the
   timestamp at creation).

Rollback of the mount = remove the symlink, the two package.json entries, and
restart. The route block in cordis.patch.yml can stay or go; without the plugin
it is inert.

---

## Owner-run live-profile edit (due after the audit-fixes run)

The route's model list changes (GLM and the large models out,
`deepseek-v4-1-flash-1017` in as primary) and two settings keys flip. These are
owner-run steps — the plan and its workers never touch `~/.dsh`.

1. **Fresh backup, then replace the model list atomically.** Take a new
   timestamped copy of `~/.dsh/profiles/desktop/cordis.patch.yml` into
   `~/.dsh/backups/`. Then replace the models under the
   `mistral-subscription:` provider block with the ACTIVE set from
   `dsh-mistral-subscription/route.example.yml` (seven models,
   `deepseek-v4-1-flash-1017` first, each with `reasoningEfforts: false`).
   Edit the file in one pass and validate before any restart:

   ```sh
   python3 - <<'PY'
   import yaml
   d = yaml.safe_load(open("/Users/phetoush/.dsh/profiles/desktop/cordis.patch.yml"))
   e = next(e for e in d if e.get("id") == "llm-pi-ai")
   print(list(e["config"]["providers"]["mistral-subscription"]["models"]))
   PY
   ```

   Expect seven model ids starting with `deepseek-v4-1-flash-1017`. If the
   script errors, the file is broken — restore the fresh backup before
   launching the app.

2. **Allowlist swap.** In the same file, the `subagent-model-selection-settings`
   entry's `allowedModels` list: remove the `mistral-subscription/zai-glm-5-3`
   entry, add `mistral-subscription/deepseek-v4-1-flash-1017`.

3. **`agent-default-model` flip.** The `agent-default-model` key (same file)
   becomes `mistral-subscription/deepseek-v4-1-flash-1017`. Owner's choice, and
   it cuts both ways: a signed-out route now fails the DEFAULT model of every
   session (see the README's "Signing out").

4. **Fence/cancel additions need no rollback.** The request fence, the
   `/cancel` route and the per-attempt outcome tracking are plugin-internal
   (repo files only). Nothing in the profile corresponds to them.

5. **Post-gate MANUAL check — the fence needs the browser session cookie.**
   The DSH fence (`ctx.connection.requestRejection`) rejects cross-site and
   forged-host requests, and it requires the settings card's `fetch` to carry
   the browser session cookie. Offline tests stub the connection and cannot
   catch a missing cookie: if the card's fetch does not send it, EVERY route
   401s live while all tests stay green. After the restart, open the DSH web
   UI, press **Sign in** on the Mistral subscription card, and confirm the
   attempt starts (URL opens, state flips to in-flight). If it 401s
   immediately, inspect the card's fetch for `credentials: "same-origin"` (or
   the cookie attaching by default) before debugging anything server-side.
