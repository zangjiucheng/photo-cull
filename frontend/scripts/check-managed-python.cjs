// CI smoke test: the Python the app downloads for the AI runtime must download, verify,
// unpack with the system tar and run on this platform.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { downloadVerified, managedPythonBuild, managedPythonExecutable } = require("../electron/python-runtime.cjs");

(async () => {
  const build = managedPythonBuild();
  if (!build) {
    console.log(`No managed Python for ${process.platform}-${process.arch}; skipping.`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-python-"));
  const archive = path.join(dir, "python.tar.gz");
  await downloadVerified(build.url, archive, build.sha256);
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  const version = execFileSync(managedPythonExecutable(dir), ["-c", "import sys, ssl, venv; print(sys.version.split()[0])"]).toString().trim();
  if (version !== build.version) throw new Error(`Expected Python ${build.version}, got ${version}`);
  console.log(`Managed Python ${version} downloaded, verified and runs on ${process.platform}-${process.arch}.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
