// Compiles and draws the live-preview shader in Chrome, the way Electron does on this platform
// (ANGLE: Direct3D 11 on Windows, Metal on macOS), and fails if it errors, loses the context or is
// too slow. Usage: node scripts/check-webgl-preview.cjs [path-to-chrome]
const path = require("node:path");
const esbuild = require("esbuild");
const puppeteer = require("puppeteer-core");

const DEFAULT_CHROME = {
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
};
const LIMIT_MS = 4000;

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "editing", "renderer.ts")],
    bundle: true,
    format: "iife",
    globalName: "Preview",
    write: false,
  });
  const browser = await puppeteer.launch({
    executablePath: process.argv[2] || DEFAULT_CHROME[process.platform],
    headless: true,
    args: ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const width = 2048, height = 1536;
      const pixels = new Float32Array(width * height * 3);
      for (let i = 0; i < pixels.length; i += 1) pixels[i] = ((i * 2654435761) % 1000) / 1000;
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      // Release the probe context so the preview gets a fresh one.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      const settings = {
        recipeVersion: 2, engineVersion: 1, rawProfileVersion: 1,
        exposure: 0.3, brilliance: 0.2, highlights: -0.2, shadows: 0.3, saturation: 0.1, vibrance: 0.2,
        temperature: 0.05, tint: 0, contrast: 0.1, blackPoint: 0.05, dehaze: 0.1, sharpen: 0.5,
        crop: { x: 0, y: 0, width: 1, height: 1, angle: 3 },
        photoStyle: { preset: "vibrant", palette: 60, tone: 0, colour: 0 },
        gradient: { enabled: true, invert: false, start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 }, feather: 1, exposure: -0.3, highlights: 0, temperature: 0 },
        selectedColor: { center: 0.6, range: 0.12, hue: 0.1, saturation: 0.2, luminance: 0 },
      };
      const target = document.createElement("canvas");
      let lost = false;
      target.addEventListener("webglcontextlost", () => { lost = true; });
      const started = performance.now();
      const preview = new Preview.EditingRenderer(target, { width, height, pixels });
      preview.draw(settings);
      const pixel = preview.readPixel();
      const firstDrawMs = performance.now() - started;
      const again = performance.now();
      for (let i = 0; i < 5; i += 1) preview.draw({ ...settings, exposure: i / 10 });
      preview.readPixel();
      const redrawMs = (performance.now() - again) / 5;
      preview.dispose();
      return { renderer, firstDrawMs, redrawMs, pixel, lost };
    });
    console.log(`WebGL renderer: ${result.renderer}`);
    console.log(`first draw (compile + upload): ${result.firstDrawMs.toFixed(0)} ms, redraw: ${result.redrawMs.toFixed(1)} ms`);
    if (errors.length) throw new Error(`Page errors: ${errors.join("; ")}`);
    if (result.lost) throw new Error("The WebGL context was lost while drawing the preview.");
    if (result.pixel.every((value) => value === 0)) throw new Error("The preview drew only black.");
    if (result.firstDrawMs > LIMIT_MS) throw new Error(`The first preview draw took ${result.firstDrawMs.toFixed(0)} ms (limit ${LIMIT_MS} ms).`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
