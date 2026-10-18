import { useEffect, useState, type ReactNode } from "react";
import browseShot from "../assets/onboarding/browse.webp";
import editorShot from "../assets/onboarding/editor.webp";
import reviewShot from "../assets/onboarding/review.webp";
import similarityShot from "../assets/onboarding/similarity.webp";
import { modLabel } from "../lib/platform";
import type { AiRuntimeStatus } from "../types";
import { Button } from "./ui/button";

const STORAGE_KEY = "photo-cull.onboarding.v1";

/**
 * True until the welcome guide has been finished or skipped on this computer. The desktop app keeps
 * this in its settings file: localStorage belongs to the page's origin, which includes the backend's
 * port, so it alone could forget and show the guide again.
 */
export async function onboardingPending(): Promise<boolean> {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "done") return false;
  } catch {
    // Fall through to the desktop setting.
  }
  if (window.aiCulling?.getOnboardingDone) {
    try {
      return !(await window.aiCulling.getOnboardingDone());
    } catch {
      return false;
    }
  }
  return true;
}

function markOnboardingDone() {
  void window.aiCulling?.setOnboardingDone?.().catch(() => undefined);
  try {
    localStorage.setItem(STORAGE_KEY, "done");
  } catch {
    // The desktop setting above still records it.
  }
}

interface Step {
  kicker: string;
  title: string;
  visual: ReactNode;
  body: ReactNode;
}

function Shot({ src, alt }: { src: string; alt: string }) {
  return <img className="onboarding-shot" src={src} alt={alt} draggable={false} />;
}

const AI_FEATURES: Array<{ feature: string; builtIn: string; ai: string }> = [
  { feature: "Photo scores", builtIn: "Sharpness, exposure, contrast and clipping", ai: "Adds TOPIQ and MUSIQ quality, NIMA and CLIP-IQA aesthetics" },
  { feature: "Similar shots", builtIn: "Near-duplicates by perceptual hash", ai: "Adds the same scene with different framing (CLIP)" },
  { feature: "Upscaling", builtIn: "—", ai: "Real-ESRGAN 2× and 4× on export" },
];

function AiComparison() {
  return (
    <div className="onboarding-compare" role="table" aria-label="Features with and without the AI runtime">
      <div className="onboarding-compare-row head" role="row">
        <span role="columnheader" />
        <span role="columnheader">Built in</span>
        <span role="columnheader">With AI runtime</span>
      </div>
      {AI_FEATURES.map((row) => (
        <div className="onboarding-compare-row" role="row" key={row.feature}>
          <span role="rowheader">{row.feature}</span>
          <span role="cell">{row.builtIn}</span>
          <span role="cell" className="ai">
            {row.ai}
          </span>
        </div>
      ))}
    </div>
  );
}

function Workflow() {
  const stages = ["Open a folder", "Score", "Review", "Similar", "Edit", "Export"];
  return (
    <div className="onboarding-flow" aria-label="Workflow">
      {stages.map((stage, index) => (
        <div className="onboarding-flow-stage" key={stage}>
          <span className="onboarding-flow-index">{index + 1}</span>
          <span>{stage}</span>
        </div>
      ))}
    </div>
  );
}

function AiInstallPanel({ status, onInstall }: { status: AiRuntimeStatus | null; onInstall: () => void }) {
  if (!status?.available) {
    return <p className="onboarding-note">The AI runtime installs from the desktop app. You can do it later from Settings.</p>;
  }
  if (status.installed) {
    return (
      <p className="onboarding-status ok">
        <span aria-hidden="true">✓</span> AI runtime installed{status.using ? " and active" : ""}.
      </p>
    );
  }
  if (status.installing) {
    return (
      <div className="onboarding-status busy" role="status">
        <span className="onboarding-spinner" aria-hidden="true" />
        <span>{status.detail || status.message}</span>
      </div>
    );
  }
  return (
    <div className="onboarding-install">
      {status.state === "error" ? <p className="onboarding-status error">{status.error || status.message}</p> : null}
      <Button onClick={onInstall}>{status.state === "error" ? "Try Again" : "Install AI Runtime"}</Button>
    </div>
  );
}

export function Onboarding({
  open,
  aiRuntimeStatus,
  onInstallAiRuntime,
  onClose,
}: {
  open: boolean;
  aiRuntimeStatus: AiRuntimeStatus | null;
  onInstallAiRuntime: () => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);

  const steps: Step[] = [
    {
      kicker: "Welcome",
      title: "From a full card to finished photos",
      visual: <Shot src={browseShot} alt="The Browse workspace: a grid of scored photos with star ratings" />,
      body: (
        <>
          <p>AI Photo Culling helps you find your best shots, then edit and export them, all in one place.</p>
          <ul>
            <li>Everything runs on this computer. Your photos are never uploaded.</li>
            <li>Originals are never changed. Edits are saved as recipes and applied on export.</li>
            <li>Works with DNG RAW files as well as JPEG, HEIC, PNG, TIFF and WebP.</li>
          </ul>
        </>
      ),
    },
    {
      kicker: "Cull",
      title: "Score, review and rate",
      visual: <Shot src={reviewShot} alt="The Review workspace: a large preview with the filmstrip and score details" />,
      body: (
        <>
          <p>Each photo gets a score as soon as its folder is scanned, so you can sort the strongest shots to the top.</p>
          <ul>
            <li>
              <kbd>H</kbd> <kbd>L</kbd> move between photos, <kbd>Space</kbd> enlarges one.
            </li>
            <li>Rate with stars and press <kbd>Q</kbd> to queue a photo for export.</li>
            <li>
              Press <kbd>?</kbd> at any time to see every shortcut.
            </li>
          </ul>
        </>
      ),
    },
    {
      kicker: "Compare",
      title: "Keep the best of every burst",
      visual: <Shot src={similarityShot} alt="The Similarity workspace: groups of near-identical photos with a suggested keeper" />,
      body: (
        <>
          <p>Similarity groups near-identical frames and suggests the best one to keep.</p>
          <ul>
            <li>Mark the rest for removal in one pass, or queue more than one.</li>
            <li>Removing takes photos out of the workspace only. The files on disk stay where they are.</li>
          </ul>
        </>
      ),
    },
    {
      kicker: "Finish",
      title: "Edit and export",
      visual: <Shot src={editorShot} alt="The Enhance & Export workspace: a photo with styles and light and color controls" />,
      body: (
        <>
          <p>Develop RAW files with styles, a tone and color pad, crop and straighten, then export the whole queue.</p>
          <ul>
            <li>Save looks as presets and name versions of a photo.</li>
            <li>If an export is interrupted, it resumes without redoing finished files.</li>
          </ul>
        </>
      ),
    },
    {
      kicker: "Optional",
      title: "Add the AI runtime",
      visual: <AiComparison />,
      body: (
        <>
          <p>
            The app works without it. The AI runtime adds learned quality and aesthetic models, smarter similarity and
            upscaling.
          </p>
          <ul>
            <li>A one-time download that uses about 2 GB of disk space. Models download the first time they are used.</li>
            <li>
              It needs Python 3.10–3.13. One already on this computer is used, or a private copy is downloaded and
              verified for you. Nothing on your system is changed.
            </li>
            <li>It installs in the background, so you can keep working while it does.</li>
          </ul>
          <AiInstallPanel status={aiRuntimeStatus} onInstall={onInstallAiRuntime} />
        </>
      ),
    },
    {
      kicker: "Ready",
      title: "You're set",
      visual: <Workflow />,
      body: (
        <>
          <p>Open a folder of photos to start. It is scanned and scored in the background while you browse.</p>
          <ul>
            <li>
              <strong>Settings</strong> (<kbd>{modLabel}+,</kbd>) has the AI runtime, its Python and update options.
            </li>
            <li>
              <strong>File → Back Up Library…</strong> saves your ratings, edits and presets in a single file.
            </li>
            <li>You can open this guide again from Settings.</li>
          </ul>
        </>
      ),
    },
  ];

  const last = index === steps.length - 1;
  const finish = () => {
    markOnboardingDone();
    setIndex(0);
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The guide sits above the app: keep its shortcuts from reaching the workspace below.
      event.stopPropagation();
      if (event.key === "Escape") finish();
      else if (event.key === "ArrowRight" && !last) setIndex((current) => current + 1);
      else if (event.key === "ArrowLeft") setIndex((current) => Math.max(0, current - 1));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  if (!open) return null;
  const step = steps[index];

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <section className="onboarding-panel">
        <div className="onboarding-visual">{step.visual}</div>
        <div className="onboarding-content">
          <div className="onboarding-text" key={index}>
            <span className="panel-kicker">
              {step.kicker} · {index + 1} of {steps.length}
            </span>
            <h2 id="onboarding-title">{step.title}</h2>
            {step.body}
          </div>
          <footer className="onboarding-footer">
            <div className="onboarding-dots" role="tablist" aria-label="Guide steps">
              {steps.map((item, dot) => (
                <button
                  key={item.kicker}
                  type="button"
                  role="tab"
                  aria-selected={dot === index}
                  aria-label={`${item.kicker}: ${item.title}`}
                  className={dot === index ? "active" : ""}
                  onClick={() => setIndex(dot)}
                />
              ))}
            </div>
            <div className="onboarding-actions">
              {last ? null : (
                <Button variant="ghost" size="sm" onClick={finish}>
                  Skip
                </Button>
              )}
              {index > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setIndex(index - 1)}>
                  Back
                </Button>
              ) : null}
              <Button size="sm" onClick={last ? finish : () => setIndex(index + 1)}>
                {last ? "Get Started" : step.kicker === "Optional" && !aiRuntimeStatus?.installed && !aiRuntimeStatus?.installing ? "Not Now" : "Next"}
              </Button>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}
