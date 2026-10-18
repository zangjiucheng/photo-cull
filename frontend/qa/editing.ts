import { EditingRenderer } from "../src/editing/renderer";
import { defaultSettings } from "../src/editing/recipe";
import type { ExportEnhanceSettings } from "../src/types";

const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
const results = document.querySelector<HTMLPreElement>("pre")!;
document.querySelector("button")!.onclick = async () => {
  results.textContent = "Running…";
  try {
    const fixtures = await (await fetch("./fixtures.json")).json();
    const renderer = new EditingRenderer(canvas, {
      width: fixtures.width,
      height: fixtures.height,
      pixels: new Float32Array(fixtures.pixels),
    });
    const gl = canvas.getContext("webgl")!;
    let maxError = 0;
    const lines = [];
    for (const scenario of fixtures.scenarios as {
      name: string;
      settings: ExportEnhanceSettings;
      expected: number[];
    }[]) {
      renderer.draw(scenario.settings);
      const actual = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        actual,
      );
      let error = 0;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++)
          for (let c = 0; c < 3; c++) {
            error = Math.max(
              error,
              Math.abs(
                actual[((canvas.height - 1 - y) * canvas.width + x) * 4 + c] -
                  scenario.expected[(y * canvas.width + x) * 3 + c],
              ),
            );
          }
      maxError = Math.max(maxError, error);
      lines.push(
        `${error <= 1 ? "PASS" : "FAIL"} ${scenario.name}: max error ${error}/255`,
      );
    }
    renderer.dispose();
    const width = 1600,
      height = 1200;
    const pixels = new Float32Array(width * height * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i % 1000) / 1000;
    const fast = new EditingRenderer(canvas, { width, height, pixels });
    const times: number[] = [];
    for (let i = 0; i < 65; i++) {
      await new Promise(requestAnimationFrame);
      const start = performance.now();
      fast.draw({
        ...defaultSettings,
        exposure: i / 100,
        brilliance: 0.3,
        vibrance: 0.2,
      });
      gl.finish();
      if (i > 4) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    fast.dispose();
    lines.push(
      `\n1600×1200 draw + GPU finish: median ${times[30].toFixed(2)} ms; p95 ${times[57].toFixed(2)} ms`,
    );
    lines.push(
      `Overall color parity: ${maxError <= 1 ? "PASS" : "FAIL"}; ${fixtures.scenarios.length} scenarios; max ${maxError}/255`,
    );
    results.textContent = lines.join("\n");
    results.className = maxError <= 1 ? "pass" : "fail";
  } catch (error) {
    results.textContent = String(error);
    results.className = "fail";
  }
};
