import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { findRuntimePython, parseVersion, pythonCandidates } = require("./python-runtime.cjs");

const probeFrom = (table) => (candidate) => {
  const key = [candidate.command, ...candidate.args].join(" ");
  return table[key] ? parseVersion(table[key]) : null;
};

describe("findRuntimePython", () => {
  it("uses the py launcher on Windows when python3.x commands do not exist", () => {
    const found = findRuntimePython({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, probe: probeFrom({ "py -3.12": "3.12.7" }) });
    expect(found.command).toBe("py");
    expect(found.args).toEqual(["-3.12"]);
    expect(found.version.label).toBe("3.12.7");
  });

  it("finds a python.org install on Windows without PATH entries", () => {
    const exe = "C:\\Users\\a\\AppData\\Local\\Programs\\Python\\Python311\\python.exe";
    const found = findRuntimePython({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, probe: probeFrom({ [exe]: "3.11.9" }) });
    expect(found.command).toBe(exe);
  });

  it("prefers the newest supported Python and skips ones torch cannot install on", () => {
    const found = findRuntimePython({
      platform: "darwin",
      env: {},
      probe: probeFrom({ python3: "3.14.0", "python3.11": "3.11.9", "/opt/homebrew/bin/python3.13": "3.13.1" }),
    });
    expect(found.command).toBe("/opt/homebrew/bin/python3.13");
  });

  it("explains what was found and how to fix it", () => {
    expect(() => findRuntimePython({ platform: "darwin", env: {}, probe: probeFrom({ python3: "3.9.6", "/opt/homebrew/bin/python3": "3.14.0" }) }))
      .toThrow(/Found Python 3\.14\.0 \(\/opt\/homebrew\/bin\/python3\), Python 3\.9\.6 \(python3\).*brew install python@3\.12/);
    expect(() => findRuntimePython({ platform: "win32", env: {}, probe: () => null }))
      .toThrow(/No Python installation was found\. Install Python 3\.12 from python\.org/);
  });

  it("checks an explicit AI_RUNTIME_PYTHON", () => {
    expect(() => findRuntimePython({ platform: "linux", env: { AI_RUNTIME_PYTHON: "/x/python" }, probe: probeFrom({ "/x/python": "3.8.10" }) }))
      .toThrow(/AI_RUNTIME_PYTHON \(\/x\/python\) is Python 3\.8\.10/);
    expect(findRuntimePython({ platform: "linux", env: { AI_RUNTIME_PYTHON: "/x/python" }, probe: probeFrom({ "/x/python": "3.12.1" }) }).command).toBe("/x/python");
  });

  it("lists the newest candidates first", () => {
    expect(pythonCandidates("win32", {})[0]).toEqual({ command: "py", args: ["-3.13"] });
    expect(pythonCandidates("linux", {})[0]).toEqual({ command: "python3.13", args: [] });
  });
});

describe("managed Python", () => {
  const { downloadVerified, managedPythonBuild, managedPythonExecutable } = require("./python-runtime.cjs");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const crypto = require("node:crypto");

  it("has a pinned build for macOS (both chips) and Windows x64", () => {
    expect(managedPythonBuild("darwin", "arm64").url).toMatch(/aarch64-apple-darwin-install_only\.tar\.gz$/);
    expect(managedPythonBuild("darwin", "x64").sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(managedPythonBuild("win32", "x64").url).toContain("x86_64-pc-windows-msvc");
    expect(managedPythonBuild("linux", "x64")).toBeNull();
    expect(managedPythonExecutable("/d", "win32")).toMatch(/python[\\/]python\.exe$/);
  });

  const fakeFetch = (bytes) => async () => new Response(bytes, { headers: { "content-length": String(bytes.length) } });

  it("keeps a download only when its checksum matches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pyrt-"));
    const data = Buffer.from("python bits");
    const good = crypto.createHash("sha256").update(data).digest("hex");
    const progress = [];
    await downloadVerified("https://x/py.tgz", path.join(dir, "ok.tgz"), good, (f) => progress.push(f), fakeFetch(data));
    expect(fs.readFileSync(path.join(dir, "ok.tgz"), "utf8")).toBe("python bits");
    expect(progress.at(-1)).toBe(1);
    await expect(downloadVerified("https://x/py.tgz", path.join(dir, "bad.tgz"), "0".repeat(64), () => {}, fakeFetch(data)))
      .rejects.toThrow(/Checksum mismatch/);
    expect(fs.readdirSync(dir)).toEqual(["ok.tgz"]);
  });
});
