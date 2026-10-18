# Development

The app is an Electron shell (`frontend/electron`) around a React + TypeScript + Vite UI (`frontend/src`) and a Flask backend (`server/`, entry point `app.py`) that does indexing, scoring, similarity, RAW processing, and the export queue.

## Requirements

- Python **3.11** (verified)
- Node.js **24** and npm (used by CI)
- macOS or Windows for the desktop app and packaging (each platform builds its own installer); the first `npm ci` downloads Electron
- `libraw` from Homebrew is installed in the macOS release build

## Setup

```bash
git clone https://github.com/zangjiucheng/photo-cull.git
cd photo-cull
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
cd frontend
npm ci
cd ..
```

`make setup PYTHON="$PWD/.venv/bin/python"` installs the Python and web dependencies in one step.

Optional extras, not needed for basic editing:

- `make setup-ai` installs `requirements-ai.txt` (pyiqa, torch, open-clip) for AI scoring and CLIP similarity.
- `make setup-faiss` installs `requirements-faiss.txt` for the FAISS similarity backend.
- In the desktop app, the **Debug** workspace can install the AI runtime instead.

## Run

```bash
make dev PYTHON="$PWD/.venv/bin/python"       # desktop app (builds the web assets, then starts Electron)
make dev-web PYTHON="$PWD/.venv/bin/python"   # browser only
```

Browser mode serves <http://127.0.0.1:5050>. Folder paths you type in browser mode must be reachable by the backend machine. `make kill` stops whatever is listening on the Flask port. `FLASK_HOST` and `FLASK_PORT` override the bind address.

For Docker browser mode see [docker/README.md](../docker/README.md) (`make docker-up`, <http://127.0.0.1:5000>).

## Test

```bash
make test PYTHON="$PWD/.venv/bin/python"   # pytest + vitest
make test-py PYTHON="$PWD/.venv/bin/python"
make test-web
make build-web                              # tsc + vite build into static/dist
```

CI (`.github/workflows/ci.yml`) runs the backend tests, the frontend tests, and the frontend production build on every push and pull request to `main`.

The GPU/CPU editing comparison page is described in the [validation record](validation/quick-raw-editor.md#reproduction).

## Package

```bash
make package-dmg PYTHON=python3.11   # DMG for the local architecture
make package PYTHON=python3.11       # DMG + update zip (what the release workflow runs)
make package-dir PYTHON=python3.11   # unpacked app for local smoke tests
```

On Windows (Git Bash or PowerShell), build the NSIS installer with npm directly:

```bash
python -m venv .package-venv
.package-venv/Scripts/python.exe -m pip install -r requirements-package.txt
cd frontend
PYTHON="$PWD/../.package-venv/Scripts/python.exe" npm run package:win
```

Packaging creates a separate `.package-venv`, bundles the backend with PyInstaller, and builds the app with electron-builder. Output goes to `release/`. `make clean` removes build artifacts.

## Release

1. Make sure `main` is green.
2. Add release notes in `docs/releases/vX.Y.Z.md`.
3. Push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

CI (`.github/workflows/ci.yml`) runs the backend tests, frontend tests, and a production build in a matrix on Ubuntu, macOS, and Windows for every push to `main` and every pull request.

The release workflow (`.github/workflows/release.yml`) runs on `v*` tags. A matrix job builds each platform in parallel: it sets the app version from the tag, runs the tests, builds the macOS DMG and update zip or the Windows NSIS installer, and smoke-tests the bundled backend by starting it and calling its API. A final job collects every artifact, writes one `SHA256SUMS.txt`, and publishes the GitHub Release with generated notes. Pull requests that touch packaging run the same builds as a dry run without publishing. Installed apps pick up the new release through the in-app updater, which needs the platform's package and `SHA256SUMS.txt`.

Builds are not code signed: no Apple Developer ID or notarization, and no Windows Authenticode certificate.

## Website

The project site lives in `site/` (static HTML and CSS, no build step) and is deployed to GitHub Pages by `.github/workflows/pages.yml` on pushes to `main` that touch `site/**` or `docs/**`, or manually from the Actions tab. The repository's Pages source must be set to **GitHub Actions**.

To preview locally:

```bash
python3 -m http.server 8000 --directory site
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DB_PATH` | Override the SQLite database path |
| `UPLOAD_FOLDER` | Upload folder for the browser backend; managed by the app on desktop |
| `RAW_RENDER_CACHE` | RAW browse preview cache folder |
| `FLASK_HOST` / `FLASK_PORT` | Browser backend bind address and port; development default `127.0.0.1:5050` |
| `AI_CULLING_DISABLE_UPDATES` | Set to `1` to disable update checks |

## Code layout

`frontend/src` is the React / TypeScript UI, `frontend/electron` the desktop shell (including the updater), and `server` the Flask backend, RAW processing, and export queue.
