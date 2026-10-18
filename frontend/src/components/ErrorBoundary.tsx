import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one failing view from blanking the whole window: shows what went wrong (also logged to
 * renderer.log by the desktop app) and lets the user try again.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} failed: ${error.stack || error.message}${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="workspace-panel error-boundary" role="alert">
        <h2>{this.props.label} stopped working</h2>
        <p className="debug-message error">{error.message}</p>
        <p className="debug-message">
          Other workspaces still work. If this keeps happening, send the renderer.log from the app's data folder with
          your bug report.
        </p>
        <div className="debug-actions">
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => this.setState({ error: null })}>
            Try Again
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => void navigator.clipboard.writeText(`${error.stack || error.message}`)}
          >
            Copy Details
          </button>
        </div>
      </div>
    );
  }
}
