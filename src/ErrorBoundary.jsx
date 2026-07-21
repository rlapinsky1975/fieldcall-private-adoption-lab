import React from "react";

// Catches uncaught render errors anywhere below it in the tree and shows a
// recoverable fallback screen instead of leaving the user with a blank
// white page. This does NOT catch errors inside event handlers, async
// code, or the FieldCall data-fetching logic itself (those already have
// their own try/catch handling) — it's specifically a last-resort net for
// render-time crashes.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Keep this even though there's no error-reporting service wired up
    // yet — it's the only trace left once React unmounts the broken tree.
    console.error("FieldCall render error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily:
            "system-ui, 'Segoe UI', Inter, Roboto, Arial, sans-serif",
          background: "#f6faf7",
          color: "#111827",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            textAlign: "center",
            background: "#fff",
            border: "1px solid #dbe7df",
            borderRadius: 24,
            padding: "32px 28px",
            boxShadow: "0 18px 42px rgba(7,21,40,.12)",
          }}
        >
          <div style={{ fontSize: 34, marginBottom: 10 }}>⚠️</div>
          <h1
            style={{
              fontSize: 22,
              margin: "0 0 10px",
              letterSpacing: "-0.02em",
              color: "#071528",
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              margin: "0 0 20px",
              color: "#475569",
              lineHeight: 1.5,
              fontSize: 15,
            }}
          >
            FieldCall hit an unexpected error and couldn't finish loading
            this screen. Your saved jobs and assessments are safe — try
            reloading the page.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              minHeight: 48,
              padding: "12px 22px",
              borderRadius: 14,
              border: "none",
              background: "#071528",
              color: "#fff",
              fontWeight: 700,
              fontSize: 15,
              cursor: "pointer",
            }}
          >
            Reload FieldCall
          </button>
        </div>
      </div>
    );
  }
}
