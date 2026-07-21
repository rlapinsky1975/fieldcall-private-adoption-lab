import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Analytics } from "@vercel/analytics/react";
import {
  getAnalyticsEntryContext,
  trackEvent as trackFieldCallEvent,
  trackPageView,
} from "./analytics.js";
import {
  ActivationChecklist,
  ContractorDecisionPanel,
  FieldCallRecord,
  OutcomeCapture,
  PrivateLabBanner,
  ShadowModeField,
  SignalTimeline,
  TrustCenter,
} from "./adoption/AdoptionExperience.jsx";
import { useAdoptionExperience } from "./adoption/useAdoptionExperience.js";

const FIELDCALL_SITE_URL = "https://myfieldcall.com";
const FIELDCALL_SUPPORT_EMAIL = "fieldcallsupport@gmail.com";
const PASSWORD_RESET_REDIRECT_URL = `${window.location.origin}/?mode=reset-password`;

function getInitialAuthMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");

    if (mode === "login") return "login";
    if (mode === "join") return "join";
    if (mode === "create") return "create";
    if (mode === "forgot") return "forgot";

    return "create";
  } catch {
    return "create";
  }
}

function getEntryMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");

    if (mode === "create") return "create";
    if (mode === "join") return "join";
    if (mode === "login") return "login";
    if (mode === "guest") return "guest";

    return "";
  } catch {
    return "";
  }
}

function decodeGuestAssessmentPayload(encodedPayload) {
  if (!encodedPayload) {
    throw new Error("Guest assessment information is missing.");
  }

  try {
    const normalized = String(encodedPayload)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("This guest assessment link is invalid. Return to FieldCall and try again.");
  }
}

function normalizeGuestAssessmentPayload(rawPayload) {
  if (!rawPayload || rawPayload.handoffVersion !== 1) {
    throw new Error("This guest assessment link is not supported. Return to FieldCall and try again.");
  }

  const expiresAt = new Date(rawPayload.guestExpiresAt || "");
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new Error("This guest assessment link has expired. Return to FieldCall and run it again.");
  }

  const selectedLocation = rawPayload.selectedLocation || {};
  const latitude = Number(selectedLocation.latitude);
  const longitude = Number(selectedLocation.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("The selected location could not be read. Return to FieldCall and select it again.");
  }

  const allowedServices = new Set([
    "Paving",
    "Striping",
    "Sealcoat",
    "Concrete",
    "Crack Seal",
  ]);
  const allowedOperatingWindows = new Set(["Day", "Night"]);
  const allowedFinalCallTimes = new Set(["12:00", "15:00", "18:00"]);
  const allowedSurfaceConditions = new Set([
    "Overlay",
    "Milled",
    "Subgrade currently exposed",
    "Subgrade exposed & paved same day",
  ]);

  const workType = allowedServices.has(rawPayload.workType)
    ? rawPayload.workType
    : "Paving";
  const operatingWindow = allowedOperatingWindows.has(rawPayload.operatingWindow)
    ? rawPayload.operatingWindow
    : "Day";
  const requestedFinalCallTime = String(
    rawPayload.finalCallTime || "15:00"
  ).slice(0, 5);
  const finalCallTime = allowedFinalCallTimes.has(requestedFinalCallTime)
    ? requestedFinalCallTime
    : "15:00";
  const surfaceCondition = allowedSurfaceConditions.has(rawPayload.surfaceCondition)
    ? rawPayload.surfaceCondition
    : "Subgrade exposed & paved same day";

  if (!rawPayload.workDate) {
    throw new Error("The work date is missing. Return to FieldCall and try again.");
  }

  return {
    projectName: String(rawPayload.projectName || "Guest FieldCall").trim() || "Guest FieldCall",
    locationQuery:
      String(rawPayload.locationQuery || selectedLocation.formattedAddress || "").trim(),
    selectedLocation: {
      displayName:
        String(selectedLocation.displayName || rawPayload.projectName || "Selected location").trim(),
      formattedAddress:
        String(selectedLocation.formattedAddress || rawPayload.locationQuery || "").trim(),
      city: String(selectedLocation.city || rawPayload.city || "").trim(),
      state: String(selectedLocation.state || rawPayload.state || "").trim(),
      latitude,
      longitude,
    },
    city: String(rawPayload.city || selectedLocation.city || "").trim(),
    state: String(rawPayload.state || selectedLocation.state || "").trim(),
    workDate: String(rawPayload.workDate),
    workType,
    operatingWindow,
    surfaceCondition:
      workType === "Paving" ? surfaceCondition : "Subgrade exposed & paved same day",
    baseExposed:
      workType === "Paving" && surfaceCondition === "Subgrade currently exposed"
        ? "Yes"
        : "No",
    multiDay: "No",
    finalCallTime,
    saveToQueue: false,
    weatherCallCaution: "balanced",
    workableRainProbabilityThreshold: 30,
  minimumWorkableWindowHours: 2,
  skipBackendHistorySave: true,
  shadowDecision: "",
  };
}

function getCompanySettingsSnapshot(settings = {}) {
  return JSON.stringify({
    weatherCallCaution: normalizeWeatherCallCaution(settings.weatherCallCaution),
    defaultFinalCallTime: normalizeFinalCallTime(settings.defaultFinalCallTime),
    workableRainProbabilityThreshold: normalizeWorkableRainThreshold(
      settings.workableRainProbabilityThreshold
    ),
    minimumWorkableWindowHours: normalizeMinimumWorkableWindowHours(
      settings.minimumWorkableWindowHours
    ),
  });
}

// =====================================================
// SECTION 1 — MAIN APP COMPONENT
// Contains app state, auth, job actions, screens, and UI render.
// =====================================================

export default function App() {
  // -----------------------------------------------------
  // 1A — APP STATE
  // -----------------------------------------------------

  const entryMode = getEntryMode();
  const initialGuestMode = entryMode === "guest";
  const [screen, setScreen] = useState(() =>
    initialGuestMode ? "guestLoading" : "dashboard"
  );
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
const [loadingBackendJobs, setLoadingBackendJobs] = useState(false);
const [checkingJobId, setCheckingJobId] = useState(null);
const [dashboardAutoRefreshRunning, setDashboardAutoRefreshRunning] = useState(false);
const dashboardAutoRefreshRunKey = useRef("");
const [session, setSession] = useState(null);
const [authMode, setAuthMode] = useState(() => getInitialAuthMode());
const [authEmail, setAuthEmail] = useState("");
const [authPassword, setAuthPassword] = useState("");
const [companyName, setCompanyName] = useState("");
const [joinCompanyId, setJoinCompanyId] = useState("");
const [activeCompanyId, setActiveCompanyId] = useState("");
const [activeCompanyName, setActiveCompanyName] = useState("");
const [activeCompanyRole, setActiveCompanyRole] = useState("");
const [companySettings, setCompanySettings] = useState({
  weatherCallCaution: "balanced",
  autoRefreshSavedJobs: true,
  defaultFinalCallTime: "15:00",
  workableRainProbabilityThreshold: 30,
  minimumWorkableWindowHours: 2,
});
const [companySettingsLoading, setCompanySettingsLoading] = useState(false);
const [companySettingsSaving, setCompanySettingsSaving] = useState(false);
const [companySettingsMessage, setCompanySettingsMessage] = useState("");
const [openCompanySetting, setOpenCompanySetting] = useState("");
const companySettingsBaselineRef = useRef("");
const [accountMessage, setAccountMessage] = useState("");
const [newPassword, setNewPassword] = useState("");
const [confirmNewPassword, setConfirmNewPassword] = useState("");
const [passwordSaving, setPasswordSaving] = useState(false);
const [deleteAccountPreview, setDeleteAccountPreview] = useState(null);
const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);
const [deleteAccountMessage, setDeleteAccountMessage] = useState("");
const [deleteAccountPassword, setDeleteAccountPassword] = useState("");
const [deleteAccountConfirmation, setDeleteAccountConfirmation] = useState("");
const [deleteAccountTransferUserId, setDeleteAccountTransferUserId] = useState("");
const [deleteCompanyPassword, setDeleteCompanyPassword] = useState("");
const [deleteCompanyConfirmation, setDeleteCompanyConfirmation] = useState("");
const [deleteCompanyMessage, setDeleteCompanyMessage] = useState("");
const [destructiveActionLoading, setDestructiveActionLoading] = useState(false);
const [authMessage, setAuthMessage] = useState("");
const [authLoading, setAuthLoading] = useState(false);
const [guestMode, setGuestMode] = useState(initialGuestMode);
const [guestEntryError, setGuestEntryError] = useState("");
const guestAssessmentStartedRef = useRef(false);
const pendingGuestImportRef = useRef(false);
const lastSavedJobRef = useRef(null);
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [savedJobs, setSavedJobs] = useState([]);
  const [showPreliminaryJobs, setShowPreliminaryJobs] = useState(false);
  const [showCallsMade, setShowCallsMade] = useState(false);
  const [defaultService, setDefaultService] = useState(() => getSavedDefaultServicePreference());
  const [serviceOptions, setServiceOptions] = useState(SERVICE_OPTIONS);
const [editingDateJobId, setEditingDateJobId] = useState(null);
const [editingDateValue, setEditingDateValue] = useState("");

const [form, setForm] = useState({
  projectName: "",
  locationQuery: "",
  selectedLocation: null,
  city: "",
  state: "",
  workDate: getTomorrowDate(),
  workType: "Paving",
  operatingWindow: "Day",
  surfaceCondition: "Subgrade exposed & paved same day",
  baseExposed: "No",
  multiDay: "No",
  finalCallTime: "15:00",
  saveToQueue: false,
  shadowDecision: "",
});

  const [result, setResult] = useState(null);
  const [resultMode, setResultMode] = useState("details");
  const [selectedMessageAudience, setSelectedMessageAudience] = useState("client");
  const [messageDraft, setMessageDraft] = useState("");
  const [showWeatherDetails, setShowWeatherDetails] = useState(false);
  const [resultJobContext, setResultJobContext] = useState(null);
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
const [showInstallHelp, setShowInstallHelp] = useState(false);
const [pushAlertsEnabled, setPushAlertsEnabled] = useState(false);
const [pushAlertsLoading, setPushAlertsLoading] = useState(false);
const [pushAlertMessage, setPushAlertMessage] = useState("");
const [language, setLanguage] = useState(() => getSavedLanguagePreference());
const t = (key, replacements = {}) => translateAppText(language, key, replacements);
const canManageCompanySettings = ["owner", "admin"].includes(
  String(activeCompanyRole || "").toLowerCase()
);
// Keep one consistent auth landing for login, create, and join entry links.
// URL mode still selects the starting tab through getInitialAuthMode().
const isCreateEntry = false;
const userHasNoCompany = Boolean(session && !activeCompanyId);
const adoption = useAdoptionExperience({
  supabase,
  userId: session?.user?.id || "",
  companyId: activeCompanyId,
  jobs: savedJobs,
  pushAlertsEnabled,
});

useEffect(() => {
  const entryContext = getAnalyticsEntryContext();

  trackPageView(`${window.location.pathname}${window.location.search}`, document.title);
  trackFieldCallEvent("app_intake_viewed", entryContext);
}, []);

function handleLanguageChange(nextLanguage) {
  setLanguage(nextLanguage);
  saveLanguagePreference(nextLanguage);
}


  // -----------------------------------------------------
  // 1B — AUTH SESSION + COMPANY CONNECTION
  // Loads the logged-in user and active company relationship.
  // -----------------------------------------------------

  useEffect(() => {
    if (!supabase) return;

    loadServiceOptions();

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);

      if (data.session?.user?.id) {
        loadUserCompany(data.session.user.id);

        const params = new URLSearchParams(window.location.search);
        if (params.get("mode") === "reset-password") {
          setScreen("resetPassword");
        }
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        setSession(nextSession || null);

        if (event === "PASSWORD_RECOVERY") {
          setScreen("resetPassword");
        }

        if (nextSession?.user?.id) {
          loadUserCompany(nextSession.user.id);
        } else {
  setActiveCompanyId("");
  setActiveCompanyName("");
  setActiveCompanyRole("");
  setSavedJobs([]);
}
      }
    );

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

useEffect(() => {
  if (!guestMode || guestAssessmentStartedRef.current) return;

  guestAssessmentStartedRef.current = true;

  async function startGuestAssessment() {
    setGuestEntryError("");
    setError("");
    setScreen("guestLoading");

    try {
      const params = new URLSearchParams(window.location.search);
      let storedGuestPayload = "";

      try {
        storedGuestPayload =
          window.sessionStorage.getItem("fieldcall_guest_handoff_payload") || "";
      } catch {
        // The in-memory handoff still works when session storage is unavailable.
      }

      const encodedGuestPayload =
        params.get("payload") ||
        window.__FIELDCALL_GUEST_PAYLOAD__ ||
        storedGuestPayload;
      const rawPayload = decodeGuestAssessmentPayload(encodedGuestPayload);
      const guestJob = normalizeGuestAssessmentPayload(rawPayload);

      setForm(guestJob);

      trackFieldCallEvent("guest_assessment_loaded", {
        ...getAnalyticsEntryContext(),
        service: guestJob.workType,
        operating_window: guestJob.operatingWindow,
        final_call_time: normalizeFinalCallTime(guestJob.finalCallTime),
      });

      const completed = await runWeatherCheck(guestJob, {
        shouldSave: false,
        openResult: true,
        guestAssessment: true,
      });

      if (completed) {
        window.__FIELDCALL_GUEST_PAYLOAD__ = "";
        try {
          window.sessionStorage.removeItem("fieldcall_guest_handoff_payload");
        } catch {
          // Cleanup is best-effort only.
        }
      } else {
        setScreen("guestError");
      }
    } catch (guestError) {
      window.__FIELDCALL_GUEST_PAYLOAD__ = "";
      try {
        window.sessionStorage.removeItem("fieldcall_guest_handoff_payload");
      } catch {
        // Cleanup is best-effort only.
      }

      const message =
        guestError?.message ||
        "The guest assessment could not be opened. Return to FieldCall and try again.";
      setGuestEntryError(message);
      setError(message);
      setScreen("guestError");

      trackFieldCallEvent("guest_assessment_failed", {
        ...getAnalyticsEntryContext(),
        failure_stage: "handoff",
      });
    }
  }

  startGuestAssessment();
}, [guestMode]);

  useEffect(() => {
  function handleBeforeInstallPrompt(event) {
    event.preventDefault();
    setInstallPromptEvent(event);
  }

  function handleAppInstalled() {
    setInstallPromptEvent(null);
    setShowInstallHelp(false);
  }

  window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  window.addEventListener("appinstalled", handleAppInstalled);

  return () => {
    window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.removeEventListener("appinstalled", handleAppInstalled);
  };
}, []);

useEffect(() => {
  document.documentElement.lang = language === "es" ? "es" : "en";
}, [language]);

useEffect(() => {
  if (
    screen === "companySettings" &&
    !companySettingsLoading &&
    !companySettingsBaselineRef.current
  ) {
    companySettingsBaselineRef.current = getCompanySettingsSnapshot(companySettings);
  }
}, [screen, companySettingsLoading, companySettings]);

useEffect(() => {
  checkPushAlertStatus();
}, [session?.user?.id, activeCompanyId]);

useEffect(() => {
  const userId = session?.user?.id;
  const refreshKey = `${activeCompanyId || "none"}-${userId || "none"}`;

  if (!activeCompanyId || !userId || savedJobs.length === 0) return;
  if (companySettings.autoRefreshSavedJobs === false) return;
  if (dashboardAutoRefreshRunKey.current === refreshKey) return;

  dashboardAutoRefreshRunKey.current = refreshKey;
  refreshEligibleSavedJobs(savedJobs, { source: "auto" });
}, [activeCompanyId, session?.user?.id, savedJobs.length, companySettings.autoRefreshSavedJobs]);

useEffect(() => {
  if (!activeCompanyId || !session?.user?.id) return;
  if (screen !== "dashboard") return;

  const hasPendingAutomaticFinalCall = savedJobs.some((job) => {
    const status = String(
      job?.autoFinalCallStatus || ""
    ).toLowerCase();

    return (
      !isSavedJobFinalResult(job) &&
      ["pending", "processing"].includes(status)
    );
  });

  if (!hasPendingAutomaticFinalCall) return;

  let pollInFlight = false;

  async function pollPendingFinalCalls() {
    if (pollInFlight) return;
    if (document.visibilityState === "hidden") return;

    pollInFlight = true;

    try {
      await loadJobsFromBackend("", "", { silent: true });
      await adoption.reload();
    } finally {
      pollInFlight = false;
    }
  }

  const intervalId = window.setInterval(
    pollPendingFinalCalls,
    30000
  );

  return () => {
    window.clearInterval(intervalId);
  };
}, [
  activeCompanyId,
  session?.user?.id,
  screen,
  savedJobs,
]);

async function checkPushAlertStatus() {
  if (!session?.user?.id || !supabase) {
    setPushAlertsEnabled(false);
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setPushAlertsEnabled(false);
    return;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration("/fieldcall-sw.js");
    const subscription = await registration?.pushManager?.getSubscription?.();

    if (!subscription?.endpoint) {
      setPushAlertsEnabled(false);
      return;
    }

    const { data } = await supabase
      .from("push_subscriptions")
      .select("id, enabled")
      .eq("endpoint", subscription.endpoint)
      .eq("user_id", session.user.id)
      .maybeSingle();

    setPushAlertsEnabled(Boolean(data?.enabled));
  } catch {
    setPushAlertsEnabled(false);
  }
}

async function loadServiceOptions() {
  if (!supabase) {
    setServiceOptions(SERVICE_OPTIONS);
    return;
  }

  const { data, error } = await supabase
    .from("service_scoring_profiles")
    .select("service_name, display_name, sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("service_name", { ascending: true });

  if (error || !Array.isArray(data) || data.length === 0) {
    setServiceOptions(SERVICE_OPTIONS);
    return;
  }

  const serviceNames = data
    .map((service) => service.service_name)
    .filter(Boolean);

  setServiceOptions(serviceNames);

  setDefaultService((currentDefault) =>
    serviceNames.includes(currentDefault)
      ? currentDefault
      : serviceNames[0] || "Paving"
  );

  setForm((currentForm) => {
    const nextWorkType = serviceNames.includes(currentForm.workType)
      ? currentForm.workType
      : serviceNames[0] || "Paving";

    const nextSurfaceCondition = isPavingService(nextWorkType)
      ? currentForm.surfaceCondition || "Subgrade exposed & paved same day"
      : "Subgrade exposed & paved same day";

    return {
      ...currentForm,
      workType: nextWorkType,
      surfaceCondition: nextSurfaceCondition,
      baseExposed: isPavingService(nextWorkType)
        ? getBaseExposedFromSurfaceCondition(nextSurfaceCondition)
        : "No",
    };
  });
}

  async function loadUserCompany(userId) {
    if (!supabase || !userId) return null;

    const { data, error } = await supabase
      .from("company_users")
      .select("company_id, role, companies(name)")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();

    if (error) {
      setAuthMessage(error.message);
      return null;
    }

    if (data?.company_id) {
      setActiveCompanyId(data.company_id);
      setActiveCompanyName(data.companies?.name || "Company");
      setActiveCompanyRole(data.role || "member");
      await loadCompanySettings(data.company_id);
      const importedGuestAssessment = await importPendingGuestAssessment(
        data.company_id,
        userId
      );
      await loadJobsFromBackend(data.company_id, userId);

      if (importedGuestAssessment) {
        setCopyNotice(
          language === "es"
            ? "Su primera evaluación de FieldCall fue guardada."
            : "Your first FieldCall assessment was saved."
        );
      }

      return data;
    }

    setActiveCompanyId("");
    setActiveCompanyName("");
    setActiveCompanyRole("");
    setSavedJobs([]);
    setAuthMode("join");
    setAuthMessage(t("finishCompanySetupLoginMessage"));

    return null;
  }

  // -----------------------------------------------------
  // 1B.1 — LOGIN, COMPANY CREATE/JOIN, AND LOGOUT
  // -----------------------------------------------------

  async function handleLogin() {
    if (!supabase) {
      setAuthMessage("Supabase is not configured.");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("");

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: authEmail.trim(),
        password: authPassword,
      });

      if (error) {
        trackFieldCallEvent("app_login_failed", {
          ...getAnalyticsEntryContext(),
          failure_stage: "credentials",
        });
        setAuthMessage(error.message);
        return;
      }

      const userId = data?.session?.user?.id;

      if (userId) {
        const companyConnection = await loadUserCompany(userId);

        if (!companyConnection?.company_id) {
          trackFieldCallEvent("app_login_no_company", {
            ...getAnalyticsEntryContext(),
          });
          return;
        }
      }

      trackFieldCallEvent("app_login_success", {
        ...getAnalyticsEntryContext(),
      });
      trackFieldCallEvent("login", {
        ...getAnalyticsEntryContext(),
        method: "email",
      });

      setAuthMessage("Logged in.");
    } catch (err) {
      setAuthMessage(err.message || "Login failed.");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleRequestPasswordReset() {
    if (!supabase) {
      setAuthMessage(t("passwordResetUnavailable"));
      return;
    }

    if (!authEmail.trim()) {
      setAuthMessage(t("emailRequired"));
      return;
    }

    setAuthLoading(true);
    setAuthMessage("");

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(authEmail.trim(), {
        redirectTo: PASSWORD_RESET_REDIRECT_URL,
      });

      if (error) throw error;

      setAuthMessage(t("passwordResetEmailSent"));
    } catch (error) {
      setAuthMessage(error?.message || t("passwordResetFailed"));
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleUpdatePassword(returnScreen = "account") {
    if (!supabase || !session?.user?.id) {
      setAccountMessage(t("signInAgain"));
      return;
    }

    if (newPassword.length < 8) {
      setAccountMessage(t("passwordMinimum"));
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setAccountMessage(t("passwordsDoNotMatch"));
      return;
    }

    setPasswordSaving(true);
    setAccountMessage("");

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      setNewPassword("");
      setConfirmNewPassword("");
      setAccountMessage(t("passwordUpdated"));
      setScreen(returnScreen);

      const url = new URL(window.location.href);
      url.searchParams.delete("mode");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    } catch (error) {
      setAccountMessage(error?.message || t("passwordUpdateFailed"));
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleCreateCompany() {
    if (!supabase) {
      setAuthMessage("Supabase is not configured.");
      return;
    }

    trackFieldCallEvent("app_signup_submitted", {
      ...getAnalyticsEntryContext(),
      signup_path: "create_company",
    });

    if (!companyName.trim()) {
      trackFieldCallEvent("app_signup_failed", {
        ...getAnalyticsEntryContext(),
        signup_path: "create_company",
        failure_stage: "company_name_validation",
      });
      setAuthMessage("Company name is required.");
      return;
    }

    setAuthLoading(true);
    setAuthMessage("");

    try {
      let activeSession = null;
      let createdAuthUser = false;

      const { data: currentSessionData } = await supabase.auth.getSession();
      activeSession = currentSessionData?.session || null;

      if (!activeSession) {
        if (!authEmail.trim()) {
          trackFieldCallEvent("app_signup_failed", {
            ...getAnalyticsEntryContext(),
            signup_path: "create_company",
            failure_stage: "email_validation",
          });
          setAuthMessage("Email is required.");
          return;
        }

        if (!authPassword) {
          trackFieldCallEvent("app_signup_failed", {
            ...getAnalyticsEntryContext(),
            signup_path: "create_company",
            failure_stage: "password_validation",
          });
          setAuthMessage("Password is required.");
          return;
        }

        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email: authEmail.trim(),
          password: authPassword,
        });

        if (signUpError) {
          trackFieldCallEvent("app_signup_failed", {
            ...getAnalyticsEntryContext(),
            signup_path: "create_company",
            failure_stage: "auth_signup",
          });
          setAuthMessage(signUpError.message);
          return;
        }

        createdAuthUser = true;

        const { data: refreshedSessionData } = await supabase.auth.getSession();
        activeSession = refreshedSessionData?.session || signUpData?.session || null;

        if (!activeSession?.user?.id) {
          trackFieldCallEvent("app_signup_pending_confirmation", {
            ...getAnalyticsEntryContext(),
            signup_path: "create_company",
          });
          setAuthMessage("Check your email to confirm your account, then log in to finish company setup.");
          return;
        }
      }

      const userId = activeSession?.user?.id;

      if (!userId) {
        setAuthMessage("Please log in to finish company setup.");
        return;
      }

      const { data: companyRows, error: companyError } = await supabase.rpc(
        "create_company_for_current_user",
        {
          p_company_name: companyName.trim(),
        }
      );

      if (companyError) {
        throw companyError;
      }

      const createdCompany = Array.isArray(companyRows)
        ? companyRows[0]
        : companyRows;

      if (!createdCompany?.company_id) {
        throw new Error("Company setup did not return a company connection.");
      }

      setSession(activeSession);
      setActiveCompanyId(createdCompany.company_id);
      setActiveCompanyName(createdCompany.company_name || companyName.trim());
      setActiveCompanyRole(createdCompany.user_role || "owner");
      setCompanySettings({
        weatherCallCaution: "balanced",
        autoRefreshSavedJobs: true,
        defaultFinalCallTime: "15:00",
        workableRainProbabilityThreshold: 30,
        minimumWorkableWindowHours: 2,
      });

      trackFieldCallEvent("app_company_created", {
        ...getAnalyticsEntryContext(),
        signup_path: "create_company",
      });
      trackFieldCallEvent("app_account_setup_completed", {
        ...getAnalyticsEntryContext(),
        signup_path: "create_company",
      });

      if (createdAuthUser) {
        trackFieldCallEvent("sign_up", {
          ...getAnalyticsEntryContext(),
          method: "email",
          signup_path: "create_company",
        });
      }

      await loadCompanySettings(createdCompany.company_id);
      const importedGuestAssessment = await importPendingGuestAssessment(
        createdCompany.company_id,
        userId
      );
      await loadJobsFromBackend(createdCompany.company_id, userId);

      if (importedGuestAssessment) {
        setCopyNotice(
          language === "es"
            ? "Su primera evaluación de FieldCall fue guardada."
            : "Your first FieldCall assessment was saved."
        );
      }

      setAuthMessage(t("companyCreatedConnected"));
    } catch (err) {
      trackFieldCallEvent("app_signup_failed", {
        ...getAnalyticsEntryContext(),
        signup_path: "create_company",
        failure_stage: "company_setup",
      });
      setAuthMessage(err.message || "Company setup failed.");
    } finally {
      setAuthLoading(false);
    }
  }

async function handleJoinCompany() {
  if (!supabase) {
    setAuthMessage("Supabase is not configured.");
    return;
  }

  trackFieldCallEvent("app_signup_submitted", {
    ...getAnalyticsEntryContext(),
    signup_path: "join_company",
  });

  if (!joinCompanyId.trim()) {
    trackFieldCallEvent("app_signup_failed", {
      ...getAnalyticsEntryContext(),
      signup_path: "join_company",
      failure_stage: "invite_code_validation",
    });
    setAuthMessage("Company access code is required.");
    return;
  }

  setAuthLoading(true);
  setAuthMessage("");

  const accessCode = joinCompanyId.trim().toUpperCase();

  const { data: inviteIsValid, error: inviteValidationError } = await supabase.rpc(
    "validate_company_invite_code",
    {
      access_code: accessCode,
    }
  );

  if (inviteValidationError || inviteIsValid !== true) {
  setAuthLoading(false);

  trackFieldCallEvent("app_join_code_invalid", {
    ...getAnalyticsEntryContext(),
  });
  trackFieldCallEvent("app_signup_failed", {
    ...getAnalyticsEntryContext(),
    signup_path: "join_company",
    failure_stage: "invite_code",
  });

  setAuthMessage("Company access code not found.");
  return;
}

  const { data: currentSessionData } = await supabase.auth.getSession();
  let activeSession = currentSessionData?.session || null;
  let createdAuthUser = false;

  if (!activeSession) {
    if (!authEmail.trim()) {
      setAuthLoading(false);
      trackFieldCallEvent("app_signup_failed", {
        ...getAnalyticsEntryContext(),
        signup_path: "join_company",
        failure_stage: "email_validation",
      });
      setAuthMessage("Email is required.");
      return;
    }

    if (!authPassword) {
      setAuthLoading(false);
      trackFieldCallEvent("app_signup_failed", {
        ...getAnalyticsEntryContext(),
        signup_path: "join_company",
        failure_stage: "password_validation",
      });
      setAuthMessage("Password is required.");
      return;
    }

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: authEmail.trim(),
      password: authPassword,
    });

    if (signUpError) {
      setAuthLoading(false);
      trackFieldCallEvent("app_signup_failed", {
        ...getAnalyticsEntryContext(),
        signup_path: "join_company",
        failure_stage: "auth_signup",
      });
      setAuthMessage(signUpError.message);
      return;
    }

    createdAuthUser = true;

    const { data: refreshedSessionData } = await supabase.auth.getSession();
    activeSession = refreshedSessionData?.session || signUpData?.session || null;
  }

  const userId = activeSession?.user?.id;

  if (!userId) {
    setAuthLoading(false);
    trackFieldCallEvent("app_signup_pending_confirmation", {
      ...getAnalyticsEntryContext(),
      signup_path: "join_company",
    });
    setAuthMessage("Check your email to confirm your account, then log in and enter the company access code again.");
    return;
  }

  const { data: joinRows, error: joinError } = await supabase.rpc(
    "join_company_by_invite_code",
    {
      access_code: accessCode,
    }
  );

  setAuthLoading(false);

  if (joinError) {
    trackFieldCallEvent("app_signup_failed", {
      ...getAnalyticsEntryContext(),
      signup_path: "join_company",
      failure_stage: "company_join",
    });
    setAuthMessage(joinError.message || "Company access code not found.");
    return;
  }

  const joinedCompany = Array.isArray(joinRows) ? joinRows[0] : joinRows;

  if (!joinedCompany?.company_id) {
    trackFieldCallEvent("app_signup_failed", {
      ...getAnalyticsEntryContext(),
      signup_path: "join_company",
      failure_stage: "company_join_response",
    });
    setAuthMessage("Company access code not found.");
    return;
  }

  setActiveCompanyId(joinedCompany.company_id);
setActiveCompanyName(joinedCompany.company_name || "Company");
setActiveCompanyRole(joinedCompany.user_role || "member");
setCompanySettings({
        weatherCallCaution: "balanced",
        autoRefreshSavedJobs: true,
        defaultFinalCallTime: "15:00",
        workableRainProbabilityThreshold: 30,
        minimumWorkableWindowHours: 2,
      });
setSavedJobs([]);

trackFieldCallEvent("app_company_joined", {
  ...getAnalyticsEntryContext(),
  signup_path: "join_company",
});
trackFieldCallEvent("app_account_setup_completed", {
  ...getAnalyticsEntryContext(),
  signup_path: "join_company",
});

if (createdAuthUser) {
  trackFieldCallEvent("sign_up", {
    ...getAnalyticsEntryContext(),
    method: "email",
    signup_path: "join_company",
  });
}

await loadCompanySettings(joinedCompany.company_id);
const importedGuestAssessment = await importPendingGuestAssessment(
  joinedCompany.company_id,
  userId
);
await loadJobsFromBackend(joinedCompany.company_id, userId);

if (importedGuestAssessment) {
  setCopyNotice(
    language === "es"
      ? "Su primera evaluación de FieldCall fue guardada."
      : "Your first FieldCall assessment was saved."
  );
}

setAuthMessage(`Joined ${joinedCompany.company_name || "company"}. You are now connected.`);
}

  async function handleLogout() {
    if (!supabase) return;

    await supabase.auth.signOut();
    setSession(null);
    setActiveCompanyId("");
setActiveCompanyName("");
setActiveCompanyRole("");
setCompanySettings({
        weatherCallCaution: "balanced",
        autoRefreshSavedJobs: true,
        defaultFinalCallTime: "15:00",
        workableRainProbabilityThreshold: 30,
        minimumWorkableWindowHours: 2,
      });
setSavedJobs([]);
setScreen("dashboard");
setAccountMessage("");
setDeleteAccountPreview(null);
setAuthMessage("Logged out.");
  }

  // -----------------------------------------------------
  // 1C — FORM + NAVIGATION ACTIONS
  // -----------------------------------------------------

async function handleShareApp() {
  const shareData = {
    title: "FieldCall",
    text: "FieldCall helps field teams make clearer weather decisions for crews, schedules, and job sites.",
    url: "https://app.myfieldcall.com",
  };

  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }

    if (navigator.clipboard) {
      await navigator.clipboard.writeText(shareData.url);
      setCopyNotice("FieldCall link copied.");
      return;
    }

    setCopyNotice("Share is not supported on this browser.");
  } catch {
    // User may cancel the share sheet. No message needed.
  }
}

async function handleInstallApp() {
  if (installPromptEvent) {
    installPromptEvent.prompt();

    const choiceResult = await installPromptEvent.userChoice;

    setInstallPromptEvent(null);

    if (choiceResult?.outcome === "accepted") {
      setCopyNotice("FieldCall install started.");
    }

    return;
  }

  setShowInstallHelp(!showInstallHelp);
}

async function handleEnableFinalCallAlerts() {
  setPushAlertMessage("");
  let alertSetupStep = "started";

  if (!session?.user?.id || !activeCompanyId) {
    setPushAlertMessage(t("alertsSignInRequired"));
    return;
  }

  if (!supabase) {
    setPushAlertMessage(t("alertsSetupMissing"));
    return;
  }

  if (!VAPID_PUBLIC_KEY) {
    setPushAlertMessage(t("alertsSetupMissing"));
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    setPushAlertMessage(t("alertsUnavailable"));
    return;
  }

  setPushAlertsLoading(true);

  try {
    alertSetupStep = "registering service worker";
    const registration = await navigator.serviceWorker.register("/fieldcall-sw.js");

    let permission = Notification.permission;

    if (permission === "default") {
      alertSetupStep = "requesting notification permission";
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      setPushAlertMessage(t("alertsBlocked"));
      setPushAlertsEnabled(false);
      return;
    }

    alertSetupStep = "checking existing push subscription";
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      alertSetupStep = "creating push subscription";
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    alertSetupStep = "reading push subscription";
    const subscriptionJson = subscription.toJSON();
    const endpoint = subscription.endpoint || subscriptionJson.endpoint;
    const p256dhKey = subscriptionJson?.keys?.p256dh;
    const authKey = subscriptionJson?.keys?.auth;

    if (!endpoint || !p256dhKey || !authKey) {
      throw new Error("Missing push subscription keys.");
    }

    alertSetupStep = "saving device to Supabase";
    const { error: saveError } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: session.user.id,
        company_id: activeCompanyId,
        endpoint,
        p256dh_key: p256dhKey,
        auth_key: authKey,
        user_agent: navigator.userAgent || null,
        platform: getPushPlatformLabel(),
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" }
    );

    if (saveError) {
      throw saveError;
    }

    setPushAlertsEnabled(true);
    setPushAlertMessage(t("alertsEnabledMessage"));
  } catch (error) {
    const detail = error?.message || String(error || "Unknown error");
    console.error("Push alert registration failed", { step: alertSetupStep, error });
    setPushAlertMessage(`Alert setup failed while ${alertSetupStep}: ${detail}`);
  } finally {
    setPushAlertsLoading(false);
  }
}

async function handleDisableFinalCallAlerts() {
  setPushAlertMessage("");

  if (!session?.user?.id || !supabase) {
    setPushAlertMessage(t("alertsSignInRequired"));
    return;
  }

  setPushAlertsLoading(true);

  try {
    const registration = await navigator.serviceWorker?.getRegistration?.("/fieldcall-sw.js");
    const subscription = await registration?.pushManager?.getSubscription?.();

    if (subscription?.endpoint) {
      const { error } = await supabase
        .from("push_subscriptions")
        .update({
          enabled: false,
          updated_at: new Date().toISOString(),
        })
        .eq("endpoint", subscription.endpoint)
        .eq("user_id", session.user.id);

      if (error) throw error;
    }

    setPushAlertsEnabled(false);
    setPushAlertMessage(t("alertsDisabledMessage"));
  } catch (error) {
    const detail = error?.message || String(error || "Unknown error");
    setPushAlertMessage(`${t("alertsDisableFailed")} ${detail}`);
  } finally {
    setPushAlertsLoading(false);
  }
}

function handleToggleFinalCallAlerts() {
  if (pushAlertsEnabled) {
    handleDisableFinalCallAlerts();
    return;
  }

  handleEnableFinalCallAlerts();
}

async function loadCompanySettings(companyIdOverride = activeCompanyId) {
  const companyIdToLoad = companyIdOverride || activeCompanyId;

  if (!supabase || !companyIdToLoad) return;

  setCompanySettingsLoading(true);
  setCompanySettingsMessage("");

  const { data, error } = await supabase
    .from("companies")
    .select(
      "weather_call_caution, auto_refresh_saved_jobs, default_final_call_time, workable_rain_probability_threshold, minimum_workable_window_hours"
    )
    .eq("id", companyIdToLoad)
    .maybeSingle();

  if (error) {
    const { data: fallbackData, error: fallbackError } = await supabase
      .from("companies")
      .select("weather_call_caution")
      .eq("id", companyIdToLoad)
      .maybeSingle();

    setCompanySettingsLoading(false);

    if (fallbackError) {
      setCompanySettings((currentSettings) => ({
        ...currentSettings,
        weatherCallCaution: normalizeWeatherCallCaution(currentSettings.weatherCallCaution),
        autoRefreshSavedJobs: currentSettings.autoRefreshSavedJobs !== false,
        defaultFinalCallTime: normalizeFinalCallTime(
          currentSettings.defaultFinalCallTime
        ),
        workableRainProbabilityThreshold: normalizeWorkableRainThreshold(
          currentSettings.workableRainProbabilityThreshold
        ),
        minimumWorkableWindowHours: normalizeMinimumWorkableWindowHours(
          currentSettings.minimumWorkableWindowHours
        ),
      }));
      setCompanySettingsMessage(t("companySettingsColumnMissing"));
      return;
    }

    setCompanySettings((currentSettings) => ({
      ...currentSettings,
      weatherCallCaution: normalizeWeatherCallCaution(fallbackData?.weather_call_caution),
      autoRefreshSavedJobs: currentSettings.autoRefreshSavedJobs !== false,
      defaultFinalCallTime: normalizeFinalCallTime(
        currentSettings.defaultFinalCallTime
      ),
      workableRainProbabilityThreshold: normalizeWorkableRainThreshold(
        currentSettings.workableRainProbabilityThreshold
      ),
      minimumWorkableWindowHours: normalizeMinimumWorkableWindowHours(
        currentSettings.minimumWorkableWindowHours
      ),
    }));
    setCompanySettingsMessage(t("autoRefreshColumnMissing"));
    return;
  }

  setCompanySettingsLoading(false);
  setCompanySettings({
    weatherCallCaution: normalizeWeatherCallCaution(data?.weather_call_caution),
    autoRefreshSavedJobs: data?.auto_refresh_saved_jobs !== false,
    defaultFinalCallTime: normalizeFinalCallTime(
      data?.default_final_call_time
    ),
    workableRainProbabilityThreshold: normalizeWorkableRainThreshold(
      data?.workable_rain_probability_threshold
    ),
    minimumWorkableWindowHours: normalizeMinimumWorkableWindowHours(
      data?.minimum_workable_window_hours
    ),
  });
}

function openAccount() {
  setError("");
  setCopyNotice("");
  setAccountMessage("");
  setScreen("account");
}

function returnToDashboard() {
  setError("");
  setCopyNotice("");
  setAccountMessage("");
  setScreen("dashboard");
}

function handleReturnFromCompanySettings() {
  const currentSnapshot = getCompanySettingsSnapshot(companySettings);
  const baselineSnapshot = companySettingsBaselineRef.current;

  if (
    baselineSnapshot &&
    currentSnapshot !== baselineSnapshot &&
    !window.confirm(t("discardUnsavedChanges"))
  ) {
    return;
  }

  companySettingsBaselineRef.current = "";
  setOpenCompanySetting("");
  setScreen("dashboard");
}

async function loadDeleteAccountPreview() {
  if (!supabase || !session?.user?.id) return;

  setDeleteAccountLoading(true);
  setDeleteAccountMessage("");

  try {
    const { data, error } = await supabase.functions.invoke("manage-account", {
      body: { action: "preview" },
    });

    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || t("accountPreviewFailed"));

    setDeleteAccountPreview(data);
    if (data.requires_transfer && Array.isArray(data.transfer_candidates)) {
      setDeleteAccountTransferUserId(data.transfer_candidates[0]?.user_id || "");
    }
  } catch (error) {
    setDeleteAccountMessage(error?.message || t("accountPreviewFailed"));
  } finally {
    setDeleteAccountLoading(false);
  }
}

function openDeleteAccount() {
  setDeleteAccountPreview(null);
  setDeleteAccountPassword("");
  setDeleteAccountConfirmation("");
  setDeleteAccountTransferUserId("");
  setDeleteAccountMessage("");
  setScreen("deleteAccount");
  loadDeleteAccountPreview();
}

function openDeleteCompany() {
  setDeleteCompanyPassword("");
  setDeleteCompanyConfirmation("");
  setDeleteCompanyMessage("");
  setScreen("deleteCompany");
}

async function reauthenticateForDestructiveAction(password) {
  const email = session?.user?.email || "";
  if (!email || !password) {
    throw new Error(t("currentPasswordRequired"));
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(t("currentPasswordIncorrect"));
}

async function handleDeleteAccount() {
  if (!supabase || !session?.user?.id) return;

  if (deleteAccountConfirmation !== "DELETE") {
    setDeleteAccountMessage(t("typeDeleteExactly"));
    return;
  }

  if (deleteAccountPreview?.requires_transfer && !deleteAccountTransferUserId) {
    setDeleteAccountMessage(t("chooseNewOwner"));
    return;
  }

  setDestructiveActionLoading(true);
  setDeleteAccountMessage("");

  try {
    await reauthenticateForDestructiveAction(deleteAccountPassword);

    const { data, error } = await supabase.functions.invoke("manage-account", {
      body: {
        action: "delete_account",
        confirmation: deleteAccountConfirmation,
        transfer_to_user_id: deleteAccountTransferUserId || null,
      },
    });

    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || t("accountDeletionFailed"));

    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // The auth record is already gone; local cleanup is best effort.
    }

    window.location.assign(`${window.location.origin}/?mode=login&account_deleted=1`);
  } catch (error) {
    setDeleteAccountMessage(error?.message || t("accountDeletionFailed"));
  } finally {
    setDestructiveActionLoading(false);
  }
}

async function handleDeleteCompany() {
  if (!supabase || !session?.user?.id || activeCompanyRole !== "owner") return;

  if (deleteCompanyConfirmation !== "DELETE COMPANY") {
    setDeleteCompanyMessage(t("typeDeleteCompanyExactly"));
    return;
  }

  setDestructiveActionLoading(true);
  setDeleteCompanyMessage("");

  try {
    await reauthenticateForDestructiveAction(deleteCompanyPassword);

    const { data, error } = await supabase.functions.invoke("manage-account", {
      body: {
        action: "delete_company",
        confirmation: deleteCompanyConfirmation,
      },
    });

    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || t("companyDeletionFailed"));

    setActiveCompanyId("");
    setActiveCompanyName("");
    setActiveCompanyRole("");
    setSavedJobs([]);
    setCompanyName("");
    setAuthMode("create");
    setAuthMessage(t("companyDeletedCreateAnother"));
    setScreen("dashboard");
  } catch (error) {
    setDeleteCompanyMessage(error?.message || t("companyDeletionFailed"));
  } finally {
    setDestructiveActionLoading(false);
  }
}

function openCompanySettings() {
  if (!canManageCompanySettings) {
    setAuthMessage(t("companySettingsAdminOnly"));
    return;
  }

  setError("");
  setCopyNotice("");
  setCompanySettingsMessage("");
  setOpenCompanySetting("");
  companySettingsBaselineRef.current = "";
  setScreen("companySettings");
  loadCompanySettings(activeCompanyId);
}

async function saveCompanySettings() {
  if (!supabase || !activeCompanyId) {
    setCompanySettingsMessage(t("companySettingsSaveFailed"));
    return;
  }

  if (!canManageCompanySettings) {
    setCompanySettingsMessage(t("companySettingsAdminOnly"));
    return;
  }

  setCompanySettingsSaving(true);
  setCompanySettingsMessage("");

  const nextSettingsPayload = {
    weather_call_caution: normalizeWeatherCallCaution(companySettings.weatherCallCaution),
    auto_refresh_saved_jobs: companySettings.autoRefreshSavedJobs !== false,
    default_final_call_time: normalizeFinalCallTime(
      companySettings.defaultFinalCallTime
    ),
    workable_rain_probability_threshold: normalizeWorkableRainThreshold(
      companySettings.workableRainProbabilityThreshold
    ),
    minimum_workable_window_hours: normalizeMinimumWorkableWindowHours(
      companySettings.minimumWorkableWindowHours
    ),
  };

  const { data, error } = await supabase
    .from("companies")
    .update(nextSettingsPayload)
    .eq("id", activeCompanyId)
    .select(
      "id, weather_call_caution, auto_refresh_saved_jobs, default_final_call_time, workable_rain_probability_threshold, minimum_workable_window_hours"
    )
    .maybeSingle();

  if (error) {
    const { data: fallbackData, error: fallbackError } = await supabase
      .from("companies")
      .update({
        weather_call_caution: nextSettingsPayload.weather_call_caution,
      })
      .eq("id", activeCompanyId)
      .select("id, weather_call_caution")
      .maybeSingle();

    setCompanySettingsSaving(false);

    if (fallbackError || !fallbackData?.id) {
      setCompanySettingsMessage(error.message || t("companySettingsSaveFailed"));
      return;
    }

    setCompanySettings((currentSettings) => ({
      ...currentSettings,
      weatherCallCaution: normalizeWeatherCallCaution(fallbackData.weather_call_caution),
      autoRefreshSavedJobs: currentSettings.autoRefreshSavedJobs !== false,
      defaultFinalCallTime: normalizeFinalCallTime(
        currentSettings.defaultFinalCallTime
      ),
      workableRainProbabilityThreshold: normalizeWorkableRainThreshold(
        currentSettings.workableRainProbabilityThreshold
      ),
      minimumWorkableWindowHours: normalizeMinimumWorkableWindowHours(
        currentSettings.minimumWorkableWindowHours
      ),
    }));
    setCompanySettingsMessage(t("autoRefreshColumnMissing"));
    setScreen("dashboard");
    return;
  }

  setCompanySettingsSaving(false);

  if (!data?.id) {
    setCompanySettingsMessage(t("companySettingsNoPermission"));
    return;
  }

  setCompanySettings({
    weatherCallCaution: normalizeWeatherCallCaution(data.weather_call_caution),
    autoRefreshSavedJobs: data.auto_refresh_saved_jobs !== false,
    defaultFinalCallTime: normalizeFinalCallTime(
      data.default_final_call_time
    ),
    workableRainProbabilityThreshold: normalizeWorkableRainThreshold(
      data.workable_rain_probability_threshold
    ),
    minimumWorkableWindowHours: normalizeMinimumWorkableWindowHours(
      data.minimum_workable_window_hours
    ),
  });
  setCompanySettingsMessage(t("companySettingsSaved"));
  companySettingsBaselineRef.current = "";
  setOpenCompanySetting("");
  setScreen("dashboard");
}

  function updateField(field, value) {
    if (field === "workType") {
      setForm((currentForm) => {
        const nextSurfaceCondition = isPavingService(value)
          ? currentForm.surfaceCondition || "Subgrade exposed & paved same day"
          : "Subgrade exposed & paved same day";

        return {
          ...currentForm,
          workType: value,
          surfaceCondition: nextSurfaceCondition,
          baseExposed: isPavingService(value)
            ? getBaseExposedFromSurfaceCondition(nextSurfaceCondition)
            : "No",
        };
      });
      return;
    }

    if (field === "surfaceCondition") {
      setForm((currentForm) => ({
        ...currentForm,
        surfaceCondition: value,
        baseExposed: getBaseExposedFromSurfaceCondition(value),
      }));
      return;
    }

    setForm((currentForm) => ({ ...currentForm, [field]: value }));
  }

  function updateDefaultService(value) {
    setDefaultService(value);
    saveDefaultServicePreference(value);
  }

  function startNewAssessment() {
    setResult(null);
    setResultMode("details");
    setSelectedMessageAudience("client");
    setMessageDraft("");
    setResultJobContext(null);
    setShowWeatherDetails(false);
    setError("");
    setCopyNotice("");
   setForm({
  projectName: "",
  locationQuery: "",
  selectedLocation: null,
  city: "",
  state: "",
  workDate: getTomorrowDate(),
  workType: defaultService || "Paving",
  operatingWindow: "Day",
  surfaceCondition: "Subgrade exposed & paved same day",
  baseExposed: "No",
  multiDay: "No",
  finalCallTime: normalizeFinalCallTime(
    companySettings.defaultFinalCallTime
  ),
  saveToQueue: false,
  shadowDecision: "",
});
    setScreen("intake");
  }

  function goHome() {
    if (guestMode) {
      window.location.assign("https://myfieldcall.com/#guest-assessment");
      return;
    }

    setResultMode("details");
    setSelectedMessageAudience("client");
    setMessageDraft("");
    setShowWeatherDetails(false);
    setResultJobContext(null);
    setError("");
    setCopyNotice("");
    setScreen("dashboard");
  }

  async function importPendingGuestAssessment(companyId, userId) {
    if (!supabase || !companyId || !userId || pendingGuestImportRef.current) {
      return false;
    }

    let pendingAssessment;

    try {
      const rawPendingAssessment = window.localStorage.getItem(
        "fieldcall_pending_guest_assessment"
      );

      if (!rawPendingAssessment) {
        return false;
      }

      pendingAssessment = JSON.parse(rawPendingAssessment);
    } catch {
      try {
        window.localStorage.removeItem("fieldcall_pending_guest_assessment");
      } catch {
        // Ignore storage cleanup errors.
      }

      return false;
    }

    const pendingJob = pendingAssessment?.job;
    const pendingResult = pendingAssessment?.result;

    if (
      !pendingJob?.selectedLocation ||
      !pendingJob?.workDate ||
      !pendingJob?.workType ||
      !pendingResult
    ) {
      try {
        window.localStorage.removeItem("fieldcall_pending_guest_assessment");
      } catch {
        // Ignore storage cleanup errors.
      }

      return false;
    }

    const storedAt = new Date(pendingAssessment?.storedAt || "");
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    if (
      !Number.isNaN(storedAt.getTime()) &&
      Date.now() - storedAt.getTime() > sevenDaysMs
    ) {
      try {
        window.localStorage.removeItem("fieldcall_pending_guest_assessment");
      } catch {
        // Ignore storage cleanup errors.
      }

      return false;
    }

    pendingGuestImportRef.current = true;

    try {
      const now = new Date().toISOString();
      const storedResult = makeStoredResult(pendingResult);
      const projectName =
        String(pendingJob.projectName || "").trim() || "Unnamed Job";
      const locationQuery =
        pendingJob.selectedLocation?.formattedAddress ||
        pendingJob.locationQuery ||
        "";
      const city =
        pendingJob.city || pendingJob.selectedLocation?.city || "";
      const state =
        pendingJob.state || pendingJob.selectedLocation?.state || "";
      const serviceType = pendingJob.workType || "Paving";
      const isFinalAssessment = storedResult?.isFinal === true;
      const status = isFinalAssessment ? "call_made" : "active";
      const checkedAt = storedResult?.checkedAt || now;
      const surfaceCondition = isPavingService(serviceType)
        ? normalizeSurfaceConditionForStorage(
            pendingJob.surfaceCondition ||
              getSurfaceConditionFromBaseExposed(pendingJob.baseExposed)
          )
        : "overlay";
      const baseExposed = isPavingService(serviceType)
        ? getBaseExposedFromSurfaceCondition(
            pendingJob.surfaceCondition ||
              getSurfaceConditionFromBaseExposed(pendingJob.baseExposed)
          ) === "Yes"
        : false;

      const { data: existingRows, error: existingError } = await supabase
        .from("jobs")
        .select("id")
        .eq("company_id", companyId)
        .eq("created_by", userId)
        .eq("project_name", projectName)
        .eq("work_date", pendingJob.workDate)
        .eq("service_type", serviceType)
        .limit(1);

      if (existingError) {
        throw new Error(
          existingError.message || "Could not check for the guest job."
        );
      }

      const existingJobId = existingRows?.[0]?.id || "";
      let savedJobId = existingJobId;

      if (existingJobId) {
        const { error: updateError } = await supabase
          .from("jobs")
          .update({
            location_query: locationQuery,
            city,
            state,
            latitude: pendingJob.selectedLocation?.latitude ?? null,
            longitude: pendingJob.selectedLocation?.longitude ?? null,
            operating_window: pendingJob.operatingWindow || "Day",
            surface_condition: surfaceCondition,
            base_exposed: baseExposed,
            multi_day: false,
            final_call_window_hours: 24,
            final_call_time: normalizeFinalCallTime(
              pendingJob.finalCallTime || companySettings.defaultFinalCallTime
            ),
            status,
            call_made_at: isFinalAssessment ? checkedAt : null,
            last_result: storedResult,
            last_checked_at: checkedAt,
            last_error: "",
            updated_at: now,
          })
          .eq("id", existingJobId)
          .eq("company_id", companyId)
          .eq("created_by", userId);

        if (updateError) {
          throw new Error(
            updateError.message || "Could not update the guest job."
          );
        }
      } else {
        const { data: insertedRows, error: insertError } = await supabase
          .from("jobs")
          .insert({
            company_id: companyId,
            created_by: userId,
            project_name: projectName,
            location_query: locationQuery,
            city,
            state,
            latitude: pendingJob.selectedLocation?.latitude ?? null,
            longitude: pendingJob.selectedLocation?.longitude ?? null,
            work_date: pendingJob.workDate,
            service_type: serviceType,
            operating_window: pendingJob.operatingWindow || "Day",
            surface_condition: surfaceCondition,
            base_exposed: baseExposed,
            multi_day: false,
            final_call_window_hours: 24,
            final_call_time: normalizeFinalCallTime(
              pendingJob.finalCallTime || companySettings.defaultFinalCallTime
            ),
            status,
            call_made_at: isFinalAssessment ? checkedAt : null,
            last_result: storedResult,
            last_checked_at: checkedAt,
            last_error: "",
            updated_at: now,
          })
          .select("id");

        if (insertError) {
          throw new Error(
            insertError.message || "Could not save the guest job."
          );
        }

        savedJobId = insertedRows?.[0]?.id || "";
      }

      if (!savedJobId) {
        throw new Error("The guest job did not return a saved job ID.");
      }

      try {
        window.localStorage.removeItem("fieldcall_pending_guest_assessment");
      } catch {
        // The backend save succeeded even if browser cleanup fails.
      }

      trackFieldCallEvent("guest_assessment_imported", {
        ...getAnalyticsEntryContext(),
        service: serviceType,
        final_call: isFinalAssessment ? "yes" : "no",
        signal: storedResult?.shortSignal || "unknown",
      });
      trackFieldCallEvent("app_activation_completed", {
        ...getAnalyticsEntryContext(),
        activation_method: "guest_assessment_import",
        service: serviceType,
      });

      try {
        window.localStorage.setItem(
          `fieldcall_first_assessment_completed:${userId}`,
          "yes"
        );
      } catch {
        // Analytics deduplication is best-effort only.
      }

      return true;
    } catch (importError) {
      console.error("Guest assessment import failed", importError);
      trackFieldCallEvent("app_activation_failed", {
        ...getAnalyticsEntryContext(),
        activation_method: "guest_assessment_import",
        failure_stage: "guest_import",
        service: pendingJob?.workType || "unknown",
      });
      setCopyNotice(
        `${
          language === "es"
            ? "La cuenta fue creada, pero la primera evaluación no se pudo guardar:"
            : "Your account was created, but the first assessment could not be saved:"
        } ${importError?.message || "Unknown error"}`
      );
      return false;
    } finally {
      pendingGuestImportRef.current = false;
    }
  }

  function handleGuestCreateAccount() {
    try {
      window.localStorage.setItem(
        "fieldcall_pending_guest_assessment",
        JSON.stringify({
          job: form,
          result,
          storedAt: new Date().toISOString(),
        })
      );
    } catch {
      // The account flow still works if browser storage is unavailable.
    }

    trackFieldCallEvent("guest_signup_clicked", {
      ...getAnalyticsEntryContext(),
      service: form.workType || "unknown",
      signal: result?.shortSignal || "unknown",
    });
    trackFieldCallEvent("app_signup_started", {
      ...getAnalyticsEntryContext(),
      signup_path: "guest_create_company",
    });

    setGuestMode(false);
    setAuthMode("create");
    setAuthMessage("");
    setError("");
    setCopyNotice("");
    setScreen("dashboard");

    const currentParams = new URLSearchParams(window.location.search);
    const entrySource = currentParams.get("entry") || "landing_guest_form";
    const destination = new URL(window.location.href);
    destination.search = "";
    destination.searchParams.set("mode", "create");
    destination.searchParams.set("from", "guest");
    destination.searchParams.set("entry", entrySource);
    window.history.replaceState({}, "", destination.toString());
  }

  // -----------------------------------------------------
  // 1D — WEATHER CHECK ACTIONS
  // -----------------------------------------------------

  function trackFirstFieldCallCompleted(jobData, assessment) {
    try {
      const analyticsIdentity =
        session?.user?.id || activeCompanyId || "browser";
      const firstAssessmentKey =
        `fieldcall_first_assessment_completed:${analyticsIdentity}`;

      if (window.localStorage.getItem(firstAssessmentKey) === "yes") return;

      const eventParameters = {
        ...getAnalyticsEntryContext(),
        service: jobData.workType || "unknown",
        final_call: assessment?.isFinal ? "yes" : "no",
        signal: assessment?.shortSignal || "unknown",
      };

      trackFieldCallEvent("app_first_fieldcall_completed", eventParameters);
      trackFieldCallEvent("app_activation_completed", {
        ...eventParameters,
        activation_method: "first_saved_assessment",
      });
      window.localStorage.setItem(firstAssessmentKey, "yes");
    } catch {
      // Analytics deduplication is best-effort only.
    }
  }

  async function runAssessment() {
  lastSavedJobRef.current = null;
  const completed = await runWeatherCheck(form, {
    shouldSave: true,
    openResult: true,
  });

  const savedJob = lastSavedJobRef.current;
  if (completed && savedJob?.id && form.shadowDecision) {
    await adoption.submitDecision({
      jobId: savedJob.id,
      stage: "before_fieldcall",
      decision: form.shadowDecision,
      fieldcallSignal: savedJob.lastResult?.shortSignal || "",
    });
  }

  if (completed) {
    await adoption.reload();
  }
}

async function runSavedJob(job) {
  await refreshSavedJobWeather(job, { source: "manual" });
}

async function refreshSavedJobWeather(job, options = {}) {
  const { source = "manual", companyIdOverride = "", userIdOverride = "" } = options;

  if (!job) return false;

  const assessmentTiming = getAssessmentTiming(job);
  const backendAutoFinalPending =
  assessmentTiming.isFinal &&
  !isSavedJobFinalResult(job) &&
  job.autoFinalCallEnabled !== false &&
  ["pending", "processing"].includes(
    String(job.autoFinalCallStatus || "").toLowerCase()
  );

  if (backendAutoFinalPending) {
    if (source === "manual") {
      setCopyNotice(t("finalCallPreparingNotice"));
    }
    return false;
  }

  if (hasWorkWindowStarted(job) && !isSavedJobFinalResult(job)) {
    if (source === "manual") {
      setCopyNotice(t("workWindowStartedNoFinal"));
    }
    return false;
  }

  const jobForm = jobToForm(job);
  const backendJobId = job.backendId || job.id;
  const isSilent = source === "auto";

  if (!isSilent) {
    setError("");
    setCopyNotice("");
    setCheckingJobId(job.id);
  }

  try {
    const assessment = await performAssessmentWithRetry({
  ...jobForm,
  backendJobId,
  activeCompanyId: companyIdOverride || activeCompanyId,
  weatherCallCaution: companySettings.weatherCallCaution,
  workableRainProbabilityThreshold:
    companySettings.workableRainProbabilityThreshold,
  minimumWorkableWindowHours:
    companySettings.minimumWorkableWindowHours,
});
    const assessmentForStorage = getManualAssessmentForStorage(assessment);

    trackFieldCallEvent("app_assessment_completed", {
      ...getAnalyticsEntryContext(),
      service: jobForm.workType || "unknown",
      final_call: assessmentForStorage?.isFinal ? "yes" : "no",
      signal: assessmentForStorage?.shortSignal || "unknown",
      final_call_time: normalizeFinalCallTime(jobForm.finalCallTime),
      refresh_source: source,
    });

    trackFirstFieldCallCompleted(jobForm, assessmentForStorage);

    updateSavedJobResult(job.id, assessmentForStorage, assessmentForStorage.isFinal);

    if (backendJobId) {
      try {
        await updateJobLatestResultInBackend(backendJobId, assessmentForStorage, "", {
          companyId: companyIdOverride,
          userId: userIdOverride,
        });
      } catch (syncErr) {
        if (!isSilent) {
          setCopyNotice(
            `${job.projectName || "Saved job"} checked. Sync had a temporary issue; refresh if needed.`
          );
        }
        return true;
      }
    }

    if (!isSilent) {
      setCopyNotice(`${job.projectName || "Saved job"} checked.`);
    }
    if (!isSilent) {
      await adoption.reload();
    }
    return true;
  } catch (err) {
    const message = getFriendlyWeatherCheckError(err);

    updateSavedJobError(job.id, message);

    if (backendJobId) {
      try {
        await updateJobLatestResultInBackend(backendJobId, null, message, {
          companyId: companyIdOverride,
          userId: userIdOverride,
        });
      } catch {
        // Keep the visible weather error as the main message.
      }
    }

    return false;
  } finally {
    if (!isSilent) {
      setCheckingJobId(null);
    }
  }
}

async function refreshEligibleSavedJobs(jobsToRefresh, options = {}) {
  const { source = "auto", companyIdOverride = "", userIdOverride = "" } = options;
  const eligibleJobs = (jobsToRefresh || []).filter((job) => {
    return (
      job?.selectedLocation &&
      job?.workDate &&
      !isSavedJobFinalResult(job) &&
      !hasWorkWindowStarted(job) &&
      !getAssessmentTiming(job).isFinal
    );
  });

  if (eligibleJobs.length === 0) return;

  setDashboardAutoRefreshRunning(true);

  try {
    for (const job of eligibleJobs) {
      await refreshSavedJobWeather(job, {
        source,
        companyIdOverride,
        userIdOverride,
      });
    }

    if (source === "manual") {
      setCopyNotice(t("activeJobsRefreshed", { count: eligibleJobs.length }));
    }
  } finally {
    setDashboardAutoRefreshRunning(false);
  }
}

async function handleManualJobsRefresh() {
  const loadedJobs = await loadJobsFromBackend();
  await refreshEligibleSavedJobs(loadedJobs || savedJobs, { source: "manual" });
}

  async function runWeatherCheck(jobData, options = {}) {
    const {
      shouldSave = false,
      openResult = true,
      updateJobId = null,
      guestAssessment = false,
    } = options;

    setError("");
    setCopyNotice("");

    if (!jobData.selectedLocation || !jobData.workDate) {
      setError(
        "Please select a location from the suggestions before running the assessment."
      );
      return false;
    }

    setLoading(true);

    try {
      const isNewSavedAssessment =
        shouldSave && !guestAssessment && !updateJobId;

      const assessment = await performAssessmentWithRetry({
        ...jobData,
        activeCompanyId: guestAssessment ? "" : activeCompanyId,
        weatherCallCaution: guestAssessment
          ? "balanced"
          : companySettings.weatherCallCaution,
        workableRainProbabilityThreshold: guestAssessment
          ? 30
          : companySettings.workableRainProbabilityThreshold,
        minimumWorkableWindowHours: guestAssessment
          ? 2
          : companySettings.minimumWorkableWindowHours,
        // A brand-new saved job does not have a backend job ID yet. Delay the
        // history insert until the job has been created so assessments.job_id
        // is never saved as null for a saved FieldCall.
        skipBackendHistorySave:
          guestAssessment ||
          jobData.skipBackendHistorySave === true ||
          isNewSavedAssessment,
      });

      let assessmentForStorage = getManualAssessmentForStorage(assessment);

      if (updateJobId) {
        updateSavedJobResult(
          updateJobId,
          assessmentForStorage,
          assessmentForStorage.isFinal
        );
      } else if (isNewSavedAssessment) {
        assessmentForStorage = await saveJobToQueue(
          jobData,
          assessmentForStorage
        );
      }

      if (guestAssessment) {
        trackFieldCallEvent("guest_assessment_completed", {
          ...getAnalyticsEntryContext(),
          service: jobData.workType || "unknown",
          final_call: assessmentForStorage?.isFinal ? "yes" : "no",
          signal: assessmentForStorage?.shortSignal || "unknown",
          final_call_time: normalizeFinalCallTime(jobData.finalCallTime),
        });
      } else {
        trackFieldCallEvent("app_assessment_completed", {
          ...getAnalyticsEntryContext(),
          service: jobData.workType || "unknown",
          final_call: assessmentForStorage?.isFinal ? "yes" : "no",
          signal: assessmentForStorage?.shortSignal || "unknown",
          final_call_time: normalizeFinalCallTime(jobData.finalCallTime),
          assessment_source: updateJobId
            ? "existing_job"
            : isNewSavedAssessment
              ? "new_job"
              : "unsaved",
        });
        trackFirstFieldCallCompleted(jobData, assessmentForStorage);
      }

      if (openResult) {
        setResult(assessmentForStorage);
        setResultMode("details");
        setSelectedMessageAudience("client");
        setMessageDraft("");
        setResultJobContext(
          isNewSavedAssessment ? lastSavedJobRef.current : null
        );
        setShowWeatherDetails(false);
        setScreen("result");
      }

      return true;
    } catch (err) {
      const message = getFriendlyWeatherCheckError(err);
      setError(message);

      if (guestAssessment) {
        setGuestEntryError(message);
        trackFieldCallEvent("guest_assessment_failed", {
          ...getAnalyticsEntryContext(),
          failure_stage: "weather_or_scoring",
          service: jobData.workType || "unknown",
        });
      } else {
        trackFieldCallEvent("app_assessment_failed", {
          ...getAnalyticsEntryContext(),
          failure_stage: "weather_or_scoring",
          service: jobData.workType || "unknown",
        });
      }

      return false;
    } finally {
      setLoading(false);
    }
  }

  // -----------------------------------------------------
  // 1E — SAVED JOB QUEUE ACTIONS
  // Handles save, refresh, archive, date edit, and view.
  // -----------------------------------------------------

  async function saveJobToQueue(jobData, assessment = null) {
    const now = new Date().toISOString();
    const isFinalAssessment = assessment?.isFinal === true;

    const cleanJob = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      projectName: jobData.projectName || "Unnamed Job",
      locationQuery: jobData.locationQuery,
      selectedLocation: jobData.selectedLocation,
      city: jobData.city,
      state: jobData.state,
      workDate: jobData.workDate,
      workType: jobData.workType,
      operatingWindow: jobData.operatingWindow,
      surfaceCondition: isPavingService(jobData.workType)
        ? jobData.surfaceCondition ||
          getSurfaceConditionFromBaseExposed(jobData.baseExposed)
        : "Subgrade exposed & paved same day",
      baseExposed: isPavingService(jobData.workType)
        ? getBaseExposedFromSurfaceCondition(
            jobData.surfaceCondition ||
              getSurfaceConditionFromBaseExposed(jobData.baseExposed)
          )
        : "No",
      multiDay: "No",
      finalCallTime: normalizeFinalCallTime(
        jobData.finalCallTime || companySettings.defaultFinalCallTime
      ),
      finalCallDueAt: jobData.finalCallDueAt || "",
      timeZone: assessment?.timeZone || jobData.timeZone || "",
      status: isFinalAssessment ? "call_made" : "active",
      callMadeAt: isFinalAssessment ? now : "",
      createdAt: now,
      updatedAt: now,
      lastResult: null,
      lastCheckedAt: "",
      lastError: "",
    };

    const existingJob = savedJobs.find((job) => {
      return (
        job.projectName.trim().toLowerCase() ===
          cleanJob.projectName.trim().toLowerCase() &&
        job.city.trim().toLowerCase() === cleanJob.city.trim().toLowerCase() &&
        job.state === cleanJob.state &&
        job.workDate === cleanJob.workDate &&
        job.workType === cleanJob.workType
      );
    });

    let backendJobId = existingJob?.backendId || existingJob?.id || "";
    let assessmentToStore = assessment;

    try {
      if (!backendJobId) {
        // Create the job as active first. The final status and locked
        // assessment are applied together after the history row is saved.
        const backendRows = await saveJobToBackend({
          ...cleanJob,
          status: "active",
          callMadeAt: "",
        });
        const backendJob = Array.isArray(backendRows)
          ? backendRows[0]
          : backendRows;
        backendJobId = backendJob?.id || "";
        cleanJob.finalCallDueAt =
          backendJob?.final_call_due_at || cleanJob.finalCallDueAt || "";
        cleanJob.timeZone =
          backendJob?.time_zone || cleanJob.timeZone || "";
      }

      if (!backendJobId) {
        throw new Error("The saved job did not return a backend job ID.");
      }

      if (
        assessmentToStore?.isFinal === true &&
        !assessmentToStore?.savedAssessmentId
      ) {
        const selectedLocation = jobData.selectedLocation || {};
        const location = {
          name:
            selectedLocation.displayName ||
            jobData.city ||
            jobData.projectName ||
            "Selected location",
          admin1: selectedLocation.state || jobData.state || "",
          latitude: selectedLocation.latitude ?? null,
          longitude: selectedLocation.longitude ?? null,
        };

        const savedAssessmentId = await saveAssessmentToBackend({
          form: {
            ...jobData,
            activeCompanyId,
            backendJobId,
          },
          location,
          timing: getAssessmentTiming({
            ...jobData,
            finalCallTime: cleanJob.finalCallTime,
            finalCallDueAt: cleanJob.finalCallDueAt,
            timeZone: cleanJob.timeZone,
          }),
          backendInput: assessmentToStore.backendInput,
          scoringResult: assessmentToStore.backendScoring,
        });

        if (!savedAssessmentId) {
          throw new Error("The final assessment did not return a history ID.");
        }

        assessmentToStore = {
          ...assessmentToStore,
          savedAssessmentId,
        };
      }

      if (assessmentToStore) {
        assessmentToStore = {
          ...assessmentToStore,
          savedJobId: backendJobId,
        };
        await updateJobLatestResultInBackend(
          backendJobId,
          assessmentToStore
        );
      }

      const storedJob = {
        ...(existingJob || {}),
        ...cleanJob,
        id: backendJobId,
        backendId: backendJobId,
        createdAt: existingJob?.createdAt || cleanJob.createdAt,
        status: assessmentToStore?.isFinal ? "call_made" : "active",
        callMadeAt: assessmentToStore?.isFinal ? now : "",
        lockedAssessmentId:
          assessmentToStore?.isFinal && assessmentToStore?.savedAssessmentId
            ? assessmentToStore.savedAssessmentId
            : existingJob?.lockedAssessmentId || "",
        lastResult: assessmentToStore
          ? makeStoredResult(assessmentToStore)
          : existingJob?.lastResult || null,
        lastCheckedAt: assessmentToStore ? now : existingJob?.lastCheckedAt || "",
        updatedAt: now,
        lastError: "",
      };

      setSavedJobs((currentJobs) => {
        const filteredJobs = currentJobs.filter((job) => {
          const isExistingLocalJob =
            existingJob &&
            (job.id === existingJob.id ||
              job.backendId === existingJob.backendId);
          const isSavedBackendJob =
            job.id === backendJobId || job.backendId === backendJobId;

          return !isExistingLocalJob && !isSavedBackendJob;
        });

        return [storedJob, ...filteredJobs];
      });

      lastSavedJobRef.current = storedJob;

      setCopyNotice(language === "es" ? "Trabajo guardado." : "Job saved.");
      return assessmentToStore;
    } catch (err) {
      setCopyNotice(
        `Job could not be saved completely: ${
          err?.message || "Unknown error"
        }`
      );
      throw err;
    }
  }
async function saveJobToBackend(job) {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  if (!activeCompanyId) {
    throw new Error("Please log in and connect a company before saving jobs.");
  }

  if (!session?.user?.id) {
    throw new Error("Please log in before saving jobs.");
  }

  const payload = {
    company_id: activeCompanyId,
    created_by: session.user.id,
    project_name: job.projectName || "Unnamed Job",
    location_query: job.locationQuery || "",
    city: job.city || "",
    state: job.state || "",
    latitude: job.selectedLocation?.latitude || null,
    longitude: job.selectedLocation?.longitude || null,
    work_date: job.workDate,
    service_type: job.workType,
    operating_window: job.operatingWindow,
    surface_condition: isPavingService(job.workType)
      ? normalizeSurfaceConditionForStorage(job.surfaceCondition)
      : "overlay",
    base_exposed: isPavingService(job.workType)
      ? getBaseExposedFromSurfaceCondition(job.surfaceCondition) === "Yes"
      : false,
    multi_day: false,
    // Legacy hours remain populated until the backend scoring context is fully
    // retired. Scheduling now uses final_call_time.
    final_call_window_hours: 24,
    final_call_time: normalizeFinalCallTime(job.finalCallTime),
    ...(job.timeZone ? { time_zone: job.timeZone } : {}),
    status: job.status || "active",
    call_made_at: job.callMadeAt || null,
  };

  const { data, error } = await supabase
    .from("jobs")
    .insert(payload)
    .select();

  if (error) {
    throw new Error(error.message || "Backend save failed.");
  }

  return data || [];
}

async function loadJobsFromBackend(
  companyIdOverride = "",
  userIdOverride = "",
  options = {}
) {
  const { silent = false } = options;
  if (!supabase) {
    setCopyNotice("Supabase is not configured.");
    return;
  }

  const companyIdToUse = companyIdOverride || activeCompanyId;
  const userIdToUse = userIdOverride || session?.user?.id;

  if (!silent) {
  setLoadingBackendJobs(true);
  setCopyNotice("");
  setError("");
}

  try {
    if (!companyIdToUse) {
  if (!silent) {
    setCopyNotice("Please log in and connect a company before loading jobs.");
    setLoadingBackendJobs(false);
  }
  return [];
}

   if (!userIdToUse) {
  if (!silent) {
    setCopyNotice("Please log in before loading jobs.");
    setLoadingBackendJobs(false);
  }
  return [];
}

    const recentFinalCallCutoff = new Date();
    recentFinalCallCutoff.setDate(recentFinalCallCutoff.getDate() - 1);
    const recentFinalCallCutoffDate = [
      recentFinalCallCutoff.getFullYear(),
      String(recentFinalCallCutoff.getMonth() + 1).padStart(2, "0"),
      String(recentFinalCallCutoff.getDate()).padStart(2, "0"),
    ].join("-");

    const [activeResult, recentFinalResult, historicalFinalResult] =
      await Promise.all([
        supabase
          .from("jobs")
          .select("*")
          .eq("company_id", companyIdToUse)
          .eq("created_by", userIdToUse)
          .eq("status", "active")
          .order("updated_at", { ascending: false }),
        supabase
          .from("jobs")
          .select("*")
          .eq("company_id", companyIdToUse)
          .eq("created_by", userIdToUse)
          .eq("status", "call_made")
          .gte("work_date", recentFinalCallCutoffDate)
          .order("updated_at", { ascending: false }),
        supabase
          .from("jobs")
          .select("*")
          .eq("company_id", companyIdToUse)
          .eq("created_by", userIdToUse)
          .eq("status", "call_made")
          .lt("work_date", recentFinalCallCutoffDate)
          .order("call_made_at", { ascending: false })
          .limit(10),
      ]);

    const queryError =
      activeResult.error ||
      recentFinalResult.error ||
      historicalFinalResult.error;

    if (queryError) {
      throw new Error(queryError.message || "Backend job load failed.");
    }

    const backendRows = [
      ...(activeResult.data || []),
      ...(recentFinalResult.data || []),
      ...(historicalFinalResult.data || []),
    ];
    const uniqueBackendRows = Array.from(
      new Map(backendRows.map((row) => [row.id, row])).values()
    );
    const backendJobs = uniqueBackendRows.map((row) =>
      backendRowToSavedJob(row)
    );

    setSavedJobs(backendJobs);

if (!silent) {
  setCopyNotice("");
}

return backendJobs;
  } catch (err) {
    if (!silent) {
  setCopyNotice(
    `Backend job load failed: ${err.message || "Unknown error"}`
  );
}

return [];
  } finally {
    if (!silent) {
  setLoadingBackendJobs(false);
}
  }
}

function backendRowToSavedJob(row) {
  const surfaceCondition = isPavingService(row.service_type || "Paving")
    ? getSurfaceConditionFromBackendRow(row)
    : "Overlay";

  return {
    id: row.id,
    backendId: row.id,
    projectName: row.project_name || "Unnamed Job",
    locationQuery: row.location_query || "",
    selectedLocation:
      row.latitude && row.longitude
        ? {
            displayName: row.project_name || row.location_query || "Saved Job",
            formattedAddress: row.location_query || "",
            city: row.city || "",
            state: row.state || "",
            latitude: row.latitude,
            longitude: row.longitude,
          }
        : null,
    city: row.city || "",
    state: row.state || "",
    workDate: row.work_date || getTomorrowDate(),
    workType: row.service_type || "Paving",
    operatingWindow: row.operating_window || "Day",
    surfaceCondition,
    baseExposed: getBaseExposedFromSurfaceCondition(surfaceCondition),
    multiDay: "No",
    finalCallTime: normalizeFinalCallTime(row.final_call_time),
    finalCallDueAt: row.final_call_due_at || "",
    timeZone: row.time_zone || "America/New_York",
        createdAt: row.created_at || new Date().toISOString(),
updatedAt: row.updated_at || row.created_at || new Date().toISOString(),
status: row.status || "active",
callMadeAt: row.call_made_at || "",
feedbackRating: row.feedback_rating || "",
feedbackSubmittedAt: row.feedback_submitted_at || "",
feedbackWindowClosesAt: row.feedback_window_closes_at || "",
copiedFromJobId: row.copied_from_job_id || "",
lockedAssessmentId: row.locked_assessment_id || "",
lastResult: row.last_result || null,
lastCheckedAt: row.last_checked_at || "",
lastError: row.last_error || "",
autoFinalCallEnabled: row.auto_final_call_enabled !== false,
autoFinalCallStatus: row.auto_final_call_status || "",
autoFinalCallCompletedAt: row.auto_final_call_completed_at || "",
autoFinalCallError: row.auto_final_call_error || "",
notificationSeenAt: row.notification_seen_at || "",
  };
}

function isAutoFinalCallUnseen(job) {
  return (
    isSavedJobAutoPrepared(job) &&
    Boolean(job?.lastResult) &&
    !job?.notificationSeenAt
  );
}

async function markAutoFinalNotificationSeen(jobId) {
  const targetJob = savedJobs.find((job) => job.id === jobId);

  if (!targetJob) return;

  const now = new Date().toISOString();
  const backendJobId = targetJob.backendId || targetJob.id;

  setSavedJobs((currentJobs) =>
    currentJobs.map((job) =>
      job.id === jobId
        ? { ...job, notificationSeenAt: now, updatedAt: now }
        : job
    )
  );

  if (!supabase || !activeCompanyId || !session?.user?.id) return;

  const { error } = await supabase
    .from("jobs")
    .update({
      notification_seen_at: now,
      updated_at: now,
    })
    .eq("id", backendJobId)
    .eq("company_id", activeCompanyId)
    .eq("created_by", session.user.id);

  if (error) {
    setCopyNotice(`Notification could not be marked seen: ${error.message || "Unknown error"}`);
  }
}

async function reviewAutoPreparedFinalCall(job) {
  await markAutoFinalNotificationSeen(job.id);
  viewSavedJob({
    ...job,
    notificationSeenAt: new Date().toISOString(),
  });
}
  function updateSavedJobResult(jobId, assessment, shouldLockCall = false) {
  const now = new Date().toISOString();

  setSavedJobs((currentJobs) =>
    currentJobs.map((job) => {
      if (job.id !== jobId) return job;

      return {
        ...job,
        status: shouldLockCall ? "call_made" : job.status || "active",
        callMadeAt: shouldLockCall ? now : job.callMadeAt || "",
        lastResult: makeStoredResult(assessment),
        lastCheckedAt: now,
        updatedAt: now,
        lastError: "",
      };
    })
  );
}
  function updateSavedJobError(jobId, message) {
  setSavedJobs((currentJobs) =>
    currentJobs.map((job) => {
      if (job.id !== jobId) return job;

      return {
        ...job,
        lastError: message,
      };
    })
  );
}

async function duplicateJobToNewDate(job) {
  const nextDate = window.prompt(
    "Enter the new work date for this copied job using YYYY-MM-DD format:",
    getTomorrowDate()
  );

  if (!nextDate) {
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
    setCopyNotice("Please use date format YYYY-MM-DD.");
    return;
  }

  const copiedJob = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectName: job.projectName || "Unnamed Job",
    locationQuery: job.locationQuery || "",
    selectedLocation: job.selectedLocation || null,
    city: job.city || "",
    state: job.state || "",
    workDate: nextDate,
    workType: job.workType || "Paving",
    operatingWindow: job.operatingWindow || "Day",
    surfaceCondition: isPavingService(job.workType)
      ? job.surfaceCondition || getSurfaceConditionFromBaseExposed(job.baseExposed)
      : "Subgrade exposed & paved same day",
    baseExposed: isPavingService(job.workType)
      ? getBaseExposedFromSurfaceCondition(
          job.surfaceCondition || getSurfaceConditionFromBaseExposed(job.baseExposed)
        )
      : "No",
    multiDay: "No",
    finalCallTime: normalizeFinalCallTime(
      job.finalCallTime || companySettings.defaultFinalCallTime
    ),
    finalCallDueAt: "",
    timeZone: job.timeZone || "",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastResult: null,
    lastCheckedAt: "",
    lastError: "",
    feedbackRating: "",
    feedbackSubmittedAt: "",
    copiedFromJobId: job.backendId || job.id,
  };

  setSavedJobs((currentJobs) => [copiedJob, ...currentJobs]);

  try {
    const backendRows = await saveJobToBackend(copiedJob);
    const backendJob = Array.isArray(backendRows) ? backendRows[0] : backendRows;
    const backendJobId = backendJob?.id;

    if (backendJobId) {
      setSavedJobs((currentJobs) =>
        currentJobs.map((currentJob) => {
          if (currentJob.id !== copiedJob.id) return currentJob;

          return {
            ...currentJob,
            id: backendJobId,
            backendId: backendJobId,
          };
        })
      );
    }

    setCopyNotice("Project copied to new date.");
  } catch (err) {
    setCopyNotice(
      `Project copied on screen, but backend save failed: ${
        err.message || "Unknown error"
      }`
    );
  }
}

async function rateLockedCall(jobId, rating) {
  const targetJob = savedJobs.find((job) => job.id === jobId);

  if (!targetJob) {
    setCopyNotice("Call not found.");
    return;
  }

  if (targetJob.feedbackRating) {
    setCopyNotice("This call has already been rated.");
    return;
  }

  if (!supabase) {
    setCopyNotice("Supabase is not configured.");
    return;
  }

  if (!activeCompanyId) {
    setCopyNotice("Please log in and connect a company before rating calls.");
    return;
  }

  if (!session?.user?.id) {
    setCopyNotice("Please log in before rating calls.");
    return;
  }

  const now = new Date().toISOString();
  const backendJobId = targetJob.backendId || targetJob.id;

  // Optimistic UI update first.
  setSavedJobs((currentJobs) =>
    currentJobs.map((job) => {
      if (job.id !== jobId) return job;

      return {
        ...job,
        feedbackRating: rating,
        feedbackSubmittedAt: now,
        updatedAt: now,
      };
    })
  );

  setCopyNotice(rating === "up" ? "Marked as good call." : "Marked as bad call.");

  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        feedback_rating: rating,
        feedback_submitted_at: now,
        updated_at: now,
      })
      .eq("id", backendJobId)
      .eq("company_id", activeCompanyId)
      .eq("created_by", session.user.id)
      .is("feedback_rating", null);

    if (error) {
      throw new Error(error.message || "Feedback save failed.");
    }
  } catch (err) {
    // Revert the visible rating if backend save fails.
    setSavedJobs((currentJobs) =>
      currentJobs.map((job) => {
        if (job.id !== jobId) return job;

        return {
          ...job,
          feedbackRating: "",
          feedbackSubmittedAt: "",
        };
      })
    );

    setCopyNotice(
      `Rating could not be saved: ${err.message || "Unknown error"}`
    );
  }
}

async function deleteSavedJob(jobId) {
  const jobToDelete = savedJobs.find((job) => job.id === jobId);

  if (!jobToDelete) {
    setCopyNotice("Job not found.");
    return;
  }

  if (!activeCompanyId) {
    setCopyNotice("Please log in and connect a company before deleting jobs.");
    return;
  }

  const backendJobId = jobToDelete.backendId || jobToDelete.id;

  // Optimistic UI update: remove from screen first.
  const updatedJobs = savedJobs.filter((job) => job.id !== jobId);
  setSavedJobs(updatedJobs);
  setCopyNotice("");

  try {
    await deleteJobFromBackend(backendJobId);
    setCopyNotice("Job deleted.");
  } catch (err) {
    // Put it back if backend delete fails.
    setSavedJobs(savedJobs);
    setCopyNotice(
      `Job could not be deleted from backend: ${err.message || "Unknown error"}`
    );
  }
}

async function updateJobLatestResultInBackend(jobId, assessment, errorMessage = "", overrides = {}) {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  const companyIdToUse = overrides.companyId || activeCompanyId;
  const userIdToUse = overrides.userId || session?.user?.id;

  if (!companyIdToUse) {
    throw new Error("Please log in and connect a company before updating jobs.");
  }

  if (!userIdToUse) {
    throw new Error("Please log in before updating jobs.");
  }

  const now = new Date().toISOString();

  const payload = errorMessage
    ? {
        last_error: errorMessage,
        updated_at: now,
      }
    : {
        last_result: makeStoredResult(assessment),
        last_checked_at: now,
        last_error: "",
        status: assessment?.isFinal ? "call_made" : "active",
        call_made_at: assessment?.isFinal ? now : null,
        ...(assessment?.isFinal && assessment?.savedAssessmentId
          ? {
              locked_assessment_id: assessment.savedAssessmentId,
            }
          : {}),
        updated_at: now,
      };

  const { data: updatedJob, error } = await supabase
    .from("jobs")
    .update(payload)
    .eq("id", jobId)
    .eq("company_id", companyIdToUse)
    .eq("created_by", userIdToUse)
    .select("id, locked_assessment_id")
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Backend latest result update failed.");
  }

  if (!updatedJob?.id) {
    throw new Error(
      "Backend latest result update did not match the saved job."
    );
  }

  if (
    assessment?.isFinal &&
    assessment?.savedAssessmentId &&
    updatedJob.locked_assessment_id !== assessment.savedAssessmentId
  ) {
    throw new Error("The final assessment was not locked to the saved job.");
  }

  return updatedJob;
}

async function deleteJobFromBackend(jobId) {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  if (!activeCompanyId) {
    throw new Error("Please log in and connect a company before deleting jobs.");
  }

  if (!session?.user?.id) {
    throw new Error("Please log in before deleting jobs.");
  }

  const { error } = await supabase
    .from("jobs")
    .update({
      status: "archived",
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("company_id", activeCompanyId)
    .eq("created_by", session.user.id);

  if (error) {
    throw new Error(error.message || "Backend archive failed.");
  }

  return true;
}

function startEditingJobDate(job) {
  setEditingDateJobId(job.id);
  setEditingDateValue(job.workDate || getTomorrowDate());
  setCopyNotice("");
}

function cancelEditingJobDate() {
  setEditingDateJobId(null);
  setEditingDateValue("");
}

async function updateSavedJobDate(jobId) {
  if (!editingDateValue) {
    setCopyNotice("Please choose a date.");
    return;
  }

  const targetJob = savedJobs.find((job) => job.id === jobId);

  const updatedJobs = savedJobs.map((job) => {
    if (job.id !== jobId) return job;

    return {
      ...job,
      workDate: editingDateValue,
      status: "active",
      callMadeAt: "",
      feedbackRating: "",
      feedbackSubmittedAt: "",
      lastResult: null,
      lastCheckedAt: "",
      lastError: "",
    };
  });

  setSavedJobs(updatedJobs);
  setEditingDateJobId(null);
  setEditingDateValue("");
  setCopyNotice("Date updated. Run a new check for this job.");

  if (!targetJob?.backendId || !activeCompanyId || !session?.user?.id || !supabase) {
    return;
  }

  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        work_date: editingDateValue,
        last_result: null,
        last_checked_at: null,
        last_error: "",
        status: "active",
        feedback_rating: null,
        feedback_submitted_at: null,
        call_made_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetJob.backendId)
      .eq("company_id", activeCompanyId)
      .eq("created_by", session.user.id);

    if (error) {
      throw new Error(error.message || "Backend date update failed.");
    }
  } catch (err) {
    setCopyNotice(`Date changed on screen, but backend update failed: ${err.message || "Unknown error"}`);
  }
}

  function viewSavedJob(job, mode = "details") {
    if (!job.lastResult) {
      setCopyNotice("Run a check on this job before viewing the full result.");
      return;
    }

    setForm(jobToForm(job));
    setResult(job.lastResult);
    setResultMode(mode === "messages" ? "messages" : "details");
    setSelectedMessageAudience("client");
    setMessageDraft("");
    setResultJobContext(job);
    setShowWeatherDetails(false);
    setError("");
    setCopyNotice("");
    setScreen("result");
  }

async function deleteResultJob() {
  if (!resultJobContext?.id) return;

  await deleteSavedJob(resultJobContext.id);
  setResultJobContext(null);
  setScreen("dashboard");
}

  // -----------------------------------------------------
  // 1F — COPY MESSAGE ACTIONS
  // -----------------------------------------------------

  async function copyText(text, label) {
    setCopyNotice("");

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyNotice(`${label} copied.`);
        return;
      }
    } catch {
      // Continue to fallback below.
    }

    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.setAttribute("readonly", "");
      textArea.style.position = "fixed";
      textArea.style.top = "0";
      textArea.style.left = "0";
      textArea.style.opacity = "0";
      textArea.style.zIndex = "-1";

      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      textArea.setSelectionRange(0, textArea.value.length);

      const copied = document.execCommand("copy");
      document.body.removeChild(textArea);

      if (copied) {
        setCopyNotice(`${label} copied.`);
      } else {
        setCopyNotice(`${label} could not copy automatically on this browser.`);
      }
    } catch {
      setCopyNotice(`${label} could not copy automatically on this browser.`);
    }
  }

  // -----------------------------------------------------
  // 1G — DERIVED VALUES FOR DISPLAY
  // -----------------------------------------------------

  const resultCommunications = result?.communications || {};

const emailTemplate = result
  ? language === "es"
    ? buildEmailTemplate(result, language)
    : resultCommunications.client || buildEmailTemplate(result, language)
  : "";

const crewTemplate = result
  ? language === "es"
    ? buildCrewTemplate(result, form, language)
    : resultCommunications.crew || buildCrewTemplate(result, form, language)
  : "";

const textTemplate = result
  ? language === "es"
    ? buildTextTemplate(result, form, language)
    : resultCommunications.vendor || buildTextTemplate(result, form, language)
  : "";

const slackTemplate = result
  ? language === "es"
    ? buildSlackTemplate(result, language)
    : resultCommunications.internal || buildSlackTemplate(result, language)
  : "";

const messageTemplates = {
  client: emailTemplate,
  crew: crewTemplate,
  vendor: textTemplate,
};

const selectedMessageTemplate = messageTemplates[selectedMessageAudience] || emailTemplate;
const selectedMessageLabel = t(selectedMessageAudience);

useEffect(() => {
  if (resultMode !== "messages") return;

  setMessageDraft(selectedMessageTemplate || "");
}, [
  resultMode,
  selectedMessageAudience,
  selectedMessageTemplate,
  result?.checkedAt,
  language,
]);

function handleMessageAudienceChange(audience) {
  setSelectedMessageAudience(audience);
  setCopyNotice("");
}

function resetMessageDraft() {
  setMessageDraft(selectedMessageTemplate || "");
  setCopyNotice(t("messageTemplateReset"));
}

const weatherConnectedTime = formatCurrentTime();
const currentResultJob = resultJobContext?.id
  ? savedJobs.find((job) => job.id === resultJobContext.id) || resultJobContext
  : null;
const currentResultJobId =
  currentResultJob?.backendId ||
  currentResultJob?.id ||
  result?.savedJobId ||
  "";
const currentJobExperience = adoption.getJobExperience(currentResultJobId);
const currentFinalDecision = currentJobExperience.decisions.find(
  (decision) => decision.stage === "final"
);
const currentResultJobHasFinalResult = currentResultJob
  ? isSavedJobFinalResult(currentResultJob)
  : result?.isFinal === true;
const currentResultJobFeedbackRating = currentResultJob?.feedbackRating || "";

const callsMadeJobs = savedJobs
  .filter((job) => isSavedJobFinalResult(job) && hasWorkDatePassed(job))
  .sort(sortNewestCallFirst)
  .slice(0, 10);

const visibleActiveJobs = savedJobs.filter((job) => {
  if (!isSavedJobFinalResult(job)) return true;

  return !hasWorkDatePassed(job);
});

function isDashboardActionRequired(job) {
  if (!job || isSavedJobFinalResult(job) || hasWorkWindowStarted(job)) {
    return false;
  }

  const timing = getAssessmentTiming(job);
  const autoFinalStatus = String(
    job.autoFinalCallStatus || ""
  ).toLowerCase();

  const automaticFinalEnabled = job.autoFinalCallEnabled !== false;

  const automaticFinalPending = [
    "pending",
    "processing",
  ].includes(autoFinalStatus);

  const automaticFinalFailed =
    timing.isFinal &&
    automaticFinalEnabled &&
    autoFinalStatus === "failed";

  const automaticFinalMissing =
    timing.isFinal &&
    automaticFinalEnabled &&
    !automaticFinalPending &&
    autoFinalStatus !== "prepared";

  const manualFinalRequired =
    timing.isFinal &&
    !automaticFinalEnabled;

  return (
    automaticFinalFailed ||
    automaticFinalMissing ||
    manualFinalRequired
  );
}

function isDashboardElevatedPreliminaryRisk(job) {
  if (!job || isSavedJobFinalResult(job) || hasWorkWindowStarted(job)) {
    return false;
  }

  const signal = String(job.lastResult?.shortSignal || "").toUpperCase();

  return (
    isTomorrowWorkDate(job.workDate) &&
    ["WATCH", "NO GO", "HIGH RISK"].includes(signal)
  );
}

const dashboardTodaysJobs = visibleActiveJobs
  .filter(
    (job) =>
      isSameWorkDate(job.workDate, new Date()) ||
      isSavedJobFinalResult(job) ||
      isDashboardActionRequired(job) ||
      isDashboardElevatedPreliminaryRisk(job)
  )
  .sort((a, b) => {
    const actionDifference =
      Number(isDashboardActionRequired(b)) -
      Number(isDashboardActionRequired(a));

    if (actionDifference) return actionDifference;

    const preliminaryRiskDifference =
      Number(isDashboardElevatedPreliminaryRisk(b)) -
      Number(isDashboardElevatedPreliminaryRisk(a));

    return preliminaryRiskDifference || sortFinalCallsFirst(a, b);
  });

const dashboardTodayJobIds = new Set(
  dashboardTodaysJobs.map((job) => job.id)
);

const dashboardPreliminaryJobs = visibleActiveJobs
  .filter((job) => !dashboardTodayJobIds.has(job.id))
  .sort(sortByWorkDateSoonestFirst);

function renderJobCard(job, options = {}) {
  const {
    showReason = false,
    showActionRequired = false,
  } = options;
  const queueTiming = getAssessmentTiming(job);
  const status = getJobStatus(job);
  const hasFinalResult = isSavedJobFinalResult(job);
  const hasAnyResult = Boolean(job.lastResult);
  const isAutoFinalPrepared = isSavedJobAutoPrepared(job);
  const finalResultTime = getSavedJobFinalResultTime(job);
  const workWindowStarted = hasWorkWindowStarted(job);
  const finalWindowOpen = queueTiming.isFinal && !hasFinalResult && !workWindowStarted;
const autoFinalStatus = String(
  job.autoFinalCallStatus || ""
).toLowerCase();

const automaticFinalEnabled =
  job.autoFinalCallEnabled !== false;

const autoFinalPending =
  finalWindowOpen &&
  automaticFinalEnabled &&
  ["pending", "processing"].includes(autoFinalStatus);

const autoFinalFailed =
  finalWindowOpen &&
  automaticFinalEnabled &&
  autoFinalStatus === "failed";

const autoFinalMissing =
  finalWindowOpen &&
  automaticFinalEnabled &&
  !["pending", "processing", "prepared", "failed"].includes(
    autoFinalStatus
  );

const manualFinalRequired =
  finalWindowOpen &&
  !automaticFinalEnabled;

const showCheckButton =
  !hasFinalResult &&
  !workWindowStarted &&
  !finalWindowOpen;

const showRetryButton = autoFinalFailed;

const showRunFinalButton =
  autoFinalMissing ||
  manualFinalRequired;

const showPreparingButton = autoFinalPending;

const showMessagesButton =
  hasFinalResult &&
  !hasWorkDatePassed(job);

const showFallbackActions =
  !hasAnyResult &&
  !showPreparingButton &&
  !showRetryButton &&
  !showRunFinalButton;

  const serviceLabel = getDashboardServiceTag(job.workType, language);
  const signal = String(job.lastResult?.shortSignal || status.label || "").toUpperCase();
  const weatherIcon =
    signal.includes("NO GO") || signal.includes("HIGH RISK")
      ? "🌧️"
      : signal.includes("WATCH") || signal.includes("MODERATE")
      ? "🌤️"
      : "☀️";
  const statusLine = hasFinalResult
    ? `${isAutoFinalPrepared ? t("autoPrepared") : t("finalCallRun")} ${formatCheckedAtFull(finalResultTime)}`
    : workWindowStarted
    ? t("workWindowStartedNoFinal")
    : showPreparingButton
    ? t("finalCallPreparing")
    : finalWindowOpen
    ? t("finalWindowOpen")
    : `${translateQueueLabel(queueTiming.queueLabel, language)} · ${getFinalCallTimingSummary(
        job,
        language
      )}`;

  return (
    <div
      key={job.id}
      style={{
        ...jobCardStyle,
        borderLeft: `6px solid ${status.color}`,
        background: status.cardBg,
      }}
    >
      <div style={jobCardContentStyle}>
        {showActionRequired && (
          <div style={actionRequiredBadgeStyle}>
            <span>!</span>
            {t("actionRequired")}
          </div>
        )}

        <div style={jobCompactTopRowStyle}>
          <div style={jobServiceColumnStyle}>
            <span style={serviceTagStyle}>{serviceLabel}</span>
            <span style={jobWeatherIconStyle}>{weatherIcon}</span>
          </div>

          <div style={jobMainColumnStyle}>
            <div style={jobTitleStatusRowStyle}>
              <h3 style={jobTitleStyle}>{job.projectName}</h3>
              <span
                style={{
                  ...jobBadgeStyle,
                  background: status.bg,
                  borderColor: status.border,
                  color: status.text,
                }}
              >
                {translateStatusLabel(status.label, language)}
              </span>
            </div>

            <p style={jobMetaStyle}>
              {job.city}, {job.state} · {formatDateLabel(job.workDate, language)}
              {job.lastResult?.workWindowTempRange && job.lastResult.workWindowTempRange !== "Unavailable"
                ? ` · ${job.lastResult.workWindowTempRange}`
                : ""}
            </p>
            <p style={jobMetaSmallStyle}>{statusLine}</p>
          </div>
        </div>

        {hasFinalResult && showMessagesButton ? (
          <div style={finalJobActionRowStyle}>
            <button
              type="button"
              onClick={() => viewSavedJob(job)}
              style={viewCallLinkButtonStyle}
            >
              {t("viewCall")}
            </button>

            <button
              type="button"
              onClick={() => viewSavedJob(job, "messages")}
              style={messagesJobButtonWideStyle}
            >
              <span style={messagesJobButtonIconStyle}>💬</span>
              {t("messages")}
            </button>
          </div>
        ) : (
          <div style={compactJobButtonGridStyle}>
            {hasAnyResult && (
              <button
                onClick={() => viewSavedJob(job)}
                style={viewJobButtonStyle}
              >
                {t("view")}
              </button>
            )}

            {showCheckButton && (
              <button
                onClick={() => runSavedJob(job)}
                style={runJobButtonStyle}
                disabled={checkingJobId === job.id || loadingAll || dashboardAutoRefreshRunning}
              >
                {checkingJobId === job.id ? t("checking") : t("check")}
              </button>
            )}

            {showPreparingButton && (
              <button
                type="button"
                style={preparingFinalCallButtonStyle}
                disabled
              >
                {t("preparing")}
              </button>
            )}

            {showRetryButton && (
              <button
                onClick={() => runSavedJob(job)}
                style={runJobButtonStyle}
                disabled={checkingJobId === job.id || loadingAll || dashboardAutoRefreshRunning}
              >
                {checkingJobId === job.id ? t("checking") : t("retry")}
              </button>
            )}

            {showRunFinalButton && (
  <button
    type="button"
    onClick={() => runSavedJob(job)}
    style={runJobButtonStyle}
    disabled={
      checkingJobId === job.id ||
      loadingAll ||
      dashboardAutoRefreshRunning
    }
  >
    {checkingJobId === job.id
      ? t("checking")
      : t("runFinalCallNow")}
  </button>
)}

            {showFallbackActions && (
              <>
                <button onClick={() => startEditingJobDate(job)} style={dateJobButtonStyle}>
                  {t("date")}
                </button>

                <button onClick={() => deleteSavedJob(job.id)} style={deleteJobButtonStyle}>
                  {t("delete")}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {showReason && job.lastResult?.reason && (
        <div style={compactReasonRowStyle}>
          <span style={compactReasonIconStyle}>{weatherIcon}</span>
          <p style={compactReasonTextStyle}>{getDisplayReason(job.lastResult, language)}</p>
        </div>
      )}

      {!hasFinalResult && editingDateJobId === job.id && (
        <div style={dateEditBoxStyle}>
          <input
            type="date"
            value={editingDateValue}
            onChange={(e) => setEditingDateValue(e.target.value)}
            style={dateEditInputStyle}
          />

          <div style={dateEditButtonGridStyle}>
            <button
              onClick={() => updateSavedJobDate(job.id)}
              style={saveDateButtonStyle}
            >
              {t("saveDate")}
            </button>

            <button onClick={cancelEditingJobDate} style={cancelDateButtonStyle}>
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {job.lastError && <div style={jobErrorStyle}>{job.lastError}</div>}
    </div>
  );
}

  // -----------------------------------------------------
  // 1H — APP RENDER
  // Dashboard, intake screen, and result screen.
  // -----------------------------------------------------

  const selectedWeatherCautionOption = getWeatherCallCautionOption(
    companySettings.weatherCallCaution
  );
  const selectedWeatherCautionIndex = getWeatherCallCautionIndex(
    companySettings.weatherCallCaution
  );
  const selectedDefaultFinalCallTimeIndex = getFinalCallTimeIndex(
    companySettings.defaultFinalCallTime
  );
  const routinePushAlertStatusMessages = [
    t("alertsEnabledMessage"),
    t("alertsDisabledMessage"),
  ];
  const nonRoutinePushAlertMessage =
    pushAlertMessage && !routinePushAlertStatusMessages.includes(pushAlertMessage)
      ? pushAlertMessage
      : "";

if ((!session || (!activeCompanyId && screen !== "resetPassword")) && !guestMode) {
  return (
    <main style={pageStyle}>
      <div style={phoneAppStyle}>
        <section style={scrollScreenStyle}>
          {isCreateEntry ? (
            <div style={createEntryTopStyle}>
              <div style={createEntryBrandRowStyle}>
                <img
                  src="/fieldcall-logo.png"
                  alt="FieldCall logo"
                  style={heroLogoImageStyle}
                />
                <p style={heroBrandNameStyle}>FieldCall</p>
                <LanguageToggle language={language} onChange={handleLanguageChange} />
              </div>
            </div>
          ) : (
            <div style={heroCardStyle}>
              <div style={heroBrandRowStyle}>
                <img
                  src="/fieldcall-logo.png"
                  alt="FieldCall logo"
                  style={heroLogoImageStyle}
                />
                <div>
                  <p style={heroBrandNameStyle}>FieldCall</p>
                </div>
                <LanguageToggle language={language} onChange={handleLanguageChange} />
              </div>

              <h2 style={heroTitleStyle}>{t("preLoginTitle")}</h2>
              <p style={heroTextStyle}>{t("preLoginText")}</p>
            </div>
          )}

          <div style={isCreateEntry ? createEntryCardStyle : preLoginCardStyle}>
            {userHasNoCompany ? (
              <div style={authHelperStyle}>
                <div style={authHelperTitleStyle}>
                  {t("finishCompanySetupTitle")}
                </div>
                <div style={authHelperTextStyle}>
                  {t("finishCompanySetupText")}
                </div>
              </div>
            ) : isCreateEntry && authMode === "create" ? (
              <div style={createEntryIntroStyle}>
                <div style={createEntryBadgeStyle}>✓ {t("freeDuringPrivateBeta")}</div>
                <h1 style={createEntryTitleStyle}>{t("createEntryTitle")}</h1>
                <p style={createEntryTextStyle}>{t("createEntryText")}</p>
              </div>
            ) : (
              <div style={authHelperStyle}>
                <div style={authHelperTitleStyle}>
                  {authMode === "forgot"
                    ? t("forgotPasswordTitle")
                    : authMode === "login"
                    ? t("welcomeBack")
                    : authMode === "create"
                    ? t("newToFieldCall")
                    : t("joiningCompany")}
                </div>
                <div style={authHelperTextStyle}>
                  {authMode === "forgot"
                    ? t("forgotPasswordText")
                    : authMode === "login"
                    ? t("welcomeBackText")
                    : authMode === "create"
                    ? t("newToFieldCallText")
                    : t("joiningCompanyText")}
                </div>
              </div>
            )}

            {authMode !== "forgot" && (
              <div style={authTabsStyle}>
              {!userHasNoCompany && (
                <button
                  onClick={() => setAuthMode("login")}
                  style={authMode === "login" ? authTabActiveStyle : authTabStyle}
                >
                  {t("login")}
                </button>
              )}

              <button
                onClick={() => setAuthMode("create")}
                style={authMode === "create" ? authTabActiveStyle : authTabStyle}
              >
                {t("createCompany")}
              </button>

              <button
                onClick={() => setAuthMode("join")}
                style={authMode === "join" ? authTabActiveStyle : authTabStyle}
              >
                {t("joinExisting")}
              </button>
              </div>
            )}

            {!session && (
              <>
                {isCreateEntry && authMode === "create" && (
                  <label style={authFieldLabelStyle}>{t("email")}</label>
                )}
                <input
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder={isCreateEntry && authMode === "create" ? "" : t("email")}
                  style={authInputStyle}
                />

                {isCreateEntry && authMode === "create" && (
                  <label style={authFieldLabelStyle}>{t("password")}</label>
                )}
                {authMode !== "forgot" && (
                  <input
                    type="password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder={isCreateEntry && authMode === "create" ? "" : t("password")}
                    style={authInputStyle}
                  />
                )}
              </>
            )}

            {authMode === "create" && (
              <>
                {isCreateEntry && (
                  <label style={authFieldLabelStyle}>{t("companyName")}</label>
                )}
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder={isCreateEntry ? "" : t("companyName")}
                  style={authInputStyle}
                />
              </>
            )}

            {authMode === "join" && (
              <input
                value={joinCompanyId}
                onChange={(e) => setJoinCompanyId(e.target.value)}
                placeholder={t("companyAccessCode")}
                style={authInputStyle}
              />
            )}

            <button
              onClick={
                authMode === "forgot"
                  ? handleRequestPasswordReset
                  : authMode === "login"
                  ? handleLogin
                  : authMode === "create"
                  ? handleCreateCompany
                  : handleJoinCompany
              }
              style={authPrimaryButtonStyle}
              disabled={authLoading}
            >
              {authLoading
                ? t("working")
                : authMode === "forgot"
                ? t("sendResetLink")
                : authMode === "login"
                ? t("login")
                : authMode === "create"
                ? t("createCompany")
                : t("joinCompany")}
            </button>

            {!userHasNoCompany && authMode === "login" && (
              <button
                type="button"
                onClick={() => {
                  setAuthMessage("");
                  setAuthMode("forgot");
                }}
                style={authTextLinkButtonStyle}
              >
                {t("forgotPassword")}
              </button>
            )}

            {authMode === "forgot" && (
              <button
                type="button"
                onClick={() => {
                  setAuthMessage("");
                  setAuthMode("login");
                }}
                style={authTextLinkButtonStyle}
              >
                ← {t("backToLogin")}
              </button>
            )}

            {!userHasNoCompany && isCreateEntry && authMode === "create" && (
              <div style={createEntrySecondaryStyle}>
                <div style={createEntryDividerStyle}>
                  <span style={createEntryDividerLineStyle} />
                  <strong>{t("or")}</strong>
                  <span style={createEntryDividerLineStyle} />
                </div>

                <p style={createEntryLinkLineStyle}>
                  {t("alreadyHaveAccount")}{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("login")}
                    style={createEntryLinkButtonStyle}
                  >
                    {t("logInLink")}
                  </button>
                </p>

                <p style={createEntryLinkLineStyle}>
                  {t("joiningExistingCompany")}{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("join")}
                    style={createEntryLinkButtonStyle}
                  >
                    {t("enterInviteCode")}
                  </button>
                </p>
              </div>
            )}

            {authMessage && authMessage !== "Logged out." && (
              <div style={authMessageStyle}>{authMessage}</div>
            )}

            {!userHasNoCompany && isCreateEntry && authMode === "create" && (
              <div style={createEntryTrustStyle}>
                <span>✓ {t("nwsForecastData")}</span>
                <span>✓ {t("operationalScoringEngine")}</span>
                <span>✓ {t("builtForContractors")}</span>
              </div>
            )}
          </div>

          {!isCreateEntry && (
            <>
              <div style={preLoginNoteStyle}>{t("preLoginNote")}</div>
              <div style={preLoginTrustStyle}>
                <span>✓ {t("nwsForecastData")}</span>
                <span>✓ {t("operationalScoringEngine")}</span>
                <span>✓ {t("builtForContractors")}</span>
              </div>
            </>
          )}
        </section>
      </div>

      <Analytics />
    </main>
  );
}

  return (
    <main style={pageStyle}>
      <div style={phoneAppStyle}>
        <div style={session || guestMode ? hiddenAuthPanelStyle : authPanelStyle}>
          {session || guestMode ? null : (
            <>
              <div style={authTabsStyle}>
                <button
                  onClick={() => setAuthMode("login")}
                  style={authMode === "login" ? authTabActiveStyle : authTabStyle}
                >
                  Login
                </button>

                <button
                  onClick={() => setAuthMode("create")}
                  style={authMode === "create" ? authTabActiveStyle : authTabStyle}
                >
                  Create Company
                </button>

                <button
                  onClick={() => setAuthMode("join")}
                  style={authMode === "join" ? authTabActiveStyle : authTabStyle}
                >
                  Join Company
                </button>
              </div>

              <input
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder={t("email")}
                style={authInputStyle}
              />

              <input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder={t("password")}
                style={authInputStyle}
              />

              {authMode === "create" && (
                <input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder={t("companyName")}
                  style={authInputStyle}
                />
              )}

              {authMode === "join" && (
                <input
                  value={joinCompanyId}
                  onChange={(e) => setJoinCompanyId(e.target.value)}
                  placeholder={t("companyAccessCode")}
                  style={authInputStyle}
                />
              )}

              <button
                onClick={
                  authMode === "login"
                    ? handleLogin
                    : authMode === "create"
                    ? handleCreateCompany
                    : handleJoinCompany
                }
                style={authPrimaryButtonStyle}
                disabled={authLoading}
              >
                {authLoading
                  ? t("working")
                  : authMode === "login"
                  ? t("login")
                  : authMode === "create"
                  ? t("createCompany")
                  : t("joinCompany")}
              </button>
            </>
          )}

          {authMessage && <div style={authMessageStyle}>{authMessage}</div>}
        </div>

        {guestMode && screen === "guestLoading" && (
          <section style={scrollScreenStyle}>
            <div style={heroCardStyle}>
              <div style={heroBrandRowStyle}>
                <img
                  src="/fieldcall-logo.png"
                  alt="FieldCall logo"
                  style={heroLogoImageStyle}
                />
                <div>
                  <p style={heroBrandNameStyle}>FieldCall</p>
                </div>
                <LanguageToggle language={language} onChange={handleLanguageChange} />
              </div>

              <p style={resultSummaryEyebrowStyle}>
                {language === "es" ? "EVALUACIÓN GRATUITA" : "FREE ASSESSMENT"}
              </p>
              <h2 style={heroTitleStyle}>
                {language === "es" ? "Revisando su trabajo" : "Checking your job"}
              </h2>
              <p style={heroTextStyle}>
                {language === "es"
                  ? "FieldCall está revisando NWS, Open-Meteo y los riesgos específicos de su servicio."
                  : "FieldCall is checking NWS, Open-Meteo, and the risks specific to your service."}
              </p>

              <div style={loadingStatusStyle}>
                <span style={spinnerDotStyle}></span>
                {t("checkingSources")}
              </div>
            </div>
          </section>
        )}

        {guestMode && screen === "guestError" && (
          <section style={scrollScreenStyle}>
            <div style={heroCardStyle}>
              <div style={heroBrandRowStyle}>
                <img
                  src="/fieldcall-logo.png"
                  alt="FieldCall logo"
                  style={heroLogoImageStyle}
                />
                <div>
                  <p style={heroBrandNameStyle}>FieldCall</p>
                </div>
                <LanguageToggle language={language} onChange={handleLanguageChange} />
              </div>

              <p style={resultSummaryEyebrowStyle}>
                {language === "es" ? "NO SE COMPLETÓ" : "ASSESSMENT NOT COMPLETED"}
              </p>
              <h2 style={heroTitleStyle}>
                {language === "es" ? "Intentémoslo de nuevo" : "Let’s try that again"}
              </h2>
              <p style={heroTextStyle}>{guestEntryError || error}</p>

              <button onClick={goHome} style={primaryButtonStyle}>
                {language === "es" ? "Volver a FieldCall" : "Return to FieldCall"}
              </button>
            </div>
          </section>
        )}

        {/* -----------------------------------------------------
            DASHBOARD SCREEN
            Main saved job queue and account footer.
        ----------------------------------------------------- */}

        {!guestMode && screen === "dashboard" && (
          <section style={scrollScreenStyle}>
            <PrivateLabBanner language={language} />
            <div style={heroCardStyle}>
<div style={heroBrandRowStyle}>
  <img
    src="/fieldcall-logo.png"
    alt="FieldCall logo"
    style={heroLogoImageStyle}
  />
  <div>
    <p style={heroBrandNameStyle}>FieldCall</p>
  </div>
  <LanguageToggle language={language} onChange={handleLanguageChange} />
</div>

<div style={heroMainRowStyle}>
  <div style={heroCopyBlockStyle}>
    <h2 style={heroTitleStyle}>{t("dashboardTitle")}</h2>
    <p style={heroTextStyle}>
      {t("dashboardText")}
    </p>
  </div>

  <button onClick={startNewAssessment} style={heroButtonStyle}>
    + {t("newAssessment")}
  </button>
</div>

              <div style={heroQuickStartStyle}>
                <div style={heroQuickStartTextStyle}>
                  <span style={heroQuickStartIconStyle}>⏱</span>
                  <div>
                    <p style={heroQuickStartLabelStyle}>{t("defaultService")}</p>
                    <p style={heroQuickStartHelpStyle}>{t("defaultServiceHelp")}</p>
                  </div>
                </div>

                <select
                  value={defaultService}
                  onChange={(e) => updateDefaultService(e.target.value)}
                  style={heroQuickStartSelectStyle}
                >
                  {serviceOptions.map((option) => (
                    <option key={option} value={option}>
                      {getLocalizedOptionLabel(option, language)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <ActivationChecklist
              language={language}
              activation={adoption.activation}
              onAddJob={startNewAssessment}
              onReviewPosture={openCompanySettings}
              onConfirmPosture={adoption.confirmRiskPosture}
              onEnableAlerts={handleToggleFinalCallAlerts}
            />

            <FieldCallRecord language={language} record={adoption.record} />

            {adoption.message && (
              <div style={errorBoxStyle}>{adoption.message}</div>
            )}

            <div style={upcomingCardStyle}>
              {copyNotice && screen === "dashboard" && (
                <div style={copyNoticeStyle}>{copyNotice}</div>
              )}

              {savedJobs.length === 0 && (
                <div style={collapsedQueueStyle}>
                  <span>{t("noSavedJobs")}</span>
                </div>
              )}

{savedJobs.length > 0 && (
  <div style={jobListStyle}>
    <div style={queueSectionHeaderStyle}>
      <div style={sectionTitleWithIconStyle}>
        <span style={greenSectionIconStyle}>✓</span>
        <div>
          <h3 style={queueSectionTitleStyle}>{t("todaysCalls")}</h3>
          <p style={queueSectionHelpStyle}>{t("todaysCallsHelp")}</p>
        </div>
      </div>

      <span style={queueSectionCountStyle}>{dashboardTodaysJobs.length}</span>
    </div>

    {dashboardTodaysJobs.length === 0 && (
      <div style={collapsedQueueStyle}>
        <span>{t("noTodaysCalls")}</span>
      </div>
    )}

    {dashboardTodaysJobs.map((job) => {
      const actionRequired = isDashboardActionRequired(job);
      const elevatedPreliminaryRisk =
        isDashboardElevatedPreliminaryRisk(job);

      return renderJobCard(job, {
        showReason: actionRequired || elevatedPreliminaryRisk,
        showActionRequired: actionRequired,
      });
    })}

    <button
      onClick={() => setShowPreliminaryJobs(!showPreliminaryJobs)}
      style={preliminaryDrawerButtonStyle}
    >
      <span>{t("preliminaryCalls")}</span>
      <span style={drawerCountPillStyle}>
        {dashboardPreliminaryJobs.length} {showPreliminaryJobs ? "−" : "+"}
      </span>
    </button>

    {showPreliminaryJobs && (
      <div style={preliminaryDrawerContentStyle}>
        {dashboardPreliminaryJobs.length === 0 && (
          <div style={collapsedQueueStyle}>
            <span>{t("noPreliminaryCalls")}</span>
          </div>
        )}

        {dashboardPreliminaryJobs.map((job) => renderJobCard(job))}
      </div>
    )}

    <button
  onClick={() => setShowCallsMade(!showCallsMade)}
  style={preliminaryDrawerButtonStyle}
>
  <span>{t("callsMade")}</span>
  <span style={drawerCountPillStyle}>
    {callsMadeJobs.length} {showCallsMade ? "−" : "+"}
  </span>
</button>

{showCallsMade && (
  <div style={preliminaryDrawerContentStyle}>
    <p style={queueSectionHelpStyle}>{t("callHistoryLimitHelp")}</p>

    {callsMadeJobs.length === 0 && (
      <div style={collapsedQueueStyle}>
        <span>{t("noLockedCalls")}</span>
      </div>
    )}

    {callsMadeJobs.map((job) => renderJobCard(job))}
  </div>
)}
  </div>
)}

<div style={jobsSyncFooterStyle}>
  <span>
    {t("jobsUpdated")} {weatherConnectedTime}
  </span>
  <button
    onClick={handleManualJobsRefresh}
    style={jobSyncButtonStyle}
    disabled={loadingBackendJobs || dashboardAutoRefreshRunning}
  >
    {loadingBackendJobs
      ? t("syncing")
      : dashboardAutoRefreshRunning
      ? t("refreshingWeather")
      : t("refresh")}
  </button>
</div>
            </div>

<div style={appActionsCardStyle}>
  <div style={appActionsWeatherStyle}>
    <span style={weatherConnectedIconStyle}>☁</span>
    <div>
      <strong>{t("weatherDataConnected")}</strong>
      <p style={miniTextStyle}>{t("weatherDataConnectedHelp")}</p>
    </div>
  </div>

  <div style={dashboardSettingsGridStyle}>
    {canManageCompanySettings && (
      <button
        onClick={openCompanySettings}
        style={dashboardSettingsButtonStyle}
      >
        <div style={dashboardSettingsTextStyle}>
          <span>{t("companySettings")}</span>
          <small>{t("companySettingsDashboardHelp")}</small>
        </div>
        <span style={dashboardSettingsChevronStyle}>›</span>
      </button>
    )}

    <button
      onClick={openAccount}
      style={dashboardSettingsButtonStyle}
    >
      <div style={dashboardSettingsTextStyle}>
        <span>{t("myAccount")}</span>
        <small>
          {pushAlertsEnabled ? t("finalCallAlertsOn") : t("finalCallAlertsOff")}
        </small>
      </div>
      <span style={dashboardSettingsChevronStyle}>›</span>
    </button>

    <button
      onClick={() => setScreen("trustCenter")}
      style={dashboardSettingsButtonStyle}
    >
      <div style={dashboardSettingsTextStyle}>
        <span>{language === "es" ? "Cómo funciona FieldCall" : "How FieldCall works"}</span>
        <small>{language === "es" ? "Metodología, límites y criterio" : "Methodology, limits, and judgment"}</small>
      </div>
      <span style={dashboardSettingsChevronStyle}>›</span>
    </button>
  </div>

  <div style={appActionsButtonRowStyle}>
    <button onClick={handleShareApp} style={appActionButtonStyle}>
      {t("shareFieldCall")}
    </button>

    <button onClick={handleInstallApp} style={appActionButtonStyle}>
      {t("addToHomeScreen")}
    </button>
  </div>

  {nonRoutinePushAlertMessage && (
    <div style={pushAlertMessageStyle}>
      {nonRoutinePushAlertMessage}
    </div>
  )}

  {showInstallHelp && (
    <div style={installHelpStyle}>
      <strong>iPhone:</strong> {t("iphoneInstallHelpStart")}{" "}
      <strong>{t("addToHomeScreen")}</strong>.
      <br />
      <strong>Android:</strong> {t("androidInstallHelp")}
    </div>
  )}
</div>
          </section>
        )}

        {/* -----------------------------------------------------
            ACCOUNT AND COMPANY SETTINGS SCREENS
        ----------------------------------------------------- */}

        {screen === "account" && (
          <section style={scrollScreenStyle}>
            <div style={settingsCardStyle}>
              <button onClick={returnToDashboard} style={screenBackButtonStyle}>
                ← {t("dashboard")}
              </button>

              <div style={sectionHeaderStyle}>
                <p style={eyebrowStyle}>{t("myAccount")}</p>
                <h2 style={pageTitleStyle}>{t("accountAndSecurity")}</h2>
                <p style={settingsIntroTextStyle}>{t("accountIntro")}</p>
              </div>

              <div style={accountProfileCardStyle}>
                <div style={accountProfileTextStyle}>
                  <strong style={accountProfileEmailStyle}>{session?.user?.email}</strong>
                  <span style={accountProfileMetaStyle}>
                    {activeCompanyName || t("company")} · {activeCompanyRole || "member"}
                  </span>
                </div>
              </div>

              <div style={settingsPanelStyle}>
                <p style={eyebrowStyle}>{t("notifications")}</p>
                <div style={settingsCompactRowStyle}>
                  <div style={settingsCompactTextStyle}>
                    <strong style={settingsCompactTitleStyle}>{t("finalCallAlerts")}</strong>
                    <p style={settingsCompactHelpStyle}>{t("finalCallAlertsSettingsHelp")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleFinalCallAlerts}
                    style={settingsCompactToggleStyle(pushAlertsEnabled)}
                    disabled={pushAlertsLoading}
                  >
                    {pushAlertsLoading ? "…" : pushAlertsEnabled ? t("on") : t("off")}
                  </button>
                </div>
                {nonRoutinePushAlertMessage && (
                  <div style={settingsMessageStyle}>{nonRoutinePushAlertMessage}</div>
                )}
              </div>

              <div style={settingsPanelStyle}>
                <p style={eyebrowStyle}>{t("security")}</p>
                <button
                  type="button"
                  onClick={() => {
                    setNewPassword("");
                    setConfirmNewPassword("");
                    setAccountMessage("");
                    setScreen("changePassword");
                  }}
                  style={accountMenuRowStyle}
                >
                  <span>{t("changePassword")}</span><b>›</b>
                </button>
                <div style={settingsCompactDividerStyle} />
                <button type="button" onClick={handleLogout} style={accountMenuRowStyle}>
                  <span>{t("logout")}</span><b>›</b>
                </button>
              </div>

              <div style={settingsPanelStyle}>
                <p style={eyebrowStyle}>{t("legalAndSupport")}</p>
                <a href={`${FIELDCALL_SITE_URL}/privacy`} target="_blank" rel="noreferrer" style={accountMenuRowStyle}>
                  <span>{t("privacyPolicy")}</span><b>›</b>
                </a>
                <div style={settingsCompactDividerStyle} />
                <a href={`${FIELDCALL_SITE_URL}/terms`} target="_blank" rel="noreferrer" style={accountMenuRowStyle}>
                  <span>{t("termsOfUse")}</span><b>›</b>
                </a>
                <div style={settingsCompactDividerStyle} />
                <a href={`mailto:${FIELDCALL_SUPPORT_EMAIL}`} style={accountMenuRowStyle}>
                  <span>{t("contactSupport")}</span><b>›</b>
                </a>
              </div>

              <div style={settingsDangerPanelStyle}>
                <p style={dangerEyebrowStyle}>{t("accountActions")}</p>
                <button type="button" onClick={openDeleteAccount} style={dangerMenuRowStyle}>
                  <span>{t("deleteAccount")}</span><b>›</b>
                </button>
              </div>

              {accountMessage && <div style={settingsMessageStyle}>{accountMessage}</div>}

              <button onClick={returnToDashboard} style={primaryButtonStyle}>
                {t("returnToDashboard")}
              </button>
            </div>
          </section>
        )}

        {(screen === "changePassword" || screen === "resetPassword") && (
          <section style={scrollScreenStyle}>
            <div style={settingsCardStyle}>
              <button
                onClick={() => setScreen(screen === "resetPassword" ? "dashboard" : "account")}
                style={screenBackButtonStyle}
              >
                ← {screen === "resetPassword" ? t("dashboard") : t("myAccount")}
              </button>

              <div style={sectionHeaderStyle}>
                <p style={eyebrowStyle}>{t("security")}</p>
                <h2 style={pageTitleStyle}>
                  {screen === "resetPassword" ? t("resetPassword") : t("changePassword")}
                </h2>
                <p style={settingsIntroTextStyle}>{t("newPasswordHelp")}</p>
              </div>

              <label style={authFieldLabelStyle}>{t("newPassword")}</label>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                style={authInputStyle}
                autoComplete="new-password"
              />

              <label style={authFieldLabelStyle}>{t("confirmNewPassword")}</label>
              <input
                type="password"
                value={confirmNewPassword}
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                style={authInputStyle}
                autoComplete="new-password"
              />

              {accountMessage && <div style={settingsMessageStyle}>{accountMessage}</div>}

              <button
                type="button"
                onClick={() => handleUpdatePassword(screen === "resetPassword" ? "dashboard" : "account")}
                style={primaryButtonStyle}
                disabled={passwordSaving}
              >
                {passwordSaving ? t("saving") : t("updatePassword")}
              </button>

              <button onClick={returnToDashboard} style={secondaryButtonStyle}>
                {t("returnToDashboard")}
              </button>
            </div>
          </section>
        )}

        {screen === "deleteAccount" && (
          <section style={scrollScreenStyle}>
            <div style={settingsCardStyle}>
              <button onClick={() => setScreen("account")} style={screenBackButtonStyle}>
                ← {t("myAccount")}
              </button>

              <div style={sectionHeaderStyle}>
                <p style={dangerEyebrowStyle}>{t("accountActions")}</p>
                <h2 style={pageTitleStyle}>{t("deleteAccount")}</h2>
                <p style={settingsIntroTextStyle}>{t("deleteAccountIntro")}</p>
              </div>

              {deleteAccountLoading && <div style={settingsMessageStyle}>{t("loadingAccountDetails")}</div>}

              {deleteAccountPreview && (
                <div style={deleteExplanationStyle}>
                  <strong>
                    {deleteAccountPreview.deletes_company
                      ? t("accountAndCompanyWillBeDeleted")
                      : deleteAccountPreview.requires_transfer
                      ? t("ownershipTransferRequired")
                      : t("accountWillBeDeleted")}
                  </strong>
                  <p>{t("deleteAccountDataExplanation")}</p>
                </div>
              )}

              {deleteAccountPreview?.requires_transfer && (
                <div style={settingsPanelStyle}>
                  <label style={authFieldLabelStyle}>{t("newCompanyOwner")}</label>
                  <select
                    value={deleteAccountTransferUserId}
                    onChange={(event) => setDeleteAccountTransferUserId(event.target.value)}
                    style={authInputStyle}
                  >
                    {(deleteAccountPreview.transfer_candidates || []).map((member) => (
                      <option key={member.user_id} value={member.user_id}>
                        {member.full_name || member.email || t("companyMember")}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <label style={authFieldLabelStyle}>{t("currentPassword")}</label>
              <input
                type="password"
                value={deleteAccountPassword}
                onChange={(event) => setDeleteAccountPassword(event.target.value)}
                style={authInputStyle}
                autoComplete="current-password"
              />

              <label style={authFieldLabelStyle}>{t("typeDeleteToConfirm")}</label>
              <input
                value={deleteAccountConfirmation}
                onChange={(event) => setDeleteAccountConfirmation(event.target.value)}
                placeholder="DELETE"
                style={authInputStyle}
                autoCapitalize="characters"
              />

              {deleteAccountMessage && <div style={dangerMessageStyle}>{deleteAccountMessage}</div>}

              <button
                type="button"
                onClick={handleDeleteAccount}
                style={destructiveButtonStyle}
                disabled={destructiveActionLoading || deleteAccountLoading || !deleteAccountPreview}
              >
                {destructiveActionLoading ? t("deleting") : t("permanentlyDeleteAccount")}
              </button>

              <button onClick={returnToDashboard} style={secondaryButtonStyle}>
                {t("returnToDashboard")}
              </button>
            </div>
          </section>
        )}

        {screen === "deleteCompany" && (
          <section style={scrollScreenStyle}>
            <div style={settingsCardStyle}>
              <button onClick={() => setScreen("companySettings")} style={screenBackButtonStyle}>
                ← {t("companySettings")}
              </button>

              <div style={sectionHeaderStyle}>
                <p style={dangerEyebrowStyle}>{t("companyActions")}</p>
                <h2 style={pageTitleStyle}>{t("deleteCompany")}</h2>
                <p style={settingsIntroTextStyle}>{t("deleteCompanyIntro")}</p>
              </div>

              <div style={deleteExplanationStyle}>
                <strong>{activeCompanyName}</strong>
                <p>{t("deleteCompanyDataExplanation")}</p>
              </div>

              <label style={authFieldLabelStyle}>{t("currentPassword")}</label>
              <input
                type="password"
                value={deleteCompanyPassword}
                onChange={(event) => setDeleteCompanyPassword(event.target.value)}
                style={authInputStyle}
                autoComplete="current-password"
              />

              <label style={authFieldLabelStyle}>{t("typeDeleteCompanyToConfirm")}</label>
              <input
                value={deleteCompanyConfirmation}
                onChange={(event) => setDeleteCompanyConfirmation(event.target.value)}
                placeholder="DELETE COMPANY"
                style={authInputStyle}
                autoCapitalize="characters"
              />

              {deleteCompanyMessage && <div style={dangerMessageStyle}>{deleteCompanyMessage}</div>}

              <button
                type="button"
                onClick={handleDeleteCompany}
                style={destructiveButtonStyle}
                disabled={destructiveActionLoading}
              >
                {destructiveActionLoading ? t("deleting") : t("permanentlyDeleteCompany")}
              </button>

              <button onClick={returnToDashboard} style={secondaryButtonStyle}>
                {t("returnToDashboard")}
              </button>
            </div>
          </section>
        )}

        {screen === "companySettings" && (
          <section style={scrollScreenStyle}>
            <div style={settingsCardStyle}>
              <button onClick={handleReturnFromCompanySettings} style={screenBackButtonStyle}>
                ← {t("dashboard")}
              </button>

              <div style={compactSettingsHeaderStyle}>
                <div>
                  <p style={eyebrowStyle}>{t("companySettings")}</p>
                  <h2 style={pageTitleStyle}>{activeCompanyName || t("company")}</h2>
                </div>
                <span style={settingsRolePillStyle}>{activeCompanyRole || "owner"}</span>
              </div>

              {!canManageCompanySettings && (
                <div style={settingsMessageStyle}>{t("companySettingsAdminOnly")}</div>
              )}

              {canManageCompanySettings && (
                <>
                  <div style={settingsAccordionListStyle}>
                    <SettingsAccordionRow
                      title={t("weatherCallCaution")}
                      summary={`${t(selectedWeatherCautionOption.labelKey)} · ${t("fieldCallStandard")}`}
                      open={openCompanySetting === "caution"}
                      onToggle={() => setOpenCompanySetting(openCompanySetting === "caution" ? "" : "caution")}
                    >
                      <p style={settingsIntroTextStyle}>{t("weatherCallCautionHelpCompact")}</p>
                      <div style={cautionSliderLabelRowStyle}>
                        <span>{t("noGoSooner")}</span><span>{t("balanced")}</span><span>{t("goMoreOftenMoreRisk")}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={WEATHER_CALL_CAUTION_OPTIONS.length - 1}
                        step="1"
                        value={selectedWeatherCautionIndex}
                        onChange={(event) => {
                          const nextOption = WEATHER_CALL_CAUTION_OPTIONS[Number(event.target.value)] || WEATHER_CALL_CAUTION_OPTIONS[2];
                          setCompanySettings((currentSettings) => ({ ...currentSettings, weatherCallCaution: nextOption.value }));
                        }}
                        style={companySettingsRangeStyle}
                        disabled={companySettingsLoading || companySettingsSaving}
                      />
                      <div style={compactSelectedValueStyle}>
                        <strong>{t(selectedWeatherCautionOption.labelKey)}</strong>
                        <span>{t(selectedWeatherCautionOption.helperKey)}</span>
                      </div>
                    </SettingsAccordionRow>

                    <SettingsAccordionRow
                      title={t("workableRainThreshold")}
                      summary={`${normalizeWorkableRainThreshold(companySettings.workableRainProbabilityThreshold)}% · ${t("fieldCallStandard")}`}
                      open={openCompanySetting === "rain"}
                      onToggle={() => setOpenCompanySetting(openCompanySetting === "rain" ? "" : "rain")}
                    >
                      <p style={settingsIntroTextStyle}>{t("workableRainThresholdHelpCompact")}</p>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={normalizeWorkableRainThreshold(companySettings.workableRainProbabilityThreshold)}
                        onChange={(event) => setCompanySettings((currentSettings) => ({
                          ...currentSettings,
                          workableRainProbabilityThreshold: normalizeWorkableRainThreshold(event.target.value),
                        }))}
                        style={companySettingsRangeStyle}
                        disabled={companySettingsLoading || companySettingsSaving}
                      />
                      <div style={compactSelectedValueStyle}>
                        <strong>{normalizeWorkableRainThreshold(companySettings.workableRainProbabilityThreshold)}%</strong>
                        <span>{t("workableRainThresholdSelectedHelp")}</span>
                      </div>
                      <details style={settingsDetailsStyle}>
                        <summary>{t("howThisWorks")}</summary>
                        <p>{t("minimumWorkableWindowFinePrint")}</p>
                      </details>
                    </SettingsAccordionRow>

                    <SettingsAccordionRow
                      title={t("defaultFinalCallTime")}
                      summary={formatFinalCallTimeLabel(companySettings.defaultFinalCallTime, language)}
                      open={openCompanySetting === "time"}
                      onToggle={() => setOpenCompanySetting(openCompanySetting === "time" ? "" : "time")}
                    >
                      <p style={settingsIntroTextStyle}>{t("defaultFinalCallTimeHelpCompact")}</p>
                      <div style={cautionSliderLabelRowStyle}>
                        <span>{t("noon")}</span><span>{t("threePm")}</span><span>{t("sixPm")}</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={FINAL_CALL_TIME_OPTIONS.length - 1}
                        step="1"
                        value={selectedDefaultFinalCallTimeIndex}
                        onChange={(event) => {
                          const nextTime = FINAL_CALL_TIME_OPTIONS[Number(event.target.value)] || FINAL_CALL_TIME_OPTIONS[1];
                          setCompanySettings((currentSettings) => ({ ...currentSettings, defaultFinalCallTime: nextTime }));
                        }}
                        style={companySettingsRangeStyle}
                        disabled={companySettingsLoading || companySettingsSaving}
                      />
                      <div style={compactSelectedValueStyle}>
                        <strong>{formatFinalCallTimeLabel(companySettings.defaultFinalCallTime, language)}</strong>
                        <span>{t("defaultFinalCallTimeSelectedHelp")}</span>
                      </div>
                      <details style={settingsDetailsStyle}>
                        <summary>{t("timingDetails")}</summary>
                        <p>{t("defaultFinalCallTimeFinePrint")}</p>
                      </details>
                    </SettingsAccordionRow>
                  </div>

                  {companySettingsMessage && <div style={settingsMessageStyle}>{companySettingsMessage}</div>}

                  {String(activeCompanyRole).toLowerCase() === "owner" && (
                    <div style={settingsDangerPanelStyle}>
                      <p style={dangerEyebrowStyle}>{t("companyActions")}</p>
                      <button type="button" onClick={openDeleteCompany} style={dangerMenuRowStyle}>
                        <span>{t("deleteCompany")}</span><b>›</b>
                      </button>
                    </div>
                  )}

                  <button
                    onClick={saveCompanySettings}
                    style={primaryButtonStyle}
                    disabled={companySettingsSaving || companySettingsLoading}
                  >
                    {companySettingsSaving ? t("saving") : t("saveChangesAndReturn")}
                  </button>
                </>
              )}

              {!canManageCompanySettings && (
                <button onClick={returnToDashboard} style={secondaryButtonStyle}>
                  {t("returnToDashboard")}
                </button>
              )}
            </div>
          </section>
        )}

        {/* -----------------------------------------------------
            INTAKE SCREEN
            New assessment form and location search.
        ----------------------------------------------------- */}

        {screen === "trustCenter" && (
          <section style={scrollScreenStyle}>
            <TrustCenter
              language={language}
              onBack={returnToDashboard}
            />
          </section>
        )}

        {screen === "intake" && (
          <section style={screenStyle}>
            <div style={cardStyle}>
              <div style={sectionHeaderStyle}>
                <p style={eyebrowStyle}>{t("newAssessment")}</p>
                <h2 style={pageTitleStyle}>{t("jobDetails")}</h2>
              </div>

              {error && <div style={errorBoxStyle}>{error}</div>}

              <LocationSearchField
                language={language}
                value={form.locationQuery}
                selectedLocation={form.selectedLocation}
                onQueryChange={(value) => {
                  setForm({
                    ...form,
                    locationQuery: value,
                    selectedLocation: null,
                    city: "",
                    state: "",
                  });
                }}
                onSelectLocation={(location) => {
                  const currentProjectName = form.projectName.trim();

                  setForm({
                    ...form,
                    projectName:
                      currentProjectName ||
                      location.displayName ||
                      location.formattedAddress ||
                      "Unnamed Job",
                    locationQuery: location.formattedAddress,
                    selectedLocation: location,
                    city: location.city,
                    state: location.state,
                  });
                }}
              />

              <Field
                label={t("projectName")}
                value={form.projectName}
                onChange={(value) => updateField("projectName", value)}
                placeholder={t("projectNamePlaceholder")}
              />

              <Field
  label={t("workDate")}
  type="date"
  value={form.workDate}
  onChange={(value) => updateField("workDate", value)}
/>


              <div style={twoColumnStyle}>
                <SelectField
  label={t("workType")}
  value={form.workType}
  options={serviceOptions}
  onChange={(value) => updateField("workType", value)}
  getOptionLabel={(option) => getLocalizedOptionLabel(option, language)}
/>

                <div style={segmentedFieldStyle}>
                  <span style={labelTextStyle}>{t("dayNight")}</span>
                  <div style={segmentedControlStyle}>
                    {["Day", "Night"].map((option) => {
                      const isActive = form.operatingWindow === option;

                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => updateField("operatingWindow", option)}
                          style={isActive ? segmentedButtonActiveStyle : segmentedButtonStyle}
                        >
                          {getLocalizedOptionLabel(option, language)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
<SelectField
  label={t("finalCallTime")}
  value={normalizeFinalCallTime(form.finalCallTime)}
  options={FINAL_CALL_TIME_OPTIONS}
  onChange={(value) => updateField("finalCallTime", value)}
  getOptionLabel={(option) =>
    formatFinalCallTimeLabel(option, language)
  }
/>

<p style={fieldHelpTextStyle}>
  {form.operatingWindow === "Night"
    ? t("finalCallTimeNightHelp")
    : t("finalCallTimeDayHelp")}
</p>

              {isPavingService(form.workType) && (
                <SelectField
                  label={t("pavingSetup")}
                  value={form.surfaceCondition || "Subgrade exposed & paved same day"}
                  options={SURFACE_CONDITION_OPTIONS}
                  onChange={(value) => updateField("surfaceCondition", value)}
                  getOptionLabel={(option) => getLocalizedOptionLabel(option, language)}
                />
              )}

              <ShadowModeField
                language={language}
                enabled={adoption.journey.shadow_mode_enabled !== false}
                value={form.shadowDecision || ""}
                onChange={(value) => updateField("shadowDecision", value)}
                onToggle={adoption.setShadowMode}
              />

              {loading && (
                <div style={loadingStatusStyle}>
                  <span style={spinnerDotStyle}></span>
                  {t("checkingSources")}
                </div>
              )}

              <button
                onClick={runAssessment}
                style={{
                  ...primaryButtonStyle,
                  opacity: loading ? 0.75 : 1,
                }}
                disabled={loading}
              >
                {loading ? t("checkingWeather") : t("runAssessment")}
              </button>

              <button onClick={goHome} style={secondaryButtonStyle}>
                {t("cancel")}
              </button>
            </div>
          </section>
        )}

        {/* -----------------------------------------------------
            RESULT SCREEN
            Assessment result, copy buttons, and details.
        ----------------------------------------------------- */}

{screen === "result" && result && (
  <section style={scrollScreenStyle}>
<div style={resultTopNavStyle}>

</div>

{resultMode === "messages" ? (
<div style={resultCardStyle}>
  <div style={messagesHeroCardStyle}>
    <p style={resultSummaryEyebrowStyle}>{t("messages")}</p>

    <div style={messagesHeroTopRowStyle}>
      <div>
        <h2 style={messagesHeroTitleStyle}>
          {form.projectName || t("notEntered")}
        </h2>
        <p style={messagesHeroMetaStyle}>
          {form.city}, {form.state} · {formatDateLabel(form.workDate, language)} · {getLocalizedOptionLabel(form.workType, language)}
        </p>
        <p style={resultCheckedAtStyle}>
          {currentResultJob && isSavedJobAutoPrepared(currentResultJob) ? t("autoPrepared") : t("checked")} {formatCheckedAtFull(result.checkedAt)}
        </p>
      </div>

      <span style={messagesSignalPillStyle(result.shortSignal)}>
        {result.isFinal ? `FINAL — ${getDisplaySignal(result.shortSignal, language)}` : getDisplaySignal(result.shortSignal, language)}
      </span>
    </div>
  </div>

  <div style={copyActionCardStyle}>
    <p style={copyActionTitleStyle}>{t("communication")}</p>
    <p style={communicationHelpStyle}>
      {t("messagesScreenHelp")}
    </p>

    {copyNotice && <div style={copyNoticeStyle}>{copyNotice}</div>}

    <div style={messageAudienceTabsStyle}>
      {MESSAGE_AUDIENCE_OPTIONS.map((audience) => {
        const isActive = selectedMessageAudience === audience;

        return (
          <button
            key={audience}
            type="button"
            onClick={() => handleMessageAudienceChange(audience)}
            style={isActive ? messageAudienceTabActiveStyle : messageAudienceTabStyle}
          >
            {t(audience)}
          </button>
        );
      })}
    </div>

    <label style={messagePreviewLabelStyle}>
      <span>{selectedMessageLabel} {t("message")}</span>
      <textarea
        value={messageDraft}
        onChange={(event) => setMessageDraft(event.target.value)}
        style={messageTextAreaStyle}
      />
    </label>

    <button
      type="button"
      onClick={() => copyText(messageDraft, `${selectedMessageLabel} ${t("message")}`)}
      style={primaryButtonStyle}
    >
      {t("copyMessage")}
    </button>

    <button
      type="button"
      onClick={resetMessageDraft}
      style={messageResetButtonStyle}
    >
      {t("resetTemplate")}
    </button>
  </div>

  <button
    type="button"
    onClick={() => {
      setResultMode("details");
      setCopyNotice("");
    }}
    style={secondaryButtonStyle}
  >
    {t("viewFullCall")}
  </button>

  <button onClick={goHome} style={primaryButtonStyle}>
    {t("dashboard")}
  </button>
</div>
) : (
<div style={resultCardStyle}>
      {guestMode && (
        <div
          style={{
            padding: "14px 16px",
            borderRadius: "16px",
            border: "1px solid #bfdbfe",
            background: "#eff6ff",
            color: "#1e3a5f",
            fontSize: "13px",
            lineHeight: 1.5,
            fontWeight: 700,
          }}
        >
          {language === "es"
            ? "Evaluación de invitado · Usa la configuración Balanceada de FieldCall. No se guardará ni se monitoreará hasta que cree una cuenta."
            : "Guest assessment · Uses FieldCall’s Balanced setting. This call is not saved or monitored until you create an account."}
        </div>
      )}

              <div style={resultSummaryCardStyle}>
                <p style={resultSummaryEyebrowStyle}>{translateCallTypeDisplay(result.callTypeDisplay, language)}</p>

                <div style={resultSummaryTopRowStyle}>
                  <div>
                    <h2 style={resultSummarySignalStyle}>
                      {result.icon} {getDisplaySignal(result.shortSignal, language)}
                    </h2>
                    <p style={resultSummarySubTextStyle}>{getDisplaySubText(result, language)}</p>
                    <p style={resultCheckedAtStyle}>
  {t("checked")} {formatCheckedAtFull(result.checkedAt)}
</p>
                  </div>

                  <div style={resultScoreBadgeStyle}>
  <strong style={resultScoreRiskLabelStyle}>{getAssessmentRiskLevelLabel(result, language)}</strong>
  <span style={resultScorePointStyle}>{result.score} pts</span>
</div>
                </div>

                <div style={resultSummaryDividerStyle} />

                <p style={resultSummaryLabelStyle}>
  {getServiceWindowTitle(result, language)}
</p>

                <h3 style={resultProductionWindowStyle}>
                  {translateWorkableWindowLabel(result.bestWindowLabel, language)}
                </h3>

                <p style={resultSummaryLabelStyle}>{t("mainReason")}</p>
                <p style={resultMainReasonStyle}>{getDisplayReason(result, language)}</p>
              </div>

{!guestMode && currentResultJobId && (
  <>
    <ContractorDecisionPanel
      language={language}
      jobId={currentResultJobId}
      fieldcallSignal={result.shortSignal}
      existingDecision={currentFinalDecision}
      onSave={({ decision, localContext }) =>
        adoption.submitDecision({
          jobId: currentResultJobId,
          stage: "final",
          decision,
          localContext,
          fieldcallSignal: result.shortSignal,
        })
      }
    />

    <SignalTimeline
      language={language}
      events={currentJobExperience.signalEvents}
    />
  </>
)}

{guestMode ? (
  <div style={copyActionCardStyle}>
    <p style={copyActionTitleStyle}>
      {language === "es" ? "Guarde y mantenga esta decisión actualizada" : "Save this call and keep it updated"}
    </p>
    <p style={communicationHelpStyle}>
      {language === "es"
        ? "Cree una cuenta gratuita para guardar este trabajo, monitorear cambios, recibir la decisión final GO o NO GO y usar las plantillas de comunicación."
        : "Create a free account to save this job, monitor changes, receive the final GO or NO GO call, and use communication templates."}
    </p>

    <button
      type="button"
      onClick={handleGuestCreateAccount}
      style={primaryButtonStyle}
    >
      {language === "es" ? "Crear cuenta gratuita" : "Create Free Account"}
    </button>
  </div>
) : (
  <div style={copyActionCardStyle}>
    <p style={copyActionTitleStyle}>{t("communication")}</p>
    <p style={communicationHelpStyle}>
      {t("communicationHelp")}
    </p>

    {copyNotice && <div style={copyNoticeStyle}>{copyNotice}</div>}

    <div style={copyGridStyle}>
      <button
        onClick={() => copyText(emailTemplate, t("client"))}
        style={copyButtonStyle}
      >
        {t("client")}
      </button>

      <button
        onClick={() => copyText(crewTemplate, t("crew"))}
        style={copyButtonStyle}
      >
        {t("crew")}
      </button>

      <button
        onClick={() => copyText(textTemplate, t("vendor"))}
        style={copyButtonStyle}
      >
        {t("vendor")}
      </button>
    </div>
  </div>
)}

              <div style={whyCardStyle}>
                <p style={whyTitleStyle}>{t("keyDecisionFactors")}</p>
                {getShortWhyPoints(result, form, language).map((point, index) => (
                  <p key={index} style={whyPointStyle}>
                    • {point}
                  </p>
                ))}
              </div>

              <div style={weatherDetailsCardStyle}>
                <button
                  onClick={() => setShowWeatherDetails(!showWeatherDetails)}
                  style={weatherDetailsToggleStyle}
                >
                  <span>{t("assessmentDetails")}</span>
                  <span>{showWeatherDetails ? "−" : "+"}</span>
                </button>

                {showWeatherDetails && (
                  <div style={weatherDetailsContentStyle}>
                    <p style={resultLineStyle}>
                      <strong>{t("finalCallTimeDetail")}:</strong>{" "}
                      {formatFinalCallTimeLabel(
                        result.finalCallTime || form.finalCallTime,
                        language
                      )}{" "}
                      {form.operatingWindow === "Night"
                        ? t("onWorkDate")
                        : t("dayBeforeWork")}
                    </p>

                    <p style={resultLineStyle}>
                      <strong>{t("forecastAgreement")}:</strong>{" "}
                      {translateForecastAgreement(result.forecastAgreementLabel, language)}
                    </p>

                    <p style={resultLineStyle}>
                      <strong>{t("weatherCheck")}:</strong> {translateCallTypeDisplay(result.callTypeDisplay, language)}
                    </p>

                    <p style={resultLineStyle}>
                      <strong>{t("sources")}:</strong> {result.sources}
                    </p>

                    <p style={resultLineStyle}>
                      <strong>{t("highestRainSignal")}:</strong>{" "}
                      {result.nwsPeakRainProbabilityDisplay !== "Unavailable"
                        ? formatNwsPeakRainSignal(result, language)
                        : t("openMeteoShows", { value: `${result.peakRainProbability}%` })}
                    </p>
                    <p style={resultLineStyle}>
                      <strong>{t("workableWindowRequirements")}:</strong>{" "}
                      {formatWorkWindowRequirements(result, language)}
                    </p>

                    {result.workWindowReason && (
                      <p style={resultLineStyle}>
                        <strong>{t("whyThisWindow")}:</strong>{" "}
                        {result.workWindowReason}
                      </p>
                    )}

                    {Array.isArray(result.alternativeWorkWindows) &&
                      result.alternativeWorkWindows.length > 1 && (
                        <p style={resultLineStyle}>
                          <strong>{t("otherQualifyingWindows")}:</strong>{" "}
                          {result.alternativeWorkWindows
                            .slice(1)
                            .map((windowOption) => windowOption?.label)
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                      )}
<p style={resultLineStyle}>
  <strong>
    {result.hasReliableWindow
      ? t("selectedWindowTemp")
      : t("assessedPeriodTemp")}:
  </strong>{" "}
  {result.workWindowTempRange || "Unavailable"}
</p>
                    <p style={resultLineStyle}>
                      <strong>{t("rainfallAssessedPeriod")}:</strong>{" "}
                      {formatRainfallAssessmentDisplay(result)}
                    </p>

                    {result.hasReliableWindow &&
                      result.rainfallSelectedWindow !== null &&
                      result.rainfallSelectedWindow !== undefined && (
                        <p style={resultLineStyle}>
                          <strong>{t("rainfallSelectedWindow")}:</strong>{" "}
                          {formatInchesForDisplay(
                            result.rainfallSelectedWindow
                          ) || "Unavailable"}
                        </p>
                      )}

                    
                  </div>
                )}
              </div>

<div style={projectDetailsCardStyle}>
  <p style={projectDetailsTitleStyle}>{t("projectDetails")}</p>

<p style={projectDetailsPrimaryStyle}>
  {form.projectName || t("notEntered")} · {form.city}, {form.state}
</p>

  <p style={projectDetailsSecondaryStyle}>
    {formatDateLabel(form.workDate, language)} · {getLocalizedOptionLabel(form.workType, language)}
  </p>
</div>

{currentResultJobHasFinalResult && currentResultJob && (
  <div style={callFeedbackCardStyle}>
    <p style={projectDetailsTitleStyle}>{t("callFeedback")}</p>

    {currentResultJobFeedbackRating ? (
      <p
        style={{
          ...ratedCallTextStyle,
          color: currentResultJobFeedbackRating === "up" ? "#166534" : "#991b1b",
        }}
      >
        {t("rated")} {currentResultJobFeedbackRating === "up" ? `👍 ${t("goodCallText")}` : `👎 ${t("badCallText")}`}
      </p>
    ) : (
      <div style={rateCallButtonGridStyle}>
        <button
          onClick={() => rateLockedCall(currentResultJob.id, "up")}
          style={feedbackButtonStyle}
        >
          👍 {t("goodCallText")}
        </button>

        <button
          onClick={() => rateLockedCall(currentResultJob.id, "down")}
          style={feedbackButtonStyle}
        >
          👎 {t("badCallText")}
        </button>
      </div>
    )}
  </div>
)}

{currentResultJob && (
  <div style={projectActionsCardStyle}>
    <p style={projectDetailsTitleStyle}>{t("projectActions")}</p>

    <div style={projectActionGridStyle}>
      <button
        onClick={() => duplicateJobToNewDate(currentResultJob)}
        style={dateJobButtonStyle}
      >
        {t("copyToNewDate")}
      </button>

      <button onClick={deleteResultJob} style={deleteJobButtonStyle}>
        {t("delete")}
      </button>
    </div>
  </div>
)}

{!guestMode &&
  currentResultJob &&
  hasWorkDatePassed(currentResultJob) && (
    <OutcomeCapture
      language={language}
      jobId={currentResultJobId}
      existingOutcome={currentJobExperience.outcome}
      onSave={(payload) =>
        adoption.submitOutcome({
          jobId: currentResultJobId,
          ...payload,
        })
      }
    />
)}

{!guestMode && (
  <button
    type="button"
    onClick={() => setScreen("trustCenter")}
    style={secondaryButtonStyle}
  >
    {language === "es" ? "Cómo se construye esta decisión" : "How this call is built"}
  </button>
)}

              <button onClick={goHome} style={guestMode ? secondaryButtonStyle : primaryButtonStyle}>
                {guestMode
                  ? language === "es"
                    ? "Volver a FieldCall"
                    : "Return to FieldCall"
                  : t("dashboard")}
              </button>

            </div>
)}
          </section>
        )}
      </div>

      <Analytics />
    </main>
  );
}

// =====================================================
// SECTION 2 — SUPABASE CONFIG + CONSTANTS
// Environment variables, client setup, service options, and states.
// =====================================================

// Supabase connection.
// These must be set in the Vercel project environment variables.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;



function makeCompanyInviteCode(name) {
  const cleanName = String(name || "COMPANY")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);

  const randomPart = Math.random().toString(36).slice(2, 6).toUpperCase();

  return `${cleanName || "COMPANY"}-${randomPart}`;
}

const SERVICE_OPTIONS = ["Paving", "Striping", "Sealcoat", "Concrete",
  "Crack Seal"
];

const DEFAULT_PAVING_SETUP = "Subgrade exposed & paved same day";
const SURFACE_CONDITION_OPTIONS = ["Overlay", "Milled", "Subgrade currently exposed", DEFAULT_PAVING_SETUP];

const FINAL_CALL_TIME_OPTIONS = ["12:00", "15:00", "18:00"];
const MESSAGE_AUDIENCE_OPTIONS = ["client", "crew", "vendor"];

const WEATHER_CALL_CAUTION_OPTIONS = [
  {
    value: "very_cautious",
    labelKey: "veryCautious",
    helperKey: "veryCautiousHelp",
  },
  {
    value: "cautious",
    labelKey: "cautious",
    helperKey: "cautiousHelp",
  },
  {
    value: "balanced",
    labelKey: "balanced",
    helperKey: "balancedHelp",
  },
  {
    value: "flexible",
    labelKey: "flexible",
    helperKey: "flexibleHelp",
  },
  {
    value: "very_flexible",
    labelKey: "veryFlexible",
    helperKey: "veryFlexibleHelp",
  },
];


const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

const APP_TRANSLATIONS = {
  en: {
    language: "Language",
    preLoginTitle: "Make the GO / NO GO call with confidence.",
    preLoginText: "Weather-supported operational decisions for crews, schedules, and job sites.",
    login: "Login",
    createCompany: "Create Company",
    join: "Join",
    joinExisting: "Join Existing",
newToFieldCall: "New to FieldCall?",
welcomeBack: "Welcome back.",
welcomeBackText: "Log in to continue managing your weather decisions.",
newToFieldCallText: "Start making weather decisions in about 60 seconds. No credit card required.",
joiningCompany: "Joining your company?",
joiningCompanyText: "Use your Company Access Code to join an existing FieldCall company.",
createCompanyHelper: "Create your company in about 60 seconds. No credit card required.",
    finishCompanySetupTitle: "Finish company setup",
    finishCompanySetupText: "You’re logged in, but this account is not connected to a FieldCall company yet. Create a company or join one with an access code.",
    finishCompanySetupLoginMessage: "Logged in. Finish setup by creating a company or joining with an access code.",
    companyCreatedConnected: "Company created. You are now connected.",
    freeDuringPrivateBeta: "Free during private beta",
    createEntryTitle: "One step away.",
    createEntryText: "You’re one step away from turning uncertain forecasts into clear crew decisions. Set up your company and make your first GO, WATCH, or NO GO call in about 60 seconds.",
    or: "or",
    alreadyHaveAccount: "Already have an account?",
    logInLink: "Log in",
    joiningExistingCompany: "Joining an existing company?",
    enterInviteCode: "Enter invite code",
    joinCompany: "Join Company",
    email: "Email",
    password: "Password",
    forgotPassword: "Forgot password?",
    forgotPasswordTitle: "Reset your password.",
    forgotPasswordText: "Enter your account email and FieldCall will send a secure reset link.",
    sendResetLink: "Send Reset Link",
    backToLogin: "Back to Login",
    passwordResetEmailSent: "If an account exists for this email, a reset link has been sent.",
    passwordResetFailed: "The password reset email could not be sent.",
    passwordResetUnavailable: "Password reset is not available right now.",
    emailRequired: "Email is required.",
    companyName: "Company name",
    companyAccessCode: "Company Access Code",
    working: "Working...",
    preLoginNote: "Every weather app gives a forecast. FieldCall gives a decision.",
    nwsForecastData: "NWS Forecast Data",
    operationalScoringEngine: "Operational Scoring Engine",
    builtForContractors: "Built for Contractors",
    dashboardTitle: "Weather calls for field work.",
    dashboardText: "Same Weather. Better Decisions.",
    newAssessment: "New Assessment",
    defaultService: "Quick-Start Service",
    defaultServiceHelp: "New assessments will start with:",
    actionRequired: "Action Required",
    actionRequiredHelp: "Calls needing a decision or closer review.",
    finalCallPreparing: "Final call being prepared",
    finalCallPreparingNotice: "The final call is being prepared automatically. Tap Sync shortly to refresh the dashboard.",
    finalWindowOpen: "Final window open",
    makeFinalCall: "Make Final Call",
    preparing: "Preparing",
    runFinalCallNow: "Run Final Call",
    retry: "Retry",
    messages: "Messages",
    syncing: "Syncing...",
    refresh: "Sync",
    noSavedJobs: "No saved jobs yet.",
    finalCallsReady: "Final Calls Ready",
    finalCallsHelp: "Final calls for review.",
    noFinalCalls: "No final calls ready.",
    todaysCalls: "Today's Calls",
    todaysCallsHelp: "Final calls and elevated preliminary risks.",
    noTodaysCalls: "No calls for today.",
    tomorrowsCalls: "Tomorrow's Calls",
    tomorrowsCallsHelp: "Calls that need communication before tomorrow’s work.",
    noTomorrowsCalls: "No calls for tomorrow.",
    upcomingPreliminaryCalls: "Upcoming / Preliminary Calls",
    upcomingPreliminaryCallsHelp: "Jobs still being monitored before the final decision window.",
    noUpcomingCalls: "No upcoming preliminary calls.",
    preliminaryCalls: "Preliminary Calls",
    noPreliminaryCalls: "No preliminary calls right now.",
    callsMade: "History",
    callHistoryLimitHelp: "Showing your 10 most recent calls.",
    noLockedCalls: "No call history yet.",
    weatherDataConnected: "Weather Data Connected",
    weatherDataConnectedHelp: "NWS and Open-Meteo active.",
    jobsUpdated: "Jobs updated",
    updated: "Updated",
    shareFieldCall: "Share FieldCall",
    addToHomeScreen: "Add to Home Screen",
    enableFinalCallAlerts: "Enable Final Call Alerts",
    enablingAlerts: "Enabling alerts...",
    finalCallAlerts: "Final Call Alerts",
    finalCallAlertsOn: "Final Call Alerts On",
    finalCallAlertsOff: "Final Call Alerts Off",
    finalCallAlertsSettingsHelp: "Notify this device when final calls are ready.",
    finalCallAlertsOnHelp: "When on, this device can receive alerts when final calls are ready.",
    finalCallAlertsOffHelp: "When off, this device will not receive final call alerts.",
    autoRefreshSavedJobs: "Auto-refresh saved jobs",
    autoRefreshSavedJobsHelp: "Refresh active non-final jobs when the dashboard opens.",
    autoRefreshSavedJobsOn: "Auto-refresh is on",
    autoRefreshSavedJobsOff: "Auto-refresh is off",
    autoRefreshSavedJobsOnHelp: "FieldCall will update non-final saved jobs before the work window starts.",
    autoRefreshSavedJobsOffHelp: "Saved jobs will update only when someone taps Sync.",
    turnOnAutoRefresh: "Turn On Auto-refresh",
    turnOffAutoRefresh: "Turn Off Auto-refresh",
    autoRefreshColumnMissing: "Auto-refresh setting is ready. Add the auto_refresh_saved_jobs column in Supabase to save this setting.",
    turnOnFinalCallAlerts: "Turn On Final Call Alerts",
    turnOffFinalCallAlerts: "Turn Off Final Call Alerts",
    on: "On",
    off: "Off",
    alertsEnabledMessage: "Final call alerts are enabled on this device.",
    alertsDisabledMessage: "Final call alerts are turned off on this device.",
    alertsDisableFailed: "Final call alerts could not be turned off.",
    alertsUnavailable: "Phone alerts are not supported in this browser. On iPhone, add FieldCall to your Home Screen first.",
    alertsBlocked: "Notifications are blocked. Enable them in your browser or phone settings to receive final call alerts.",
    alertsEnableFailed: "Final call alerts did not finish setting up. Try again.",
    alertsSetupMissing: "Final call alerts are not fully set up yet.",
    alertsSignInRequired: "Sign in to enable final call alerts.",
    myAccount: "My Account",
    accountAndSecurity: "Account & Security",
    accountIntro: "Manage your login, device alerts, support, and account access.",
    notifications: "Notifications",
    security: "Security",
    changePassword: "Change Password",
    resetPassword: "Reset Password",
    newPassword: "New Password",
    confirmNewPassword: "Confirm New Password",
    newPasswordHelp: "Use at least 8 characters and enter the same password twice.",
    updatePassword: "Update Password",
    passwordMinimum: "Your password must be at least 8 characters.",
    passwordsDoNotMatch: "The passwords do not match.",
    passwordUpdated: "Your password has been updated.",
    passwordUpdateFailed: "Your password could not be updated.",
    signInAgain: "Please sign in again to continue.",
    legalAndSupport: "Legal & Support",
    privacyPolicy: "Privacy Policy",
    termsOfUse: "Terms of Use",
    contactSupport: "Contact Support",
    accountActions: "Account Actions",
    companyActions: "Company Actions",
    deleteAccount: "Delete Account",
    deleteAccountIntro: "Permanently remove your FieldCall login and personal account data.",
    deleteAccountDataExplanation: "Company-owned job and assessment records may remain without identifying you. If you are the only company user, the company and its records will also be deleted.",
    loadingAccountDetails: "Checking your company ownership and account details…",
    accountWillBeDeleted: "Your account will be permanently deleted.",
    accountAndCompanyWillBeDeleted: "Your account and company will be permanently deleted.",
    ownershipTransferRequired: "Choose a new company owner before deleting your account.",
    newCompanyOwner: "New Company Owner",
    companyMember: "Company member",
    currentPassword: "Current Password",
    currentPasswordRequired: "Enter your current password.",
    currentPasswordIncorrect: "The current password is incorrect.",
    typeDeleteToConfirm: "Type DELETE to confirm",
    typeDeleteExactly: "Type DELETE exactly to continue.",
    chooseNewOwner: "Choose a new company owner.",
    permanentlyDeleteAccount: "Permanently Delete Account",
    accountDeletionFailed: "The account could not be deleted.",
    accountPreviewFailed: "FieldCall could not check your account deletion options.",
    deleteCompany: "Delete Company",
    deleteCompanyIntro: "Permanently remove this company and all company-owned FieldCall records.",
    deleteCompanyDataExplanation: "This deletes company jobs, assessments, settings, locations, final-call queue items, and every user’s access to this company. Your personal login will remain active.",
    typeDeleteCompanyToConfirm: "Type DELETE COMPANY to confirm",
    typeDeleteCompanyExactly: "Type DELETE COMPANY exactly to continue.",
    permanentlyDeleteCompany: "Permanently Delete Company",
    companyDeletionFailed: "The company could not be deleted.",
    companyDeletedCreateAnother: "Company deleted. Create a new company or join another company.",
    deleting: "Deleting…",
    returnToDashboard: "Return to Dashboard",
    discardUnsavedChanges: "Discard unsaved company-setting changes and return to the dashboard?",
    company: "Company",
    companySettings: "Company Settings",
    companyProfile: "Company Profile",
    appBehavior: "App Behavior",
    defaultFinalCallTime: "Default Final Call Time",
    whenShouldFieldCallPrepareFinalCalls: "When should FieldCall prepare final calls?",
    defaultFinalCallTimeHelp: "New assessments start with this time. Users can override it for an individual job.",
    defaultFinalCallTimeSelectedHelp: "This becomes the starting choice for new assessments.",
    defaultFinalCallTimeFinePrint: "Day jobs use the day before work. Night jobs use the work date. Times follow the job’s local time zone.",
    noon: "Noon",
    threePm: "3 PM",
    sixPm: "6 PM",
    companySettingsIntro: "Set how your company wants FieldCall to handle weather calls.",
    companySettingsDashboardHelp: "Company weather-call defaults",
    fieldCallStandard: "FieldCall standard",
    weatherCallCautionHelpCompact: "Move left for earlier NO GO calls. Move right to accept more weather risk.",
    workableRainThresholdHelpCompact: "Hours at or below this threshold may qualify for the workable window.",
    defaultFinalCallTimeHelpCompact: "The starting final-call time for new jobs. Individual jobs can override it.",
    howThisWorks: "How this works",
    timingDetails: "Timing details",
    saveChangesAndReturn: "Save Changes & Return",
    companySettingsAdminOnly: "Only company owners or admins can change company settings.",
    weatherCallCaution: "Weather Call Caution",
    howCautiousShouldFieldCallBe: "How cautious should FieldCall be?",
    weatherCallCautionHelp: "Move left to make NO GO calls sooner. Move right to allow more GO calls, with more weather risk.",
    noGoSooner: "NO GO sooner",
    goMoreOftenMoreRisk: "GO more often (more risk)",
    veryCautious: "Very Cautious",
    veryCautiousHelp: "NO GO calls happen much sooner.",
    cautious: "Cautious",
    cautiousHelp: "NO GO calls happen sooner than the standard setting.",
    balanced: "Balanced",
    balancedHelp: "Standard FieldCall setting.",
    flexible: "Flexible",
    flexibleHelp: "Allows more GO calls, but with more weather risk.",
    veryFlexible: "Very Flexible",
    veryFlexibleHelp: "Allows the most GO calls and accepts the most weather risk.",
    weatherCallCautionFinePrint: "This setting applies to your company’s weather calls.",
    workableRainThreshold: "Workable Rain Threshold",
    whatRainChanceIsWorkable: "What hourly rain chance is workable?",
    workableRainThresholdHelp: "An hour above this company threshold will not appear inside a workable window. The highest probability from approved sources is used.",
    workableRainThresholdSelectedHelp: "Hours at or below this threshold can qualify.",
    fieldCallStandardRainThreshold: "FieldCall standard",
    minimumWorkableWindowFinePrint: "A workable window requires at least 2 continuous hours. Rainfall amount, thunder wording, and lightning do not independently remove an hour.",
    workableWindowRequirements: "Workable Window Requirements",
    whyThisWindow: "Why this window",
    otherQualifyingWindows: "Other qualifying windows",
    saveCompanySettings: "Save Company Settings",
    saveAndReturnDashboard: "Save & Return to Dashboard",
    saving: "Saving...",
    companySettingsSaved: "Company settings saved.",
    companySettingsSaveFailed: "Company settings could not be saved.",
    companySettingsNoPermission: "Settings were not saved. Check company permissions or RLS policy.",
    companySettingsColumnMissing: "Settings page is ready. Add the weather_call_caution column in Supabase to load and save this setting.",
    iphoneInstallHelpStart: "Tap the browser share button, then choose",
    androidInstallHelp: "Use the browser menu or install prompt when available.",
    logout: "Logout",
    jobDetails: "Job Details",
    projectName: "Project Name",
    projectNamePlaceholder: "Auto-filled from selected location",
    workDate: "Work Date",
    workType: "Work Type",
    dayNight: "Day/Night",
    finalCallTime: "Final Call Time",
    finalCallTimeDayHelp: "For day work, FieldCall prepares the final call at this local time on the day before work.",
    finalCallTimeNightHelp: "For night work, FieldCall prepares the final call at this local time on the work date.",
    pavingSetup: "Paving setup",
    checkingSources: "Checking NWS and Open-Meteo…",
    checkingWeather: "Checking Weather...",
    refreshingWeather: "Refreshing...",
    activeJobsRefreshed: "Refreshed {count} active job(s).",
    runAssessment: "Run Assessment",
    cancel: "Cancel",
    saveDate: "Save Date",
    view: "View",
    viewCall: "View call",
    duplicate: "Duplicate",
    delete: "Delete",
    check: "Check",
    checking: "Checking...",
    date: "Date",
    callMade: "Call made",
    finalCallRun: "Final call run",
    finalCallScheduled: "Final call {time}",
    workWindowStartedNoFinal: "Work window started — no final call saved.",
    inWorkWindow: "In work window",
    autoPrepared: "Auto-prepared",
    autoFinalNoticeEyebrow: "Final call prepared",
    autoFinalNoticeTitle: "FieldCall prepared your final weather call.",
    autoFinalNoticeText: "{count} saved job has an automatic final call ready to review.",
    review: "Review",
    dismiss: "Dismiss",
    rated: "Rated:",
    rateTheCall: "Rate the call",
    goodCallText: "Good Call",
    badCallText: "Bad Call",
    checked: "Checked",
    bestWorkableWindow: "Best Workable Window",
    mainReason: "Primary Consideration",
    communication: "Communication",
    communicationHelp: "Copy the client, crew, or vendor update for this call.",
    messagesScreenHelp: "Review and edit the right update before copying.",
    viewFullCall: "View Full Call",
    message: "Message",
    copyMessage: "Copy Message",
    resetTemplate: "Reset to FieldCall Template",
    messageTemplateReset: "Template reset.",
    client: "Client",
    crew: "Crew",
    vendor: "Vendor",
    internal: "Internal",
    keyDecisionFactors: "KEY DECISION FACTORS",
    assessmentDetails: "Assessment Details",
    finalCallTimeDetail: "Final Call Time",
    dayBeforeWork: "the day before work",
    onWorkDate: "on the work date",
    forecastAgreement: "Forecast Agreement",
    weatherCheck: "Weather Check",
    sources: "Sources",
    highestRainSignal: "Highest rain signal",
    nwsShows: "NWS shows {value}",
    openMeteoShows: "Open-Meteo shows {value}",
    selectedWindowTemp: "Best-window temperature",
    assessedPeriodTemp: "Assessed-period temperature",
    rainfallAssessedPeriod: "Forecast rainfall during assessed period",
    rainfallSelectedWindow: "Forecast rainfall during best window",
    projectDetails: "Project Details",
    projectActions: "Project Actions",
    copyToNewDate: "Copy to new date",
    callFeedback: "Call Feedback",
    notEntered: "Not entered",
    dashboard: "Dashboard",
    chooseDate: "Choose date",
    noDate: "No date",
    today: "Today",
    tomorrow: "Tomorrow",
    location: "Location",
    locationPlaceholder: "Business name, address, or city/state",
    searchingLocations: "Searching locations…",
    locationNotFound: "We couldn’t find that location. Try business name, address, or city/state.",
    locationSearchFailed: "Location search failed.",
  },
  es: {
    language: "Idioma",
    preLoginTitle: "Tome la decisión GO / NO GO con confianza.",
    preLoginText: "Decisiones operativas con respaldo del clima para cuadrillas, horarios y sitios de trabajo.",
    login: "Iniciar sesión",
    createCompany: "Crear empresa",
    join: "Unirse",
    joinExisting: "Unirse existente",
newToFieldCall: "¿Nuevo en FieldCall?",
welcomeBack: "Bienvenido de nuevo.",
welcomeBackText: "Inicie sesión para continuar administrando sus decisiones meteorológicas.",
newToFieldCallText: "Comience a tomar decisiones meteorológicas en unos 60 segundos. No se requiere tarjeta de crédito.",
joiningCompany: "¿Se une a su empresa?",
joiningCompanyText: "Use el código de acceso de su empresa para unirse a una empresa existente de FieldCall.",
createCompanyHelper: "Cree su empresa en aproximadamente 60 segundos. No se requiere tarjeta.",
    finishCompanySetupTitle: "Terminar configuración de empresa",
    finishCompanySetupText: "Ya inició sesión, pero esta cuenta todavía no está conectada a una empresa de FieldCall. Cree una empresa o únase con un código de acceso.",
    finishCompanySetupLoginMessage: "Sesión iniciada. Termine la configuración creando una empresa o uniéndose con un código de acceso.",
    companyCreatedConnected: "Empresa creada. Ya está conectado.",
    freeDuringPrivateBeta: "Gratis durante la beta privada",
    createEntryTitle: "A un paso.",
    createEntryText: "Está a un paso de convertir pronósticos inciertos en decisiones claras para su equipo. Configure su compañía y haga su primera decisión GO, WATCH o NO GO en aproximadamente 60 segundos.",
    or: "o",
    alreadyHaveAccount: "¿Ya tiene una cuenta?",
    logInLink: "Iniciar sesión",
    joiningExistingCompany: "¿Se une a una empresa existente?",
    enterInviteCode: "Ingrese el código de invitación",
    joinCompany: "Unirse a empresa",
    email: "Correo electrónico",
    password: "Contraseña",
    forgotPassword: "¿Olvidó su contraseña?",
    forgotPasswordTitle: "Restablezca su contraseña.",
    forgotPasswordText: "Ingrese el correo de su cuenta y FieldCall enviará un enlace seguro.",
    sendResetLink: "Enviar enlace",
    backToLogin: "Volver a iniciar sesión",
    passwordResetEmailSent: "Si existe una cuenta con este correo, se envió un enlace para restablecerla.",
    passwordResetFailed: "No se pudo enviar el correo para restablecer la contraseña.",
    passwordResetUnavailable: "El restablecimiento de contraseña no está disponible ahora.",
    emailRequired: "El correo electrónico es obligatorio.",
    companyName: "Nombre de la empresa",
    companyAccessCode: "Código de acceso de la empresa",
    working: "Procesando...",
    preLoginNote: "Cualquier app del clima da un pronóstico. FieldCall da una decisión.",
    nwsForecastData: "Datos del pronóstico NWS",
    operationalScoringEngine: "Motor de calificación operativa",
    builtForContractors: "Creado para contratistas",
    dashboardTitle: "Decisiones del clima para trabajo en campo.",
    dashboardText: "Mismo clima. Mejores decisiones.",
    newAssessment: "Nueva evaluación",
    defaultService: "Servicio de inicio rápido",
    defaultServiceHelp: "Las nuevas evaluaciones comenzarán con:",
    actionRequired: "Acción requerida",
    actionRequiredHelp: "Decisiones que necesitan revisión o decisión final.",
    finalCallPreparing: "Preparando decisión final",
    finalCallPreparingNotice: "La decisión final se está preparando automáticamente. Toque Sync en un momento para actualizar el panel.",
    finalWindowOpen: "Ventana final abierta",
    makeFinalCall: "Hacer decisión final",
    preparing: "Preparando",
    runFinalCallNow: "Ejecutar llamada final",
    retry: "Reintentar",
    messages: "Mensajes",
    syncing: "Sincronizando...",
    refresh: "Sync",
    noSavedJobs: "Todavía no hay trabajos guardados.",
    finalCallsReady: "Decisiones finales listas",
    finalCallsHelp: "Decisiones finales para revisar.",
    noFinalCalls: "No hay decisiones finales listas.",
    todaysCalls: "Decisiones de hoy",
    todaysCallsHelp: "Decisiones finales y riesgos preliminares elevados.",
    noTodaysCalls: "No hay decisiones para hoy.",
    tomorrowsCalls: "Decisiones de mañana",
    tomorrowsCallsHelp: "Decisiones que necesitan comunicación antes del trabajo de mañana.",
    noTomorrowsCalls: "No hay decisiones para mañana.",
    upcomingPreliminaryCalls: "Próximas / preliminares",
    upcomingPreliminaryCallsHelp: "Trabajos que todavía se monitorean antes de la ventana final.",
    noUpcomingCalls: "No hay revisiones preliminares próximas.",
    preliminaryCalls: "Revisiones preliminares",
    noPreliminaryCalls: "No hay revisiones preliminares ahora.",
    callsMade: "Historial",
    callHistoryLimitHelp: "Se muestran sus 10 decisiones más recientes.",
    noLockedCalls: "Todavía no hay historial de decisiones.",
    weatherDataConnected: "Datos del clima conectados",
    weatherDataConnectedHelp: "NWS y Open-Meteo activos.",
    jobsUpdated: "Trabajos actualizados",
    updated: "Actualizado",
    shareFieldCall: "Compartir FieldCall",
    addToHomeScreen: "Agregar a pantalla de inicio",
    enableFinalCallAlerts: "Activar alertas de decisión final",
    enablingAlerts: "Activando alertas...",
    finalCallAlerts: "Alertas de decisión final",
    finalCallAlertsOn: "Alertas de decisión final activadas",
    finalCallAlertsOff: "Alertas de decisión final desactivadas",
    finalCallAlertsSettingsHelp: "Notificar a este dispositivo cuando las decisiones finales estén listas.",
    finalCallAlertsOnHelp: "Cuando están activadas, este dispositivo puede recibir alertas cuando las decisiones finales estén listas.",
    finalCallAlertsOffHelp: "Cuando están desactivadas, este dispositivo no recibirá alertas de decisión final.",
    autoRefreshSavedJobs: "Auto-actualizar trabajos guardados",
    autoRefreshSavedJobsHelp: "Actualiza trabajos activos no finales cuando se abre el panel.",
    autoRefreshSavedJobsOn: "Auto-actualización activada",
    autoRefreshSavedJobsOff: "Auto-actualización desactivada",
    autoRefreshSavedJobsOnHelp: "FieldCall actualizará trabajos no finales antes de que comience la ventana de trabajo.",
    autoRefreshSavedJobsOffHelp: "Los trabajos guardados se actualizarán solo cuando alguien toque Sync.",
    turnOnAutoRefresh: "Activar auto-actualización",
    turnOffAutoRefresh: "Desactivar auto-actualización",
    autoRefreshColumnMissing: "La configuración de auto-actualización está lista. Agregue la columna auto_refresh_saved_jobs en Supabase para guardar esta configuración.",
    turnOnFinalCallAlerts: "Activar alertas de decisión final",
    turnOffFinalCallAlerts: "Desactivar alertas de decisión final",
    on: "Activado",
    off: "Desactivado",
    alertsEnabledMessage: "Las alertas de decisión final están activadas en este dispositivo.",
    alertsDisabledMessage: "Las alertas de decisión final están desactivadas en este dispositivo.",
    alertsDisableFailed: "No se pudieron desactivar las alertas de decisión final.",
    alertsUnavailable: "Las alertas del teléfono no son compatibles con este navegador. En iPhone, agregue FieldCall a la pantalla de inicio primero.",
    alertsBlocked: "Las notificaciones están bloqueadas. Actívelas en la configuración del navegador o teléfono para recibir alertas.",
    alertsEnableFailed: "Las alertas de decisión final no se terminaron de configurar. Inténtelo de nuevo.",
    alertsSetupMissing: "Las alertas de decisión final aún no están completamente configuradas.",
    alertsSignInRequired: "Inicie sesión para activar las alertas de decisión final.",
    myAccount: "Mi cuenta",
    accountAndSecurity: "Cuenta y seguridad",
    accountIntro: "Administre su acceso, alertas del dispositivo y ayuda.",
    notifications: "Notificaciones",
    security: "Seguridad",
    changePassword: "Cambiar contraseña",
    resetPassword: "Restablecer contraseña",
    newPassword: "Nueva contraseña",
    confirmNewPassword: "Confirmar nueva contraseña",
    newPasswordHelp: "Use al menos 8 caracteres e ingrese la misma contraseña dos veces.",
    updatePassword: "Actualizar contraseña",
    passwordMinimum: "La contraseña debe tener al menos 8 caracteres.",
    passwordsDoNotMatch: "Las contraseñas no coinciden.",
    passwordUpdated: "Su contraseña fue actualizada.",
    passwordUpdateFailed: "No se pudo actualizar la contraseña.",
    signInAgain: "Vuelva a iniciar sesión para continuar.",
    legalAndSupport: "Legal y ayuda",
    privacyPolicy: "Política de privacidad",
    termsOfUse: "Términos de uso",
    contactSupport: "Contactar soporte",
    accountActions: "Acciones de la cuenta",
    companyActions: "Acciones de la empresa",
    deleteAccount: "Eliminar cuenta",
    deleteAccountIntro: "Elimine permanentemente su acceso y datos personales de FieldCall.",
    deleteAccountDataExplanation: "Los trabajos y evaluaciones de la empresa pueden permanecer sin identificarlo. Si usted es el único usuario, también se eliminarán la empresa y sus registros.",
    loadingAccountDetails: "Revisando la propiedad de la empresa y los datos de la cuenta…",
    accountWillBeDeleted: "Su cuenta será eliminada permanentemente.",
    accountAndCompanyWillBeDeleted: "Su cuenta y empresa serán eliminadas permanentemente.",
    ownershipTransferRequired: "Elija un nuevo dueño antes de eliminar su cuenta.",
    newCompanyOwner: "Nuevo dueño de la empresa",
    companyMember: "Miembro de la empresa",
    currentPassword: "Contraseña actual",
    currentPasswordRequired: "Ingrese su contraseña actual.",
    currentPasswordIncorrect: "La contraseña actual es incorrecta.",
    typeDeleteToConfirm: "Escriba DELETE para confirmar",
    typeDeleteExactly: "Escriba DELETE exactamente para continuar.",
    chooseNewOwner: "Elija un nuevo dueño de la empresa.",
    permanentlyDeleteAccount: "Eliminar cuenta permanentemente",
    accountDeletionFailed: "No se pudo eliminar la cuenta.",
    accountPreviewFailed: "FieldCall no pudo revisar las opciones de eliminación.",
    deleteCompany: "Eliminar empresa",
    deleteCompanyIntro: "Elimine permanentemente esta empresa y todos sus registros en FieldCall.",
    deleteCompanyDataExplanation: "Esto elimina trabajos, evaluaciones, configuraciones, ubicaciones, colas de decisiones finales y el acceso de todos los usuarios. Su inicio de sesión personal seguirá activo.",
    typeDeleteCompanyToConfirm: "Escriba DELETE COMPANY para confirmar",
    typeDeleteCompanyExactly: "Escriba DELETE COMPANY exactamente para continuar.",
    permanentlyDeleteCompany: "Eliminar empresa permanentemente",
    companyDeletionFailed: "No se pudo eliminar la empresa.",
    companyDeletedCreateAnother: "Empresa eliminada. Cree otra empresa o únase a una existente.",
    deleting: "Eliminando…",
    returnToDashboard: "Volver al panel",
    discardUnsavedChanges: "¿Descartar los cambios no guardados y volver al panel?",
    company: "Empresa",
    companySettings: "Configuración de la empresa",
    companyProfile: "Perfil de la empresa",
    appBehavior: "Comportamiento de la app",
    defaultFinalCallTime: "Hora predeterminada de decisión final",
    whenShouldFieldCallPrepareFinalCalls: "¿Cuándo debe FieldCall preparar las decisiones finales?",
    defaultFinalCallTimeHelp: "Las nuevas evaluaciones comienzan con esta hora. El usuario puede cambiarla para un trabajo individual.",
    defaultFinalCallTimeSelectedHelp: "Esta será la opción inicial para nuevas evaluaciones.",
    defaultFinalCallTimeFinePrint: "Los trabajos diurnos usan el día anterior. Los trabajos nocturnos usan la fecha de trabajo. La hora corresponde a la zona horaria del trabajo.",
    noon: "Mediodía",
    threePm: "3 PM",
    sixPm: "6 PM",
    companySettingsIntro: "Configure cómo su empresa quiere que FieldCall maneje las decisiones del clima.",
    companySettingsDashboardHelp: "Valores del clima de la empresa",
    fieldCallStandard: "Estándar de FieldCall",
    weatherCallCautionHelpCompact: "Mueva a la izquierda para NO GO antes. Mueva a la derecha para aceptar más riesgo.",
    workableRainThresholdHelpCompact: "Las horas iguales o inferiores a este umbral pueden calificar.",
    defaultFinalCallTimeHelpCompact: "Hora inicial para trabajos nuevos. Cada trabajo puede cambiarla.",
    howThisWorks: "Cómo funciona",
    timingDetails: "Detalles del horario",
    saveChangesAndReturn: "Guardar cambios y volver",
    companySettingsAdminOnly: "Solo los dueños o administradores pueden cambiar la configuración de la empresa.",
    weatherCallCaution: "Cautela de decisión del clima",
    howCautiousShouldFieldCallBe: "¿Qué tan cauteloso debe ser FieldCall?",
    weatherCallCautionHelp: "Mueva a la izquierda para hacer decisiones NO GO antes. Mueva a la derecha para permitir más decisiones GO, con más riesgo.",
    noGoSooner: "NO GO antes",
    goMoreOftenMoreRisk: "Más GO (más riesgo)",
    veryCautious: "Muy cauteloso",
    veryCautiousHelp: "Las decisiones NO GO suceden mucho antes.",
    cautious: "Cauteloso",
    cautiousHelp: "Las decisiones NO GO suceden antes que la configuración estándar.",
    balanced: "Balanceado",
    balancedHelp: "Configuración estándar de FieldCall.",
    flexible: "Flexible",
    flexibleHelp: "Permite más decisiones GO, pero con más riesgo climático.",
    veryFlexible: "Muy flexible",
    veryFlexibleHelp: "Permite la mayor cantidad de decisiones GO y acepta más riesgo climático.",
    weatherCallCautionFinePrint: "Esta configuración se aplica a las decisiones del clima de su empresa.",
    workableRainThreshold: "Umbral de lluvia trabajable",
    whatRainChanceIsWorkable: "¿Qué probabilidad horaria de lluvia es trabajable?",
    workableRainThresholdHelp: "Una hora por encima de este umbral de la empresa no aparecerá dentro de una ventana trabajable. Se usa la probabilidad más alta de las fuentes aprobadas.",
    workableRainThresholdSelectedHelp: "Las horas iguales o inferiores a este umbral pueden calificar.",
    fieldCallStandardRainThreshold: "Estándar de FieldCall",
    minimumWorkableWindowFinePrint: "Una ventana trabajable requiere al menos 2 horas continuas. La cantidad de lluvia, el texto de tormenta y los rayos no eliminan una hora por sí solos.",
    workableWindowRequirements: "Requisitos de la ventana trabajable",
    whyThisWindow: "Por qué esta ventana",
    otherQualifyingWindows: "Otras ventanas que califican",
    saveCompanySettings: "Guardar configuración",
    saveAndReturnDashboard: "Guardar y volver al panel",
    saving: "Guardando...",
    companySettingsSaved: "Configuración de la empresa guardada.",
    companySettingsSaveFailed: "No se pudo guardar la configuración de la empresa.",
    companySettingsNoPermission: "La configuración no se guardó. Revise los permisos de la empresa o la política RLS.",
    companySettingsColumnMissing: "La página de configuración está lista. Agregue la columna weather_call_caution en Supabase para cargar y guardar esta configuración.",
    iphoneInstallHelpStart: "Toque el botón de compartir del navegador y elija",
    androidInstallHelp: "Use el menú del navegador o la opción de instalación cuando esté disponible.",
    logout: "Cerrar sesión",
    jobDetails: "Detalles del trabajo",
    projectName: "Nombre del proyecto",
    projectNamePlaceholder: "Se llena automáticamente con la ubicación seleccionada",
    workDate: "Fecha de trabajo",
    workType: "Tipo de trabajo",
    dayNight: "Día/Noche",
    finalCallTime: "Hora de decisión final",
    finalCallTimeDayHelp: "Para trabajo diurno, FieldCall prepara la decisión final a esta hora local el día anterior al trabajo.",
    finalCallTimeNightHelp: "Para trabajo nocturno, FieldCall prepara la decisión final a esta hora local en la fecha de trabajo.",
    pavingSetup: "Condición de pavimentación",
    checkingSources: "Revisando NWS y Open-Meteo…",
    checkingWeather: "Revisando clima...",
    refreshingWeather: "Actualizando...",
    activeJobsRefreshed: "Se actualizaron {count} trabajo(s) activos.",
    runAssessment: "Ejecutar evaluación",
    cancel: "Cancelar",
    saveDate: "Guardar fecha",
    view: "Ver",
    viewCall: "Ver decisión",
    duplicate: "Duplicar",
    delete: "Eliminar",
    check: "Revisar",
    checking: "Revisando...",
    date: "Fecha",
    callMade: "Decisión tomada",
    finalCallRun: "Decisión final revisada",
    finalCallScheduled: "Decisión final {time}",
    workWindowStartedNoFinal: "La ventana de trabajo comenzó — no se guardó decisión final.",
    inWorkWindow: "En ventana de trabajo",
    autoPrepared: "Preparado automáticamente",
    autoFinalNoticeEyebrow: "Decisión final preparada",
    autoFinalNoticeTitle: "FieldCall preparó su decisión final del clima.",
    autoFinalNoticeText: "{count} trabajo guardado tiene una decisión final automática lista para revisar.",
    review: "Revisar",
    dismiss: "Descartar",
    rated: "Calificado:",
    rateTheCall: "Calificar la decisión",
    goodCallText: "Buena decisión",
    badCallText: "Mala decisión",
    checked: "Revisado",
    bestWorkableWindow: "Mejor ventana de trabajo",
    mainReason: "Consideración principal",
    communication: "Comunicación",
    communicationHelp: "Copie la actualización para cliente, cuadrilla o proveedor.",
    messagesScreenHelp: "Revise y edite la actualización correcta antes de copiar.",
    viewFullCall: "Ver decisión completa",
    message: "Mensaje",
    copyMessage: "Copiar mensaje",
    resetTemplate: "Restablecer plantilla de FieldCall",
    messageTemplateReset: "Plantilla restablecida.",
    client: "Cliente",
    crew: "Cuadrilla",
    vendor: "Proveedor",
    internal: "Interno",
    keyDecisionFactors: "FACTORES CLAVE DE DECISIÓN",
    assessmentDetails: "Detalles de la evaluación",
    finalCallTimeDetail: "Hora de decisión final",
    dayBeforeWork: "el día anterior al trabajo",
    onWorkDate: "en la fecha de trabajo",
    forecastAgreement: "Acuerdo del pronóstico",
    weatherCheck: "Revisión del clima",
    sources: "Fuentes",
    highestRainSignal: "Señal más alta de lluvia",
    nwsShows: "NWS muestra {value}",
    openMeteoShows: "Open-Meteo muestra {value}",
    selectedWindowTemp: "Temperatura en la mejor ventana",
    assessedPeriodTemp: "Temperatura del período evaluado",
    rainfallAssessedPeriod: "Lluvia pronosticada durante el período evaluado",
    rainfallSelectedWindow: "Lluvia pronosticada durante la mejor ventana",
    projectDetails: "Detalles del proyecto",
    projectActions: "Acciones del proyecto",
    copyToNewDate: "Copiar a nueva fecha",
    callFeedback: "Comentarios de la decisión",
    notEntered: "No ingresado",
    dashboard: "Panel",
    chooseDate: "Elegir fecha",
    noDate: "Sin fecha",
    today: "Hoy",
    tomorrow: "Mañana",
    location: "Ubicación",
    locationPlaceholder: "Nombre del negocio, dirección o ciudad/estado",
    searchingLocations: "Buscando ubicaciones…",
    locationNotFound: "No pudimos encontrar esa ubicación. Intente con el nombre del negocio, dirección o ciudad/estado.",
    locationSearchFailed: "La búsqueda de ubicación falló.",
  },
};

const OPTION_TRANSLATIONS = {
  es: {
    Paving: "Pavimentación",
    Striping: "Señalización",
    Sealcoat: "Sellado",
    Concrete: "Concreto",
    "Crack Seal": "Sellado de grietas",
    Day: "Día",
    Night: "Noche",
    Overlay: "Recapa",
    Milled: "Fresado",
    "Subgrade currently exposed": "Subrasante expuesta actualmente",
    "Subgrade exposed & paved same day": "Subrasante expuesta y pavimentada el mismo día",
  },
};

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}

function getPushPlatformLabel() {
  const userAgent = navigator.userAgent || "";

  if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
  if (/android/i.test(userAgent)) return "Android";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/macintosh|mac os/i.test(userAgent)) return "macOS";

  return "Web";
}

function getSavedLanguagePreference() {
  try {
    const savedLanguage = window.localStorage.getItem("fieldcall-language");
    return savedLanguage === "es" ? "es" : "en";
  } catch {
    return "en";
  }
}

function saveLanguagePreference(language) {
  try {
    window.localStorage.setItem("fieldcall-language", language === "es" ? "es" : "en");
  } catch {
    // Local storage can be unavailable in private or restricted browsers.
  }
}

function getSavedDefaultServicePreference() {
  try {
    const savedService = window.localStorage.getItem("fieldcall-default-service");
    return savedService || "Paving";
  } catch {
    return "Paving";
  }
}

function saveDefaultServicePreference(serviceName) {
  try {
    if (serviceName) {
      window.localStorage.setItem("fieldcall-default-service", serviceName);
    }
  } catch {
    // Local storage can be unavailable in private or restricted browsers.
  }
}

function translateAppText(language, key, replacements = {}) {
  const fallback = APP_TRANSLATIONS.en[key] || key;
  const translated = APP_TRANSLATIONS[language]?.[key] || fallback;

  return Object.entries(replacements).reduce((text, [name, value]) => {
    return text.replaceAll(`{${name}}`, String(value));
  }, translated);
}

function getLocalizedOptionLabel(option, language = "en") {
  return OPTION_TRANSLATIONS[language]?.[option] || option;
}

function getDashboardServiceTag(serviceName, language = "en") {
  const normalized = String(serviceName || "").trim().toLowerCase();

  const englishTags = {
    paving: "PAVING",
    striping: "STRIPING",
    sealcoat: "SEAL",
    concrete: "CONCRETE",
    "crack seal": "CRACK",
  };

  const spanishTags = {
    paving: "PAVIM",
    striping: "SEÑAL",
    sealcoat: "SELLADO",
    concrete: "CONCRETO",
    "crack seal": "GRIETAS",
  };

  const tag = language === "es" ? spanishTags[normalized] : englishTags[normalized];

  return tag || String(serviceName || "SERVICE").toUpperCase().slice(0, 8);
}

function normalizeWeatherCallCaution(value) {
  const matchingOption = WEATHER_CALL_CAUTION_OPTIONS.find(
    (option) => option.value === value
  );

  return matchingOption?.value || "balanced";
}

function normalizeWorkableRainThreshold(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, parsed))
    : 30;
}

function normalizeMinimumWorkableWindowHours(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(24, Math.max(1, Math.round(parsed)))
    : 2;
}

function getWeatherCallCautionIndex(value) {
  const normalizedValue = normalizeWeatherCallCaution(value);
  const optionIndex = WEATHER_CALL_CAUTION_OPTIONS.findIndex(
    (option) => option.value === normalizedValue
  );

  return optionIndex >= 0 ? optionIndex : 2;
}

function getWeatherCallCautionOption(value) {
  return WEATHER_CALL_CAUTION_OPTIONS[
    getWeatherCallCautionIndex(value)
  ] || WEATHER_CALL_CAUTION_OPTIONS[2];
}

function normalizeFinalCallTime(value) {
  const normalized = String(value || "15:00").slice(0, 5);
  return FINAL_CALL_TIME_OPTIONS.includes(normalized)
    ? normalized
    : "15:00";
}

function getFinalCallTimeIndex(value) {
  const index = FINAL_CALL_TIME_OPTIONS.indexOf(
    normalizeFinalCallTime(value)
  );
  return index >= 0 ? index : 1;
}

function formatFinalCallTimeLabel(value, language = "en") {
  const normalized = normalizeFinalCallTime(value);

  if (normalized === "12:00") {
    return language === "es" ? "Mediodía" : "Noon";
  }

  if (normalized === "18:00") return "6 PM";
  return "3 PM";
}

function getFinalCallTimingSummary(job, language = "en") {
  const timeLabel = formatFinalCallTimeLabel(job?.finalCallTime, language);
  const timingLabel =
    job?.operatingWindow === "Night"
      ? translateAppText(language, "onWorkDate")
      : translateAppText(language, "dayBeforeWork");

  return `${translateAppText(language, "finalCallScheduled", {
    time: timeLabel,
  })} · ${timingLabel}`;
}

function getFinalCallScheduleDate(workDate, operatingWindow) {
  if (!workDate) return "";

  const date = new Date(`${workDate}T12:00:00`);

  if (String(operatingWindow || "Day").toLowerCase() !== "night") {
    date.setDate(date.getDate() - 1);
  }

  return date.toISOString().split("T")[0];
}

function zonedDateTimeToDate(dateString, timeString, timeZone) {
  if (!dateString) return null;

  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = normalizeFinalCallTime(timeString)
    .split(":")
    .map(Number);

  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    return null;
  }

  if (!timeZone) {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    let candidate = targetUtc;

    for (let iteration = 0; iteration < 3; iteration += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(candidate))
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, Number(part.value)])
      );

      const representedUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second || 0
      );
      const offset = representedUtc - candidate;
      candidate = targetUtc - offset;
    }

    return new Date(candidate);
  } catch {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }
}

function getDisplaySignal(signal, language = "en") {
  if (language !== "es") return signal;

  const labels = {
    GO: "GO / AVANZAR",
    WATCH: "WATCH / MONITOREAR",
    "NO GO": "NO GO / NO AVANZAR",
    "HIGH RISK": "ALTO RIESGO",
    FAVORABLE: "AVANZAR",
  };

  return labels[signal] || signal;
}

function translateStatusLabel(label, language = "en") {
  if (language !== "es") return label;

  if (label === "FINAL") return "FINAL";
  if (label === "PRELIM") return "PRELIMINAR";
  if (label === "WATCH") return "WATCH";
  if (label === "CALL MADE") return "DECISIÓN TOMADA";
  if (label === "LOW RISK") return "BAJO RIESGO";
  if (label === "MODERATE RISK") return "RIESGO MODERADO";
  if (label === "HIGH RISK") return "ALTO RIESGO";
  if (label === "IN WORK WINDOW") return "EN VENTANA";
  if (label?.startsWith("MADE — ")) {
    return `TOMADA — ${getDisplaySignal(label.replace("MADE — ", ""), language)}`;
  }

  return getDisplaySignal(label, language);
}

function translateQueueLabel(label, language = "en") {
  if (language !== "es") return label;
  if (label === "Final call ready") return "Decisión final lista";
  if (label === "Preliminary review") return "Revisión preliminar";
  return label;
}

function translateCallTypeDisplay(value, language = "en") {
  if (language !== "es") return value;
  if (value === "FINAL OPERATIONAL ASSESSMENT") return "EVALUACIÓN OPERATIVA FINAL";
  if (value === "PRELIMINARY REVIEW") return "REVISIÓN PRELIMINAR";
  if (value === "Final Weather Assessment") return "Evaluación final del clima";
  if (value === "Preliminary Review") return "Revisión preliminar";
  return value;
}

function getServiceWindowTitle(result, language = "en") {
  const backendTitle = String(result?.windowTitle || "").trim();

  if (!backendTitle) {
    return language === "es"
      ? "Mejor ventana de trabajo"
      : "Best Workable Window";
  }

  return translateWindowTitle(backendTitle, language);
}

function translateWindowTitle(value, language = "en") {
  if (language !== "es") return value;

  if (!value || value === "Best Workable Window") {
    return "Mejor ventana de trabajo";
  }

  if (value === "Longest application window found") {
    return "Ventana de trabajo más larga encontrada";
  }

  return value
    .replace("Longest application window found", "Ventana de trabajo más larga encontrada")
    .replace("Best Workable Window", "Mejor ventana de trabajo")
    .replace("Workable Window", "Ventana de trabajo");
}

function translateWorkableWindowLabel(value, language = "en") {
  if (language !== "es") return value;
  if (!value) return value;
  if (value === "Unavailable") return "No disponible";
  if (String(value).includes("No workable window")) {
    return "No se identificó una ventana confiable de trabajo.";
  }
  if (String(value).includes("Workable window unavailable")) {
    return "Ventana de trabajo no disponible.";
  }
  return value;
}

function translateForecastAgreement(value, language = "en") {
  const normalized = String(value || "").toLowerCase();

  if (language !== "es") {
    if (normalized.includes("severe disagreement")) return "Forecast signals are mixed.";
    return value;
  }

  if (!normalized || normalized === "unavailable") return "No disponible";
  if (normalized.includes("forecast signals are mixed") || normalized.includes("severe disagreement")) {
    return "Las señales del pronóstico son mixtas.";
  }
  if (normalized.includes("good") || normalized.includes("strong")) return "Buen acuerdo entre fuentes";
  if (normalized.includes("moderate")) return "Acuerdo moderado entre fuentes";
  if (normalized.includes("spread") || normalized.includes("conflict") || normalized.includes("disagreement")) return "Diferencia notable entre fuentes";
  return value;
}

function getDisplaySubText(result, language = "en") {
  if (language !== "es") return result?.subText || "";

  if (!result?.isFinal) {
    return "Esta es una revisión preliminar. La decisión final debe hacerse más cerca del trabajo.";
  }

  if (result.shortSignal === "GO" || result.shortSignal === "FAVORABLE") {
    return "Las condiciones apoyan avanzar según lo planeado.";
  }

  if (result.shortSignal === "WATCH") {
    return "Las condiciones requieren monitoreo antes de comprometer cuadrilla y horario.";
  }

  return "No se recomienda avanzar con la ventana de trabajo actual.";
}

function getDisplayReason(result, language = "en") {
  const backendReason = String(result?.reason || "").trim();

  if (backendReason) {
    return backendReason;
  }

  return language === "es"
    ? "Razón de evaluación no disponible."
    : "Assessment reason unavailable.";
}

function buildDataBackedMainReason(result, language = "en") {
  if (!result) return "";

  const signal = String(result.shortSignal || "").toUpperCase();
  const rainDisplay = getMainReasonRainDisplay(result);
  const peakDisplay = getMainReasonPeakRainDisplay(result);
  const tempDisplay = getMainReasonTemperatureDisplay(result);
  const serviceLabel = result.workType || "this service";
  const hasRainData = Boolean(rainDisplay);
  const hasPeakData = Boolean(peakDisplay);

  if (!hasRainData && !hasPeakData && !tempDisplay) return "";

  if (language === "es") {
    if (signal === "GO" || signal === "FAVORABLE") {
      const parts = [];
      if (hasPeakData && hasRainData) {
        parts.push(`La señal de lluvia alcanza ${peakDisplay}, pero la acumulación prevista durante la ventana de trabajo es ${rainDisplay}.`);
      } else if (hasRainData) {
        parts.push(`La acumulación prevista durante la ventana de trabajo es ${rainDisplay}.`);
      } else if (hasPeakData) {
        parts.push(`La señal de lluvia alcanza ${peakDisplay}, pero las condiciones siguen dentro del riesgo operativo aceptable.`);
      }
      if (tempDisplay) parts.push(`Temperaturas de trabajo: ${tempDisplay}.`);
      return parts.join(" ");
    }

    if (signal === "WATCH") {
      const parts = [];
      if (hasPeakData) parts.push(`La señal de lluvia alcanza ${peakDisplay}.`);
      if (hasRainData) parts.push(`La acumulación prevista durante la ventana de trabajo es ${rainDisplay}.`);
      parts.push("Siga monitoreando antes de comprometer cuadrilla y horario.");
      return parts.join(" ");
    }

    if (signal === "NO GO" || signal === "HIGH RISK") {
      if (hasRainData) {
        return `La acumulación prevista durante la ventana de trabajo llega a ${rainDisplay}, creando demasiado riesgo de producción y calidad para ${serviceLabel}.`;
      }
      return `La señal de lluvia alcanza ${peakDisplay}, creando demasiado riesgo de producción y calidad para ${serviceLabel}.`;
    }

    return "";
  }

  if (signal === "GO" || signal === "FAVORABLE") {
    const parts = [];
    if (hasPeakData && hasRainData) {
      parts.push(`Rain signal peaks at ${peakDisplay}, but forecast accumulation during the work window is ${rainDisplay}.`);
    } else if (hasRainData) {
      parts.push(`Forecast accumulation during the work window is ${rainDisplay}.`);
    } else if (hasPeakData) {
      parts.push(`Rain signal peaks at ${peakDisplay}, but conditions remain within acceptable operational risk.`);
    }
    if (tempDisplay) parts.push(`Temps remain workable at ${tempDisplay}.`);
    return parts.join(" ");
  }

  if (signal === "WATCH") {
    const parts = [];
    if (hasPeakData) parts.push(`Rain signal reaches ${peakDisplay}.`);
    if (hasRainData) parts.push(`Forecast accumulation during the work window is ${rainDisplay}.`);
    parts.push("Continue monitoring before committing crews and schedule.");
    return parts.join(" ");
  }

  if (signal === "NO GO" || signal === "HIGH RISK") {
    if (hasRainData) {
      return `Forecast accumulation during the work window reaches ${rainDisplay}, creating too much production and quality risk for ${serviceLabel}.`;
    }
    return `Rain signal reaches ${peakDisplay}, creating too much production and quality risk for ${serviceLabel}.`;
  }

  return "";
}

function getMainReasonPeakRainDisplay(result) {
  const nwsDisplay = result?.nwsPeakRainProbabilityDisplay;

  if (nwsDisplay && nwsDisplay !== "Unavailable") {
    return nwsDisplay;
  }

  const peak = Number(result?.peakRainProbability);

  if (Number.isFinite(peak)) {
    return `${Math.round(peak)}%`;
  }

  return "";
}

function getMainReasonRainDisplay(result) {
  const amount = Number(result?.totalPrecipitationInches);

  if (!Number.isFinite(amount)) return "";

  return formatInchesForDisplay(amount);
}

function getMainReasonTemperatureDisplay(result) {
  const tempRange = result?.workWindowTempRange;

  if (!tempRange || tempRange === "Unavailable") return "";

  return tempRange;
}

function formatInchesForDisplay(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) return "";
  if (amount > 0 && amount < 0.01) return `<0.01"`;

  return `${amount.toFixed(2)}"`;
}

function formatRainfallAssessmentDisplay(result) {
  const hasMinimum =
    result?.rainfallTotalMin !== null &&
    result?.rainfallTotalMin !== undefined &&
    result?.rainfallTotalMin !== "";
  const hasMaximum =
    result?.rainfallTotalMax !== null &&
    result?.rainfallTotalMax !== undefined &&
    result?.rainfallTotalMax !== "";
  const minimum = Number(result?.rainfallTotalMin);
  const maximum = Number(result?.rainfallTotalMax);

  if (hasMinimum && hasMaximum && Number.isFinite(minimum) && Number.isFinite(maximum)) {
    if (Math.abs(maximum - minimum) >= 0.01) {
      const source = result?.rainfallAmountSource;
      const sourceNote = source && source !== "Unavailable"
        ? ` (${source} higher)`
        : "";
      return `${formatInchesForDisplay(minimum)}–${formatInchesForDisplay(maximum)}${sourceNote}`;
    }

    return formatInchesForDisplay(maximum) || "Unavailable";
  }

  return (
    formatInchesForDisplay(
      result?.rainfallAssessedPeriod ?? result?.totalPrecipitationInches
    ) || "Unavailable"
  );
}

function formatWorkWindowRequirements(result, language = "en") {
  const requirements = result?.workWindowRequirements || {};
  const parts = [];
  const rainThreshold = Number(
    requirements.company_rain_probability_threshold ?? 30
  );
  const minimumHours = Number(requirements.minimum_continuous_hours ?? 2);

  parts.push(
    language === "es"
      ? `lluvia ≤ ${rainThreshold}%`
      : `rain probability ≤ ${rainThreshold}%`
  );
  parts.push(
    language === "es"
      ? `${minimumHours}+ horas continuas`
      : `${minimumHours}+ continuous hours`
  );

  if (requirements.minimum_temperature_f !== undefined) {
    parts.push(
      language === "es"
        ? `temperatura ≥ ${requirements.minimum_temperature_f}°F`
        : `temperature ≥ ${requirements.minimum_temperature_f}°F`
    );
  }

  if (requirements.requires_rising_temperature_below_f !== undefined) {
    parts.push(
      language === "es"
        ? `en aumento por debajo de ${requirements.requires_rising_temperature_below_f}°F`
        : `rising below ${requirements.requires_rising_temperature_below_f}°F`
    );
  }

  if (requirements.humidity_exclusive_max_percent !== undefined) {
    parts.push(
      language === "es"
        ? `humedad < ${requirements.humidity_exclusive_max_percent}%`
        : `humidity < ${requirements.humidity_exclusive_max_percent}%`
    );
  }

  if (requirements.sustained_wind_exclusive_max_mph !== undefined) {
    parts.push(
      language === "es"
        ? `viento sostenido < ${requirements.sustained_wind_exclusive_max_mph} mph`
        : `sustained wind < ${requirements.sustained_wind_exclusive_max_mph} mph`
    );
  }

  return parts.join(" · ");
}

function getAssessmentRiskLevelLabel(result, language = "en") {
  const backendRiskLevel = String(result?.riskLevel || "").toLowerCase();
  const score = Number(result?.score ?? result?.rawScore ?? 0);

  const normalizedRiskLevel = ["low", "moderate", "high"].includes(backendRiskLevel)
    ? backendRiskLevel
    : score <= 20
    ? "low"
    : score <= 40
    ? "moderate"
    : "high";

  if (language === "es") {
    if (normalizedRiskLevel === "low") return "Riesgo bajo";
    if (normalizedRiskLevel === "moderate") return "Riesgo moderado";
    return "Riesgo alto";
  }

  if (normalizedRiskLevel === "low") return "Low Risk";
  if (normalizedRiskLevel === "moderate") return "Moderate Risk";
  return "High Risk";
}

function getCategoryRiskLabel(points, language = "en") {
  const value = Number(points || 0);

  if (language === "es") {
    if (value <= 4) return "Bajo";
    if (value <= 14) return "Medio";
    return "Alto";
  }

  if (value <= 4) return "Low";
  if (value <= 14) return "Moderate";
  return "High";
}

function getCategoryRiskSummary(result, language = "en") {
  const production = result?.categoryPoints?.production;
  const quality = result?.categoryPoints?.quality;
  const safety = result?.categoryPoints?.safety;

  if (production === undefined || quality === undefined || safety === undefined) {
    return "";
  }

  if (language === "es") {
    return `Producción: ${getCategoryRiskLabel(production, language)} · Calidad: ${getCategoryRiskLabel(quality, language)} · Seguridad: ${getCategoryRiskLabel(safety, language)}`;
  }

  return `Production: ${getCategoryRiskLabel(production, language)} · Quality: ${getCategoryRiskLabel(quality, language)} · Safety: ${getCategoryRiskLabel(safety, language)}`;
}

function isPavingService(serviceName) {
  return String(serviceName || "").trim().toLowerCase() === "paving";
}

function getBaseExposedFromSurfaceCondition(surfaceCondition) {
  return surfaceCondition === "Subgrade currently exposed" ? "Yes" : "No";
}

function getSurfaceConditionFromBaseExposed(baseExposed) {
  return baseExposed === "Yes" ? "Subgrade currently exposed" : DEFAULT_PAVING_SETUP;
}

function normalizeSurfaceConditionForStorage(surfaceCondition) {
  if (surfaceCondition === "Milled") return "milled_surface";
  if (surfaceCondition === "Subgrade currently exposed") return "exposed_subgrade";
  if (surfaceCondition === DEFAULT_PAVING_SETUP) return "subgrade_same_day";
  return "overlay";
}

function getSurfaceConditionFromBackendRow(row) {
  const storedCondition = String(row?.surface_condition || "").toLowerCase();

  if (storedCondition === "milled_surface") return "Milled";
  if (storedCondition === "subgrade_same_day") return DEFAULT_PAVING_SETUP;
  if (storedCondition === "exposed_subgrade" || storedCondition === "exposed_base") {
    return "Subgrade currently exposed";
  }

  return getSurfaceConditionFromBaseExposed(row?.base_exposed ? "Yes" : "No");
}

function getBackendSurfaceCondition(form) {
  const storedCondition = normalizeSurfaceConditionForStorage(form?.surfaceCondition);

  if (storedCondition === "milled_surface") return "milled_surface";
  if (storedCondition === "exposed_subgrade") return "exposed_base";
  return "existing_surface";
}

const STATE_NAME_BY_ABBR = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  IA: "Iowa",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  MA: "Massachusetts",
  MD: "Maryland",
  ME: "Maine",
  MI: "Michigan",
  MN: "Minnesota",
  MO: "Missouri",
  MS: "Mississippi",
  MT: "Montana",
  NC: "North Carolina",
  ND: "North Dakota",
  NE: "Nebraska",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NV: "Nevada",
  NY: "New York",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VA: "Virginia",
  VT: "Vermont",
  WA: "Washington",
  WI: "Wisconsin",
  WV: "West Virginia",
  WY: "Wyoming",
};

// =====================================================
// SECTION 3 — JOB + RESULT HELPERS
// Converts jobs/results between UI state and stored result objects.
// =====================================================

function jobToForm(job) {
  return {
    projectName: job.projectName,
    locationQuery: job.selectedLocation?.formattedAddress || job.locationQuery || "",
    selectedLocation: job.selectedLocation || null,
    city: job.city,
    state: job.state,
    workDate: job.workDate,
    workType: job.workType,
    operatingWindow: job.operatingWindow,
    surfaceCondition: isPavingService(job.workType)
      ? job.surfaceCondition || getSurfaceConditionFromBaseExposed(job.baseExposed)
      : "Subgrade exposed & paved same day",
    baseExposed: isPavingService(job.workType)
      ? job.baseExposed || getBaseExposedFromSurfaceCondition(job.surfaceCondition)
      : "No",
multiDay: "No",
finalCallTime: normalizeFinalCallTime(job.finalCallTime),
finalCallDueAt: job.finalCallDueAt || "",
timeZone: job.timeZone || "",
saveToQueue: false,
shadowDecision: "",
  };
}

function makeStoredResult(result) {
  return {
    savedJobId: result.savedJobId || null,
    savedAssessmentId: result.savedAssessmentId || null,
    checkedAt: result.checkedAt || new Date().toISOString(),
    heading: result.heading,
    shortSignal: result.shortSignal,
    icon: result.icon,
    score: result.score,
    rawScore: result.rawScore,
    subText: result.subText,
    scoreText: result.scoreText,
    window: result.window,
    windowTitle: result.windowTitle,
    reason: result.reason,
    reasonKey: result.reasonKey,
    scoringVersion: result.scoringVersion || "",
    logicRelease: result.logicRelease || "",
    weatherCallCaution: result.weatherCallCaution || "balanced",
    riskLevel: result.riskLevel || "",
    riskLevelLabel: result.riskLevelLabel || "",
    scoreBreakdown: Array.isArray(result.scoreBreakdown) ? result.scoreBreakdown : [],
    leadingFactor: result.leadingFactor || null,
    riskFactors: result.riskFactors,
    categoryPoints: result.categoryPoints,

    averageRainProbability: result.averageRainProbability,
    peakRainProbability: result.peakRainProbability,
    totalPrecipitationInches: result.totalPrecipitationInches,
    rainfallAssessedPeriod: result.rainfallAssessedPeriod,
    rainfallSelectedWindow: result.rainfallSelectedWindow,
    rainfallTotalMin: result.rainfallTotalMin,
    rainfallTotalMax: result.rainfallTotalMax,
    rainfallAmountSource: result.rainfallAmountSource,
    rainfallAmountDisagreement: result.rainfallAmountDisagreement,
    selectedWindowTemperatureRange: result.selectedWindowTemperatureRange,
    assessedPeriodTemperatureRange: result.assessedPeriodTemperatureRange,
    hasReliableWindow: result.hasReliableWindow === true,
    workWindowTempRange: result.workWindowTempRange,
    workWindowRequirements: result.workWindowRequirements || {},
    workWindowReason: result.workWindowReason || "",
    alternativeWorkWindows: Array.isArray(result.alternativeWorkWindows)
      ? result.alternativeWorkWindows
      : [],

    bestLowPrecipHours: result.bestLowPrecipHours,
    bestWindowLabel: result.bestWindowLabel,
    bestWindowAverageRain: result.bestWindowAverageRain,
    bestWindowTotalPrecip: result.bestWindowTotalPrecip,

    locationLabel: result.locationLabel,
    sources: result.sources,

    riskBarText: result.riskBarText,
    markerLeft: result.markerLeft,

isFinal: result.isFinal === true,
autoFinalCallPrepared: result.autoFinalCallPrepared === true,
finalCallSource:
  result.finalCallSource ||
  (result.autoFinalCallPrepared === true
    ? "scheduler"
    : result.isFinal === true
    ? "manual"
    : "preliminary"),
timingText: result.timingText,
finalCallTime: normalizeFinalCallTime(result.finalCallTime),
finalCallDueAt: result.finalCallDueAt || "",
timeZone: result.timeZone || "",
// Kept for backward-compatible stored results while old backend wording is retired.
finalCallWindowHours: result.finalCallWindowHours || "24",
callTypeLabel: result.callTypeLabel,
callTypeDisplay: result.callTypeDisplay,

    whyPoints: result.whyPoints,

    nwsAvailable: result.nwsAvailable,
    nwsPeakRainProbability: result.nwsPeakRainProbability,
    nwsPeakRainProbabilityDisplay: result.nwsPeakRainProbabilityDisplay,
    nwsPeakRainProbabilityHour: result.nwsPeakRainProbabilityHour,
    nwsPeakRainProbabilityHourDisplay: result.nwsPeakRainProbabilityHourDisplay,
    nwsSummary: result.nwsSummary,
    nwsSignal: result.nwsSignal,
    openMeteoSignal: result.openMeteoSignal,

    forecastAgreementLabel: result.forecastAgreementLabel,
    forecastAgreementShortLabel: result.forecastAgreementShortLabel,
    sourceSpreadLevel: result.sourceSpreadLevel,
    sourceSpreadPoints: result.sourceSpreadPoints,
    higherRiskSource: result.higherRiskSource,

    operationalNote: result.operationalNote,

    communications: result.communications || {},

    openMeteoSource: result.openMeteoSource,
    nwsSource: result.nwsSource,
    combinedSourceProfile: result.combinedSourceProfile,

    surfaceCondition: result.surfaceCondition,
    baseExposed: result.baseExposed,
    workType: result.workType,
    operatingWindow: result.operatingWindow || "Day",
  };
}


function getManualAssessmentForStorage(assessment) {
  if (!assessment) return assessment;

  return {
    ...assessment,
    autoFinalCallPrepared: false,
    finalCallSource: assessment.isFinal === true ? "manual" : "preliminary",
  };
}

// =====================================================
// SECTION 4 — DATE + FORMAT HELPERS
// Handles date labels, time labels, state names, and rounding.
// =====================================================

function getTomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().split("T")[0];
}

function getStateName(stateAbbreviation) {
  return STATE_NAME_BY_ABBR[stateAbbreviation] || stateAbbreviation;
}

function formatFullDateLabel(dateString, language = "en") {
  if (!dateString) return translateAppText(language, "chooseDate");

  const inputDate = new Date(`${dateString}T12:00:00`);

  return inputDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateLabel(dateString, language = "en") {
  if (!dateString) return translateAppText(language, "noDate");

  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const inputDate = new Date(`${dateString}T12:00:00`);

  if (inputDate.toDateString() === today.toDateString()) {
    return translateAppText(language, "today");
  }

  if (inputDate.toDateString() === tomorrow.toDateString()) {
    return translateAppText(language, "tomorrow");
  }

  return inputDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function isSameWorkDate(dateString, compareDate) {
  if (!dateString || !compareDate) return false;

  const inputDate = new Date(`${dateString}T12:00:00`);
  const targetDate = new Date(compareDate);

  return inputDate.toDateString() === targetDate.toDateString();
}

function isTomorrowWorkDate(dateString) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return isSameWorkDate(dateString, tomorrow);
}

function formatCurrentTime() {
  return new Date().toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCheckedAtFull(dateString) {
  const checkedDate = dateString ? new Date(dateString) : new Date();

  return checkedDate.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatHour(hour) {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function formatNwsPeakRainSignal(result, language = "en") {
  const value = result?.nwsPeakRainProbabilityDisplay;
  if (!value || value === "Unavailable") return "Unavailable";

  const hourDisplay = result?.nwsPeakRainProbabilityHourDisplay;

  if (language === "es") {
    return hourDisplay
      ? `NWS alcanza un máximo de ${value} alrededor de ${hourDisplay}`
      : `NWS alcanza un máximo de ${value}`;
  }

  return hourDisplay
    ? `NWS peaks at ${value} around ${hourDisplay}`
    : `NWS peaks at ${value}`;
}

function roundToTwo(value) {
  return Math.round(value * 100) / 100;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Weather source timed out. Please try again.", {
        cause: error,
      });
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// =====================================================
// SECTION 5 — WEATHER CHECK WORKFLOW
// Coordinates location, weather source calls, and assessment building.
// =====================================================

async function performAssessment(jobData) {
  const location = jobData.selectedLocation
    ? {
        name: jobData.selectedLocation.displayName,
        admin1: jobData.selectedLocation.state,
        latitude: jobData.selectedLocation.latitude,
        longitude: jobData.selectedLocation.longitude,
      }
    : await getCoordinates(jobData.city, jobData.state);

  let openMeteoWeather;
let nwsWeather;

  try {
    openMeteoWeather = await getOpenMeteoForecast(
  location,
  jobData.workDate,
  jobData.operatingWindow,
  jobData.workType
);
  } catch (err) {
    openMeteoWeather = {
      available: false,
      error: err.message || "Open-Meteo unavailable",
    };
  }

  try {
    nwsWeather = await getNwsForecast(location, jobData);
  } catch (err) {
    nwsWeather = {
      available: false,
      error: err.message || "NWS unavailable",
      peakRainProbability: null,
      averageRainProbability: null,
      summary: "NWS unavailable",
      shortForecasts: [],
    };
  }

  if (!openMeteoWeather?.available && !nwsWeather?.available) {
    throw new Error(
      "Weather sources temporarily unavailable. Please try again."
    );
  }

  return await buildAssessment(
    openMeteoWeather,
    jobData,
    location,
    nwsWeather
  );
}

function getNwsSummaryText(nwsWeather) {
  if (!nwsWeather?.available) {
    return `NWS summary unavailable: ${
      nwsWeather?.error || "No data returned"
    }`;
  }

  const peak =
    typeof nwsWeather.peakRainProbability === "number"
      ? `${nwsWeather.peakRainProbability}% peak rain chance`
      : "rain chance unavailable";

  return `NWS: ${peak}. ${nwsWeather.summary || "Summary unavailable"}`;
}
// =====================================================
// SECTION 6 — WEATHER API FUNCTIONS
// Geoapify location search, Open-Meteo forecast, and NWS forecast.
// =====================================================

async function searchGeoapifyLocations(searchText) {
  const apiKey = import.meta.env.VITE_GEOAPIFY_API_KEY;

  if (!apiKey) {
    throw new Error("Geoapify API key missing.");
  }

  const params = new URLSearchParams({
    text: searchText,
    filter: "countrycode:us",
    format: "json",
    limit: "6",
    apiKey,
  });

  const response = await fetchWithTimeout(
    `https://api.geoapify.com/v1/geocode/autocomplete?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error("Location search failed.");
  }

  const data = await response.json();
  const results = data.results || [];

  return results.map((item) => {
    const city = item.city || item.town || item.village || item.county || "";
    const state = item.state_code || item.state || "";

    return {
      displayName:
        item.name ||
        item.address_line1 ||
        item.formatted ||
        `${city}, ${state}`,
      formattedAddress:
        item.formatted ||
        [item.address_line1, item.address_line2].filter(Boolean).join(", "),
      city,
      state,
      latitude: item.lat,
      longitude: item.lon,
    };
  });
}

async function getCoordinates(city, state) {
  const cityClean = city.trim();
  const stateClean = state.trim().toUpperCase();
  const stateFullName = getStateName(stateClean);

  const queriesToTry = [
    cityClean,
    `${cityClean} ${stateFullName}`,
    `${cityClean} ${stateClean}`,
  ];

  for (const queryText of queriesToTry) {
    const query = encodeURIComponent(queryText);
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=20&language=en&format=json&country_code=US`;

    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      throw new Error("Could not reach geocoding service.");
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      continue;
    }

    const usResults = data.results.filter(
      (place) => place.country_code === "US"
    );

    const stateMatch = usResults.find((place) => {
      const admin1 = (place.admin1 || "").toUpperCase();
      const admin1Code = (place.admin1_code || "").toUpperCase();

      return (
        admin1 === stateFullName.toUpperCase() ||
        admin1Code.endsWith(`-${stateClean}`) ||
        admin1Code === stateClean
      );
    });

    const fallbackMatch = usResults[0];
    const match = stateMatch || fallbackMatch;

    if (match) {
      return {
        name: match.name,
        admin1: match.admin1,
        latitude: match.latitude,
        longitude: match.longitude,
      };
    }
  }

  throw new Error(
    "Location not found. Try spelling out the city and use a 2-letter state code like NC."
  );
}

async function getOpenMeteoForecast(
  location,
  workDate,
  operatingWindow = "Day",
  workType = "Paving"
) {
  // Release 1 Step 6: Day assessments use only the selected work date.
  // Night assessments use the selected evening plus the following morning.
  // Concrete no longer fetches a second day here because the overnight-low
  // rule is inactive until the operational-cycle model is consolidated.
  const needsFollowingDay = operatingWindow === "Night";

  const endDate = needsFollowingDay
    ? getNextDateString(workDate)
    : workDate;

  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    hourly:
      "precipitation_probability,precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "auto",
    start_date: workDate,
    end_date: endDate,
  });

  const url =
    `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error("Could not reach weather service.");
  }

  const data = await response.json();
  data.available = true;

  if (!data.hourly || !data.hourly.time) {
    throw new Error("No hourly forecast data returned.");
  }

  return data;
}

async function getNwsForecast(location, form) {
  const pointUrl = `https://api.weather.gov/points/${Number(
    location.latitude
  ).toFixed(4)},${Number(location.longitude).toFixed(4)}`;

  const pointResponse = await fetchWithTimeout(pointUrl, {
    headers: {
      Accept: "application/geo+json",
    },
  });

  if (!pointResponse.ok) {
    throw new Error("NWS point lookup failed.");
  }

  const pointData = await pointResponse.json();
  const hourlyUrl = pointData.properties?.forecastHourly;
  const gridUrl = pointData.properties?.forecastGridData;

  if (!hourlyUrl) {
    throw new Error("NWS hourly forecast link missing.");
  }

  const hourlyResponse = await fetchWithTimeout(hourlyUrl, {
    headers: {
      Accept: "application/geo+json",
    },
  });

  if (!hourlyResponse.ok) {
    throw new Error("NWS hourly forecast failed.");
  }

  const hourlyData = await hourlyResponse.json();
  const periods = hourlyData.properties?.periods || [];

  let gridData = null;
  if (gridUrl) {
    try {
      const gridResponse = await fetchWithTimeout(gridUrl, {
        headers: {
          Accept: "application/geo+json",
        },
      });

      if (gridResponse.ok) {
        gridData = await gridResponse.json();
      }
    } catch {
      // NWS hourly probability remains usable when grid QPF is unavailable.
    }
  }

  const nwsQpf = buildNwsHourlyQpf(periods, gridData);

  const workPeriods = getNwsWorkPeriods(periods, form);

  if (workPeriods.length === 0) {
  throw new Error(
    "NWS hourly forecast does not yet cover the selected work date."
  );
}

const usablePeriods = workPeriods;

  const rainValues = usablePeriods
    .map((period) => period.probabilityOfPrecipitation?.value)
    .filter((value) => typeof value === "number");

  const peakRainProbability =
    rainValues.length > 0 ? Math.max(...rainValues) : null;

  const peakRainPeriod =
    typeof peakRainProbability === "number"
      ? usablePeriods.find(
          (period) =>
            period.probabilityOfPrecipitation?.value === peakRainProbability
        )
      : null;

  const peakRainProbabilityHour = peakRainPeriod?.startTime
    ? Number(peakRainPeriod.startTime.slice(11, 13))
    : null;

  const peakRainProbabilityHourDisplay =
    typeof peakRainProbabilityHour === "number" &&
    Number.isFinite(peakRainProbabilityHour)
      ? formatHour(peakRainProbabilityHour)
      : "";

  const averageRainProbability =
    rainValues.length > 0
      ? Math.round(
          rainValues.reduce((sum, value) => sum + value, 0) / rainValues.length
        )
      : null;

  const shortForecasts = [
    ...new Set(
      usablePeriods
        .map((period) => period.shortForecast)
        .filter(Boolean)
        .slice(0, 8)
    ),
  ];

  const summary =
    shortForecasts.length > 0
      ? shortForecasts.join(" / ")
      : "NWS forecast summary unavailable";

  return {
    available: true,
    error: "",
    peakRainProbability,
    peakRainProbabilityHour,
    peakRainProbabilityHourDisplay,
    averageRainProbability,
    summary,
    shortForecasts,
    workPeriods,
    allPeriods: periods,
    qpfAvailable: nwsQpf.available,
    qpfHourlyByTime: nwsQpf.hourlyByTime,
    qpfSourceUpdatedAt: gridData?.properties?.updateTime || null,
    sourceLabel: nwsQpf.available
      ? "NWS hourly forecast and grid QPF"
      : "NWS hourly forecast",
  };
}

function buildNwsHourlyQpf(periods, gridData) {
  const qpf = gridData?.properties?.quantitativePrecipitation;
  const values = Array.isArray(qpf?.values) ? qpf.values : [];

  if (!Array.isArray(periods) || periods.length === 0 || values.length === 0) {
    return { available: false, hourlyByTime: {} };
  }

  const hourlyByTime = {};
  let usableIntervalCount = 0;

  values.forEach((entry) => {
    const parsed = parseNwsValidTime(entry?.validTime);
    if (entry?.value === null || entry?.value === undefined) return;
    const millimeters = Number(entry?.value);

    if (!parsed || !Number.isFinite(millimeters) || millimeters < 0) return;

    const coveredPeriods = periods.filter((period) => {
      const timestamp = new Date(period?.startTime || "").getTime();
      return Number.isFinite(timestamp) && timestamp >= parsed.startMs && timestamp < parsed.endMs;
    });

    if (coveredPeriods.length === 0) return;

    usableIntervalCount += 1;
    const amountInches = millimeters / 25.4;
    const weights = coveredPeriods.map((period) => {
      const probability = Number(period?.probabilityOfPrecipitation?.value);
      return Number.isFinite(probability) && probability > 0 ? probability : 0;
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);

    coveredPeriods.forEach((period, index) => {
      const key = String(period.startTime || "").slice(0, 13);
      const share = totalWeight > 0
        ? weights[index] / totalWeight
        : 1 / coveredPeriods.length;
      const allocated = amountInches * share;

      hourlyByTime[key] = roundToSix((hourlyByTime[key] || 0) + allocated);
    });
  });

  return {
    available: usableIntervalCount > 0,
    hourlyByTime,
  };
}

function parseNwsValidTime(validTime) {
  const [startText, durationText] = String(validTime || "").split("/");
  const startMs = new Date(startText || "").getTime();
  const durationMs = parseIsoDurationMilliseconds(durationText);

  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  return { startMs, endMs: startMs + durationMs };
}

function parseIsoDurationMilliseconds(duration) {
  const match = String(duration || "").match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );

  if (!match) return null;

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);

  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function roundToSix(value) {
  return Math.round(Number(value || 0) * 1000000) / 1000000;
}

function getNwsWorkPeriods(periods, form) {
  if (!Array.isArray(periods)) return [];

  const workDate = form.workDate;
  const nextDate = getNextDateString(workDate);

  return periods.filter((period) => {
    if (!period.startTime) return false;

    const datePart = period.startTime.slice(0, 10);
    const hour = Number(period.startTime.slice(11, 13));

    if (form.operatingWindow === "Night") {
      const eveningOfWorkDate = datePart === workDate && hour >= 19;
      const morningAfterWorkDate = datePart === nextDate && hour <= 6;

      return eveningOfWorkDate || morningAfterWorkDate;
    }

    return datePart === workDate && hour >= 6 && hour <= 19;
  });
}

function getNextDateString(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString().split("T")[0];
}

// =====================================================
// SECTION 7 — ASSESSMENT TIMING + DASHBOARD STATUS
// Determines preliminary/final timing and saved job badge status.
// =====================================================

function getAssessmentTiming(form, timeZoneOverride = "") {
  const now = new Date();
  const finalCallTime = normalizeFinalCallTime(form?.finalCallTime);
  const timeZone =
    timeZoneOverride || form?.timeZone || form?.timezone || "";

  const finalCallScheduleDate = getFinalCallScheduleDate(
    form?.workDate,
    form?.operatingWindow
  );

  const storedDueAt = form?.finalCallDueAt
    ? new Date(form.finalCallDueAt)
    : null;
  const calculatedDueAt = zonedDateTimeToDate(
    finalCallScheduleDate,
    finalCallTime,
    timeZone
  );
  const finalCallDueAt =
    storedDueAt && !Number.isNaN(storedDueAt.getTime())
      ? storedDueAt
      : calculatedDueAt;

  const { start: workStart } = getWorkWindowBounds(form);
  const hoursUntilStart = workStart
    ? (workStart.getTime() - now.getTime()) / 36e5
    : Number.POSITIVE_INFINITY;
  const hoursUntilFinal = finalCallDueAt
    ? (finalCallDueAt.getTime() - now.getTime()) / 36e5
    : Number.POSITIVE_INFINITY;

  const isFinal = Boolean(
    finalCallDueAt && now.getTime() >= finalCallDueAt.getTime()
  );

  let timingText;

  if (hoursUntilStart < 0) {
    timingText = "Work date/time has passed";
  } else if (isFinal) {
    timingText = `Final call time reached (${formatFinalCallTimeLabel(
      finalCallTime
    )})`;
  } else {
    timingText = `Final call scheduled for ${formatFinalCallTimeLabel(
      finalCallTime
    )}`;
  }

  return {
    isFinal,
    hoursUntilStart,
    hoursUntilFinal,
    // Retained only for compatibility with the current scoring RPC response.
    finalCallWindowHours: 24,
    finalCallTime,
    finalCallDueAt: finalCallDueAt?.toISOString?.() || "",
    timeZone,
    timingText,
    queueLabel: isFinal ? "Final call ready" : "Preliminary review",
  };
}

function getWorkWindowBounds(job) {
  if (!job?.workDate) {
    return { start: null, end: null };
  }

  const start = new Date(`${job.workDate}T00:00:00`);
  const end = new Date(`${job.workDate}T00:00:00`);

  if (job.operatingWindow === "Night") {
    start.setHours(19, 30, 0, 0);
    end.setDate(end.getDate() + 1);
    end.setHours(6, 0, 0, 0);
  } else {
    start.setHours(6, 30, 0, 0);
    end.setHours(19, 0, 0, 0);
  }

  return { start, end };
}

function hasWorkWindowStarted(job) {
  const { start } = getWorkWindowBounds(job);
  if (!start) return false;

  return new Date().getTime() >= start.getTime();
}

function isInsideWorkWindow(job) {
  const { start, end } = getWorkWindowBounds(job);
  if (!start || !end) return false;

  const now = new Date().getTime();
  return now >= start.getTime() && now <= end.getTime();
}

function hasWorkDatePassed(job) {
  const { end } = getWorkWindowBounds(job);
  if (!end) return false;

  return new Date().getTime() > end.getTime();
}

function getJobSortTime(job) {
  return new Date(
    job.callMadeAt ||
      job.lastCheckedAt ||
      job.updatedAt ||
      job.createdAt ||
      job.workDate ||
      0
  ).getTime();
}

function getWorkDateSortTime(job) {
  return new Date(`${job.workDate}T12:00:00`).getTime();
}

function sortNewestJobFirst(a, b) {
  return getJobSortTime(b) - getJobSortTime(a);
}

function sortNewestCallFirst(a, b) {
  return getJobSortTime(b) - getJobSortTime(a);
}

function sortByWorkDateSoonestFirst(a, b) {
  const aDate = getWorkDateSortTime(a);
  const bDate = getWorkDateSortTime(b);

  if (aDate !== bDate) {
    return aDate - bDate;
  }

  return getJobSortTime(b) - getJobSortTime(a);
}

function sortFinalCallsFirst(a, b) {
  const aDate = new Date(`${a.workDate}T12:00:00`).getTime();
  const bDate = new Date(`${b.workDate}T12:00:00`).getTime();

  if (aDate !== bDate) {
    return aDate - bDate;
  }

  return getJobSortTime(b) - getJobSortTime(a);
}

function isSavedJobAutoPrepared(job) {
  return (
    job?.autoFinalCallStatus === "prepared" ||
    job?.lastResult?.autoFinalCallPrepared === true
  );
}

function isSavedJobFinalResult(job) {
  return Boolean(
    job?.lastResult &&
      (job.status === "call_made" ||
        job.lastResult?.isFinal === true ||
        job.autoFinalCallStatus === "prepared")
  );
}

function getSavedJobFinalResultTime(job) {
  return (
    job?.autoFinalCallCompletedAt ||
    job?.callMadeAt ||
    job?.lastCheckedAt ||
    job?.lastResult?.checkedAt ||
    job?.updatedAt ||
    job?.createdAt ||
    new Date().toISOString()
  );
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRetryableWeatherCheckError(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return (
    message.includes("load failed") ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("temporarily unavailable") ||
    message.includes("timeout")
  );
}

function getFriendlyWeatherCheckError(error) {
  const message = String(error?.message || error || "");

  if (isRetryableWeatherCheckError(error)) {
    return "Weather check did not finish. Tap Check again.";
  }

  if (message.toLowerCase().includes("backend scoring failed")) {
    return "Weather scoring did not finish. Tap Check again.";
  }

  if (message.toLowerCase().includes("assessment history save failed")) {
    return "Weather check completed, but history could not be saved. Refresh and try again.";
  }

  return message || "Weather check did not finish. Tap Check again.";
}

async function performAssessmentWithRetry(jobData) {
  try {
    return await performAssessment(jobData);
  } catch (error) {
    if (!isRetryableWeatherCheckError(error)) {
      throw error;
    }

    await sleep(650);
    return await performAssessment(jobData);
  }
}

function getJobStatus(job) {
  const timing = getAssessmentTiming(job);
  const hasFinalResult = isSavedJobFinalResult(job);
  const signal = job.lastResult?.shortSignal || "FINAL";

  if (!hasFinalResult && hasWorkWindowStarted(job)) {
    return {
      label: "IN WORK WINDOW",
      color: "#64748b",
      bg: "#f8fafc",
      border: "#cbd5e1",
      text: "#334155",
      cardBg: "linear-gradient(90deg, #f8fafc 0%, #ffffff 45%)",
    };
  }

  if (hasFinalResult) {
    if (signal === "GO" || signal === "FAVORABLE") {
      return {
        label: `FINAL — ${signal}`,
        color: "#16a34a",
        bg: "#ecfdf5",
        border: "#bbf7d0",
        text: "#166534",
        cardBg: "linear-gradient(90deg, #f0fdf4 0%, #ffffff 45%)",
      };
    }

    if (signal === "WATCH") {
      return {
        label: "FINAL — REVIEW",
        color: "#f5c542",
        bg: "#fffbeb",
        border: "#fde68a",
        text: "#713f12",
        cardBg: "linear-gradient(90deg, #fffbeb 0%, #ffffff 45%)",
      };
    }

    return {
      label: signal === "FINAL" ? "FINAL" : `FINAL — ${signal}`,
      color: "#dc2626",
      bg: "#fef2f2",
      border: "#fecaca",
      text: "#991b1b",
      cardBg: "linear-gradient(90deg, #fef2f2 0%, #ffffff 45%)",
    };
  }

  if (!job.lastResult) {
    return timing.isFinal
      ? {
          label: "FINAL",
          color: "#16a34a",
          bg: "#ecfdf5",
          border: "#bbf7d0",
          text: "#166534",
          cardBg: "linear-gradient(90deg, #f0fdf4 0%, #ffffff 45%)",
        }
      : {
          label: "PRELIM",
          color: "#f5c542",
          bg: "#fffbeb",
          border: "#fde68a",
          text: "#713f12",
          cardBg: "linear-gradient(90deg, #fffbeb 0%, #ffffff 45%)",
        };
  }

  if (
    job.lastResult.shortSignal === "GO" ||
    job.lastResult.shortSignal === "FAVORABLE"
  ) {
    return {
      label: "LOW RISK",
      color: "#16a34a",
      bg: "#ecfdf5",
      border: "#bbf7d0",
      text: "#166534",
      cardBg: "linear-gradient(90deg, #f0fdf4 0%, #ffffff 45%)",
    };
  }

  if (job.lastResult.shortSignal === "WATCH") {
    return {
      label: "MODERATE RISK",
      color: "#f5c542",
      bg: "#fffbeb",
      border: "#fde68a",
      text: "#713f12",
      cardBg: "linear-gradient(90deg, #fffbeb 0%, #ffffff 45%)",
    };
  }

  return {
    label: "HIGH RISK",
    color: "#dc2626",
    bg: "#fef2f2",
    border: "#fecaca",
    text: "#991b1b",
    cardBg: "linear-gradient(90deg, #fef2f2 0%, #ffffff 45%)",
  };
}

// =====================================================
// SECTION 8 — BACKEND SCORING + RESULT BUILDER
// Sends weather inputs to Supabase scoring and formats the result.
// =====================================================


async function buildAssessment(openMeteoWeather, form, location, nwsWeather) {
  if (!supabase) {
    throw new Error("Supabase is not configured. Backend scoring is required for Paving V1.");
  }


  const assessmentTimeZone =
    form.timeZone || openMeteoWeather?.timezone || "";
  const timing = getAssessmentTiming(
    { ...form, timeZone: assessmentTimeZone },
    assessmentTimeZone
  );
  const backendInput = buildBackendScoringInput(openMeteoWeather, nwsWeather, form);
  const backendContext = {
  is_final_call_window: timing.isFinal,
  // The backend still accepts the legacy hours field, but final status is now
  // determined by the selected local clock time.
  final_call_window_hours: timing.finalCallWindowHours,
  final_call_time: timing.finalCallTime,
  operating_window: form.operatingWindow,
  work_date: form.workDate,
  weather_call_caution: normalizeWeatherCallCaution(
    form.weatherCallCaution || "balanced"
  ),
  workable_rain_probability_threshold: normalizeWorkableRainThreshold(
    form.workableRainProbabilityThreshold
  ),
  minimum_workable_window_hours: normalizeMinimumWorkableWindowHours(
    form.minimumWorkableWindowHours
  ),
};

  const { data, error } = await supabase.rpc("score_fieldcall_assessment", {
    p_service_name: form.workType || "Paving",
    p_input_data: backendInput,
    p_context: backendContext,
  });

  if (error) {
    throw new Error(
      `Backend scoring failed: ${error.message || "Unknown backend error"}`
    );
  }

  if (data?.error) {
    throw new Error(data.message || "Backend scoring returned an error.");
  }
    let savedAssessmentId = null;

if (timing.isFinal && form.skipBackendHistorySave !== true) {
  try {
    savedAssessmentId = await saveAssessmentToBackend({
      form,
      location,
      timing,
      backendInput,
      scoringResult: data,
    });
  } catch {
    // A history-save issue should not prevent the weather result from displaying.
  }
}

  const backendDisplaySignal = data?.display_signal || data?.signal;
  if (!backendDisplaySignal) {
    throw new Error("Backend scoring did not return a display signal.");
  }
const backendWindowTitle = data?.window_title || "Best Workable Window";
const backendWindowLabel = data?.window_label || "Workable window unavailable.";
const backendSubText = data?.sub_text || "";
const backendScoreText = data?.score_text || "";
const effectiveBackendInput = data?.effective_input || backendInput;
const selectedWindowDetails =
  effectiveBackendInput?.selected_window || data?.selected_window || {};
  const score = Number(data?.total_score ?? 0);
  const productionScore = Number(data?.production_score ?? 0);
  const qualityScore = Number(data?.quality_score ?? 0);
  const safetyScore = Number(data?.safety_score ?? 0);
  const hardStopTriggered = Boolean(data?.hard_stop_triggered);
  const shortSignal = backendDisplaySignal;
  const icon = getSignalIcon(shortSignal);
  const callTypeLabel = timing.isFinal
    ? "Final Weather Assessment"
    : "Preliminary Review";
  const callTypeDisplay = timing.isFinal
    ? "FINAL OPERATIONAL ASSESSMENT"
    : "PRELIMINARY REVIEW";
  const heading = timing.isFinal
    ? `${icon} TOMORROW’S FIELD CALL — ${shortSignal}`
    : `${icon} FIELD CALL PRELIMINARY REVIEW — ${shortSignal}`;
const workableWindowLabel = backendWindowLabel;
const reasonKey = data?.reason_key || "low_risk";
const backendReason =
  data?.reason_text || "Assessment reason unavailable.";

  return {
  savedAssessmentId,
  checkedAt: new Date().toISOString(),
    heading,
    shortSignal,
    icon,
    score,
    rawScore: score,
    subText: backendSubText,
scoreText: backendScoreText,
    window: workableWindowLabel,
    windowTitle: backendWindowTitle,
    reason: backendReason,
    reasonKey,
    scoringVersion: data?.scoring_version || "",
    logicRelease: data?.logic_release || "",
    weatherCallCaution:
      data?.weather_call_caution || backendContext.weather_call_caution,
    riskLevel: data?.risk_level || "",
    riskLevelLabel: data?.risk_level_label || "",
    scoreBreakdown: Array.isArray(data?.score_breakdown)
      ? data.score_breakdown
      : [],
    leadingFactor: data?.leading_factor || null,
    riskFactors: Array.isArray(data?.risk_factors)
  ? data.risk_factors
  : getBackendRiskFactors({
      backendInput,
      hardStopTriggered,
      productionScore,
      qualityScore,
      safetyScore,
    }),
    categoryPoints: {
      production: productionScore,
      quality: qualityScore,
      safety: safetyScore,
    },

    averageRainProbability: effectiveBackendInput.average_rain_probability,
    peakRainProbability: effectiveBackendInput.peak_rain_probability,
    rainfallAssessedPeriod:
      data?.rainfall_assessed_period ??
      effectiveBackendInput.rainfall_assessed_period ??
      effectiveBackendInput.rainfall_total_work_window ??
      0,
    rainfallSelectedWindow:
      data?.rainfall_selected_window ??
      effectiveBackendInput.rainfall_selected_window ??
      null,
    rainfallTotalMin: effectiveBackendInput.rainfall_total_min ?? null,
    rainfallTotalMax: effectiveBackendInput.rainfall_total_max ?? null,
    rainfallAmountSource:
      effectiveBackendInput.rainfall_amount_source || "Unavailable",
    rainfallAmountDisagreement:
      effectiveBackendInput.rainfall_amount_disagreement || "unavailable",
    totalPrecipitationInches:
      data?.rainfall_assessed_period ??
      effectiveBackendInput.rainfall_assessed_period ??
      effectiveBackendInput.rainfall_total_work_window ??
      0,
    selectedWindowTemperatureRange:
      data?.selected_window_temperature_range ||
      effectiveBackendInput.selected_window_temperature_range ||
      "Unavailable",
    assessedPeriodTemperatureRange:
      data?.assessed_period_temperature_range ||
      effectiveBackendInput.assessed_period_temperature_range ||
      effectiveBackendInput.temperature_range ||
      "Unavailable",
    hasReliableWindow: data?.has_reliable_window === true,
    workWindowRequirements:
      selectedWindowDetails?.window_requirements || {},
    workWindowReason:
      selectedWindowDetails?.window_reason ||
      selectedWindowDetails?.window_note ||
      "",
    alternativeWorkWindows: Array.isArray(
      selectedWindowDetails?.alternative_windows
    )
      ? selectedWindowDetails.alternative_windows
      : [],
    workWindowTempRange:
      (data?.has_reliable_window === true
        ? data?.selected_window_temperature_range ||
          effectiveBackendInput.selected_window_temperature_range
        : data?.assessed_period_temperature_range ||
          effectiveBackendInput.assessed_period_temperature_range) ||
      effectiveBackendInput.temperature_range ||
      "Unavailable",

    bestLowPrecipHours: effectiveBackendInput.best_low_precip_hours || "Unavailable",
    bestWindowLabel: workableWindowLabel,
    bestWindowAverageRain: effectiveBackendInput.average_rain_probability,
    bestWindowTotalPrecip:
      data?.rainfall_selected_window ??
      effectiveBackendInput.rainfall_selected_window ??
      null,

    locationLabel: `${location.name}, ${location.admin1 || form.state}`,
    sources: getBackendSourcesChecked(openMeteoWeather, nwsWeather),

    riskBarText: getRiskBarText(score),
    markerLeft: getMarkerLeft(score),

    isFinal: timing.isFinal,
    timingText: timing.timingText,
    finalCallTime: timing.finalCallTime,
    finalCallDueAt: timing.finalCallDueAt,
    timeZone: timing.timeZone || assessmentTimeZone,
    // Backward compatibility for older stored-result consumers.
    finalCallWindowHours: String(timing.finalCallWindowHours || 24),
    callTypeLabel,
    callTypeDisplay,

    whyPoints: Array.isArray(data?.why_points)
  ? data.why_points
  : getBackendWhyPoints({
      backendInput,
      productionScore,
      qualityScore,
      safetyScore,
      hardStopTriggered,
      timing,
    }),

    nwsAvailable: Boolean(nwsWeather?.available),
    nwsPeakRainProbability: effectiveBackendInput.nws_peak_rain_probability,
    nwsPeakRainProbabilityDisplay:
      typeof backendInput.nws_peak_rain_probability === "number"
        ? `${backendInput.nws_peak_rain_probability}%`
        : "Unavailable",
    nwsPeakRainProbabilityHour: nwsWeather?.peakRainProbabilityHour ?? null,
    nwsPeakRainProbabilityHourDisplay:
      nwsWeather?.peakRainProbabilityHourDisplay || "",
    nwsSummary: getNwsSummaryText(nwsWeather),

    nwsSignal: nwsWeather?.available ? "Backend scored" : "UNAVAILABLE",
    openMeteoSignal: openMeteoWeather?.hourly?.time ? "Backend scored" : "UNAVAILABLE",

    forecastAgreementLabel: backendInput.forecast_agreement_label,
    forecastAgreementShortLabel: backendInput.forecast_agreement,
    sourceSpreadLevel: backendInput.forecast_agreement,
    sourceSpreadPoints: null,
    higherRiskSource: backendInput.higher_risk_source || "Backend scoring",

    operationalNote: hardStopTriggered
  ? "FieldCall identified a hard stop condition inside the final call window."
  : `Scoring completed through the FieldCall ${form.workType || "selected service"} matrix.`,

    backendInput,
    backendScoring: data,
    communications: data?.communications || {},
    openMeteoSource: null,
    nwsSource: null,
    combinedSourceProfile: backendInput,

    surfaceCondition: isPavingService(form.workType) ? form.surfaceCondition || "Subgrade exposed & paved same day" : "Subgrade exposed & paved same day",
    baseExposed: isPavingService(form.workType)
      ? getBaseExposedFromSurfaceCondition(form.surfaceCondition)
      : "No",
    workType: form.workType,
    operatingWindow: form.operatingWindow,
    hardStopTriggered,
  };
}
async function saveAssessmentToBackend({
  form,
  location,
  timing,
  backendInput,
  scoringResult,
}) {
  if (!supabase) {
    throw new Error("Assessment history save failed: Supabase is not configured.");
  }

  const { data: savedAssessment, error } = await supabase
  .from("assessments")
  .insert({
    company_id: form.activeCompanyId || null,
    job_id: form.backendJobId || null,

    service_type: form.workType || "Paving",
    project_name: form.projectName || "Unnamed Job",
    city: form.city || location?.name || "",
    state: form.state || location?.admin1 || "",
    work_date: form.workDate,
    operating_window: form.operatingWindow,

    is_final_call_window: timing.isFinal,

    input_data: backendInput,
    scoring_result: scoringResult,

    signal: scoringResult?.display_signal ?? scoringResult?.signal ?? null,
total_score: scoringResult?.total_score ?? null,
production_score: scoringResult?.production_score ?? null,
quality_score: scoringResult?.quality_score ?? null,
safety_score: scoringResult?.safety_score ?? null,

    sources_checked:
      backendInput?.nws_qpf_rainfall_total !== null &&
      backendInput?.nws_qpf_rainfall_total !== undefined
        ? "NWS hourly forecast and grid QPF, Open-Meteo"
        : "NWS hourly forecast, Open-Meteo",
  })
  .select("id")
  .single();

  if (error) {
    throw new Error(`Assessment history save failed: ${error.message}`);
  }
  return savedAssessment?.id || null;
}
function buildBackendScoringInput(openMeteoWeather, nwsWeather, form) {
  const openHours = openMeteoWeather?.hourly?.time
    ? getOperatingHours(openMeteoWeather, form)
    : [];
  const nwsHours = nwsWeather?.available ? getNwsOperatingHours(nwsWeather, form) : [];

  const openWindow = analyzeWorkableWindow(openHours);
const nwsWindow = analyzeWorkableWindow(nwsHours);
const limitingWindow = chooseLimitingWorkableWindow(openWindow, nwsWindow);

const workableWindowHours =
  typeof limitingWindow?.workableWindowHours === "number"
    ? limitingWindow.workableWindowHours
    : 0;

  const openAverageRain = getAverageRainProbabilityFromHours(openHours);
  const nwsAverageRain = typeof nwsWeather?.averageRainProbability === "number"
    ? nwsWeather.averageRainProbability
    : getAverageRainProbabilityFromHours(nwsHours);
  const averageRainProbability = getAverageNumeric([openAverageRain, nwsAverageRain]);

  const openPeakRain = getPeakRainProbabilityFromHours(openHours);
  const nwsPeakRain = typeof nwsWeather?.peakRainProbability === "number"
    ? nwsWeather.peakRainProbability
    : getPeakRainProbabilityFromHours(nwsHours);
  const peakRainProbability = getHighestNumeric([openPeakRain, nwsPeakRain]);

  const openMeteoRainfallTotal = getOptionalTotalPrecipitationFromHours(
    openHours,
    Boolean(openMeteoWeather?.hourly?.time)
  );
  const nwsQpfCoverageComplete =
    nwsHours.length > 0 &&
    nwsHours.every((hour) => typeof hour?.precipitation === "number");
  const nwsQpfRainfallTotal = getOptionalTotalPrecipitationFromHours(
    nwsHours,
    nwsQpfCoverageComplete
  );
  const accumulationSelection = chooseAccumulationSource({
    openMeteoRainfallTotal,
    nwsQpfRainfallTotal,
  });
  const totalPrecipitation = accumulationSelection.selectedTotal;
  const selectedAccumulationHours =
    accumulationSelection.selectedSource === "NWS QPF" ? nwsHours : openHours;
  const firstFiveHoursPrecip = getTotalPrecipitationFromHours(
    selectedAccumulationHours.slice(0, 5)
  );
  const rainDisruptionHours = getRainDisruptionHours(
    openHours,
    nwsHours,
    accumulationSelection.selectedSource
  );
  const peakOccursCoreHours = doesPeakOccurDuringCoreHours(openHours, nwsHours, peakRainProbability);
  const forecastAgreement = getBackendForecastAgreement({
    openAverageRain,
    nwsAverageRain,
    openPeakRain,
    nwsPeakRain,
    openMeteoRainfallTotal,
    nwsQpfRainfallTotal,
  });
  const temperatureRange = getTemperatureRangeFromHours(openHours.length ? openHours : nwsHours);
  const airTemperatureCondition = getAirTemperatureCondition(openHours.length ? openHours : nwsHours);
  const summaryText = `${nwsWeather?.summary || ""} ${openHours.map((h) => h.shortForecast || "").join(" ")}`;
  const hourlyWeather = buildHourlyWeatherForBackend(
    openHours,
    nwsHours,
    accumulationSelection.selectedSource,
    {
      workableRainProbabilityThreshold:
        form.workableRainProbabilityThreshold,
      minimumWorkableWindowHours:
        form.minimumWorkableWindowHours,
    }
  );

  return {
    workable_window_hours: workableWindowHours ?? 0,
    rainfall_total_work_window: totalPrecipitation ?? 0,
    rainfall_within_5_hours_of_start: firstFiveHoursPrecip ?? 0,
    rain_disruption_hours: rainDisruptionHours,
    average_rain_probability: averageRainProbability ?? 0,
    peak_rain_probability: peakRainProbability ?? 0,
    peak_occurs_core_hours: peakOccursCoreHours,
    forecast_volatility: "none",
    forecast_agreement: forecastAgreement.level,
    forecast_agreement_label: forecastAgreement.label,
    radar_conflict: "none",
    air_temperature_condition: airTemperatureCondition,

    hourly_weather: hourlyWeather,
    hourly_payload_version: "cross-service-v1",
    hourly_merge_version: "selected-higher-total-source-v2",
    weather_input_version: "approved-source-accumulation-workable-window-v3",
    workable_rain_probability_threshold: normalizeWorkableRainThreshold(
      form.workableRainProbabilityThreshold
    ),
    minimum_workable_window_hours: normalizeMinimumWorkableWindowHours(
      form.minimumWorkableWindowHours
    ),
    open_meteo_rainfall_total: openMeteoRainfallTotal,
    nws_qpf_rainfall_total: nwsQpfRainfallTotal,
    nws_qpf_coverage_complete: nwsQpfCoverageComplete,
    rainfall_total_min: accumulationSelection.minimumTotal,
    rainfall_total_max: accumulationSelection.maximumTotal,
    rainfall_amount_source: accumulationSelection.selectedSource,
    rainfall_amount_sources_available: accumulationSelection.availableSources,
    rainfall_amount_disagreement: forecastAgreement.amountDisagreement,

    surface_condition: isPavingService(form.workType)
      ? getBackendSurfaceCondition(form)
      : "existing_surface",
    multi_day_saturation_trend: "none",
    lightning_risk: getLightningRiskFromText(summaryText),
    severe_weather_risk: getSevereWeatherRiskFromText(summaryText),
    temperature_range: temperatureRange,
    best_low_precip_hours: getBestLowPrecipHours(openHours.length ? openHours : nwsHours),

open_meteo_workable_window_hours:
  openWindow.hasData && typeof openWindow.workableWindowHours === "number"
    ? openWindow.workableWindowHours
    : null,

nws_workable_window_hours:
  nwsWindow.hasData && typeof nwsWindow.workableWindowHours === "number"
    ? nwsWindow.workableWindowHours
    : null,

    nws_peak_rain_probability: typeof nwsPeakRain === "number" ? nwsPeakRain : null,
    higher_risk_source: forecastAgreement.higherRiskSource,
  };
}
function buildHourlyWeatherForBackend(
  openHours = [],
  nwsHours = [],
  selectedAccumulationSource = "Open-Meteo",
  workWindowSettings = {}
) {
  const companyRainThreshold = normalizeWorkableRainThreshold(
    workWindowSettings.workableRainProbabilityThreshold
  );
  const minimumWorkableWindowHours = normalizeMinimumWorkableWindowHours(
    workWindowSettings.minimumWorkableWindowHours
  );
  const getMergeKey = (hour, fallbackIndex) => {
    const rawTime = String(hour?.time || hour?.startTime || "");

    if (/^\d{4}-\d{2}-\d{2}T\d{2}/.test(rawTime)) {
      return rawTime.slice(0, 13);
    }

    const hourNumber = Number(hour?.hour);
    return Number.isFinite(hourNumber)
      ? `hour-${hourNumber}`
      : `index-${fallbackIndex}`;
  };

  const getNumericValue = (hour, keys) => {
    for (const key of keys) {
      const value = hour?.[key];

      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }

    return null;
  };

  const firstAvailableNumber = (values) => {
    const value = values.find(
      (candidate) => typeof candidate === "number" && Number.isFinite(candidate)
    );

    return value ?? null;
  };

  const getHourlyPrecipitation = (hour) => {
    if (!hour) return null;

    return getNumericValue(hour, [
      "precipitationInches",
      "rainfall_inches",
      "precipitation",
    ]);
  };

  const openByKey = new Map();
  const nwsByKey = new Map();
  const orderedKeys = [];

  openHours.forEach((hour, index) => {
    const key = getMergeKey(hour, index);
    openByKey.set(key, hour);

    if (!orderedKeys.includes(key)) {
      orderedKeys.push(key);
    }
  });

  nwsHours.forEach((hour, index) => {
    const key = getMergeKey(hour, index);
    nwsByKey.set(key, hour);

    if (!orderedKeys.includes(key)) {
      orderedKeys.push(key);
    }
  });

  return orderedKeys.map((key, index) => {
    const openHour = openByKey.get(key) || null;
    const nwsHour = nwsByKey.get(key) || null;

    const openRainProbability = getNumericValue(openHour, [
      "precipitationProbability",
      "rainProbability",
      "probabilityOfPrecipitation",
    ]);

    const nwsRainProbability = getNumericValue(nwsHour, [
      "precipitationProbability",
      "rainProbability",
      "probabilityOfPrecipitation",
    ]);

    const availableRainProbabilities = [
      openRainProbability,
      nwsRainProbability,
    ].filter(
      (value) => typeof value === "number" && Number.isFinite(value)
    );

    const combinedRainProbability = availableRainProbabilities.length
      ? Math.max(...availableRainProbabilities)
      : null;

    const openMeteoPrecipitation = getHourlyPrecipitation(openHour);
    const nwsQpfPrecipitation = getHourlyPrecipitation(nwsHour);
    const selectedPrecipitation =
      selectedAccumulationSource === "NWS QPF"
        ? nwsQpfPrecipitation
        : selectedAccumulationSource === "Open-Meteo"
        ? openMeteoPrecipitation
        : null;

    const timestamp =
      openHour?.time || nwsHour?.time || nwsHour?.startTime || "";

    const hourNumber = firstAvailableNumber([
      getNumericValue(openHour, ["hour"]),
      getNumericValue(nwsHour, ["hour"]),
    ]);

    const forecastText =
      nwsHour?.shortForecast || openHour?.shortForecast || "";

    return {
      index,
      time: timestamp,
      hour: hourNumber ?? index,
      is_operating_hour: true,
      company_rain_probability_threshold: companyRainThreshold,
      minimum_workable_window_hours: minimumWorkableWindowHours,
      rain_probability: combinedRainProbability,
      open_meteo_rain_probability: openRainProbability,
      nws_rain_probability: nwsRainProbability,
      rain_probability_source:
        openRainProbability !== null && nwsRainProbability !== null
          ? openRainProbability === nwsRainProbability
            ? "Both"
            : openRainProbability > nwsRainProbability
            ? "Open-Meteo"
            : "NWS"
          : openRainProbability !== null
          ? "Open-Meteo"
          : nwsRainProbability !== null
          ? "NWS"
          : "Unavailable",
      rainfall_inches: selectedPrecipitation,
      open_meteo_rainfall_inches: openMeteoPrecipitation,
      nws_qpf_rainfall_inches: nwsQpfPrecipitation,
      rainfall_amount_source: selectedAccumulationSource,
      temperature_f: firstAvailableNumber([
        getNumericValue(openHour, [
          "temperature",
          "temperatureF",
          "temperature_f",
        ]),
        getNumericValue(nwsHour, [
          "temperature",
          "temperatureF",
          "temperature_f",
        ]),
      ]),
      humidity: firstAvailableNumber([
        getNumericValue(openHour, [
          "humidity",
          "relativeHumidity",
          "relative_humidity",
        ]),
        getNumericValue(nwsHour, [
          "humidity",
          "relativeHumidity",
          "relative_humidity",
        ]),
      ]),
      wind_mph: firstAvailableNumber([
        getNumericValue(openHour, ["windSpeed", "windSpeedMph", "wind_mph"]),
        getNumericValue(nwsHour, ["windSpeed", "windSpeedMph", "wind_mph"]),
      ]),
      wind_gust_mph: firstAvailableNumber([
        getNumericValue(openHour, [
          "windGust",
          "windGustMph",
          "wind_gust_mph",
          "windGusts",
          "wind_gust",
        ]),
        getNumericValue(nwsHour, [
          "windGust",
          "windGustMph",
          "wind_gust_mph",
          "windGusts",
          "wind_gust",
        ]),
      ]),
      forecast_text: forecastText,
      short_forecast: forecastText,
    };
  });
}


// =====================================================
// SECTION 9 — BACKEND SCORING INPUT HELPER FUNCTIONS
// Supports forecast agreement, rain disruption, temperature, and risk inputs.
// =====================================================
function getLowestNumeric(values) {
  const nums = values.filter((value) => typeof value === "number" && !Number.isNaN(value));
  return nums.length ? Math.min(...nums) : null;
}

function chooseLimitingWorkableWindow(...windows) {
  const candidates = windows.filter(
    (window) =>
      window &&
      window.hasData &&
      typeof window.workableWindowHours === "number" &&
      !Number.isNaN(window.workableWindowHours)
  );

  if (!candidates.length) return null;

  return candidates.sort(
    (a, b) => a.workableWindowHours - b.workableWindowHours
  )[0];
}

function getHighestNumeric(values) {
  const nums = values.filter((value) => typeof value === "number" && !Number.isNaN(value));
  return nums.length ? Math.max(...nums) : null;
}

function getAverageNumeric(values) {
  const nums = values.filter((value) => typeof value === "number" && !Number.isNaN(value));
  if (!nums.length) return null;
  return Math.round(nums.reduce((sum, value) => sum + value, 0) / nums.length);
}

function getRainDisruptionHours(
  openHours,
  nwsHours,
  selectedAccumulationSource = "Open-Meteo"
) {
  const mergedHours = buildHourlyWeatherForBackend(
    openHours,
    nwsHours,
    selectedAccumulationSource
  );
  if (!mergedHours.length) return 0;

  return mergedHours.filter((hour) => {
    const precip = typeof hour.rainfall_inches === "number" ? hour.rainfall_inches : 0;
    const rainProb = typeof hour.rain_probability === "number" ? hour.rain_probability : 0;
    const text = String(hour.short_forecast || "").toLowerCase();
    return (
      precip >= 0.01 ||
      rainProb >= 50 ||
      text.includes("rain") ||
      text.includes("showers") ||
      text.includes("thunder")
    );
  }).length;
}

function doesPeakOccurDuringCoreHours(openHours, nwsHours, peakRainProbability) {
  if (typeof peakRainProbability !== "number") return false;
  const allHours = [...(openHours || []), ...(nwsHours || [])];

  return allHours.some((hour) => {
    const rainProb = typeof hour.precipitationProbability === "number" ? hour.precipitationProbability : 0;
    return rainProb === peakRainProbability && isCoreProductionHour(hour.hour);
  });
}

function isCoreProductionHour(hour) {
  return Number(hour) >= 8 && Number(hour) < 15;
}

function getBackendForecastAgreement({
  openAverageRain,
  nwsAverageRain,
  openPeakRain,
  nwsPeakRain,
  openMeteoRainfallTotal,
  nwsQpfRainfallTotal,
}) {
  const hasBothProbabilities =
    typeof openAverageRain === "number" && typeof nwsAverageRain === "number";
  const averageSpread = hasBothProbabilities
    ? Math.abs(openAverageRain - nwsAverageRain)
    : 0;
  const peakSpread =
    typeof openPeakRain === "number" && typeof nwsPeakRain === "number"
      ? Math.abs(openPeakRain - nwsPeakRain)
      : 0;
  const hasBothAmounts =
    typeof openMeteoRainfallTotal === "number" &&
    typeof nwsQpfRainfallTotal === "number";
  const amountSpread = hasBothAmounts
    ? Math.abs(openMeteoRainfallTotal - nwsQpfRainfallTotal)
    : null;
  const amountDisagreement =
    amountSpread === null
      ? "unavailable"
      : amountSpread >= 0.2
      ? "severe"
      : amountSpread >= 0.05
      ? "moderate"
      : "strong";
  const probabilityHigherRiskSource =
    (openAverageRain || 0) + (openPeakRain || 0) >
    (nwsAverageRain || 0) + (nwsPeakRain || 0)
      ? "Open-Meteo"
      : "NWS";
  const amountHigherRiskSource = hasBothAmounts
    ? openMeteoRainfallTotal > nwsQpfRainfallTotal
      ? "Open-Meteo"
      : "NWS"
    : probabilityHigherRiskSource;
  const higherRiskSource =
    amountDisagreement === "moderate" || amountDisagreement === "severe"
      ? amountHigherRiskSource
      : probabilityHigherRiskSource;

  if (!hasBothProbabilities && !hasBothAmounts) {
    return {
      level: "strong",
      label: "Single-source or limited-source backend scoring.",
      higherRiskSource: "Available source",
      amountDisagreement,
    };
  }

  if (averageSpread >= 30 || peakSpread >= 40 || amountDisagreement === "severe") {
    return {
      level: "severe_disagreement",
      label: "Severe disagreement between approved sources.",
      higherRiskSource,
      amountDisagreement,
    };
  }

  if (averageSpread >= 15 || peakSpread >= 20 || amountDisagreement === "moderate") {
    return {
      level: "moderate_disagreement",
      label: "Moderate disagreement between approved sources.",
      higherRiskSource,
      amountDisagreement,
    };
  }

  return {
    level: "strong",
    label: "Approved sources are generally aligned.",
    higherRiskSource: "Neither",
    amountDisagreement,
  };
}

function getAirTemperatureCondition(hours) {
  const temps = (hours || [])
    .map((hour) => hour.temperature)
    .filter((value) => typeof value === "number");

  if (!temps.length) return "50F_or_higher_and_rising";

  const low = Math.min(...temps);
  const first = temps[0];
  const last = temps[temps.length - 1];
  const rising = last >= first;

  if (low < 40) return "below_40F";
  if (low < 45) return "40F_to_44F";
  if (low < 50 && rising) return "48F_to_49F_and_rising_into_upper_50s";
  if (low < 50) return "45F_to_49F_not_rising";
  return rising ? "50F_or_higher_and_rising" : "45F_to_49F_not_rising";
}

function getLightningRiskFromText(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("frequent lightning") || value.includes("dangerous lightning")) return "high";
  if (value.includes("thunderstorm") || value.includes("thunderstorms")) return "elevated";
  if (value.includes("thunder") || value.includes("storm")) return "possible";
  return "none";
}

function getSevereWeatherRiskFromText(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("warning") || value.includes("severe") || value.includes("damaging wind")) {
    return "warning_or_high_potential";
  }
  if (value.includes("watch") || value.includes("strong storm")) {
    return "watch_or_low_potential";
  }
  return "none";
}

function getBackendRiskFactors({
  backendInput,
  hardStopTriggered,
}) {
  const factors = [];

  if (hardStopTriggered) factors.push("0.20\"+ rain within 5 hours of start");
  if (backendInput.rainfall_total_work_window >= 0.1) factors.push("Measurable rain during production window");
  if (backendInput.workable_window_hours < 6) factors.push("Limited workable production window");
  if (backendInput.peak_rain_probability >= 65 && backendInput.peak_occurs_core_hours) factors.push("High peak rain chance during core hours");
  if (backendInput.air_temperature_condition !== "50F_or_higher_and_rising") factors.push("Air temperature below preferred paving baseline");
  if (backendInput.surface_condition === "exposed_base") factors.push("Subgrade currently exposed increases moisture sensitivity");
  if (backendInput.lightning_risk !== "none") factors.push("Lightning or thunderstorm risk present");

  if (!factors.length) factors.push("Normal monitoring still required");
  if (factors.length === 1) factors.push("Final call should be based on updated weather data");

  return factors.slice(0, 2);
}

function getBackendWhyPoints({ backendInput, productionScore, qualityScore, safetyScore, hardStopTriggered, timing }) {
  const points = [];
  points.push(
    timing.isFinal
      ? "This assessment is inside the selected final call window."
      : `This assessment is preliminary because the job is ${timing.timingText}.`
  );
  points.push(`Production score: ${productionScore}. Quality score: ${qualityScore}. Safety score: ${safetyScore}.`);
  points.push(`Workable window: ${backendInput.workable_window_hours} hours.`);
  points.push(`Rain during work window: ${backendInput.rainfall_total_work_window}".`);
  if (hardStopTriggered) points.push("Backend hard stop triggered.");
  return points;
}

function getBackendSourcesChecked(openMeteoWeather, nwsWeather) {
  const sources = [];
  if (nwsWeather?.available) {
    sources.push(
      nwsWeather?.qpfAvailable
        ? "NWS hourly forecast and grid QPF"
        : "NWS hourly forecast"
    );
  }
  if (openMeteoWeather?.hourly?.time) sources.push("Open-Meteo");
  return sources.length ? sources.join(", ") : "No approved sources available";
}
function getShortWhyPoints(result, form, language = "en") {
  const backendPoints = Array.isArray(result?.whyPoints)
    ? result.whyPoints
        .map((point) => String(point || "").trim())
        .filter(Boolean)
    : [];

  if (backendPoints.length > 0) {
    return backendPoints;
  }

  const backendRiskFactors = Array.isArray(result?.riskFactors)
    ? result.riskFactors
        .map((factor) => String(factor || "").trim())
        .filter(Boolean)
    : [];

  if (backendRiskFactors.length > 0) {
    return backendRiskFactors;
  }

  return [
    language === "es"
      ? "Los factores de decisión no están disponibles para esta evaluación guardada. Ejecute una nueva revisión."
      : "Decision factors are unavailable for this saved assessment. Run a new check.",
  ];
}

// =====================================================
// SECTION 10 — WEATHER WINDOW HELPERS
// Filters hourly weather data and analyzes workable windows.
// =====================================================

function getOperatingHours(weather, form) {
  const hourly = weather?.hourly;

  if (!hourly?.time || !Array.isArray(hourly.time)) {
    return [];
  }

  const workDate = form?.workDate || "";
  const nextDate = workDate ? getNextDateString(workDate) : "";
  const operatingWindow = form?.operatingWindow || "Day";

  const rows = hourly.time.map((time, index) => {
    const datePart = String(time).slice(0, 10);
    const hour = Number(String(time).slice(11, 13));

    return {
      time,
      datePart,
      hour,
      displayHour: Number.isFinite(hour) ? formatHour(hour) : "",
      precipitationProbability:
        hourly.precipitation_probability?.[index] === null ||
        hourly.precipitation_probability?.[index] === undefined
          ? null
          : hourly.precipitation_probability[index],
      precipitation:
        hourly.precipitation?.[index] === null ||
        hourly.precipitation?.[index] === undefined
          ? null
          : hourly.precipitation[index],
      temperature:
        hourly.temperature_2m?.[index] === null ||
        hourly.temperature_2m?.[index] === undefined
          ? null
          : hourly.temperature_2m[index],
      humidity:
        hourly.relative_humidity_2m?.[index] === null ||
        hourly.relative_humidity_2m?.[index] === undefined
          ? null
          : hourly.relative_humidity_2m[index],
      windSpeed:
        hourly.wind_speed_10m?.[index] === null ||
        hourly.wind_speed_10m?.[index] === undefined
          ? null
          : hourly.wind_speed_10m[index],
      windGust:
        hourly.wind_gusts_10m?.[index] === null ||
        hourly.wind_gusts_10m?.[index] === undefined
          ? null
          : hourly.wind_gusts_10m[index],
      shortForecast: "",
    };
  });

  if (operatingWindow === "Night") {
    return rows.filter((row) => {
      const eveningOfWorkDate =
        row.datePart === workDate && row.hour >= 19;
      const morningAfterWorkDate =
        row.datePart === nextDate && row.hour <= 6;

      return eveningOfWorkDate || morningAfterWorkDate;
    });
  }

  return rows.filter(
    (row) =>
      row.datePart === workDate &&
      row.hour >= 6 &&
      row.hour <= 19
  );
}

function getNwsOperatingHours(nwsWeather, form) {
  if (!nwsWeather?.available || !Array.isArray(nwsWeather.workPeriods)) {
    return [];
  }

  return nwsWeather.workPeriods.map((period) => {
    const hour = Number(period.startTime?.slice(11, 13));
    const rainValue = period.probabilityOfPrecipitation?.value;
    const qpfKey = String(period.startTime || "").slice(0, 13);
    const hasQpfValue = Object.prototype.hasOwnProperty.call(
      nwsWeather?.qpfHourlyByTime || {},
      qpfKey
    );
    const qpfValue = nwsWeather?.qpfHourlyByTime?.[qpfKey];

    return {
      time: period.startTime,
      hour,
      displayHour: formatHour(hour),
      precipitationProbability:
        typeof rainValue === "number" ? rainValue : 0,
      precipitation:
        nwsWeather?.qpfAvailable === true && hasQpfValue
          ? typeof qpfValue === "number"
            ? qpfValue
            : 0
          : null,
      temperature:
        typeof period.temperature === "number" ? period.temperature : null,
      humidity: null,
      windSpeed:
        typeof period.windSpeed === "string"
          ? parseNwsWindSpeed(period.windSpeed)
          : null,
      shortForecast: period.shortForecast || "",
    };
  });
}

function parseNwsWindSpeed(windSpeedText) {
  if (!windSpeedText) return null;

  const match = String(windSpeedText).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function isHourWorkable(hour) {
  const rainProbability =
    typeof hour.precipitationProbability === "number"
      ? hour.precipitationProbability
      : 0;

  const precipitation =
    typeof hour.precipitation === "number" ? hour.precipitation : 0;

  const forecastText = (hour.shortForecast || "").toLowerCase();

  const hasStormLanguage =
    forecastText.includes("thunder") ||
    forecastText.includes("storm") ||
    forecastText.includes("heavy rain");

  if (hasStormLanguage) return false;

  return rainProbability <= 30 && precipitation <= 0.01;
}


function analyzeWorkableWindow(hours, minimumHours = 6) {
  if (!Array.isArray(hours) || hours.length === 0) {
    return {
      hasData: false,
      workableWindowHours: null,
      meetsMinimumWindow: false,
      label: "Unavailable",
      averageRain: "N/A",
      totalPrecip: "N/A",
      startLabel: "",
      endLabel: "",
    };
  }

  let longestWindow = [];
  let currentWindow = [];

  hours.forEach((hour) => {
    if (isHourWorkable(hour)) {
      currentWindow.push(hour);
    } else {
      if (currentWindow.length > longestWindow.length) {
        longestWindow = currentWindow;
      }

      currentWindow = [];
    }
  });

  if (currentWindow.length > longestWindow.length) {
    longestWindow = currentWindow;
  }

  if (longestWindow.length === 0) {
    return {
      hasData: true,
      workableWindowHours: 0,
      meetsMinimumWindow: false,
      label: "No reliable work window identified.",
      averageRain: "N/A",
      totalPrecip: "N/A",
      startLabel: "",
      endLabel: "",
    };
  }

  const averageRain = Math.round(
    longestWindow.reduce(
      (sum, hour) => sum + hour.precipitationProbability,
      0
    ) / longestWindow.length
  );

  const totalPrecip = roundToTwo(
    longestWindow.reduce((sum, hour) => sum + hour.precipitation, 0)
  );

  const startLabel = longestWindow[0].displayHour;
  const endLabel = longestWindow[longestWindow.length - 1].displayHour;
  const workableWindowHours = longestWindow.length;

  return {
    hasData: true,
    workableWindowHours,
    meetsMinimumWindow: workableWindowHours >= minimumHours,
    label:
      workableWindowHours >= minimumHours
        ? `${startLabel} – ${endLabel}`
        : `Longest workable stretch is ${workableWindowHours} hours.`,
    averageRain,
    totalPrecip,
    startLabel,
    endLabel,
  };
}

function getBestLowPrecipHours(hours) {
  if (!hours.length) {
    return "Unavailable";
  }

  const sorted = [...hours].sort((a, b) => {
    if (a.precipitationProbability !== b.precipitationProbability) {
      return a.precipitationProbability - b.precipitationProbability;
    }

    return a.precipitation - b.precipitation;
  });

  const best = sorted.slice(0, 4);

  return best
    .map(
      (hour) =>
        `${hour.displayHour} (${hour.precipitationProbability}%, ${roundToTwo(
          hour.precipitation
        )}")`
    )
    .join(", ");
}

function getAverageRainProbabilityFromHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0) return null;

  return Math.round(
    hours.reduce((sum, hour) => sum + hour.precipitationProbability, 0) /
      hours.length
  );
}

function getPeakRainProbabilityFromHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0) return null;

  return Math.max(...hours.map((hour) => hour.precipitationProbability));
}

function getPrecipitationInchesFromHour(hour) {
  if (!hour) return 0;

  // Explicit inch value, if already provided.
  if (typeof hour.precipitationInches === "number") {
    return hour.precipitationInches;
  }

  // Backend-normalized inch value, if already provided.
  if (typeof hour.rainfall_inches === "number") {
    return hour.rainfall_inches;
  }

  // Open-Meteo is requested with precipitation_unit: "inch",
  // so hour.precipitation is already inches.
  if (typeof hour.precipitation === "number") {
    return hour.precipitation;
  }

  return 0;
}

function getTotalPrecipitationFromHours(hours = []) {
  if (!Array.isArray(hours) || hours.length === 0) return 0;

  const total = hours.reduce((sum, hour) => {
    return sum + getPrecipitationInchesFromHour(hour);
  }, 0);

  return Math.round(total * 1000) / 1000;
}

function getOptionalTotalPrecipitationFromHours(hours = [], sourceAvailable = false) {
  if (!sourceAvailable || !Array.isArray(hours) || hours.length === 0) {
    return null;
  }

  return getTotalPrecipitationFromHours(hours);
}

function chooseAccumulationSource({
  openMeteoRainfallTotal,
  nwsQpfRainfallTotal,
}) {
  const available = [
    { source: "Open-Meteo", total: openMeteoRainfallTotal },
    { source: "NWS QPF", total: nwsQpfRainfallTotal },
  ].filter(
    (item) => typeof item.total === "number" && Number.isFinite(item.total)
  );

  if (available.length === 0) {
    return {
      selectedSource: "Unavailable",
      selectedTotal: null,
      minimumTotal: null,
      maximumTotal: null,
      availableSources: [],
    };
  }

  const selected = [...available].sort((a, b) => b.total - a.total)[0];
  const totals = available.map((item) => item.total);

  return {
    selectedSource: selected.source,
    selectedTotal: Math.round(selected.total * 1000) / 1000,
    minimumTotal: Math.round(Math.min(...totals) * 1000) / 1000,
    maximumTotal: Math.round(Math.max(...totals) * 1000) / 1000,
    availableSources: available.map((item) => item.source),
  };
}

function getTemperatureRangeFromHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0) {
    return "Unavailable";
  }

  const temperatures = hours
    .map((hour) => hour.temperature)
    .filter((value) => typeof value === "number");

  if (temperatures.length === 0) {
    return "Unavailable";
  }

  const lowTemp = Math.round(Math.min(...temperatures));
  const highTemp = Math.round(Math.max(...temperatures));

  return `${lowTemp}°–${highTemp}°F`;
}

// =====================================================
// SECTION 11 — BACKEND RESULT DISPLAY HELPERS
// Formats score, signal, risk bar, and result labels for the UI.
// =====================================================

function getNoWorkableWindowText() {
  return "No workable window greater than 6 hours identified.";
}

function getSignalIcon(signal) {
  if (signal === "GO") return "🟢";
  if (signal === "NO GO") return "🔴";
  if (signal === "FAVORABLE") return "🔵";
  if (signal === "WATCH") return "🟡";
  return "⚠️";
}

function getRiskBarText(score) {
  if (score <= 25) return "🟢 🟡 🔴 ────▲──── ────────";
  if (score <= 45) return "🟢 🟡 🔴 ─────▲─── ────────";
  if (score <= 60) return "🟢 🟡 🔴 ──────── ▲───────";
  return "🟢 🟡 🔴 ──────── ────────▲";
}

function getMarkerLeft(score) {
  return `${Math.max(0, Math.min(100, Number(score) || 0))}%`;
}

// =====================================================
// SECTION 12 — COMMUNICATION COPY TEMPLATES
// Builds internal, client, vendor, and crew message templates.
// =====================================================

function buildSlackTemplate(result, language = "en") {
  const riskFactors = getTemplateRiskFactors(result, language);

  if (language === "es") {
    const heading = result.isFinal
      ? `${getDisplaySignal(result.shortSignal, language)} — Evaluación final del clima`
      : `${getDisplaySignal(result.shortSignal, language)} — Revisión preliminar del clima`;

    const concernLabel = result.isFinal ? "Razón principal" : "Preocupación principal";
    const finalCallNote = result.isFinal
      ? ""
      : `\n\nNota: La evaluación final GO / NO GO debe repetirse a las ${formatFinalCallTimeLabel(result.finalCallTime, language)} ${result.operatingWindow === "Night" ? "en la fecha de trabajo" : "el día anterior al trabajo"}.`;

    return `${heading}\n\nPuntaje: ${result.score} puntos\nVentana de trabajo: ${getSlackWorkableWindow(result, language)}\n${concernLabel}: ${getDisplayReason(result, language)}\n\nFactores clave de riesgo:\n• ${riskFactors[0]}\n• ${riskFactors[1]}\n\nFuentes revisadas: ${result.sources}${finalCallNote}`;
  }

  const heading = result.isFinal
    ? `${result.shortSignal} — Final Weather Assessment`
    : `${result.shortSignal} — Preliminary Weather Review`;

  const concernLabel = result.isFinal ? "Main reason" : "Main concern";

  const finalCallNote = result.isFinal
    ? ""
    : `

Note: Final GO / NO GO assessment should be rerun at ${formatFinalCallTimeLabel(result.finalCallTime, language)} ${result.operatingWindow === "Night" ? "on the work date" : "the day before work"}.`;

  return `${heading}

Score: ${result.score} points — ${result.scoreText}
Workable window: ${getSlackWorkableWindow(result, language)}
${concernLabel}: ${result.reason}

Key risk factors:
• ${riskFactors[0]}
• ${riskFactors[1]}

Sources checked: ${result.sources}${finalCallNote}`;
}

function getSlackWorkableWindow(result, language = "en") {
  if (result.shortSignal === "NO GO" || result.shortSignal === "HIGH RISK") {
    return language === "es"
      ? "No se identificó una ventana confiable de trabajo."
      : getNoWorkableWindowText(result.workType);
  }

  if (result.shortSignal === "WATCH") {
    return translateWorkableWindowLabel(result.window || "Still uncertain.", language);
  }

  if (result.workType === "Striping") {
    return language === "es"
      ? translateWorkableWindowLabel(result.window || "Ventana de señalización de 3+ horas identificada.", language)
      : result.window || "3+ hour striping window identified.";
  }

  return language === "es"
    ? translateWorkableWindowLabel(result.window || "Ventana de trabajo de 6+ horas identificada.", language)
    : result.window || "6+ hour workable production window identified.";
}

function getTemplateRiskFactors(result, language = "en") {
  if (language === "es") {
    const factors = [];

    if (result?.hardStopTriggered) factors.push("Condición de alto riesgo activada por lluvia cerca del inicio");
    if (Number(result?.totalPrecipitationInches || 0) >= 0.1) factors.push("Lluvia medible durante la ventana de producción");
    if (Number(result?.peakRainProbability || 0) >= 65) factors.push("Alta probabilidad máxima de lluvia durante horas clave");
    if (String(result?.bestWindowLabel || "").includes("No workable")) factors.push("No se identificó una ventana confiable de trabajo");
    if (result?.surfaceCondition === "Subgrade currently exposed") factors.push("Subrasante expuesta aumenta la sensibilidad a humedad");

    if (!factors.length) factors.push("El monitoreo normal sigue siendo necesario");
    if (factors.length === 1) factors.push("La decisión final debe basarse en datos actualizados del clima");

    return factors.slice(0, 2);
  }

  const riskFactors = Array.isArray(result.riskFactors)
    ? result.riskFactors.filter(Boolean)
    : [];

  if (riskFactors.length >= 2) {
    return riskFactors.slice(0, 2);
  }

  if (riskFactors.length === 1) {
    return [riskFactors[0], "Normal monitoring still required"];
  }

  return ["Normal monitoring still required", "Final call should be based on updated weather data"];
}

function buildEmailTemplate(result, language = "en") {
  if (language === "es") {
    if (!result.isFinal) {
      return `Asunto: Actualización de revisión del clima\n\nBuenos días,\n\nRevisamos los reportes más recientes del clima, y esto sigue siendo una revisión preliminar, no una decisión final.\n\nEn este momento, la señal actual es ${getDisplaySignal(result.shortSignal, language)}. Seguiremos monitoreando el pronóstico y tomaremos la decisión final más cerca de la fecha programada.\n\nFuentes revisadas:\n${result.sources}`;
    }

    if (result.shortSignal === "GO" || result.shortSignal === "FAVORABLE") {
      return `Asunto: Actualización de clima para el trabajo\n\nBuenos días,\n\nRevisamos los reportes más recientes del clima, y por ahora las condiciones apoyan avanzar según lo planeado.\n\nSeguiremos pendientes de las condiciones durante el trabajo y avisaremos de inmediato si algo cambia.\n\nFuentes revisadas:\n${result.sources}`;
    }

    return `Asunto: Actualización por retraso de clima\n\nBuenos días,\n\nRevisamos los reportes más recientes del clima, y desafortunadamente las condiciones no se ven lo suficientemente confiables para avanzar según lo programado.\n\nEn este momento hay suficiente riesgo de interrupción por clima, así que es mejor esperar en lugar de iniciar y no poder completar el trabajo correctamente.\n\nSeguiremos monitoreando las condiciones y enviaremos una actualización tan pronto tengamos una mejor ventana de trabajo.\n\nFuentes revisadas:\n${result.sources}`;
  }

  if (!result.isFinal) {
    return `Subject: Weather Review Update

Good morning,

We reviewed the latest weather reports, and this is still a preliminary weather review rather than a final weather call.

Right now, the current outlook is ${result.shortSignal}. We’ll continue monitoring the forecast and will make a final call closer to the scheduled work date.

Weather sources reviewed:
${result.sources}`;
  }

  if (result.shortSignal === "GO") {
    return `Subject: Weather Review Update

Good morning,

We reviewed the latest weather reports, and right now things still look good for us to move forward as planned.

We’ll keep an eye on conditions throughout the work and will let you know right away if anything changes.

Weather sources reviewed:
${result.sources}`;
  }

  return `Subject: Weather Delay Update

Good morning,

We reviewed the latest weather reports, and unfortunately the weather does not look reliable enough for us to move forward as scheduled.

At this point, there is enough risk for weather-related interruption that we feel it is best to hold off rather than risk starting and not being able to complete the work properly.

We’ll continue watching conditions and will update you as soon as we have a better workable option.

Weather sources reviewed:
${result.sources}`;
}

function buildTextTemplate(result, form, language = "en") {
  const city = form?.city || "[City]";

  if (language === "es") {
    if (!result.isFinal) {
      return `Hola, seguimos monitoreando el clima en ${city} para este trabajo. Por favor manténganse en espera por ahora. Enviaremos la decisión final cuando estemos más cerca.`;
    }

    if (result.shortSignal === "GO" || result.shortSignal === "FAVORABLE") {
      return `Hola, el clima se ve lo suficientemente favorable en ${city} para avanzar según lo planeado.`;
    }

    return `Hola, no vamos a avanzar mañana en ${city} debido al riesgo de clima. Por favor esperen indicaciones y enviaremos una actualización cuando tengamos una mejor ventana.`;
  }

  if (!result.isFinal) {
    return `Hey, we’re still watching the weather in ${city} for this one. Please stay on standby for now. I’ll make the final call the day before.`;
  }

  if (result.shortSignal === "GO") {
    return `Hey, weather looks good enough in ${city} to proceed as planned.`;
  }

  return `Hey, we are not moving forward tomorrow in ${city} due to weather risk. Please hold off and I’ll send an update once we have a better window.`;
}

function buildCrewTemplate(result, form, language = "en") {
  const city = form.city || "[City]";

  if (language === "es") {
    if (!result.isFinal) {
      return `Hola, seguimos monitoreando el clima en ${city} para este trabajo. Manténganse en espera por ahora. Enviaré la decisión final cuando estemos más cerca.`;
    }

    if (result.shortSignal === "GO" || result.shortSignal === "FAVORABLE") {
      return `Hola, el clima se ve lo suficientemente favorable en ${city} para avanzar según lo planeado.`;
    }

    return `Hola, no vamos a avanzar mañana en ${city} por riesgo de clima. Enviaré una actualización cuando tengamos una mejor ventana.`;
  }

  if (!result.isFinal) {
    return `Hey, we’re still watching the weather in ${city} for this job. Stay on standby for now. I’ll send the final call once we’re closer.`;
  }

  if (result.shortSignal === "GO") {
    return `Hey, weather looks good enough in ${city} to move forward as planned.`;
  }

  return `Hey, we are not moving forward tomorrow in ${city} due to weather risk. I’ll send an update once we have a better window.`;
}
// =====================================================
// SECTION 13 — SMALL UI COMPONENTS
// Reusable location search, fields, selects, summaries, and stats.
// =====================================================

function SettingsAccordionRow({ title, summary, open, onToggle, children }) {
  return (
    <div style={settingsAccordionItemStyle}>
      <button type="button" onClick={onToggle} style={settingsAccordionButtonStyle}>
        <div style={settingsAccordionTextStyle}>
          <strong>{title}</strong>
          <span>{summary}</span>
        </div>
        <span style={settingsAccordionChevronStyle}>{open ? "−" : "+"}</span>
      </button>
      {open && <div style={settingsAccordionBodyStyle}>{children}</div>}
    </div>
  );
}

function LanguageToggle({ language, onChange }) {
  return (
    <div style={languageToggleStyle} aria-label="Language selector">
      {LANGUAGE_OPTIONS.map((option) => {
        const isActive = option.code === language;

        return (
          <button
            key={option.code}
            type="button"
            onClick={() => onChange(option.code)}
            style={isActive ? languageToggleButtonActiveStyle : languageToggleButtonStyle}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function LocationSearchField({
  language = "en",
  value,
  selectedLocation,
  onQueryChange,
  onSelectLocation,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");

  async function handleChange(nextValue) {
    onQueryChange(nextValue);
    setMessage("");

    if (nextValue.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    setSearching(true);

    try {
      const results = await searchGeoapifyLocations(nextValue);

      if (results.length === 0) {
        setSuggestions([]);
        setMessage(
          translateAppText(language, "locationNotFound")
        );
      } else {
        setSuggestions(results);
      }
       } catch (err) {
      setSuggestions([]);
      setMessage(err.message || translateAppText(language, "locationSearchFailed"));
    } finally {
      setSearching(false);
    }
  }

  return (
    <div style={locationSearchWrapStyle}>
      <label style={labelStyle}>
        <span style={labelTextStyle}>{translateAppText(language, "location")}</span>
        <input
          value={value}
          placeholder={translateAppText(language, "locationPlaceholder")}
          onChange={(e) => handleChange(e.target.value)}
          style={inputStyle}
        />
      </label>

      {searching && <p style={locationHelpStyle}>{translateAppText(language, "searchingLocations")}</p>}

      {selectedLocation && (
        <div style={selectedLocationStyle}>
          <strong>{selectedLocation.displayName}</strong>
          <span>{selectedLocation.formattedAddress}</span>
        </div>
      )}

      {suggestions.length > 0 && !selectedLocation && (
        <div style={suggestionListStyle}>
          {suggestions.map((suggestion) => (
            <button
              key={`${suggestion.latitude}-${suggestion.longitude}-${suggestion.formattedAddress}`}
              type="button"
              onClick={() => {
                onSelectLocation(suggestion);
                setSuggestions([]);
                setMessage("");
              }}
              style={suggestionButtonStyle}
            >
              <strong>{suggestion.displayName}</strong>
              <span>{suggestion.formattedAddress}</span>
            </button>
          ))}
        </div>
      )}

      {message && <p style={locationErrorTextStyle}>{message}</p>}
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder = "" }) {
  return (
    <label style={labelStyle}>
      <span style={labelTextStyle}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange, getOptionLabel }) {
  return (
    <label style={labelStyle}>
      <span style={labelTextStyle}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={selectStyle}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {getOptionLabel ? getOptionLabel(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

// =====================================================
// SECTION 14 — STYLES
// Inline styles kept at the bottom for easier editing.
// =====================================================

const languageToggleStyle = {
  marginLeft: "auto",
  display: "flex",
  alignItems: "center",
  gap: "4px",
  padding: "3px",
  borderRadius: "999px",
  background: "rgba(255, 255, 255, 0.12)",
  border: "1px solid rgba(255, 255, 255, 0.18)",
};

const languageToggleButtonStyle = {
  border: "0",
  borderRadius: "999px",
  padding: "6px 8px",
  background: "transparent",
  color: "rgba(255, 255, 255, 0.78)",
  fontSize: "10px",
  fontWeight: 900,
  cursor: "pointer",
};

const languageToggleButtonActiveStyle = {
  ...languageToggleButtonStyle,
  background: "#ffffff",
  color: "#071528",
};

const preLoginCardStyle = {
  marginTop: "12px",
  background: "#ffffff",
  borderRadius: "22px",
  padding: "14px",
  display: "grid",
  gap: "9px",
  border: "1px solid #e2e8f0",
  boxShadow: "0 14px 30px rgba(15, 23, 42, 0.10)",
};

const createEntryTopStyle = {
  background: "linear-gradient(135deg, #071528 0%, #0d1f35 55%, #13243a 100%)",
  color: "white",
  borderRadius: "24px 24px 14px 14px",
  padding: "20px 18px 58px",
  boxShadow: "0 18px 34px rgba(15, 23, 42, 0.26)",
  border: "1px solid rgba(255,255,255,0.10)",
};

const createEntryBrandRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: "5px",
  width: "100%",
};

const createEntryCardStyle = {
  ...preLoginCardStyle,
  marginTop: "-44px",
  borderRadius: "24px",
  padding: "22px 16px 16px",
  gap: "10px",
  position: "relative",
};

const createEntryIntroStyle = {
  textAlign: "center",
  display: "grid",
  gap: "10px",
  marginBottom: "4px",
};

const createEntryBadgeStyle = {
  justifySelf: "center",
  padding: "8px 12px",
  borderRadius: "999px",
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
  color: "#166534",
  fontSize: "12px",
  fontWeight: 900,
};

const createEntryTitleStyle = {
  margin: "4px 0 0",
  color: "#071528",
  fontSize: "30px",
  lineHeight: "32px",
  letterSpacing: "-0.06em",
};

const createEntryTextStyle = {
  margin: "0 auto 6px",
  maxWidth: "360px",
  color: "#52637a",
  fontSize: "14px",
  lineHeight: "20px",
  fontWeight: 700,
};

const authFieldLabelStyle = {
  margin: "2px 0 -4px",
  color: "#071528",
  fontSize: "13px",
  fontWeight: 900,
};

const createEntrySecondaryStyle = {
  display: "grid",
  gap: "8px",
  textAlign: "center",
};

const createEntryDividerStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  alignItems: "center",
  gap: "12px",
  color: "#64748b",
  fontSize: "13px",
  fontWeight: 900,
  margin: "4px 0 0",
};

const createEntryDividerLineStyle = {
  height: "1px",
  background: "#cbd5e1",
};

const createEntryLinkLineStyle = {
  margin: 0,
  color: "#334155",
  fontSize: "13px",
  lineHeight: "18px",
  fontWeight: 700,
};

const createEntryLinkButtonStyle = {
  border: "0",
  background: "transparent",
  color: "#0f5bd8",
  fontSize: "13px",
  fontWeight: 900,
  padding: 0,
  cursor: "pointer",
};

const createEntryTrustStyle = {
  marginTop: "8px",
  padding: "13px 14px",
  borderRadius: "16px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#334155",
  fontSize: "12px",
  fontWeight: 900,
  lineHeight: "18px",
  display: "grid",
  gap: "3px",
  textAlign: "center",
};

const preLoginNoteStyle = {
  marginTop: "12px",
  padding: "12px",
  borderRadius: "16px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#64748b",
  fontSize: "12px",
  fontWeight: 800,
  lineHeight: "17px",
  textAlign: "center",
};

const preLoginTrustStyle = {
  marginTop: "10px",
  padding: "10px 12px",
  borderRadius: "14px",
  background: "transparent",
  color: "#64748b",
  fontSize: "11px",
  fontWeight: 800,
  lineHeight: "18px",
  display: "grid",
  gap: "3px",
  textAlign: "center",
};

const authPanelStyle = {
  background: "#ffffff",
  borderBottom: "1px solid #e2e8f0",
  padding: "10px",
  display: "grid",
  gap: "8px",
};

const hiddenAuthPanelStyle = {
  display: "none",
};

const authHelperStyle = {
  padding: "12px",
  borderRadius: "16px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  textAlign: "center",
};

const authHelperTitleStyle = {
  color: "#071528",
  fontSize: "14px",
  fontWeight: 900,
  marginBottom: "4px",
};

const authHelperTextStyle = {
  color: "#64748b",
  fontSize: "12px",
  fontWeight: 800,
  lineHeight: "17px",
};

const authTabsStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "6px",
};


const authTabStyle = {
  padding: "9px 6px",
  borderRadius: "12px",
  border: "1px solid #cbd5e1",
  background: "#f8fafc",
  color: "#334155",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const authTabActiveStyle = {
  ...authTabStyle,
  background: "#071528",
  color: "#ffffff",
  borderColor: "#071528",
};

const authInputStyle = {
  width: "100%",
  height: "38px",
  padding: "8px 10px",
  borderRadius: "12px",
  border: "1px solid #cbd5e1",
  fontSize: "13px",
  boxSizing: "border-box",
};

const authPrimaryButtonStyle = {
  width: "100%",
  padding: "11px",
  borderRadius: "14px",
  border: "none",
  background: "#f5c542",
  color: "#071528",
  fontSize: "13px",
  fontWeight: 900,
  cursor: "pointer",
};

const authMessageStyle = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#64748b",
  borderRadius: "12px",
  padding: "8px",
  fontSize: "12px",
  fontWeight: 800,
};

const loggedInFooterStyle = {
  marginTop: "10px",
  padding: "8px 4px 12px",
  borderRadius: "0",
  background: "transparent",
  border: "none",
  color: "#64748b",
  fontSize: "11px",
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
};

const loggedInUserBlockStyle = {
  display: "grid",
  gap: "2px",
  minWidth: 0,
};


const footerLogoutButtonStyle = {
  border: "none",
  background: "transparent",
  color: "#0f172a",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
  textDecoration: "underline",
};

const footerSettingsButtonStyle = {
  ...footerLogoutButtonStyle,
  color: "#b38600",
};

const collapsedQueueStyle = {
  marginTop: "8px",
  padding: "10px 12px",
  borderRadius: "14px",
  background: "#f8fafc",
  border: "1px solid #eef2f7",
  color: "#64748b",
  fontSize: "12px",
  fontWeight: 800,
  textAlign: "center",
};

const pageStyle = {
  minHeight: "100dvh",
  background: "linear-gradient(180deg, #ecfdf5 0%, #f8fafc 55%)",
  padding: "0",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
  overflow: "hidden",
};

const phoneAppStyle = {
  maxWidth: "430px",
  margin: "0 auto",
  minHeight: "100dvh",
  height: "100dvh",
  background: "#f8fafc",
  boxShadow: "0 0 42px rgba(15, 23, 42, 0.20)",
  overflow: "hidden",
};

const resultTopNavStyle = {
  marginBottom: "10px",
};

const topBackButtonStyle = {
  width: "100%",
  padding: "11px",
  borderRadius: "15px",
  border: "1px solid #cbd5e1",
  background: "white",
  color: "#071528",
  fontSize: "14px",
  fontWeight: 900,
  cursor: "pointer",
};
const appHeaderStyle = {
  height: "48px",
  background: "rgba(243, 246, 251, 0.98)",
  borderBottom: "1px solid rgba(203, 213, 225, 0.7)",
  padding: "4px 12px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  boxSizing: "border-box",
};

const centeredLogoStyle = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "7px",
  textAlign: "left",
};

const logoImageStyle = {
  width: "28px",
  height: "28px",
  borderRadius: "8px",
  objectFit: "contain",
  background: "white",
};

const logoStyle = {
  margin: 0,
  fontSize: "18px",
  lineHeight: "18px",
  color: "#0f172a",
  letterSpacing: "-0.02em",
};

const taglineStyle = {
  margin: "0",
  fontSize: "9px",
  color: "#64748b",
  fontWeight: 600,
};

const screenStyle = {
  height: "100dvh",
  padding: "calc(10px + env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom))",
  display: "grid",
  gap: "10px",
  boxSizing: "border-box",
};

const scrollScreenStyle = {
  height: "100dvh",
  padding: "calc(10px + env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom))",
  boxSizing: "border-box",
  overflowY: "auto",
};

const heroCardStyle = {
  background: "linear-gradient(135deg, #071528 0%, #0d1f35 55%, #13243a 100%)",
  color: "white",
  borderRadius: "22px",
  padding: "15px 16px 14px",
  boxShadow: "0 14px 28px rgba(15, 23, 42, 0.24)",
  border: "1px solid rgba(255,255,255,0.10)",
};

const heroBrandRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: "5px",
  width: "100%",
  marginBottom: "13px",
};

const heroLogoImageStyle = {
  width: "38px",
  height: "38px",
  objectFit: "contain",
  background: "transparent",
  display: "block",
  transform: "translateY(1px)",
};

const heroBrandNameStyle = {
  margin: 0,
  color: "#ffffff",
  fontSize: "22px",
  lineHeight: "25px",
  fontWeight: 900,
  letterSpacing: "-0.04em",
};

const heroTitleStyle = {
  margin: 0,
  fontSize: "24px",
  lineHeight: "27px",
  letterSpacing: "-0.045em",
  color: "#ffffff",
};
const heroTextStyle = {
  color: "rgba(255,255,255,0.78)",
  lineHeight: "18px",
  margin: "5px 0 0",
  fontSize: "13px",
  whiteSpace: "pre-line",
};

const heroMainRowStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: "12px",
  alignItems: "center",
  marginBottom: "12px",
};

const heroCopyBlockStyle = {
  minWidth: 0,
};

const heroActionRowStyle = {
  display: "flex",
  justifyContent: "flex-end",
  marginBottom: "10px",
};

const heroButtonStyle = {
  width: "auto",
  minWidth: "145px",
  padding: "12px 13px",
  borderRadius: "16px",
  border: "none",
  background: "#f5c542",
  color: "#071528",
  fontSize: "13px",
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const heroQuickStartStyle = {
  marginTop: "2px",
  padding: "9px 10px",
  borderRadius: "16px",
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.08)",
  display: "grid",
  gridTemplateColumns: "1fr 128px",
  gap: "9px",
  alignItems: "center",
};

const heroQuickStartTextStyle = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  minWidth: 0,
};

const heroQuickStartIconStyle = {
  width: "25px",
  height: "25px",
  borderRadius: "999px",
  border: "1px solid rgba(255,255,255,0.20)",
  display: "grid",
  placeItems: "center",
  color: "#ffffff",
  fontSize: "12px",
  fontWeight: 900,
  flex: "0 0 auto",
};

const heroQuickStartLabelStyle = {
  margin: 0,
  color: "#ffffff",
  fontSize: "12px",
  lineHeight: "14px",
  fontWeight: 900,
};

const heroQuickStartHelpStyle = {
  margin: "2px 0 0",
  color: "rgba(255,255,255,0.72)",
  fontSize: "10.5px",
  lineHeight: "14px",
  fontWeight: 700,
};

const heroQuickStartSelectStyle = {
  width: "100%",
  height: "36px",
  padding: "7px 9px",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.20)",
  background: "#071528",
  color: "#ffffff",
  fontSize: "12px",
  fontWeight: 900,
  boxSizing: "border-box",
};
const defaultServiceCardStyle = {
  marginTop: "10px",
  background: "rgba(255,255,255,0.96)",
  borderRadius: "18px",
  padding: "12px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  display: "grid",
  gridTemplateColumns: "1fr 150px",
  gap: "10px",
  alignItems: "center",
  boxShadow: "0 10px 24px rgba(15, 23, 42, 0.08)",
};

const defaultServiceHelpStyle = {
  margin: "3px 0 0",
  fontSize: "11px",
  color: "#64748b",
  lineHeight: "15px",
};

const defaultServiceSelectStyle = {
  width: "100%",
  height: "38px",
  padding: "8px",
  borderRadius: "13px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: "12px",
  fontWeight: 800,
  boxSizing: "border-box",
};

const commandCenterStyle = {
  marginTop: "10px",
  background: "rgba(255,255,255,0.96)",
  borderRadius: "22px",
  padding: "13px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  boxShadow: "0 14px 30px rgba(15, 23, 42, 0.10)",
};

const commandEyebrowStyle = {
  margin: "0 0 9px",
  color: "#b38600",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.09em",
};

const statsGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr 1fr",
  gap: "7px",
};

const statBoxStyle = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "14px",
  padding: "8px 4px",
  display: "grid",
  gap: "2px",
  textAlign: "center",
  color: "#0f172a",
  fontSize: "10px",
};

const runAllButtonStyle = {
  width: "100%",
  marginTop: "10px",
  padding: "12px",
  borderRadius: "15px",
  border: "none",
  background: "#071528",
  color: "white",
  fontSize: "14px",
  fontWeight: 900,
  cursor: "pointer",
};

const premiumMiniCardStyle = {
  background: "rgba(255,255,255,0.92)",
  borderRadius: "18px",
  padding: "12px 14px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  fontSize: "13px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  boxShadow: "0 10px 24px rgba(15, 23, 42, 0.08)",
  marginTop: "10px",
};

const appActionsCardStyle = {
  marginTop: "9px",
  background: "rgba(255,255,255,0.92)",
  borderRadius: "18px",
  padding: "10px",
  border: "1px solid rgba(226, 232, 240, 0.90)",
  display: "grid",
  gap: "9px",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.05)",
};

const appActionsTopRowStyle = {
  display: "grid",
  gap: "8px",
};

const appActionsWeatherStyle = {
  display: "flex",
  alignItems: "center",
  gap: "9px",
  minWidth: 0,
  color: "#0f172a",
  fontSize: "12px",
  padding: "2px 2px 9px",
  borderBottom: "1px solid #eef2f7",
};

const weatherConnectedIconStyle = {
  width: "30px",
  height: "30px",
  borderRadius: "999px",
  border: "1px solid #bbf7d0",
  color: "#16a34a",
  display: "grid",
  placeItems: "center",
  fontSize: "16px",
  flex: "0 0 auto",
};

const appActionsButtonRowStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "7px",
  paddingTop: "1px",
};

const appActionButtonStyle = {
  width: "100%",
  padding: "8px 6px",
  borderRadius: "11px",
  border: "1px solid #e2e8f0",
  background: "#f8fafc",
  color: "#475569",
  fontSize: "10px",
  fontWeight: 900,
  cursor: "pointer",
};

function pushAlertButtonStyle(enabled) {
  return {
    ...appActionButtonStyle,
    gridColumn: "1 / -1",
    border: enabled ? "1px solid #bbf7d0" : "1px solid #cbd5e1",
    background: enabled ? "#f0fdf4" : "#ffffff",
    color: enabled ? "#166534" : "#071528",
    cursor: enabled ? "default" : "pointer",
  };
}

const pushAlertMessageStyle = {
  gridColumn: "1 / -1",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  borderRadius: "14px",
  padding: "9px 10px",
  fontSize: "12px",
  fontWeight: 800,
  lineHeight: "17px",
};

const installHelpStyle = {
  gridColumn: "1 / -1",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#713f12",
  borderRadius: "14px",
  padding: "10px",
  fontSize: "12px",
  fontWeight: 800,
  lineHeight: "17px",
};

const miniTextStyle = {
  margin: "3px 0 0",
  fontSize: "12px",
  color: "#64748b",
};

const goldDotStyle = {
  width: "12px",
  height: "12px",
  borderRadius: "999px",
  background: "#f5c542",
  boxShadow: "0 0 0 5px rgba(245, 197, 66, 0.18)",
};

const autoFinalNoticeStyle = {
  background: "linear-gradient(135deg, #071528 0%, #0d1f35 62%, #12352d 100%)",
  color: "white",
  borderRadius: "22px",
  padding: "14px",
  boxShadow: "0 16px 34px rgba(15, 23, 42, 0.22)",
  marginTop: "10px",
  border: "1px solid rgba(255,255,255,0.10)",
};

const autoFinalNoticeEyebrowStyle = {
  margin: "0 0 4px",
  color: "#f5c542",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const autoFinalNoticeTitleStyle = {
  margin: 0,
  fontSize: "16px",
  lineHeight: "20px",
  color: "#ffffff",
};

const autoFinalNoticeTextStyle = {
  margin: "5px 0 0",
  fontSize: "11.5px",
  lineHeight: "16px",
  color: "#dbeafe",
  fontWeight: 700,
};

const autoFinalNoticeListStyle = {
  display: "grid",
  gap: "8px",
  marginTop: "11px",
};

const autoFinalNoticeItemStyle = {
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "15px",
  padding: "10px",
  display: "grid",
  gap: "8px",
};

const autoFinalNoticeJobMetaStyle = {
  margin: "3px 0 0",
  fontSize: "11px",
  color: "#cbd5e1",
  fontWeight: 800,
};

const autoFinalNoticeButtonRowStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};

const autoFinalNoticeButtonStyle = {
  border: "1px solid #f5c542",
  background: "#f5c542",
  color: "#071528",
  borderRadius: "12px",
  padding: "9px 10px",
  fontSize: "12px",
  fontWeight: 900,
  cursor: "pointer",
};

const autoFinalDismissButtonStyle = {
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.08)",
  color: "#ffffff",
  borderRadius: "12px",
  padding: "9px 10px",
  fontSize: "12px",
  fontWeight: 900,
  cursor: "pointer",
};

const upcomingCardStyle = {
  background: "rgba(255,255,255,0.96)",
  borderRadius: "22px",
  padding: "10px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  boxShadow: "0 12px 26px rgba(15, 23, 42, 0.08)",
  marginTop: "9px",
};

const upcomingHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  paddingBottom: "8px",
  borderBottom: "1px solid #eef2f7",
};

const upcomingTitleStyle = {
  margin: 0,
  fontSize: "20px",
  lineHeight: "22px",
  color: "#0f172a",
};

const jobCountStyle = {
  minWidth: "30px",
  height: "30px",
  borderRadius: "999px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#713f12",
  display: "grid",
  placeItems: "center",
  fontWeight: 900,
};

const emptyQueueStyle = {
  marginTop: "12px",
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  borderRadius: "16px",
  padding: "12px",
  fontSize: "13px",
};

const emptyQueueTextStyle = {
  margin: "4px 0 0",
  color: "#64748b",
  lineHeight: "18px",
};

const emptyStateButtonStyle = {
  width: "100%",
  marginTop: "12px",
  padding: "12px",
  borderRadius: "15px",
  border: "none",
  background: "#071528",
  color: "white",
  fontSize: "14px",
  fontWeight: 900,
  cursor: "pointer",
};

const jobListStyle = {
  display: "grid",
  gap: "7px",
  marginTop: "8px",
};

const queueSectionHeaderStyle = {
  marginTop: "3px",
  padding: "8px 10px",
  borderRadius: "14px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
};

const sectionTitleWithIconStyle = {
  display: "flex",
  alignItems: "center",
  gap: "9px",
  minWidth: 0,
};

const actionRequiredIconStyle = {
  width: "24px",
  height: "24px",
  borderRadius: "999px",
  background: "#ef4444",
  color: "#ffffff",
  display: "grid",
  placeItems: "center",
  fontSize: "14px",
  fontWeight: 900,
  flex: "0 0 auto",
};

const greenSectionIconStyle = {
  ...actionRequiredIconStyle,
  background: "#16a34a",
  fontSize: "12px",
};

const actionRequiredBadgeStyle = {
  width: "fit-content",
  padding: "4px 8px",
  borderRadius: "999px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  display: "flex",
  alignItems: "center",
  gap: "5px",
  fontSize: "10px",
  lineHeight: "12px",
  fontWeight: 900,
};

const queueSectionTitleStyle = {
  margin: 0,
  fontSize: "14px",
  lineHeight: "17px",
  color: "#0f172a",
  fontWeight: 900,
};

const queueSectionHelpStyle = {
  margin: "3px 0 0",
  fontSize: "11px",
  lineHeight: "15px",
  color: "#64748b",
  fontWeight: 700,
};

const queueSectionCountStyle = {
  minWidth: "28px",
  height: "28px",
  borderRadius: "999px",
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
  color: "#166534",
  display: "grid",
  placeItems: "center",
  fontSize: "12px",
  fontWeight: 900,
};

const drawerCountPillStyle = {
  minWidth: "28px",
  height: "24px",
  padding: "0 8px",
  borderRadius: "999px",
  background: "#f1f5f9",
  color: "#071528",
  display: "grid",
  placeItems: "center",
  fontSize: "12px",
  fontWeight: 900,
};

const preliminaryDrawerButtonStyle = {
  width: "100%",
  marginTop: "8px",
  padding: "11px 12px",
  borderRadius: "14px",
  border: "1px solid #e2e8f0",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: "13px",
  fontWeight: 900,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  boxShadow: "0 6px 16px rgba(15, 23, 42, 0.04)",
};

const preliminaryDrawerContentStyle = {
  display: "grid",
  gap: "8px",
};

const jobCardStyle = {
  border: "1px solid #e2e8f0",
  borderRadius: "14px",
  padding: "9px 10px",
  background: "#ffffff",
  boxShadow: "0 4px 12px rgba(15, 23, 42, 0.03)",
  overflow: "hidden",
};

const jobCardContentStyle = {
  display: "grid",
  gap: "8px",
};

const jobCompactTopRowStyle = {
  display: "grid",
  gridTemplateColumns: "58px minmax(0, 1fr)",
  gap: "10px",
  alignItems: "center",
  minWidth: 0,
};

const jobMainColumnStyle = {
  minWidth: 0,
  display: "grid",
  gap: "3px",
};

const jobTitleStatusRowStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: "8px",
  alignItems: "center",
  minWidth: 0,
};

const jobServiceColumnStyle = {
  minWidth: 0,
  width: "58px",
  display: "grid",
  alignContent: "center",
  justifyItems: "center",
  gap: "6px",
  overflow: "hidden",
};

const jobWeatherIconStyle = {
  width: "28px",
  height: "28px",
  display: "grid",
  placeItems: "center",
  fontSize: "20px",
  lineHeight: "22px",
};

const jobInfoColumnStyle = {
  minWidth: 0,
  display: "grid",
  gap: "3px",
};

const jobActionColumnStyle = {
  minWidth: 0,
  display: "grid",
  gap: "6px",
  alignItems: "center",
  justifyItems: "stretch",
};

const jobTopRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "8px",
};

const jobTitleBlockStyle = {
  minWidth: 0,
  display: "grid",
  gap: "2px",
};

const serviceTagStyle = {
  width: "100%",
  maxWidth: "56px",
  boxSizing: "border-box",
  border: "1px solid #cbd5e1",
  borderRadius: "999px",
  padding: "4px 6px",
  background: "#f8fafc",
  color: "#475569",
  fontSize: "8.5px",
  lineHeight: "10px",
  fontWeight: 900,
  letterSpacing: "0.03em",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  textAlign: "center",
};

const jobBadgeStyle = {
  justifySelf: "end",
  maxWidth: "124px",
  boxSizing: "border-box",
  border: "1px solid",
  borderRadius: "999px",
  padding: "5px 9px",
  fontSize: "10.5px",
  lineHeight: "12px",
  fontWeight: 900,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const jobTitleStyle = {
  margin: 0,
  fontSize: "14px",
  color: "#0f172a",
  lineHeight: "17px",
  letterSpacing: "-0.025em",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const jobMetaStyle = {
  margin: 0,
  fontSize: "11px",
  color: "#334155",
  fontWeight: 800,
  lineHeight: "14px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const jobMetaSmallStyle = {
  margin: 0,
  fontSize: "10.5px",
  color: "#64748b",
  lineHeight: "14px",
  fontWeight: 700,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const latestResultStyle = {
  marginTop: "7px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "11px",
  padding: "6px 8px",
};

const latestResultLineStyle = {
  margin: "2px 0",
  fontSize: "10.5px",
  color: "#334155",
  lineHeight: "14px",
};

const compactReasonRowStyle = {
  marginTop: "8px",
  paddingTop: "8px",
  borderTop: "1px solid rgba(226, 232, 240, 0.9)",
  display: "grid",
  gridTemplateColumns: "34px 1fr",
  gap: "8px",
  alignItems: "center",
};

const compactReasonIconStyle = {
  width: "30px",
  height: "30px",
  display: "grid",
  placeItems: "center",
  fontSize: "19px",
};

const compactReasonTextStyle = {
  margin: 0,
  color: "#334155",
  fontSize: "12px",
  lineHeight: "16px",
  fontWeight: 700,
};

const jobErrorStyle = {
  marginTop: "8px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: "12px",
  padding: "8px",
  fontSize: "11px",
  fontWeight: 800,
};

const jobButtonGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr 1fr",
  gap: "6px",
  marginTop: "8px",
};

const compactJobButtonGridStyle = {
  display: "flex",
  gap: "8px",
  marginTop: 0,
  minWidth: 0,
  width: "100%",
};

const lockedJobButtonGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "6px",
  marginTop: "8px",
};

const lockedJobActionGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "6px",
  marginTop: "8px",
};

const rateCallBoxStyle = {
  marginTop: "8px",
  padding: "8px",
  borderRadius: "13px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
};

const ratedCallTextStyle = {
  margin: 0,
  fontSize: "12px",
  fontWeight: 900,
  lineHeight: "16px",
};

const rateCallLabelStyle = {
  margin: "0 0 6px",
  color: "#64748b",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const rateCallButtonGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "6px",
};

const feedbackButtonStyle = {
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  borderRadius: "13px",
  padding: "10px 4px",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const viewJobButtonStyle = {
  flex: 1,
  minWidth: 0,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#071528",
  borderRadius: "11px",
  padding: "9px 8px",
  minHeight: "36px",
  fontSize: "12px",
  lineHeight: "14px",
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const runJobButtonStyle = {
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "#071528",
  color: "white",
  borderRadius: "11px",
  padding: "9px 8px",
  minHeight: "36px",
  fontSize: "12px",
  lineHeight: "14px",
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const makeFinalCallButtonStyle = {
  ...runJobButtonStyle,
  background: "linear-gradient(135deg, #ea580c 0%, #c2410c 100%)",
};

const preparingFinalCallButtonStyle = {
  ...runJobButtonStyle,
  background: "#f8fafc",
  border: "1px solid #cbd5e1",
  color: "#64748b",
  cursor: "not-allowed",
};

const finalJobActionRowStyle = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gap: "8px",
  alignItems: "center",
  width: "100%",
  minWidth: 0,
};

const viewCallLinkButtonStyle = {
  border: "none",
  background: "transparent",
  color: "#071528",
  borderRadius: "11px",
  padding: "9px 4px",
  minHeight: "36px",
  fontSize: "12px",
  lineHeight: "14px",
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const messagesJobButtonWideStyle = {
  ...runJobButtonStyle,
  flex: "initial",
  width: "100%",
  justifyContent: "center",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  background: "linear-gradient(135deg, #071528 0%, #0d1f35 100%)",
  whiteSpace: "nowrap",
  overflow: "visible",
  textOverflow: "clip",
};

const messagesJobButtonIconStyle = {
  fontSize: "13px",
  lineHeight: "13px",
};

const messagesJobButtonStyle = {
  ...runJobButtonStyle,
  background: "linear-gradient(135deg, #071528 0%, #0d1f35 100%)",
};

const jobsSyncFooterStyle = {
  marginTop: "10px",
  paddingTop: "10px",
  borderTop: "1px solid #eef2f7",
  color: "#64748b",
  fontSize: "11px",
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
};

const jobSyncButtonStyle = {
  padding: 0,
  border: "none",
  background: "transparent",
  color: "#071528",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const smallRefreshButtonStyle = {
  marginTop: "4px",
  padding: 0,
  border: "none",
  background: "transparent",
  color: "#071528",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
  textDecoration: "underline",
};

const loadBackendJobsButtonStyle = {
  width: "100%",
  marginTop: "10px",
  marginBottom: "8px",
  padding: "11px",
  borderRadius: "15px",
  border: "1px solid #e2e8f0",
  background: "#ffffff",
  color: "#071528",
  fontSize: "13px",
  fontWeight: 900,
  cursor: "pointer",
};

const dateJobButtonStyle = {
  border: "1px solid #fde68a",
  background: "#fffbeb",
  color: "#713f12",
  borderRadius: "13px",
  padding: "10px 4px",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const dateEditBoxStyle = {
  marginTop: "8px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "13px",
  padding: "8px",
};

const dateEditInputStyle = {
  width: "100%",
  height: "38px",
  padding: "8px 10px",
  borderRadius: "12px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: "13px",
  fontWeight: 800,
  boxSizing: "border-box",
};

const dateEditButtonGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "6px",
  marginTop: "7px",
};

const saveDateButtonStyle = {
  border: "none",
  background: "#071528",
  color: "white",
  borderRadius: "12px",
  padding: "9px 4px",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const cancelDateButtonStyle = {
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#334155",
  borderRadius: "12px",
  padding: "9px 4px",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const deleteJobButtonStyle = {
  border: "1px solid #fecaca",
  background: "#fef2f2",
  color: "#991b1b",
  borderRadius: "13px",
  padding: "10px 4px",
  fontSize: "11px",
  fontWeight: 900,
  cursor: "pointer",
};

const cardStyle = {
  background: "rgba(255,255,255,0.96)",
  borderRadius: "24px",
  padding: "14px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  boxShadow: "0 14px 30px rgba(15, 23, 42, 0.10)",
};

const screenBackButtonStyle = {
  width: "100%",
  marginBottom: "9px",
  padding: "9px 11px",
  borderRadius: "13px",
  border: "1px solid #dbe3ec",
  background: "#ffffff",
  color: "#071528",
  fontSize: "12px",
  fontWeight: 900,
  textAlign: "left",
  cursor: "pointer",
};

const dashboardSettingsGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: "8px",
};

const dashboardSettingsButtonStyle = {
  width: "100%",
  minWidth: 0,
  padding: "11px 12px",
  borderRadius: "14px",
  border: "1px solid #dbe3ec",
  background: "#ffffff",
  color: "#071528",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  textAlign: "left",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 900,
};

const dashboardSettingsTextStyle = {
  minWidth: 0,
  display: "grid",
  gap: "3px",
};

const dashboardSettingsChevronStyle = {
  color: "#64748b",
  fontSize: "20px",
  lineHeight: 1,
  flex: "0 0 auto",
};

const compactSettingsHeaderStyle = {
  padding: "2px 1px 10px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
  borderBottom: "1px solid #eef2f7",
};

const settingsAccordionListStyle = {
  marginTop: "9px",
  display: "grid",
  gap: "8px",
};

const settingsAccordionItemStyle = {
  overflow: "hidden",
  borderRadius: "15px",
  border: "1px solid #dfe7ef",
  background: "#ffffff",
};

const settingsAccordionButtonStyle = {
  width: "100%",
  padding: "12px",
  border: "none",
  background: "transparent",
  display: "grid",
  gridTemplateColumns: "1fr auto",
  alignItems: "center",
  gap: "10px",
  textAlign: "left",
  cursor: "pointer",
};

const settingsAccordionTextStyle = {
  display: "grid",
  gap: "3px",
  minWidth: 0,
  color: "#0f172a",
  fontSize: "13px",
};

const settingsAccordionChevronStyle = {
  width: "26px",
  height: "26px",
  borderRadius: "999px",
  display: "grid",
  placeItems: "center",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  fontSize: "16px",
  fontWeight: 900,
};

const settingsAccordionBodyStyle = {
  padding: "0 12px 12px",
  borderTop: "1px solid #eef2f7",
};

const compactSelectedValueStyle = {
  padding: "8px 10px",
  borderRadius: "12px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  display: "flex",
  justifyContent: "space-between",
  gap: "10px",
  alignItems: "center",
  color: "#0f172a",
  fontSize: "12px",
};

const settingsDetailsStyle = {
  marginTop: "8px",
  color: "#64748b",
  fontSize: "11px",
  lineHeight: "15px",
  fontWeight: 700,
};

const accountProfileCardStyle = {
  marginTop: "8px",
  padding: "12px",
  borderRadius: "15px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#0f172a",
};

const accountProfileTextStyle = {
  display: "grid",
  gap: "4px",
  minWidth: 0,
};

const accountProfileEmailStyle = {
  color: "#0f172a",
  fontSize: "13px",
  lineHeight: "17px",
  overflowWrap: "anywhere",
};

const accountProfileMetaStyle = {
  color: "#64748b",
  fontSize: "11px",
  lineHeight: "15px",
  fontWeight: 800,
  textTransform: "capitalize",
};

const accountMenuRowStyle = {
  width: "100%",
  padding: "10px 0",
  border: "none",
  background: "transparent",
  color: "#0f172a",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  fontSize: "13px",
  lineHeight: "16px",
  fontWeight: 900,
  textAlign: "left",
  cursor: "pointer",
  textDecoration: "none",
};

const settingsDangerPanelStyle = {
  marginTop: "10px",
  padding: "10px",
  borderRadius: "15px",
  background: "#fff7f7",
  border: "1px solid #fecaca",
};

const dangerEyebrowStyle = {
  margin: "0 0 3px",
  color: "#b91c1c",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.09em",
};

const dangerMenuRowStyle = {
  ...accountMenuRowStyle,
  color: "#991b1b",
};

const deleteExplanationStyle = {
  margin: "9px 0",
  padding: "11px",
  borderRadius: "14px",
  background: "#fff7f7",
  border: "1px solid #fecaca",
  color: "#7f1d1d",
  fontSize: "12px",
  lineHeight: "16px",
};

const dangerMessageStyle = {
  margin: "8px 0",
  padding: "10px",
  borderRadius: "13px",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  fontSize: "12px",
  fontWeight: 800,
};

const destructiveButtonStyle = {
  width: "100%",
  marginTop: "8px",
  padding: "12px",
  borderRadius: "14px",
  border: "1px solid #991b1b",
  background: "#b91c1c",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 900,
  cursor: "pointer",
};

const authTextLinkButtonStyle = {
  width: "100%",
  marginTop: "8px",
  border: "none",
  background: "transparent",
  color: "#334155",
  fontSize: "12px",
  fontWeight: 900,
  cursor: "pointer",
  textDecoration: "underline",
};

const settingsCardStyle = {
  ...cardStyle,
  padding: "12px",
};

const sectionHeaderStyle = {
  marginBottom: "7px",
  paddingBottom: "7px",
  borderBottom: "1px solid #eef2f7",
};

const eyebrowStyle = {
  margin: "0 0 3px",
  color: "#b38600",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.09em",
};

const pageTitleStyle = {
  margin: 0,
  fontSize: "20px",
  lineHeight: "22px",
  color: "#0f172a",
  letterSpacing: "-0.02em",
};

const settingsIntroTextStyle = {
  margin: "4px 0 0",
  color: "#64748b",
  fontSize: "11px",
  lineHeight: "15px",
  fontWeight: 700,
};

const settingsSummaryCardStyle = {
  marginTop: "8px",
  padding: "9px",
  borderRadius: "15px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
  color: "#0f172a",
  fontSize: "13px",
};

const settingsRolePillStyle = {
  padding: "5px 9px",
  borderRadius: "999px",
  background: "#fff7d6",
  border: "1px solid #f5c542",
  color: "#7a5a00",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
};

const settingsPanelStyle = {
  marginTop: "9px",
  padding: "10px",
  borderRadius: "16px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  boxShadow: "0 6px 16px rgba(15, 23, 42, 0.04)",
};

const settingsPanelTitleStyle = {
  margin: "0 0 3px",
  color: "#0f172a",
  fontSize: "15px",
  lineHeight: "18px",
};

const cautionSliderLabelRowStyle = {
  marginTop: "9px",
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "6px",
  color: "#64748b",
  fontSize: "10px",
  lineHeight: "13px",
  fontWeight: 900,
  textAlign: "center",
};

const companySettingsRangeStyle = {
  width: "100%",
  margin: "8px 0 6px",
  accentColor: "#f5c542",
  cursor: "pointer",
};

const selectedCautionCardStyle = {
  padding: "8px",
  borderRadius: "14px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#0f172a",
  display: "grid",
  gap: "4px",
  fontSize: "13px",
};

const settingsAlertCardStyle = {
  marginTop: "8px",
  padding: "9px",
  borderRadius: "15px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  display: "grid",
  gap: "7px",
  color: "#0f172a",
  fontSize: "13px",
};

function settingsStatusPillStyle(enabled) {
  return {
    justifySelf: "start",
    padding: "5px 9px",
    borderRadius: "999px",
    background: enabled ? "#ecfdf5" : "#f8fafc",
    border: enabled ? "1px solid #bbf7d0" : "1px solid #cbd5e1",
    color: enabled ? "#166534" : "#475569",
    fontSize: "10px",
    fontWeight: 900,
    textTransform: "uppercase",
  };
}

function settingsAlertToggleButtonStyle(enabled) {
  return {
    width: "100%",
    borderRadius: "14px",
    padding: "9px 11px",
    border: enabled ? "1px solid #fed7aa" : "1px solid #bbf7d0",
    background: enabled ? "#fff7ed" : "#ecfdf5",
    color: enabled ? "#9a3412" : "#166534",
    fontSize: "12px",
    fontWeight: 900,
    cursor: "pointer",
  };
}

const settingsCompactListStyle = {
  marginTop: "8px",
  display: "grid",
  gap: "0",
};

const settingsCompactRowStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: "12px",
  alignItems: "center",
  padding: "7px 0",
};

const settingsCompactTextStyle = {
  minWidth: 0,
};

const settingsCompactTitleStyle = {
  display: "block",
  color: "#0f172a",
  fontSize: "13px",
  lineHeight: "16px",
  fontWeight: 900,
};

const settingsCompactHelpStyle = {
  margin: "3px 0 0",
  color: "#64748b",
  fontSize: "11px",
  lineHeight: "15px",
  fontWeight: 700,
};

const settingsCompactDividerStyle = {
  height: "1px",
  background: "#e2e8f0",
};

function settingsCompactToggleStyle(enabled) {
  return {
    minWidth: "48px",
    height: "30px",
    borderRadius: "999px",
    border: enabled ? "1px solid #bbf7d0" : "1px solid #cbd5e1",
    background: enabled ? "#ecfdf5" : "#f8fafc",
    color: enabled ? "#166534" : "#475569",
    fontSize: "10px",
    fontWeight: 900,
    cursor: "pointer",
    textTransform: "uppercase",
  };
}

const settingsFinePrintStyle = {
  margin: "6px 0 0",
  color: "#64748b",
  fontSize: "11px",
  lineHeight: "16px",
  fontWeight: 700,
};

const settingsMessageStyle = {
  marginTop: "8px",
  padding: "9px",
  borderRadius: "14px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  color: "#475569",
  fontSize: "12px",
  lineHeight: "16px",
  fontWeight: 800,
};

const settingsActionFooterStyle = {
  marginTop: "8px",
  paddingTop: "8px",
  position: "sticky",
  bottom: "0",
  background: "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.98) 28%)",
  borderRadius: "0 0 18px 18px",
  zIndex: 3,
};

const locationSearchWrapStyle = {
  position: "relative",
  marginTop: "8px",
};

const locationHelpStyle = {
  margin: "5px 0 0",
  fontSize: "11px",
  color: "#64748b",
  fontWeight: 700,
};

const selectedLocationStyle = {
  marginTop: "7px",
  background: "#f0fdf4",
  borderRadius: "12px",
  padding: "8px",
  color: "#14532d",
  display: "grid",
  gap: "2px",
  fontSize: "11px",
  lineHeight: "15px",
};

const suggestionListStyle = {
  marginTop: "6px",
  background: "white",
  borderRadius: "14px",
  boxShadow: "0 14px 28px rgba(15, 23, 42, 0.16)",
  overflow: "hidden",
  display: "grid",
  border: "1px solid #e2e8f0",
};

const suggestionButtonStyle = {
  width: "100%",
  border: "none",
  background: "white",
  padding: "10px",
  textAlign: "left",
  display: "grid",
  gap: "2px",
  fontSize: "12px",
  color: "#0f172a",
  cursor: "pointer",
  borderBottom: "1px solid #f1f5f9",
};

const locationErrorTextStyle = {
  margin: "6px 0 0",
  fontSize: "11px",
  color: "#991b1b",
  fontWeight: 800,
};

const labelStyle = {
  display: "block",
  marginTop: "8px",
};

const labelTextStyle = {
  display: "block",
  fontWeight: 800,
  marginBottom: "4px",
  color: "#172033",
  fontSize: "12px",
};

const fieldHelpTextStyle = {
  margin: "4px 0 0",
  fontSize: "11px",
  color: "#64748b",
  lineHeight: "15px",
  fontWeight: 700,
};

const inputStyle = {
  width: "100%",
  height: "39px",
  padding: "9px 10px",
  borderRadius: "13px",
  border: "1px solid #cbd5e1",
  boxSizing: "border-box",
  fontSize: "14px",
  background: "#ffffff",
  color: "#0f172a",
  outline: "none",
  boxShadow: "inset 0 1px 0 rgba(15,23,42,0.03)",
};

const datePickerShellStyle = {
  width: "100%",
  height: "39px",
  padding: "9px 10px",
  borderRadius: "13px",
  border: "1px solid #cbd5e1",
  boxSizing: "border-box",
  background: "#ffffff",
  color: "#0f172a",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
  overflow: "hidden",
  boxShadow: "inset 0 1px 0 rgba(15,23,42,0.03)",
};

const datePickerTextStyle = {
  fontSize: "14px",
  fontWeight: 500,
  color: "#0f172a",
  pointerEvents: "none",
};

const hiddenDateInputStyle = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  opacity: 0,
  cursor: "pointer",
};

const selectStyle = {
  ...inputStyle,
  appearance: "auto",
};

const twoColumnStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};

const segmentedFieldStyle = {
  display: "block",
  marginTop: "8px",
};

const segmentedControlStyle = {
  width: "100%",
  height: "39px",
  padding: "3px",
  borderRadius: "13px",
  border: "1px solid #cbd5e1",
  background: "#f8fafc",
  boxSizing: "border-box",
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "3px",
};

const segmentedButtonStyle = {
  border: "0",
  borderRadius: "10px",
  background: "transparent",
  color: "#64748b",
  fontSize: "12px",
  fontWeight: 900,
  cursor: "pointer",
};

const segmentedButtonActiveStyle = {
  ...segmentedButtonStyle,
  background: "#071528",
  color: "#ffffff",
  boxShadow: "0 5px 12px rgba(7, 21, 40, 0.18)",
};

const checkboxCardStyle = {
  marginTop: "10px",
  display: "flex",
  gap: "10px",
  alignItems: "flex-start",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: "14px",
  padding: "10px",
  color: "#713f12",
  fontSize: "13px",
};

const checkboxStyle = {
  marginTop: "2px",
  width: "18px",
  height: "18px",
  accentColor: "#071528",
};

const checkboxHelpStyle = {
  margin: "3px 0 0",
  fontSize: "12px",
  color: "#92400e",
};

const primaryButtonStyle = {
  width: "100%",
  marginTop: "10px",
  padding: "13px",
  borderRadius: "16px",
  border: "none",
  background: "#071528",
  color: "white",
  fontSize: "15px",
  fontWeight: 900,
  cursor: "pointer",
  boxShadow: "0 10px 18px rgba(7, 21, 40, 0.22)",
};

const secondaryButtonStyle = {
  width: "100%",
  marginTop: "7px",
  padding: "11px",
  borderRadius: "15px",
  border: "1px solid #cbd5e1",
  background: "white",
  color: "#172033",
  fontSize: "14px",
  fontWeight: 800,
  cursor: "pointer",
};

const smallHeaderButtonStyle = {
  width: "30px",
  height: "30px",
  borderRadius: "999px",
  border: "1px solid #cbd5e1",
  background: "white",
  color: "#0f172a",
  fontSize: "15px",
  fontWeight: 900,
  cursor: "pointer",
  boxShadow: "0 4px 10px rgba(15, 23, 42, 0.06)",
};

const loadingStatusStyle = {
  marginTop: "9px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  color: "#92400e",
  borderRadius: "13px",
  padding: "9px",
  fontSize: "12px",
  fontWeight: 800,
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const spinnerDotStyle = {
  width: "9px",
  height: "9px",
  borderRadius: "999px",
  background: "#f5c542",
  boxShadow: "0 0 0 4px rgba(245, 197, 66, 0.22)",
};

const errorBoxStyle = {
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: "13px",
  padding: "9px",
  fontSize: "12px",
  fontWeight: 800,
};

const messagesHeroCardStyle = {
  background: "linear-gradient(135deg, #071528 0%, #0d1f35 100%)",
  color: "white",
  borderRadius: "22px",
  padding: "16px",
  border: "1px solid rgba(255,255,255,0.10)",
  boxShadow: "0 16px 32px rgba(15, 23, 42, 0.16)",
};

const messagesHeroTopRowStyle = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "12px",
};

const messagesHeroTitleStyle = {
  margin: 0,
  color: "#ffffff",
  fontSize: "24px",
  lineHeight: "27px",
  letterSpacing: "-0.04em",
};

const messagesHeroMetaStyle = {
  margin: "5px 0 0",
  color: "rgba(255,255,255,0.78)",
  fontSize: "12px",
  fontWeight: 800,
  lineHeight: "17px",
};

const messagesSignalPillStyle = (signal) => {
  const normalized = String(signal || "").toUpperCase();
  const isGo = normalized === "GO" || normalized === "FAVORABLE";
  const isWatch = normalized === "WATCH";

  return {
    flexShrink: 0,
    padding: "8px 10px",
    borderRadius: "999px",
    background: isGo ? "#ecfdf5" : isWatch ? "#fffbeb" : "#fef2f2",
    border: `1px solid ${isGo ? "#bbf7d0" : isWatch ? "#fde68a" : "#fecaca"}`,
    color: isGo ? "#166534" : isWatch ? "#713f12" : "#991b1b",
    fontSize: "11px",
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    textAlign: "center",
    whiteSpace: "nowrap",
  };
};

const resultCardStyle = {
  background: "rgba(255,255,255,0.97)",
  borderRadius: "24px",
  padding: "13px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  boxShadow: "0 14px 30px rgba(15, 23, 42, 0.10)",
};

const resultSummaryCardStyle = {
  background: "#f8fafc",
  borderRadius: "22px",
  padding: "18px",
  border: "1px solid rgba(226, 232, 240, 0.95)",
  boxShadow: "0 16px 32px rgba(15, 23, 42, 0.12)",
};

const resultSummaryEyebrowStyle = {
  margin: "0 0 10px",
  color: "#b38600",
  fontSize: "11px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.09em",
};

const resultSummaryTopRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "12px",
};

const resultSummarySignalStyle = {
  margin: 0,
  fontSize: "34px",
  lineHeight: "36px",
  color: "#0f172a",
  letterSpacing: "-0.04em",
};

const resultSummarySubTextStyle = {
  margin: "4px 0 0",
  color: "#475569",
  fontSize: "13px",
  fontWeight: 700,
  lineHeight: "18px",
};

const resultCheckedAtStyle = {
  margin: "3px 0 0",
  color: "#64748b",
  fontSize: "10px",
  fontWeight: 800,
  lineHeight: "13px",
};

const resultScoreBadgeStyle = {
  minWidth: "86px",
  minHeight: "86px",
  borderRadius: "999px",
  background: "#071528",
  color: "white",
  display: "grid",
  placeItems: "center",
  alignContent: "center",
  boxShadow: "0 12px 24px rgba(7, 21, 40, 0.24)",
  textAlign: "center",
};

const resultScoreRiskLabelStyle = {
  fontSize: "12px",
  lineHeight: "13px",
  fontWeight: 900,
  letterSpacing: "-0.04em",
};

const resultScorePointStyle = {
  marginTop: "2px",
  fontSize: "11px",
  lineHeight: "13px",
  fontWeight: 700,
  opacity: 0.88,
};

const resultSummaryDividerStyle = {
  height: "1px",
  background: "rgba(203, 213, 225, 0.75)",
  margin: "14px 0",
};

const resultSummaryLabelStyle = {
  margin: "10px 0 4px",
  color: "#64748b",
  fontSize: "10px",
  fontWeight: 900,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const resultProductionWindowStyle = {
  margin: 0,
  color: "#0f172a",
  fontSize: "22px",
  lineHeight: "25px",
};

const resultMainReasonStyle = {
  margin: 0,
  color: "#0f172a",
  fontSize: "14px",
  lineHeight: "20px",
  fontWeight: 700,
};

const resultTopRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "10px",
};

const signalTitleStyle = {
  margin: 0,
  fontSize: "25px",
  lineHeight: "26px",
  color: "#0f172a",
  letterSpacing: "-0.03em",
};

const signalSubTextStyle = {
  margin: "2px 0 0",
  color: "#64748b",
  fontSize: "12px",
  fontWeight: 600,
};

const scorePillStyle = {
  minWidth: "64px",
  padding: "8px",
  borderRadius: "16px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  textAlign: "center",
  display: "grid",
  gap: "0",
  color: "#713f12",
};

const callTypeBannerStyle = {
  marginTop: "8px",
  padding: "9px",
  borderRadius: "14px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  display: "flex",
  justifyContent: "space-between",
  gap: "10px",
  fontSize: "12px",
  color: "#0f172a",
};

const riskBarStyle = {
  position: "relative",
  height: "28px",
  borderRadius: "999px",
  background: "#f1f5f9",
  border: "1px solid #e2e8f0",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-around",
  fontSize: "15px",
  marginTop: "8px",
};

const riskMarkerStyle = {
  position: "absolute",
  top: "14px",
  color: "#071528",
  fontSize: "13px",
};

const bestWindowCardStyle = {
  marginTop: "9px",
  padding: "10px",
  borderRadius: "15px",
  background: "#071528",
  color: "white",
  border: "1px solid rgba(255,255,255,0.08)",
};

const bestWindowLabelStyle = {
  margin: "0 0 3px",
  fontSize: "10px",
  fontWeight: 900,
  color: "#f5c542",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const bestWindowTitleStyle = {
  margin: 0,
  fontSize: "19px",
  lineHeight: "22px",
};

const bestWindowSubStyle = {
  margin: "3px 0 0",
  fontSize: "12px",
  color: "rgba(255,255,255,0.78)",
  fontWeight: 700,
};

const agreementCardStyle = {
  marginTop: "9px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "15px",
  padding: "10px",
};

const agreementTitleStyle = {
  margin: "0 0 5px",
  color: "#071528",
  fontWeight: 900,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const agreementLineStyle = {
  margin: "4px 0",
  color: "#64748b",
  fontSize: "12px",
  lineHeight: "16px",
  fontWeight: 700,
};

const weatherBoxStyle = {
  marginTop: "8px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "15px",
  padding: "9px",
};

const weatherDetailsCardStyle = {
  marginTop: "9px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "16px",
  overflow: "hidden",
};

const weatherDetailsToggleStyle = {
  width: "100%",
  padding: "12px",
  border: "none",
  background: "#ffffff",
  color: "#071528",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: "13px",
  fontWeight: 900,
  cursor: "pointer",
};

const weatherDetailsContentStyle = {
  borderTop: "1px solid #e2e8f0",
  padding: "10px 12px",
  background: "#f8fafc",
};

const projectDetailsCardStyle = {
  marginTop: "9px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "14px",
  padding: "9px 11px",
};
const projectActionsCardStyle = {
  ...projectDetailsCardStyle,
};

const callFeedbackCardStyle = {
  ...projectDetailsCardStyle,
};

const projectActionGridStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};


const projectDetailsPrimaryStyle = {
  margin: "0",
  color: "#0f172a",
  fontSize: "12px",
  fontWeight: 900,
  lineHeight: "16px",
};

const projectDetailsSecondaryStyle = {
  margin: "3px 0 0",
  color: "#64748b",
  fontSize: "11px",
  fontWeight: 800,
  lineHeight: "15px",
};

const projectDetailsTitleStyle = {
  margin: "0 0 8px",
  fontWeight: 900,
  fontSize: "12px",
  color: "#071528",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const weatherTitleStyle = {
  margin: "0 0 6px",
  fontWeight: 900,
  fontSize: "11px",
  color: "#1e3a8a",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const actionCardStyle = {
  marginTop: "9px",
  background: "#f0fdf4",
  border: "1px solid #bbf7d0",
  borderRadius: "15px",
  padding: "10px",
};

const actionTitleStyle = {
  margin: "0 0 5px",
  color: "#166534",
  fontWeight: 900,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const actionTextStyle = {
  margin: 0,
  color: "#14532d",
  fontSize: "12px",
  lineHeight: "17px",
  fontWeight: 700,
};

const whyCardStyle = {
  marginTop: "9px",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: "15px",
  padding: "10px",
};

const whyTitleStyle = {
  margin: "0 0 5px",
  color: "#713f12",
  fontWeight: 900,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const whyPointStyle = {
  margin: "4px 0",
  color: "#713f12",
  fontSize: "12px",
  lineHeight: "16px",
  fontWeight: 700,
};

const summaryCompactStyle = {
  marginTop: "9px",
  display: "grid",
  gap: "4px",
};

const summaryLineStyle = {
  display: "flex",
  justifyContent: "space-between",
  gap: "10px",
  borderBottom: "1px solid #f1f5f9",
  paddingBottom: "4px",
  fontSize: "12px",
};

const summaryLabelStyle = {
  color: "#64748b",
  fontWeight: 800,
};

const summaryValueStyle = {
  color: "#0f172a",
  fontWeight: 900,
  textAlign: "right",
};

const outputBoxStyle = {
  marginTop: "8px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: "15px",
  padding: "9px",
};

const resultHeadingStyle = {
  margin: "0 0 7px",
  fontWeight: 900,
  fontSize: "12px",
};

const resultLineStyle = {
  margin: "5px 0",
  fontSize: "12px",
  lineHeight: "16px",
  color: "#0f172a",
};

const copyActionCardStyle = {
  marginTop: "10px",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "16px",
  padding: "10px",
};

const copyActionTitleStyle = {
  margin: "0 0 8px",
  fontWeight: 900,
  fontSize: "12px",
  color: "#071528",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const communicationHelpStyle = {
  margin: "-4px 0 8px",
  color: "#64748b",
  fontSize: "11px",
  fontWeight: 700,
  lineHeight: "15px",
};

const copyNoticeStyle = {
  background: "#f0fdf4",
  border: "1px solid #bbf7d0",
  color: "#166534",
  borderRadius: "12px",
  padding: "8px",
  fontSize: "12px",
  fontWeight: 800,
  marginBottom: "8px",
};

const copyGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "6px",
};

const copyButtonStyle = {
  width: "100%",
  minWidth: 0,
  padding: "10px 4px",
  borderRadius: "13px",
  border: "1px solid #fde68a",
  background: "#fffbeb",
  color: "#713f12",
  fontSize: "11.5px",
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const messageAudienceTabsStyle = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gap: "6px",
  marginBottom: "9px",
};

const messageAudienceTabStyle = {
  border: "1px solid #cbd5e1",
  background: "#f8fafc",
  color: "#334155",
  borderRadius: "13px",
  padding: "10px 6px",
  fontSize: "12px",
  fontWeight: 900,
  cursor: "pointer",
};

const messageAudienceTabActiveStyle = {
  ...messageAudienceTabStyle,
  borderColor: "#f5c542",
  background: "#fffbeb",
  color: "#713f12",
};

const messagePreviewLabelStyle = {
  display: "grid",
  gap: "7px",
  color: "#071528",
  fontSize: "12px",
  fontWeight: 900,
  marginBottom: "9px",
};

const messageTextAreaStyle = {
  width: "100%",
  minHeight: "220px",
  resize: "vertical",
  border: "1px solid #cbd5e1",
  borderRadius: "14px",
  padding: "11px",
  background: "#f8fafc",
  color: "#0f172a",
  fontSize: "13px",
  lineHeight: "18px",
  fontWeight: 700,
  boxSizing: "border-box",
  whiteSpace: "pre-wrap",
};

const messageResetButtonStyle = {
  width: "100%",
  marginTop: "7px",
  padding: "10px 6px",
  borderRadius: "13px",
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#334155",
  fontSize: "12px",
  fontWeight: 900,
  cursor: "pointer",
};
