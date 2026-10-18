# Getting started

AI Photo Culling runs locally on your Mac or Windows PC. Photos are indexed in place, edits are stored as recipes in a local database, and export never overwrites originals.

## Requirements

- macOS on Apple Silicon (arm64), or Windows 10/11 (x64; Windows on ARM runs it through x64 emulation). Intel Macs and Linux don't have builds yet.
- Nothing else for basic use: the Python backend for scoring, RAW editing, and export is bundled in the app.
- Optional: a network connection to install the AI runtime (extra scoring models and CLIP similarity) from the **Settings** workspace (`⌘,` / `Ctrl+,`). The installer uses a Python 3.10–3.13 already on your computer; if there isn't one, it downloads a private copy of Python 3.12 (about 25 MB on macOS, 46 MB on Windows), checks its SHA-256, and keeps it in the app's data folder without changing your system. To use a specific Python instead, choose **Custom Python** under *Python for AI Runtime* in Settings, then reinstall the runtime. The `AI_RUNTIME_PYTHON` environment variable still overrides both.

## Install

Every release publishes the installers and a `SHA256SUMS.txt` you can check downloads against.

### macOS

1. Download the `.dmg` from the [latest release](https://github.com/zangjiucheng/photo-cull/releases/latest) (check it with `shasum -a 256 <file>.dmg`).
2. Open the DMG and drag **AI Photo Culling.app** into **Applications**.
3. Eject the DMG and launch the app from Applications. Running it from Applications (not from the DMG) is what lets in-app updates replace it later.

### Windows

1. Download `AI.Photo.Culling.<version>.x64.msi` from the [latest release](https://github.com/zangjiucheng/photo-cull/releases/latest) (check it with `certutil -hashfile <file>.msi SHA256` in Command Prompt).
2. Double-click it. The MSI installs for the current user only, needs no administrator rights, adds Start menu and desktop shortcuts, and opens the app when it finishes.
3. Uninstall from **Settings → Apps → Installed apps**. IT can deploy it silently with `msiexec /i <file>.msi /qn`.
4. Nightly builds from before v0.4.0 used an `.exe` installer. The first update to an MSI build removes that install for you; your library and settings are kept.

## First launch and Gatekeeper (macOS)

Release builds are not signed with an Apple Developer ID and are not notarized, so macOS may refuse to open the app the first time ("cannot be opened", "Apple could not verify..." or "is damaged").

To open it anyway:

1. Try to open the app once and dismiss the warning.
2. Open **System Settings → Privacy & Security**, scroll to the message about AI Photo Culling, and click **Open Anyway**. Confirm with your password.

If macOS reports that the app "is damaged", remove the quarantine attribute that the browser added to the download, then open it again:

```bash
xattr -dr com.apple.quarantine "/Applications/AI Photo Culling.app"
```

Only do this for a copy you downloaded from this repository's Releases page.

## First launch and SmartScreen (Windows)

The MSI is not code signed yet, so Microsoft Defender SmartScreen may show "Windows protected your PC" the first time. Click **More info**, check that the file came from this repository's Releases page, then click **Run anyway**.

## First run

1. On the launcher, click **Open Folder...** and choose a folder of photos (DJI DNG and other image formats). The folder becomes a workspace and appears under **Recent** next time. **Open Workspace File...** reopens a saved workspace file.
2. Wait for indexing. Scoring runs in the background; **Stats** shows progress.
3. Cull in **Browse**, **Review**, and **Similarity**: rate with stars, filter by AI score, and press `Q` to add photos to the export queue.
4. Finish the queued photos in **Enhance & Export** (see [Editing](editing.md)) and export them.

Removing a workspace from the recent list, or removing photos from a workspace in Similarity, never deletes files on disk. **Restore Removed** brings removed photos back.

## Welcome guide

The first time you open the app, a short guide walks through browsing, review, similarity and editing, explains what the optional AI runtime adds, and lets you start installing it right there. Open it again any time from **Help → Welcome Guide** or the **Welcome Guide** button in Settings.

## Updates

- On every launch the app checks GitHub Releases for a newer version. You can also check manually: **AI Photo Culling → Check for Updates...** on macOS, **Help → Check for Updates...** on Windows.
- When an update is available you see its release notes and can choose **Update**, **Later**, or **Skip This Version**.
- **Update** downloads the update for your platform and verifies it against `SHA256SUMS.txt`. Then choose **Restart Now** or **Install on Quit**.
  - macOS: the zip for your architecture replaces the app (the version inside is checked first; if replacing fails, the previous version is restored). This needs the app in a writable folder such as `/Applications`; when it runs from the DMG, the release page opens instead.
  - Windows: the new MSI installs silently (per user, no admin) after the app quits, then the app starts again.
- **Settings → Updates** chooses the channel: **Stable** (releases only) or **Nightly** (a build of the latest code each night; less tested, so back up your library first). It also shows the exact version, commit and build time, with **Copy Version** for bug reports. A nightly user switching back to Stable moves on at the next stable release.
- Set `AI_CULLING_DISABLE_UPDATES=1` in the app's environment to turn update checks off.
- v0.2.0 and earlier have no updater; install v0.2.1 or later manually once.

## Your data

Desktop data lives in `~/Library/Application Support/AI Photo Culling/` on macOS and `%APPDATA%\AI Photo Culling\` on Windows: the SQLite workspace database (ratings, scores, edit recipes), preview caches, and logs. Back up the database together with your photo folders. A workspace file saved with **File → Save Workspace File...** (`⌘S` / `Ctrl+S`) only stores folder references, not photos or edits. Updating the app keeps this data.

## Back up and restore

Use **File → Back Up Library...** to save a backup of the library: ratings, scores, edits, versions, presets and export history. The backup is a zip with a consistent copy of the database and a manifest of what it contains. Original photos are never included; keep backing those up separately.

**File → Restore Library...** checks the backup (format, checksum and database integrity) and shows what it contains before anything changes. Restoring replaces the current library, which is first saved as a copy next to it (`ai_culling.before-restore-<date>.db`). Backups from older versions are upgraded automatically.

## Reconnecting moved folders

If a workspace's folder has moved, was renamed, or its disk is not connected, the start screen shows **Folder not found** with a **Locate...** button. Choose the folder's new location; the app checks that the photos are really there before reconnecting, and your ratings and edits carry over.
