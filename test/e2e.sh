#!/usr/bin/env bash
# End-to-end test against a LOCAL bare git remote (no GitHub / no real SSH).
# Exercises: clone -> fetch/reset -> upsert/commit/push, the HTTP+SSE API,
# add / update / delete, manifest read-back, and the bare repo's resulting state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
PORT=8799
BASE="http://127.0.0.1:${PORT}"
trap 'kill "${SRV:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT

echo "workdir: $T"

# --- dummy deploy key (existence is all that's needed for a local-path remote) ---
printf 'dummy-not-a-real-key\n' > "$T/deploy_key"
chmod 600 "$T/deploy_key"

# --- seed a bare remote with staging + main, each holding an empty manifest ---
git init -q --bare "$T/remote.git"
git clone -q "$T/remote.git" "$T/seed"
(
  cd "$T/seed"
  git config user.email t@e.st && git config user.name tester
  printf '{\n  "mods": []\n}\n' > index.json
  git add index.json && git commit -q -m "init manifest"
  git branch -M staging && git push -q origin staging
  git checkout -q -b main && git push -q origin main
)

# --- a real fabric jar, built independently by python's zipfile ---
python3 - "$T/examplemod.jar" examplemod 1.2.3 <<'PY'
import sys, zipfile, json
fmj = json.dumps({"schemaVersion":1,"id":sys.argv[2],"version":sys.argv[3],
                  "depends":{"minecraft":"1.21.11"}}, indent=2)
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("fabric.mod.json", fmj)
    z.writestr("com/example/Mod.class", "x"*2048)
PY
# a second, different mod for the concurrency regression test
python3 - "$T/othermod.jar" othermod 1.0.0 <<'PY'
import sys, zipfile, json
fmj = json.dumps({"schemaVersion":1,"id":sys.argv[2],"version":sys.argv[3],
                  "depends":{"minecraft":"1.21.11"}}, indent=2)
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("fabric.mod.json", fmj)
    z.writestr("com/example/Mod.class", "y"*2048)
PY

# --- launch the server against the local bare remote ---
MODPACK_REPO_SSH="$T/remote.git" \
MODPACK_CLONE_DIR="$T/clone" \
WORK_DIR="$T/work" \
DEPLOY_KEY_PATH="$T/deploy_key" \
MODPACK_BRANCHES="staging,main" \
MODPACK_DEFAULT_BRANCH="staging" \
GIT_AUTHOR_NAME="modpack-tool" \
GIT_AUTHOR_EMAIL="modpack-tool@local" \
HOST="127.0.0.1" PORT="$PORT" \
node "$ROOT/src/server.js" > "$T/server.log" 2>&1 &
SRV=$!

# wait for the port
for i in $(seq 1 50); do
  if curl -fsS "$BASE/api/config" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

# --- drive the full lifecycle ---
node "$ROOT/test/e2e_driver.mjs" "$BASE" "$T/examplemod.jar" "$T/othermod.jar"

# --- verify the bare remote received the full history ---
# init + add + remove + 2 concurrent adds = 5 commits (mutex serializes both adds).
echo "--- remote staging log ---"
git --git-dir="$T/remote.git" log --oneline staging | head -8
COMMITS=$(git --git-dir="$T/remote.git" rev-list --count staging)
echo "staging commit count: $COMMITS"
test "$COMMITS" -ge 5 || { echo "expected >=5 commits (concurrent pushes dropped?)"; exit 1; }

echo "--- final index.json on remote staging ---"
INDEX=$(git --git-dir="$T/remote.git" show staging:index.json)
echo "$INDEX"

# both concurrently-pushed mods must be present (regression guard for the race)
echo "$INDEX" | grep -q '"id": "examplemod"' && echo "$INDEX" | grep -q '"id": "othermod"' \
  && echo "both concurrent mods present on remote: OK" \
  || { echo "a concurrent push was lost"; exit 1; }

echo ""
echo "=========================================="
echo " E2E PASSED"
echo "=========================================="
