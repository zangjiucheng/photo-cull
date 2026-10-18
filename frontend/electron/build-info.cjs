// Which build is running: written next to main.cjs when the app is packaged, read from git in development.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BUILD_INFO_FILE = path.join(__dirname, "build-info.json");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Commit and time of the build in `repoRoot`; GITHUB_SHA wins in CI. */
function collectBuildInfo(repoRoot, env = process.env, now = new Date()) {
  const commit = env.GITHUB_SHA || git(["rev-parse", "HEAD"], repoRoot);
  // Local builds with uncommitted changes are marked so they are never mistaken for the commit.
  const dirty = !env.GITHUB_SHA && git(["status", "--porcelain", "--untracked-files=no"], repoRoot) !== "";
  return { commit: commit || null, dirty, builtAt: now.toISOString() };
}

function writeBuildInfo(repoRoot, target = BUILD_INFO_FILE) {
  const info = collectBuildInfo(repoRoot);
  fs.writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

function readBuildInfo(repoRoot, file = BUILD_INFO_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ...collectBuildInfo(repoRoot), builtAt: null };
  }
}

/** "0.3.1 (a1b2c3d, 2026-10-18 15:30 UTC)" */
function describeBuild(version, info) {
  const parts = [];
  if (info?.commit) parts.push(`${info.commit.slice(0, 7)}${info.dirty ? "+dirty" : ""}`);
  if (info?.builtAt) parts.push(`${info.builtAt.slice(0, 16).replace("T", " ")} UTC`);
  return parts.length ? `${version} (${parts.join(", ")})` : version;
}

module.exports = { BUILD_INFO_FILE, collectBuildInfo, describeBuild, readBuildInfo, writeBuildInfo };
