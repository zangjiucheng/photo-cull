import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { compareVersions, parseChecksums, selectChannelRelease, selectUpdateAsset, selectZipAsset, windowsInstallScript } = require("./update-utils.cjs");

describe("compareVersions", () => {
  it("orders semantic versions and ignores the tag prefix", () => {
    expect(compareVersions("v0.2.1", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
  });

  it("treats a release as newer than its prerelease", () => {
    expect(compareVersions("0.3.0", "0.3.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBeLessThan(0);
  });

  it("never reports an update for unparseable versions", () => {
    expect(compareVersions("nightly", "0.2.0")).toBe(0);
  });
});

describe("selectChannelRelease", () => {
  const releases = [
    { tag_name: "v0.3.2-nightly.202610190700", prerelease: true },
    { tag_name: "v0.3.2-nightly.202610180700", prerelease: true },
    { tag_name: "v0.3.1", prerelease: false },
    { tag_name: "v0.4.0", prerelease: false, draft: true },
  ];

  it("offers stable users only full releases", () => {
    expect(selectChannelRelease(releases, "stable").tag_name).toBe("v0.3.1");
  });

  it("offers nightly users the newest build, and the next stable once it ships", () => {
    expect(selectChannelRelease(releases, "nightly").tag_name).toBe("v0.3.2-nightly.202610190700");
    const shipped = [{ tag_name: "v0.3.2", prerelease: false }, ...releases];
    expect(selectChannelRelease(shipped, "nightly").tag_name).toBe("v0.3.2");
  });

  it("orders nightlies by their timestamp", () => {
    expect(compareVersions("0.3.2-nightly.202610190700", "0.3.2-nightly.202610182359")).toBeGreaterThan(0);
    expect(compareVersions("0.3.2-nightly.202610190700", "0.3.1")).toBeGreaterThan(0);
  });
});

describe("parseChecksums", () => {
  it("keys entries by GitHub asset name", () => {
    const hash = "a".repeat(64);
    const checksums = parseChecksums(`${hash}  AI Photo Culling-0.2.1-arm64-mac.zip\n`);
    expect(checksums.get("AI.Photo.Culling-0.2.1-arm64-mac.zip")).toBe(hash);
  });
});

describe("selectZipAsset", () => {
  const assets = [
    { name: "AI.Photo.Culling-0.2.1-arm64.dmg" },
    { name: "AI.Photo.Culling-0.2.1-arm64-mac.zip" },
    { name: "AI.Photo.Culling-0.2.1-mac.zip" },
  ];

  it("picks the zip for the running architecture", () => {
    expect(selectZipAsset(assets, "arm64")?.name).toBe("AI.Photo.Culling-0.2.1-arm64-mac.zip");
    expect(selectZipAsset(assets, "x64")?.name).toBe("AI.Photo.Culling-0.2.1-mac.zip");
  });

  it("returns null when no matching zip was published", () => {
    expect(selectZipAsset([{ name: "AI.Photo.Culling-0.2.0-arm64.dmg" }], "arm64")).toBeNull();
  });
});

describe("selectUpdateAsset", () => {
  const assets = [
    { name: "AI.Photo.Culling-0.4.0-arm64.dmg" },
    { name: "AI.Photo.Culling-0.4.0-arm64-mac.zip" },
    { name: "AI.Photo.Culling.0.4.0.x64.msi" },
  ];

  it("uses the NSIS installer on Windows and the zip on macOS", () => {
    expect(selectUpdateAsset(assets, "win32", "x64")?.name).toBe("AI.Photo.Culling.0.4.0.x64.msi");
    expect(selectUpdateAsset(assets, "darwin", "arm64")?.name).toBe("AI.Photo.Culling-0.4.0-arm64-mac.zip");
  });

  it("has nothing to offer on other platforms or without a package", () => {
    expect(selectUpdateAsset(assets, "linux", "x64")).toBeNull();
    expect(selectUpdateAsset([{ name: "AI.Photo.Culling-0.3.1-arm64-mac.zip" }], "win32", "x64")).toBeNull();
  });
});

describe("windowsInstallScript", () => {
  it("waits for the app, installs the MSI silently per user and relaunches", () => {
    const script = windowsInstallScript();
    expect(script).toMatch(/Wait-Process -Id \$AppPid/);
    expect(script).toMatch(/msiexec\.exe' -ArgumentList '\/i'.*'\/qn', '\/norestart'/);
    expect(script).toMatch(/if \(\$Relaunch -eq 1/);
    // An older NSIS install of the same folder is removed before the MSI goes in.
    expect(script.indexOf("$Uninstaller")).toBeLessThan(script.indexOf("msiexec.exe"));
  });
});
