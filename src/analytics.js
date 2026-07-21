const ANALYTICS_CONTEXT = {
  site_area: "app",
  product: "fieldcall",
};

function getSanitizedPageContext() {
  try {
    const url = new URL(window.location.href);

    // The guest payload contains encoded job details and must never be sent to
    // Google Analytics through page_location or page_path.
    url.searchParams.delete("payload");
    if (url.hash.includes("payload=")) url.hash = "";

    return {
      page_location: url.toString(),
      page_path: `${url.pathname}${url.search}`,
    };
  } catch {
    return {
      page_location: "https://app.myfieldcall.com/",
      page_path: "/",
    };
  }
}

export function getAnalyticsEntryContext() {
  try {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode") || "standard";
    const entrySource =
      params.get("entry") ||
      (params.get("from") === "guest" ? "guest_assessment" : "direct");

    return {
      entry_mode: mode,
      entry_source: entrySource,
    };
  } catch {
    return {
      entry_mode: "standard",
      entry_source: "direct",
    };
  }
}

export function trackEvent(eventName, parameters = {}) {
  try {
    if (typeof window === "undefined" || typeof window.gtag !== "function") return;

    window.gtag("event", eventName, {
      ...ANALYTICS_CONTEXT,
      ...getSanitizedPageContext(),
      ...parameters,
      transport_type: "beacon",
    });
  } catch {
    // Analytics must never break the app.
  }
}

export function trackPageView(_pathname, title = document.title) {
  try {
    if (typeof window === "undefined" || typeof window.gtag !== "function") return;

    window.gtag("event", "page_view", {
      ...ANALYTICS_CONTEXT,
      ...getAnalyticsEntryContext(),
      ...getSanitizedPageContext(),
      page_title: title || document.title,
    });
  } catch {
    // Analytics must never interrupt app startup.
  }
}
