import { useState } from "react";
import {
  ActivationChecklist,
  ContractorDecisionPanel,
  FieldCallRecord,
  OutcomeCapture,
  PrivateLabBanner,
  ShadowModeField,
  SignalTimeline,
  TrustCenter,
} from "./AdoptionExperience.jsx";

const SAMPLE_EVENTS = [
  {
    id: "one",
    signal: "GO",
    checked_at: "2026-07-20T15:00:00-04:00",
    window_label: "7:00 AM – 2:00 PM",
  },
  {
    id: "two",
    signal: "WATCH",
    checked_at: "2026-07-21T08:00:00-04:00",
    window_label: "Rain timing moved earlier; workable window narrowed.",
  },
  {
    id: "three",
    signal: "NO GO",
    checked_at: "2026-07-21T15:00:00-04:00",
    window_label: "No reliable paving window identified.",
  },
];

export default function AdoptionPreview() {
  const [shadowEnabled, setShadowEnabled] = useState(true);
  const [shadowDecision, setShadowDecision] = useState("GO");
  const [trustOpen, setTrustOpen] = useState(false);

  if (trustOpen) {
    return (
      <main style={pageStyle}>
        <div style={phoneStyle}>
          <TrustCenter onBack={() => setTrustOpen(false)} />
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={phoneStyle}>
        <PrivateLabBanner />
        <header style={heroStyle}>
          <div style={brandStyle}>
            <img src="/fieldcall-logo.png" alt="FieldCall" style={logoStyle} />
            <strong>FieldCall</strong>
          </div>
          <span style={eyebrowStyle}>PRIVATE WORKFLOW PREVIEW</span>
          <h1 style={titleStyle}>The call stays yours.</h1>
          <p style={copyStyle}>FieldCall monitors the weather beside your judgment and builds proof from your own jobs.</p>
        </header>

        <ActivationChecklist
          activation={{ completedCount: 1, total: 3, complete: false, steps: { firstJob: true, posture: false, alerts: false } }}
          onAddJob={() => {}}
          onReviewPosture={() => {}}
          onConfirmPosture={() => {}}
          onEnableAlerts={() => {}}
        />
        <FieldCallRecord record={{ jobsMonitored: 5, materiallyChanged: 2, callsRecorded: 3, outcomesCaptured: 2 }} />
        <ShadowModeField enabled={shadowEnabled} value={shadowDecision} onChange={setShadowDecision} onToggle={setShadowEnabled} />
        <ContractorDecisionPanel jobId="preview-job" fieldcallSignal="NO GO" onSave={async () => true} />
        <SignalTimeline events={SAMPLE_EVENTS} />
        <OutcomeCapture jobId="preview-job" onSave={async () => true} />
        <button type="button" onClick={() => setTrustOpen(true)} style={trustButtonStyle}>How this call is built</button>
      </div>
    </main>
  );
}

const pageStyle = { minHeight: "100vh", padding: "24px 12px", background: "#eaf0f4", fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" };
const phoneStyle = { width: "100%", maxWidth: "430px", margin: "0 auto", padding: "14px", borderRadius: "28px", background: "#f8fafb", boxShadow: "0 24px 60px rgba(15,42,64,.16)" };
const heroStyle = { padding: "22px", borderRadius: "22px", background: "#15334b", color: "#fff" };
const brandStyle = { display: "flex", alignItems: "center", gap: "9px", marginBottom: "28px" };
const logoStyle = { width: "34px", height: "34px", objectFit: "contain" };
const eyebrowStyle = { color: "#e6c552", fontSize: "10px", fontWeight: 900, letterSpacing: ".12em" };
const titleStyle = { margin: "8px 0", fontSize: "34px", lineHeight: 1.02, letterSpacing: "-.04em" };
const copyStyle = { margin: 0, color: "#d9e4ec", fontSize: "13px", lineHeight: 1.55 };
const trustButtonStyle = { width: "100%", margin: "0 0 8px", padding: "13px", border: "1px solid #cbd8e2", borderRadius: "13px", background: "#fff", color: "#15334b", fontWeight: 900 };
