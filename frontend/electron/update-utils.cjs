// Pure helpers for the self-updater, kept free of Electron so they can be unit tested.

function parseVersion(value) {
  const match = String(value || "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) {
    return null;
  }
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || "",
  };
}

// Returns >0 when a is newer than b, <0 when older, 0 when equal or unparseable.
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] - right.parts[index];
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease) {
    return 1;
  }
  if (!right.prerelease) {
    return -1;
  }
  return left.prerelease < right.prerelease ? -1 : 1;
}

// The release to offer on a channel. Stable follows GitHub's "latest" release; nightly takes the
// newest of every published release, so a nightly user moves on to the next stable once it ships.
function selectChannelRelease(releases, channel) {
  let best = null;
  for (const release of releases || []) {
    if (release.draft || !parseVersion(release.tag_name)) {
      continue;
    }
    if (channel !== "nightly" && release.prerelease) {
      continue;
    }
    if (!best || compareVersions(release.tag_name, best.tag_name) > 0) {
      best = release;
    }
  }
  return best;
}

// GitHub rewrites spaces in uploaded asset names to dots, while shasum prints the local file name.
function normalizeAssetName(name) {
  return String(name || "").trim().replace(/\s+/g, ".");
}

function parseChecksums(text) {
  const checksums = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) {
      checksums.set(normalizeAssetName(match[2]), match[1].toLowerCase());
    }
  }
  return checksums;
}

// macOS updates replace the .app from the release zip; Windows installs the release MSI silently.
function selectUpdateAsset(assets, platform, arch) {
  if (platform === "win32") {
    return (assets || []).find((asset) => /\.msi$/i.test(asset.name || "")) || null;
  }
  return platform === "darwin" ? selectZipAsset(assets, arch) : null;
}

function selectZipAsset(assets, arch) {
  const zips = (assets || []).filter((asset) => /\.zip$/i.test(asset.name || ""));
  return zips.find((asset) => asset.name.includes(`-${arch}-`))
    || (arch === "x64" ? zips.find((asset) => !/-arm64-/.test(asset.name)) : null)
    || null;
}

// PowerShell run detached on Windows once the app has quit: remove an older NSIS install of the
// same app (it shared the install folder), install the MSI per user without UI, then relaunch.
// msiexec's own "run after finish" only fires with UI, so the relaunch happens here.
function windowsInstallScript() {
  return [
    "param([int]$AppPid, [string]$Msi, [string]$Log, [string]$Exe, [string]$Uninstaller, [string]$InstallDir, [int]$Relaunch)",
    "Wait-Process -Id $AppPid -Timeout 120 -ErrorAction SilentlyContinue",
    "if ($Uninstaller -and (Test-Path -LiteralPath $Uninstaller)) {",
    "  Start-Process -FilePath $Uninstaller -ArgumentList '/S', \"_?=$InstallDir\" -Wait",
    "  Remove-Item -LiteralPath $Uninstaller -Force -ErrorAction SilentlyContinue",
    "}",
    "$install = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', \"`\"$Msi`\"\", '/qn', '/norestart', '/l*v', \"`\"$Log`\"\" -Wait -PassThru",
    "Add-Content -LiteralPath $Log -Value \"msiexec exit code $($install.ExitCode)\"",
    "if ($Relaunch -eq 1 -and (Test-Path -LiteralPath $Exe)) { Start-Process -FilePath $Exe }",
    "",
  ].join("\r\n");
}

module.exports = {
  compareVersions,
  normalizeAssetName,
  parseChecksums,
  selectChannelRelease,
  selectUpdateAsset,
  selectZipAsset,
  windowsInstallScript,
};
