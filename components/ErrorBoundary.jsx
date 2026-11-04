"use client";
import { Component } from "react";

// Nov 4, 2026: the league-switch crash showed only Next's generic
// "Application error" screen, which hides the actual error. This boundary
// catches a render error in the Predictor, keeps the rest of the page from
// dying, and shows the real error message + stack on screen so it can be
// read (and fixed) instead of guessed at. It never hides the error.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    try { console.error("Joetito render error:", error, info); } catch {}
  }
  render() {
    const { error, info } = this.state;
    if (error) {
      return (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 12px", background: "#0a0a0f", color: "#e2e8f0", fontFamily: "Inter, system-ui, sans-serif", minHeight: "100vh" }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Something went wrong rendering this league — the app did not fully crash.</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Error: {String(error?.message || error)}</div>
          {info?.componentStack && (
            <details style={{ marginTop: 12, fontSize: 11, color: "#cbd5e1", whiteSpace: "pre-wrap" }}>
              <summary>Error details (for diagnosis)</summary>
              {String(info.componentStack)}
            </details>
          )}
          <button onClick={() => window.location.reload()} style={{ marginTop: 16, padding: "8px 14px", borderRadius: 10, background: "#6366f1", color: "#fff", border: "none", fontWeight: 700, cursor: "pointer" }}>Reload page</button>
          <button onClick={() => this.setState({ error: null, info: null })} style={{ marginLeft: 8, marginTop: 16, padding: "8px 14px", borderRadius: 10, background: "#1e293b", color: "#fff", border: "1px solid #334155", fontWeight: 700, cursor: "pointer" }}>Try again without reloading</button>
        </div>
      );
    }
    return this.props.children;
  }
}
