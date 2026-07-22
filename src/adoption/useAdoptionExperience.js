import { useCallback, useEffect, useMemo, useState } from "react";

const EMPTY_JOURNEY = {
  shadow_mode_enabled: true,
  show_field_proof_on_dashboard: true,
  risk_posture_confirmed_at: null,
  activation_completed_at: null,
};

export function useAdoptionExperience({
  supabase,
  userId,
  companyId,
  jobs = [],
  pushAlertsEnabled = false,
}) {
  const [journey, setJourney] = useState(EMPTY_JOURNEY);
  const [decisions, setDecisions] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [signalEvents, setSignalEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadedScope, setLoadedScope] = useState("");
  const [message, setMessage] = useState("");

  const activeScope = userId && companyId ? `${userId}:${companyId}` : "";
  const journeyLoaded = Boolean(activeScope && loadedScope === activeScope);

  const load = useCallback(async () => {
    if (!supabase || !userId || !companyId) {
      setJourney(EMPTY_JOURNEY);
      setDecisions([]);
      setOutcomes([]);
      setSignalEvents([]);
      setLoadedScope("");
      return;
    }

    const scopeBeingLoaded = `${userId}:${companyId}`;
    setLoadedScope("");
    setLoading(true);

    try {
      const [journeyResult, decisionsResult, outcomesResult, eventsResult] =
        await Promise.all([
          supabase
            .from("fieldcall_user_journeys")
            .select("*")
            .eq("user_id", userId)
            .eq("company_id", companyId)
            .maybeSingle(),
          supabase
            .from("contractor_decisions")
            .select("*")
            .eq("user_id", userId)
            .eq("company_id", companyId)
            .order("decided_at", { ascending: false })
            .limit(200),
          supabase
            .from("job_outcomes")
            .select("*")
            .eq("user_id", userId)
            .eq("company_id", companyId)
            .order("submitted_at", { ascending: false })
            .limit(100),
          supabase
            .from("job_signal_events")
            .select("*")
            .eq("company_id", companyId)
            .eq("user_id", userId)
            .order("checked_at", { ascending: false })
            .limit(300),
        ]);

      const firstError =
        journeyResult.error ||
        decisionsResult.error ||
        outcomesResult.error ||
        eventsResult.error;

      if (firstError) throw firstError;

      setJourney({ ...EMPTY_JOURNEY, ...(journeyResult.data || {}) });
      setDecisions(decisionsResult.data || []);
      setOutcomes(outcomesResult.data || []);
      setSignalEvents(eventsResult.data || []);
      setLoadedScope(scopeBeingLoaded);
      setMessage("");
    } catch (error) {
      setMessage(
        error?.message ||
          "The private test features could not be loaded. Apply the included migration first."
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, userId, companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const upsertJourney = useCallback(
    async (patch) => {
      if (!supabase || !userId || !companyId) return false;

      const nextJourney = {
        ...journey,
        ...patch,
        user_id: userId,
        company_id: companyId,
        updated_at: new Date().toISOString(),
      };

      setJourney(nextJourney);

      const { data, error } = await supabase
        .from("fieldcall_user_journeys")
        .upsert(nextJourney, { onConflict: "user_id,company_id" })
        .select("*")
        .single();

      if (error) {
        setMessage(error.message || "Setup progress could not be saved.");
        await load();
        return false;
      }

      setJourney({ ...EMPTY_JOURNEY, ...data });
      setMessage("");
      return true;
    },
    [supabase, userId, companyId, journey, load]
  );

  const setShadowMode = useCallback(
    (enabled) => upsertJourney({ shadow_mode_enabled: Boolean(enabled) }),
    [upsertJourney]
  );

  const setShowFieldProofOnDashboard = useCallback(
    (enabled) =>
      upsertJourney({
        show_field_proof_on_dashboard: Boolean(enabled),
      }),
    [upsertJourney]
  );

  const confirmRiskPosture = useCallback(
    () => upsertJourney({ risk_posture_confirmed_at: new Date().toISOString() }),
    [upsertJourney]
  );

  const submitDecision = useCallback(
    async ({ jobId, stage, decision, localContext = "", fieldcallSignal = "" }) => {
      if (!supabase || !userId || !companyId || !jobId || !decision) return false;

      const payload = {
        company_id: companyId,
        job_id: jobId,
        user_id: userId,
        stage,
        decision,
        local_context: localContext.trim() || null,
        fieldcall_signal: fieldcallSignal || null,
        decided_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("contractor_decisions")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        setMessage(error.message || "Your call could not be saved.");
        return false;
      }

      setDecisions((current) => [
        data,
        ...current.filter(
          (item) =>
            !(
              item.job_id === data.job_id &&
              item.user_id === data.user_id &&
              item.stage === data.stage
            )
        ),
      ]);
      setMessage("");
      return true;
    },
    [supabase, userId, companyId]
  );

  const submitOutcome = useCallback(
    async ({
      jobId,
      actualDecision,
      weatherAffected,
      fieldcallHelped,
      missingContext = "",
    }) => {
      if (!supabase || !userId || !companyId || !jobId || !actualDecision) {
        return false;
      }

      const payload = {
        company_id: companyId,
        job_id: jobId,
        user_id: userId,
        actual_decision: actualDecision,
        weather_materially_affected: weatherAffected,
        fieldcall_helped: fieldcallHelped,
        missing_context: missingContext.trim() || null,
        submitted_at: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("job_outcomes")
        .insert(payload)
        .select("*")
        .single();

      if (error) {
        setMessage(error.message || "The job outcome could not be saved.");
        return false;
      }

      setOutcomes((current) => [
        data,
        ...current.filter(
          (item) => !(item.job_id === data.job_id && item.user_id === data.user_id)
        ),
      ]);
      setMessage("");
      return true;
    },
    [supabase, userId, companyId]
  );

  const activation = useMemo(() => {
    // Until the saved journey has loaded, there is no reliable basis for
    // deciding whether onboarding is complete. Returning null prevents the
    // new-user checklist from flashing during login.
    if (!journeyLoaded) return null;

    const steps = {
      firstJob: jobs.length > 0,
      posture: Boolean(journey.risk_posture_confirmed_at),
      alerts: Boolean(pushAlertsEnabled),
    };
    const completedCount = Object.values(steps).filter(Boolean).length;
    const completedPreviously = Boolean(journey.activation_completed_at);

    return {
      steps,
      completedCount,
      total: 3,
      // Activation is a one-time milestone. Turning an optional preference such
      // as final-call alerts off later must not reopen the startup checklist.
      complete: completedPreviously || completedCount === 3,
    };
  }, [
    jobs.length,
    journeyLoaded,
    journey.risk_posture_confirmed_at,
    journey.activation_completed_at,
    pushAlertsEnabled,
  ]);

  useEffect(() => {
    if (!activation?.complete || journey.activation_completed_at) return;
    upsertJourney({ activation_completed_at: new Date().toISOString() });
  }, [activation?.complete, journey.activation_completed_at, upsertJourney]);

  const record = useMemo(() => {
    const eventsByJob = new Map();
    signalEvents.forEach((event) => {
      const list = eventsByJob.get(event.job_id) || [];
      list.push(event);
      eventsByJob.set(event.job_id, list);
    });

    const materiallyChanged = Array.from(eventsByJob.values()).filter((events) => {
      return new Set(events.map((event) => event.signal).filter(Boolean)).size > 1;
    }).length;

    const finalDecisions = decisions.filter((item) => item.stage === "before_fieldcall");
    const aligned = finalDecisions.filter((item) => {
      if (item.decision === "DELAY") return item.fieldcall_signal === "WATCH";
      return item.decision === item.fieldcall_signal;
    }).length;

    const agreementRate = finalDecisions.length
      ? Math.round((aligned / finalDecisions.length) * 100)
      : null;

    return {
      jobsMonitored: eventsByJob.size,
      callsRecorded: finalDecisions.length,
      materiallyChanged,
      outcomesCaptured: outcomes.length,
      aligned,
      agreementRate,
    };
  }, [signalEvents, decisions, outcomes]);

  const getJobExperience = useCallback(
    (jobId) => ({
      decisions: decisions.filter((item) => item.job_id === jobId),
      outcome: outcomes.find((item) => item.job_id === jobId) || null,
      signalEvents: signalEvents
        .filter((item) => item.job_id === jobId)
        .sort((a, b) => new Date(a.checked_at) - new Date(b.checked_at)),
    }),
    [decisions, outcomes, signalEvents]
  );

  return {
    journey,
    decisions,
    outcomes,
    signalEvents,
    loading,
    journeyLoaded,
    message,
    activation,
    record,
    reload: load,
    setShadowMode,
    setShowFieldProofOnDashboard,
    confirmRiskPosture,
    submitDecision,
    submitOutcome,
    getJobExperience,
  };
}
