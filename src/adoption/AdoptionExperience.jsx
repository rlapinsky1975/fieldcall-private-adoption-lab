import { useEffect, useMemo, useState } from "react";
import "./adoption.css";

const COPY = {
  en: {
    setupTitle: "Finish setting up FieldCall",
    setupHelp: "Three practical steps put your first job under active monitoring.",
    realJob: "Save one real job",
    realJobHelp: "Use tomorrow’s actual work—not a sample job.",
    posture: "Confirm your company standard",
    postureHelp: "Choose the decision posture you want applied before pressure hits.",
    alerts: "Turn on final-call alerts",
    alertsHelp: "Let FieldCall come to you when the final call is ready.",
    addJob: "Add first job",
    review: "Review setting",
    confirm: "Confirm current standard",
    enable: "Enable alerts",
    monitoring: "FieldCall is monitoring your first job.",
    recordHelp: "Built from your own operation. Not a generic accuracy claim.",
    monitored: "Jobs monitored",
    changed: "Recommendation changes",
    calls: "Final decisions",
    outcomes: "Verified outcomes",
    shadowTitle: "Run beside your judgment",
    shadowHelp: "Make your own call first. FieldCall will compare—not replace it.",
    yourRead: "Before you see FieldCall, what is your current read?",
    optional: "Optional",
    go: "GO",
    delay: "DELAY",
    noGo: "NO GO",
    finalTitle: "My Final Call",
    finalHelp: "FieldCall provides the framework. You still own the decision.",
    localContext: "Local context FieldCall cannot see",
    localPlaceholder: "Site moisture, drainage, haul distance, client restrictions…",
    saveCall: "Save my call",
    saved: "Your call is saved.",
    comparison: "FieldCall assessment",
    yourDecision: "Your decision",
    timelineTitle: "How this call changed",
    timelineHelp: "Each check is preserved so you can see what moved and when.",
    noTimeline: "The first monitoring point will appear after this job is saved and checked.",
    outcomeTitle: "What happened on this job?",
    outcomeHelp: "Two quick answers help build proof and improve the framework.",
    worked: "Worked",
    delayed: "Delayed",
    canceled: "Canceled",
    weatherAffected: "Did weather materially affect the work?",
    helped: "Did FieldCall help you make or communicate the call?",
    yes: "Yes",
    no: "No",
    missing: "What mattered that FieldCall did not know?",
    missingPlaceholder: "Optional local condition or operational factor",
    saveOutcome: "Save outcome",
    outcomeSaved: "Outcome saved. This now counts in your FieldCall Record.",
  },
  es: {
    setupTitle: "Termine de configurar FieldCall",
    setupHelp: "Tres pasos prácticos ponen su primer trabajo bajo monitoreo activo.",
    realJob: "Guarde un trabajo real",
    realJobHelp: "Use el trabajo real de mañana, no un ejemplo.",
    posture: "Confirme el estándar de su empresa",
    postureHelp: "Elija la postura que desea aplicar antes de que llegue la presión.",
    alerts: "Active las alertas de decisión final",
    alertsHelp: "FieldCall le avisará cuando la decisión final esté lista.",
    addJob: "Agregar primer trabajo",
    review: "Revisar ajuste",
    confirm: "Confirmar estándar actual",
    enable: "Activar alertas",
    monitoring: "FieldCall está monitoreando su primer trabajo.",
    recordHelp: "Creado con su propia operación. No es una promesa genérica de precisión.",
    monitored: "Trabajos monitoreados",
    changed: "Cambios de recomendación",
    calls: "Decisiones finales",
    outcomes: "Resultados verificados",
    shadowTitle: "Trabaje junto a su criterio",
    shadowHelp: "Decida primero. FieldCall compara; no reemplaza su criterio.",
    yourRead: "Antes de ver FieldCall, ¿cuál es su lectura actual?",
    optional: "Opcional",
    go: "ADELANTE",
    delay: "DEMORAR",
    noGo: "NO PROCEDER",
    finalTitle: "Mi decisión final",
    finalHelp: "FieldCall aporta el marco. Usted sigue siendo responsable de la decisión.",
    localContext: "Contexto local que FieldCall no puede ver",
    localPlaceholder: "Humedad, drenaje, distancia de acarreo, restricciones del cliente…",
    saveCall: "Guardar mi decisión",
    saved: "Su decisión está guardada.",
    comparison: "Evaluación de FieldCall",
    yourDecision: "Su decisión",
    timelineTitle: "Cómo cambió esta decisión",
    timelineHelp: "Cada revisión se conserva para mostrar qué cambió y cuándo.",
    noTimeline: "El primer punto aparecerá después de guardar y revisar este trabajo.",
    outcomeTitle: "¿Qué ocurrió en este trabajo?",
    outcomeHelp: "Dos respuestas rápidas ayudan a crear evidencia y mejorar el marco.",
    worked: "Se trabajó",
    delayed: "Demorado",
    canceled: "Cancelado",
    weatherAffected: "¿El clima afectó materialmente el trabajo?",
    helped: "¿FieldCall ayudó a decidir o comunicar?",
    yes: "Sí",
    no: "No",
    missing: "¿Qué factor importante no conocía FieldCall?",
    missingPlaceholder: "Condición local o factor operativo opcional",
    saveOutcome: "Guardar resultado",
    outcomeSaved: "Resultado guardado. Ahora cuenta en su historial de FieldCall.",
  },
};

function useCopy(language) {
  return COPY[language === "es" ? "es" : "en"];
}

function ChecklistRow({ done, title, help, children }) {
  return (
    <div className={`fcx-check-row ${done ? "is-done" : ""}`}>
      <div className="fcx-check-icon">{done ? "✓" : ""}</div>
      <div className="fcx-check-copy">
        <strong>{title}</strong>
        <p>{help}</p>
      </div>
      {!done && <div className="fcx-check-action">{children}</div>}
    </div>
  );
}

export function ActivationChecklist({
  language = "en",
  activation,
  onAddJob,
  onReviewPosture,
  onConfirmPosture,
  onEnableAlerts,
}) {
  const c = useCopy(language);
  if (!activation || activation.complete) return null;

  return (
    <section className="fcx-card fcx-activation">
      <div className="fcx-card-heading">
        <div>
          <span className="fcx-eyebrow">{activation.completedCount}/3</span>
          <h3>{c.setupTitle}</h3>
          <p>{c.setupHelp}</p>
        </div>
        <div className="fcx-progress-ring">{activation.completedCount}</div>
      </div>

      <ChecklistRow done={activation.steps.firstJob} title={c.realJob} help={c.realJobHelp}>
        <button type="button" onClick={onAddJob}>{c.addJob}</button>
      </ChecklistRow>

      <ChecklistRow done={activation.steps.posture} title={c.posture} help={c.postureHelp}>
        <div className="fcx-inline-actions">
          <button type="button" className="is-secondary" onClick={onReviewPosture}>{c.review}</button>
          <button type="button" onClick={onConfirmPosture}>{c.confirm}</button>
        </div>
      </ChecklistRow>

      <ChecklistRow done={activation.steps.alerts} title={c.alerts} help={c.alertsHelp}>
        <button type="button" onClick={onEnableAlerts}>{c.enable}</button>
      </ChecklistRow>
    </section>
  );
}

export function FieldCallRecord({ language = "en", record }) {
  const c = useCopy(language);
  const stats = [
    [record?.jobsMonitored || 0, c.monitored],
    [record?.materiallyChanged || 0, c.changed],
    [record?.callsRecorded || 0, c.calls],
    [record?.outcomesCaptured || 0, c.outcomes],
  ];

  return (
    <section className="fcx-card fcx-record">
      <div className="fcx-card-heading compact">
        <div>
          <span className="fcx-eyebrow">FIELD PROOF</span>
          <p>{c.recordHelp}</p>
        </div>
      </div>
      <div className="fcx-stat-grid">
        {stats.map(([value, label]) => (
          <div className="fcx-stat" key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ShadowModeField({ language = "en", enabled, value, onChange, onToggle }) {
  const c = useCopy(language);

  return (
    <section className={`fcx-card fcx-shadow ${enabled ? "is-on" : ""}`}>
      <div className="fcx-shadow-head">
        <div>
          <span className="fcx-eyebrow">SHADOW MODE</span>
          <h3>{c.shadowTitle}</h3>
          <p>{c.shadowHelp}</p>
        </div>
        <button
          type="button"
          className={`fcx-toggle ${enabled ? "is-on" : ""}`}
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
        >
          <span />
        </button>
      </div>

      {enabled && (
        <div className="fcx-shadow-choice">
          <label>{c.yourRead} <small>{c.optional}</small></label>
          <div className="fcx-choice-grid">
            {["GO", "DELAY", "NO GO"].map((decision) => (
              <button
                type="button"
                key={decision}
                className={value === decision ? "is-selected" : ""}
                onClick={() => onChange(value === decision ? "" : decision)}
              >
                {decision === "GO" ? c.go : decision === "DELAY" ? c.delay : c.noGo}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SignalPill({ signal }) {
  const normalized = String(signal || "").toUpperCase();
  return <span className={`fcx-signal signal-${normalized.replaceAll(" ", "-")}`}>{normalized}</span>;
}

export function ContractorDecisionPanel({
  language = "en",
  jobId,
  fieldcallSignal,
  existingDecision,
  onSave,
}) {
  const c = useCopy(language);
  const [decision, setDecision] = useState(existingDecision?.decision || "");
  const [localContext, setLocalContext] = useState(existingDecision?.local_context || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(Boolean(existingDecision));

  useEffect(() => {
    setDecision(existingDecision?.decision || "");
    setLocalContext(existingDecision?.local_context || "");
    setSaved(Boolean(existingDecision));
  }, [existingDecision?.id]);

  if (!jobId) return null;

  async function handleSave() {
    if (!decision) return;
    setSaving(true);
    const ok = await onSave({ decision, localContext });
    setSaving(false);
    setSaved(Boolean(ok));
  }

  return (
    <section className="fcx-card fcx-decision">
      <div className="fcx-card-heading compact">
        <div>
          <span className="fcx-eyebrow">JUDGMENT STAYS FINAL</span>
          <h3>{c.finalTitle}</h3>
          <p>{c.finalHelp}</p>
        </div>
      </div>

      <div className="fcx-compare-row">
        <div><span>{c.comparison}</span><SignalPill signal={fieldcallSignal} /></div>
        {saved && <div><span>{c.yourDecision}</span><SignalPill signal={decision} /></div>}
      </div>

      <div className="fcx-choice-grid">
        {["GO", "DELAY", "NO GO"].map((value) => (
          <button
            type="button"
            key={value}
            className={decision === value ? "is-selected" : ""}
            onClick={() => { setDecision(value); setSaved(false); }}
          >
            {value === "GO" ? c.go : value === "DELAY" ? c.delay : c.noGo}
          </button>
        ))}
      </div>

      <label className="fcx-text-field">
        <span>{c.localContext}</span>
        <textarea
          value={localContext}
          onChange={(event) => { setLocalContext(event.target.value); setSaved(false); }}
          placeholder={c.localPlaceholder}
        />
      </label>

      <button type="button" className="fcx-primary" onClick={handleSave} disabled={!decision || saving}>
        {saving ? "…" : saved ? `✓ ${c.saved}` : c.saveCall}
      </button>
    </section>
  );
}

export function SignalTimeline({ language = "en", events = [] }) {
  const c = useCopy(language);
  const displayEvents = events.slice(-5).reverse();

  return (
    <section className="fcx-card fcx-timeline">
      <div className="fcx-card-heading compact">
        <div>
          <span className="fcx-eyebrow">MONITORING HISTORY</span>
          <h3>{c.timelineTitle}</h3>
          <p>{c.timelineHelp}</p>
        </div>
      </div>

      {displayEvents.length === 0 ? (
        <p className="fcx-empty">{c.noTimeline}</p>
      ) : (
        <div className="fcx-event-list">
          {displayEvents.map((event, index) => (
            <div className="fcx-event" key={event.id}>
              <div className="fcx-event-line"><span /></div>
              <div className="fcx-event-body">
                <div className="fcx-event-top">
                  <SignalPill signal={event.signal} />
                  <time>{new Date(event.checked_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
                </div>
                <strong>{event.window_label || event.reason || "Assessment updated"}</strong>
                {index === 0 && events.length > 1 && <small>Latest monitoring point</small>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function OutcomeCapture({ language = "en", jobId, existingOutcome, onSave }) {
  const c = useCopy(language);
  const [actualDecision, setActualDecision] = useState(existingOutcome?.actual_decision || "");
  const [weatherAffected, setWeatherAffected] = useState(existingOutcome?.weather_materially_affected ?? null);
  const [fieldcallHelped, setFieldcallHelped] = useState(existingOutcome?.fieldcall_helped ?? null);
  const [missingContext, setMissingContext] = useState(existingOutcome?.missing_context || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(Boolean(existingOutcome));

  useEffect(() => {
    setActualDecision(existingOutcome?.actual_decision || "");
    setWeatherAffected(existingOutcome?.weather_materially_affected ?? null);
    setFieldcallHelped(existingOutcome?.fieldcall_helped ?? null);
    setMissingContext(existingOutcome?.missing_context || "");
    setSaved(Boolean(existingOutcome));
  }, [existingOutcome?.id]);

  if (!jobId) return null;

  async function handleSave() {
    setSaving(true);
    const ok = await onSave({ actualDecision, weatherAffected, fieldcallHelped, missingContext });
    setSaving(false);
    setSaved(Boolean(ok));
  }

  return (
    <section className="fcx-card fcx-outcome">
      <div className="fcx-card-heading compact">
        <div>
          <span className="fcx-eyebrow">OUTCOME</span>
          <h3>{c.outcomeTitle}</h3>
          <p>{c.outcomeHelp}</p>
        </div>
      </div>

      <div className="fcx-choice-grid">
        {[["WORKED", c.worked], ["DELAYED", c.delayed], ["CANCELED", c.canceled]].map(([value, label]) => (
          <button type="button" key={value} className={actualDecision === value ? "is-selected" : ""} onClick={() => { setActualDecision(value); setSaved(false); }}>{label}</button>
        ))}
      </div>

      <BinaryQuestion label={c.weatherAffected} value={weatherAffected} onChange={(value) => { setWeatherAffected(value); setSaved(false); }} copy={c} />
      <BinaryQuestion label={c.helped} value={fieldcallHelped} onChange={(value) => { setFieldcallHelped(value); setSaved(false); }} copy={c} />

      <label className="fcx-text-field">
        <span>{c.missing}</span>
        <textarea value={missingContext} onChange={(event) => { setMissingContext(event.target.value); setSaved(false); }} placeholder={c.missingPlaceholder} />
      </label>

      <button type="button" className="fcx-primary" onClick={handleSave} disabled={!actualDecision || weatherAffected === null || fieldcallHelped === null || saving}>
        {saving ? "…" : saved ? `✓ ${c.outcomeSaved}` : c.saveOutcome}
      </button>
    </section>
  );
}

function BinaryQuestion({ label, value, onChange, copy }) {
  return (
    <div className="fcx-binary">
      <span>{label}</span>
      <div>
        <button type="button" className={value === true ? "is-selected" : ""} onClick={() => onChange(true)}>{copy.yes}</button>
        <button type="button" className={value === false ? "is-selected" : ""} onClick={() => onChange(false)}>{copy.no}</button>
      </div>
    </div>
  );
}

export function TrustCenter({ language = "en", onBack }) {
  const spanish = language === "es";
  const sections = useMemo(() => spanish ? [
    ["Lo que hace FieldCall", "Compara señales confiables del pronóstico y aplica una lógica específica del servicio, la ventana de trabajo y la tolerancia de la empresa."],
    ["Lo que no puede ver", "Condiciones del sitio, humedad real, drenaje, capacidad de la cuadrilla, distancia de acarreo, disponibilidad de planta y restricciones del cliente siguen requiriendo criterio local."],
    ["Por qué cambia una decisión", "Las señales se revisan con el tiempo. Cuando cambia la lluvia, la ventana viable, el acuerdo entre fuentes o un riesgo de calidad o seguridad, la evaluación puede cambiar."],
    ["Quién toma la decisión final", "Usted. FieldCall muestra una evaluación estructurada; la persona responsable conserva y registra la decisión final."],
    ["Cómo se crea evidencia", "FieldCall guarda los puntos de monitoreo, su decisión y el resultado real. Esto construye un historial de su propia operación sin prometer una precisión imposible."],
  ] : [
    ["What FieldCall does", "It compares trusted forecast signals and applies logic for the service, work window, and company decision posture."],
    ["What it cannot see", "Actual site moisture, drainage, crew capability, haul distance, plant availability, and client restrictions still require local judgment."],
    ["Why a call can change", "Signals are reviewed over time. If rain timing, the workable window, source agreement, or a quality or safety risk changes, the assessment may change."],
    ["Who owns the final call", "You do. FieldCall presents a structured assessment; the responsible person records and owns the final decision."],
    ["How proof is built", "FieldCall preserves monitoring points, your decision, and the real outcome. That creates a record from your operation without making an impossible accuracy promise."],
  ], [spanish]);

  return (
    <section className="fcx-trust-screen">
      <button type="button" className="fcx-back" onClick={onBack}>← {spanish ? "Panel" : "Dashboard"}</button>
      <div className="fcx-trust-hero">
        <span className="fcx-eyebrow">{spanish ? "METODOLOGÍA" : "METHODOLOGY"}</span>
        <h2>{spanish ? "Cómo FieldCall apoya una decisión responsable" : "How FieldCall supports a responsible call"}</h2>
        <p>{spanish ? "No es magia. No es una garantía. Es un marco más claro para trabajar con información imperfecta." : "Not magic. Not a guarantee. A clearer framework for working with imperfect information."}</p>
      </div>
      <div className="fcx-trust-list">
        {sections.map(([title, body], index) => (
          <article key={title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><h3>{title}</h3><p>{body}</p></div>
          </article>
        ))}
      </div>
      <div className="fcx-trust-note">
        <strong>{spanish ? "La promesa" : "The promise"}</strong>
        <p>{spanish ? "Menos revisiones repetidas. Más consistencia. Su criterio sigue siendo final." : "Less repeated checking. More consistency. Your judgment stays final."}</p>
      </div>
    </section>
  );
}
