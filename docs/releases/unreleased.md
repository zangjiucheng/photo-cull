# Unreleased — RAW finishing

Implemented on `feat/raw-finishing`; not yet included in a packaged release.

- Native 100% detail with Retina physical-pixel mapping, pan, original comparison and clipping.
- Sampled RGB/luminance histogram of the edited crop.
- One manual source-anchored local gradient with feather, invert, exposure, highlights and warmth.
- Smooth selective color and neutral-gray relative white-balance picker.
- Explicit engine/base-profile versions; old recipes retain the current look.
- Shared resident cache budget and bounded/cancelable pending prefetch.

Library recovery (`feat/library-recovery`):

- Library backup and verified restore (checksum, SQLite integrity, schema upgrade), keeping the previous library as a copy; reconnect workspaces whose folder moved.
- Presets live in the library (moved once from this device's local storage) with rename and JSON import/export.
- Named per-photo versions that store recipes only.
- Resumable exports: recipes recorded per photo, atomic file writes, resume after a crash without rewriting finished files, retry only failures.
- Direct crop handles on the whole-image view and two-point horizon leveling.
- Same-scene exposure matching to a reference photo, previewed before applying, capped at ±1 EV, highlight-aware, skipping night/silhouette mismatches.
- AI runtime finds Python 3.10–3.13 more reliably (Windows py launcher, python.org and Homebrew installs) and downloads a verified private Python 3.12 when none is installed.
- Nightly builds (prereleases every night, or on demand per branch) and an update channel choice in Settings; Settings and About show the version with its commit and build time.
- The Debug tab is now **Settings** (`⌘,` / `Ctrl+,`), where you can pick a custom Python for the AI runtime and reinstall it.

Real high-ISO night, 48MP, extended desktop/memory, optional-model and user aesthetic acceptance remain open under PER-367.

See [validation](../validation/raw-finishing.md) and [controls](../editing.md).
