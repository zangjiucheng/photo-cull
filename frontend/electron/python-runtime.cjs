// Finds a Python that can host the optional AI runtime (torch, numpy, pyiqa, open_clip).
// Kept free of Electron so the search and the error message can be unit tested.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// When no suitable Python is installed, the app downloads this relocatable CPython build
// (astral-sh/python-build-standalone, the builds uv uses) into its own data folder: no admin
// rights and no change to the system. Pinned with the release's published SHA-256.
const MANAGED_PYTHON = {
  version: "3.12.14",
  release: "20260924",
  builds: {
    "darwin-arm64": {
      file: "cpython-3.12.14+20260924-aarch64-apple-darwin-install_only.tar.gz",
      sha256: "9763f43db2481a6af36af82ec40302aab7a73632f880129d07a6e81aec846277",
      bytes: 25153879,
    },
    "darwin-x64": {
      file: "cpython-3.12.14+20260924-x86_64-apple-darwin-install_only.tar.gz",
      sha256: "0d6a4a299908123f00bc844df737603f047ff9eba14fda6cad83f3cf3cb3a2af",
      bytes: 24837706,
    },
    "win32-x64": {
      file: "cpython-3.12.14+20260924-x86_64-pc-windows-msvc-install_only.tar.gz",
      sha256: "c5303174bc29f5205decf6721ac549d4eb41c448f9b8c46cbc562d00348865bb",
      bytes: 46462396,
    },
  },
};

/** The pinned build for this machine, or null where none is published (e.g. Linux here). */
function managedPythonBuild(platform = process.platform, arch = process.arch) {
  const build = MANAGED_PYTHON.builds[`${platform}-${arch}`];
  if (!build) return null;
  return {
    ...build,
    version: MANAGED_PYTHON.version,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${MANAGED_PYTHON.release}/${encodeURIComponent(build.file)}`,
  };
}

/** Executable inside an extracted install_only archive (which unpacks to python/). */
function managedPythonExecutable(dir, platform = process.platform) {
  return platform === "win32" ? path.join(dir, "python", "python.exe") : path.join(dir, "python", "bin", "python3");
}

/**
 * The tar to unpack with. On Windows use the bsdtar in System32 explicitly: a GNU tar earlier on
 * PATH (Git for Windows) reads "C:\\..." as a remote host and fails.
 */
function systemTar(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

/** Download url to target, failing unless the SHA-256 matches. onProgress gets 0..1. */
async function downloadVerified(url, target, sha256, onProgress = () => {}, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const partial = `${target}.partial`;
  const output = fs.createWriteStream(partial);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
      if (total) onProgress(received / total);
    }
  } finally {
    await new Promise((resolve) => output.end(resolve));
  }
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(url)} (expected ${sha256}, got ${actual})`);
  }
  fs.renameSync(partial, target);
}

// torch and numpy publish wheels for this range; newer Pythons install but fail on torch.
const MIN_MINOR = 10;
const MAX_MINOR = 13;
const SUPPORTED_LABEL = `3.${MIN_MINOR}–3.${MAX_MINOR}`;

function isSupported(version) {
  return Boolean(version) && version.major === 3 && version.minor >= MIN_MINOR && version.minor <= MAX_MINOR;
}

function parseVersion(text) {
  const match = String(text || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), label: match[0] } : null;
}

/** Candidates in preference order: newest supported Python first, generic names last. */
function pythonCandidates(platform = process.platform, env = process.env) {
  const minors = [];
  for (let minor = MAX_MINOR; minor >= MIN_MINOR; minor -= 1) minors.push(minor);
  const candidates = [];
  const add = (command, args = []) => candidates.push({ command, args });
  if (platform === "win32") {
    // The py launcher ships with every python.org installer, even without "Add to PATH".
    for (const minor of minors) add("py", [`-3.${minor}`]);
    const roots = [
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "Python"),
      env.ProgramFiles && env.ProgramFiles,
    ].filter(Boolean);
    for (const minor of minors) {
      for (const root of roots) add(path.win32.join(root, `Python3${minor}`, "python.exe"));
    }
    add("python");
    add("python3");
    return candidates;
  }
  for (const minor of minors) add(`python3.${minor}`);
  for (const minor of minors) {
    add(`/opt/homebrew/bin/python3.${minor}`);
    add(`/usr/local/bin/python3.${minor}`);
    add(`/Library/Frameworks/Python.framework/Versions/3.${minor}/bin/python3`);
  }
  if (env.HOME) add(path.posix.join(env.HOME, ".pyenv", "shims", "python3"));
  add("/opt/homebrew/bin/python3");
  add("/usr/local/bin/python3");
  add("python3");
  return candidates;
}

function describe(candidate) {
  return [candidate.command, ...candidate.args].join(" ");
}

function installHint(platform) {
  if (platform === "win32") {
    return `Install Python 3.12 from python.org (the installer's py launcher is enough), then click Install again.`;
  }
  if (platform === "darwin") {
    return `Install Python 3.12 from python.org or with Homebrew (brew install python@3.12), then click Install again.`;
  }
  return `Install Python 3.12 with your package manager, then click Install again.`;
}

/**
 * Pick the first supported Python. `probe(candidate)` returns a parsed version or null.
 * A Python named by AI_RUNTIME_PYTHON, or else chosen in Settings (`custom`), is used as is;
 * otherwise the candidates are searched. Throws an Error that says what was found and how to fix it.
 */
function findRuntimePython({ probe, platform = process.platform, env = process.env, log = () => {}, custom = null }) {
  const configured = env.AI_RUNTIME_PYTHON
    ? { command: env.AI_RUNTIME_PYTHON, args: [], source: "AI_RUNTIME_PYTHON" }
    : custom
      ? { command: custom, args: [], source: "the Python chosen in Settings" }
      : null;
  if (configured) {
    const { source, ...candidate } = configured;
    const version = probe(candidate);
    log(`[python] ${source}=${candidate.command} version=${version?.label || "unavailable"}`);
    if (isSupported(version)) return { ...candidate, version };
    throw new Error(
      `AI Runtime needs Python ${SUPPORTED_LABEL}; ${source} (${candidate.command}) is ${version ? `Python ${version.label}` : "not runnable"}.`,
    );
  }
  // Probe every location and keep the newest supported version: a newer Python may live at a
  // later candidate (e.g. Homebrew 3.13) than an older one on PATH.
  const found = [];
  let best = null;
  for (const candidate of pythonCandidates(platform, env)) {
    const version = probe(candidate);
    log(`[python] candidate=${describe(candidate)} version=${version?.label || "unavailable"}`);
    if (!version) continue;
    if (isSupported(version)) {
      if (!best || version.minor > best.version.minor) best = { ...candidate, version };
    } else if (!found.some((item) => item.version.label === version.label)) {
      found.push({ candidate, version });
    }
  }
  if (best) return best;
  const seen = found.length
    ? `Found ${found.map((item) => `Python ${item.version.label} (${describe(item.candidate)})`).join(", ")}, which torch/numpy do not support.`
    : "No Python installation was found.";
  throw new Error(
    `AI Runtime needs Python ${SUPPORTED_LABEL}. ${seen} ${installHint(platform)} You can also set AI_RUNTIME_PYTHON to a compatible python executable.`,
  );
}

module.exports = {
  MAX_MINOR,
  MIN_MINOR,
  SUPPORTED_LABEL,
  describe,
  downloadVerified,
  findRuntimePython,
  isSupported,
  managedPythonBuild,
  managedPythonExecutable,
  parseVersion,
  pythonCandidates,
  systemTar,
};
