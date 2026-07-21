import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import AdoptionPreview from "./adoption/AdoptionPreview.jsx";
import "./index.css";

const showDesignPreview =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("private-preview") === "1";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      {showDesignPreview ? <AdoptionPreview /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
