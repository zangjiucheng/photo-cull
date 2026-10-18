# Getting started

AI Photo Culling runs locally on your Mac. Photos are indexed in place, edits are stored as recipes in a local database, and export never overwrites originals.

## Requirements

- macOS on Apple Silicon (arm64). Intel Macs, Windows, and Linux don't have verified builds yet.
- Nothing else for basic use: the Python backend for scoring, RAW editing, and export is bundled in the app.
- Optional: a network connection to install the AI runtime (extra scoring models and CLIP similarity) from the **Debug** workspace.

## Install

1. Download the `.dmg` from the [latest release](https://github.com/zangjiucheng/photo-cull/releases/latest). Each release also publishes `SHA256SUMS.txt`; you can check the download with `shasum -a 256 <file>.dmg`.
2. Open the DMG and drag **AI Photo Culling.app** into **Applications**.
3. Eject the DMG and launch the app from Applications. Running it from Applications (not from the DMG) is what lets in-app updates replace it later.

## First launch and Gatekeeper

Release builds are not signed with an Apple Developer ID and are not notarized, so macOS may refuse to open the app the first time ("cannot be opened", "Apple could not verify..." or "is damaged").

To open it anyway:

1. Try to open the app once and dismiss the warning.
2. Open **System Settings → Privacy & Security**, scroll to the message about AI Photo Culling, and click **Open Anyway**. Confirm with your password.

If macOS reports that the app "is damaged", remove the quarantine attribute that the browser added to the download, then open it again:

```bash
xattr -dr com.apple.quarantine "/Applications/AI Photo Culling.app"
```

Only do this for a copy you downloaded from this repository's Releases page.

## First run

1. On the launcher, click **Open Folder...** and choose a folder of photos (DJI DNG and other image formats). The folder becomes a workspace and appears under **Recent** next time. **Open Workspace File...** reopens a saved workspace file.
2. Wait for indexing. Scoring runs in the background; **Stats** shows progress.
3. Cull in **Browse**, **Review**, and **Similarity**: rate with stars, filter by AI score, and press `Q` to add photos to the export queue.
4. Finish the queued photos in **Enhance & Export** (see [Editing](editing.md)) and export them.

Removing a workspace from the recent list, or removing photos from a workspace in Similarity, never deletes files on disk. **Restore Removed** brings removed photos back.

## Updates

- On every launch the app checks GitHub Releases for a newer version. You can also use **AI Photo Culling → Check for Updates...**.
- When an update is available you see its release notes and can choose **Update**, **Later**, or **Skip This Version**.
- **Update** downloads the zip for your architecture, verifies it against `SHA256SUMS.txt`, and checks the version inside it. Then choose **Restart Now** or **Install on Quit**. If replacing the app fails, the previous version is restored.
- In-place updates require the app to be in a writable folder such as `/Applications`. If it is running from the DMG, the release page opens instead.
- Set `AI_CULLING_DISABLE_UPDATES=1` in the app's environment to turn update checks off.
- v0.2.0 and earlier have no updater; install v0.2.1 or later manually once.

## Your data

Desktop data lives in `~/Library/Application Support/AI Photo Culling/`: the SQLite workspace database (ratings, scores, edit recipes), preview caches, and logs. Back up the database together with your photo folders. A workspace file saved with **File → Save Workspace File...** (`⌘S`) only stores folder references, not photos or edits. Updating the app keeps this data.
