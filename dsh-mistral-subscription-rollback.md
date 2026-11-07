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
