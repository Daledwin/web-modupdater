# web-modupdater

A small **local web tool** to add / update / remove Minecraft **Fabric** mods in your
central modpack repo (`Daledwin/modpack`), consumed by the `modupdater` mod.

It takes a jar (uploaded, downloaded, or **built from source**), validates it's a real
Fabric mod, computes its SHA‑256, upserts the `index.json` manifest, and **commits &
pushes** — all authenticated by a dedicated **SSH deploy key**, so the machine running
this never needs your personal GitHub credentials.

```
 jar source ──▶ validate fabric.mod.json ──▶ sha256 ──▶ preview index.json diff ──▶ confirm ──▶ commit & push (deploy key)
   upload                (id, version)                     (dry-run)            (you click)        staging | main
   url
   build (gradlew)
```

---

## What it does

* **3 ways to provide a jar**
  1. **Upload** a `.jar`.
  2. **From URL** — a direct link to a `.jar` (GitHub release asset, Modrinth/CurseForge
     CDN, raw git…). Redirects are followed.
  3. **Build from source** — clone a Fabric mod repo and run `./gradlew build` (JDK 21),
     taking the production jar from `build/libs` (excludes `-sources`/`-dev`/`-javadoc`).
* **Validates** the jar is a Fabric mod by reading `fabric.mod.json` from inside it, and
  extracts `id` + `version` (rejects clearly if missing/unreadable).
* **Computes SHA‑256** (lowercase hex) — mandatory; `modupdater` refuses entries without it.
* **Upserts `index.json` by `id`** — replaces the existing entry, and if the jar filename
  changed, **deletes the old jar** from the repo too.
* **Commits & pushes** to the chosen branch (`staging` default, or `main`) via the deploy key.
* **Preview & confirmation** — shows the generated entry, the `index.json` diff, and which
  files are added/removed **before** anything is pushed. Nothing is pushed until you confirm.
* **Bonus**: lists the mods on a branch (with `side` + `version`), lets you **delete** one,
  warns if the mod's `depends.minecraft` ≠ the expected MC version, and a **dry‑run** toggle.

### `index.json` schema

```json
{
  "mods": [
    {
      "id": "examplemod",
      "version": "1.2.3",
      "file": "examplemod-1.2.3.jar",
      "side": "server|client|both",
      "sha256": "<64 lowercase hex chars>"
    }
  ]
}
```

* `id` / `version` — read from `fabric.mod.json` **inside** the jar.
* `file` — the jar's filename at the repo root (the client downloads `<repo>/<file>`, so it
  **must** match the committed file). Sanitized to a safe basename ending in `.jar`.
* `side` — `server` / `client` / `both`.
* `sha256` — SHA‑256 of the jar bytes.

---

## Prerequisites

* **Docker** (recommended) — the image bundles **JDK 21**, Node, git and ssh, so all three
  source modes (including *build from source*) work reproducibly.
* **Or** run with **Node ≥ 18** directly. In that case *build from source* additionally
  needs **JDK 21** + a Gradle wrapper in the target repo on the host. (Upload / URL modes
  work with Node alone.)

---

## 1. Generate the deploy key

On any machine, create a dedicated key for **this repo only**:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "modpack-tool"
```

Then on GitHub: **repo → Settings → Deploy keys → Add deploy key**, paste
`deploy_key.pub`, and **check “Allow write access”**.

Put the **private** key somewhere outside this project, readable only by you:

```bash
mkdir -p ~/.ssh && mv deploy_key ~/.ssh/modpack_deploy_key
chmod 600 ~/.ssh/modpack_deploy_key
```

> The tool copies the key into a `0600` file in its work dir at startup, so it works even
> when the source is bind‑mounted read‑only with odd permissions.

---

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

| Variable                 | Required | Default                                   | Meaning |
|--------------------------|:--------:|-------------------------------------------|---------|
| `DEPLOY_KEY_PATH`        |   ✅     | —                                         | Host path to the **private** deploy key. |
| `MODPACK_REPO_SSH`       |          | `git@github.com:Daledwin/modpack.git`     | Target repo (SSH). |
| `MODPACK_BRANCHES`       |          | `staging,main`                            | Allowed branches. |
| `MODPACK_DEFAULT_BRANCH` |          | `staging`                                 | Default branch in the UI. |
| `MODPACK_MC_VERSION`     |          | `1.21.11`                                 | Expected MC version (warn only). |
| `GIT_AUTHOR_NAME`        |          | `modpack-tool`                            | Commit author/committer name. |
| `GIT_AUTHOR_EMAIL`       |          | `modpack-tool@local`                      | Commit author/committer email. |
| `MODPACK_CLONE_DIR`      |          | `<WORK_DIR>/modpack-clone`                | Local working clone path. |
| `WORK_DIR`               |          | `./.work` (local) · `/data` (Docker)      | Scratch: clone, builds, gradle cache, key. |
| `HOST` / `PORT`          |          | `127.0.0.1` / `8787`                      | HTTP bind. |

---

## 3. Run

### With Docker (recommended)

```bash
docker compose up --build
# open http://127.0.0.1:8787
```

The deploy key (from `DEPLOY_KEY_PATH` in `.env`) is bind‑mounted read‑only; the working
clone, build scratch and Gradle cache persist in `./data`.

### With Node directly

```bash
# .env is auto-loaded; or export the vars yourself
npm start
# open http://127.0.0.1:8787
```

For *build from source* without Docker, make sure `java -version` reports **21**.

---

## 4. Use it

1. Pick a **source** (Upload / URL / Build), a **side**, and a **branch**.
2. Click **Prepare** — watch progress (download / gradle build / validate / diff) stream live.
3. Review the **generated entry** and the **`index.json` diff**. Warnings appear for an MC
   mismatch, an unresolved `${version}` dev jar, or an existing `id` being replaced.
4. Click **Confirm & push** — get the commit hash (and a link, for GitHub remotes) on success.

The **Manifest** panel (right) lists what's currently on the selected branch and lets you
remove a mod (which deletes its jar + entry and pushes the change). Click the **deploy key**
chip in the header to run a live access check (`git ls-remote`).

---

## Tests

```bash
npm test            # unit tests (zip reader, fabric parse, sha256, sanitization, upsert/diff…)
bash test/e2e.sh    # full add/update/delete lifecycle against a local bare git remote
```

The unit tests validate the in‑house ZIP reader and SHA‑256 against **python3's** `zipfile`
and `hashlib` (independent implementations). The e2e test spins up the server against a
throwaway local remote and verifies the resulting commit history and `index.json`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| **deploy key not set / not ready** (header chip red) | `DEPLOY_KEY_PATH` unset or file missing. |
| **access denied** on the key check / push refused | Deploy key not added to the repo, or added **without write access**; or `MODPACK_REPO_SSH` points at the wrong repo. |
| **“not a Fabric mod”** | The jar has no `fabric.mod.json` at its root (Forge/NeoForge jar, or an unprocessed dev jar). |
| **`${version}` placeholder warning** | You grabbed an unmapped dev jar from `build/libs`; use the remapped production jar (the tool already excludes `-dev`/`-sources`). |
| **Gradle build failed** | See the streamed Gradle log in the console; the source repo must be public and have a working Gradle wrapper. JDK 21 is required (use Docker). |
| **branch does not exist on the remote** | Create the `staging` / `main` branch on GitHub first. |
| **non‑fast‑forward** | Someone pushed meanwhile — the tool auto re‑syncs and retries once. |

---

## Security notes

* Bind is `127.0.0.1` by default — this is a **local** tool; don't expose it publicly.
* The deploy key grants write access to the modpack repo only. Keep it `0600` and outside
  the project (it's covered by `.gitignore`).
* `fabric.mod.json` is read with a minimal in‑house ZIP reader (no archive is extracted to
  disk for validation), and target filenames are sanitized to a safe basename at the repo root.
* *Build from source* accepts **http(s) URLs only** (leading‑`-`, `file:`, `ssh:` and local
  paths are rejected, and `protocol.file/ext` are disabled for the clone). Be aware it still
  runs the project's Gradle build, which executes that repo's build scripts — only build
  sources you trust.
* The Docker container runs as root so it can read a host‑owned `0600` key bind‑mount and
  write `/data`. That's fine for a localhost tool; harden (non‑root + matching uid) if you
  deploy it somewhere shared.
