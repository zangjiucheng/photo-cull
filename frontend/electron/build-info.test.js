import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { collectBuildInfo, describeBuild } = require("./build-info.cjs");

describe("build info", () => {
  it("uses the CI commit and the build time", () => {
    const info = collectBuildInfo("/nowhere", { GITHUB_SHA: "a1b2c3d4e5f6" }, new Date("2026-10-18T15:30:12Z"));
    expect(info).toEqual({ commit: "a1b2c3d4e5f6", dirty: false, builtAt: "2026-10-18T15:30:12.000Z" });
  });

  it("describes a build with short commit and UTC time", () => {
    expect(describeBuild("0.3.1", { commit: "a1b2c3d4e5f6", dirty: false, builtAt: "2026-10-18T15:30:12.000Z" }))
      .toBe("0.3.1 (a1b2c3d, 2026-10-18 15:30 UTC)");
    expect(describeBuild("0.3.1", { commit: "a1b2c3d4e5f6", dirty: true, builtAt: null })).toBe("0.3.1 (a1b2c3d+dirty)");
    expect(describeBuild("0.3.1", { commit: null, builtAt: null })).toBe("0.3.1");
  });
});
