const CHECK_STATUSES = new Set([
  "matched_campaign",
  "possible_match",
  "new_unmatched_case",
  "not_scam",
]);

function concise(value, maximum = 100) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function label(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function percent(value) {
  const number = Number(value);
  return Math.round(Math.max(0, Math.min(1, Number.isFinite(number) ? number : 0)) * 100);
}

function formatDate(value, fallback = "CURRENT") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date).toUpperCase();
}

function publicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function evidenceSource(value) {
  const normalized = String(value || "input").toUpperCase();
  if (normalized.includes("IMAGE") || normalized.includes("VISION") || normalized.includes("QR")) return "IMAGE";
  if (normalized.includes("URL") || normalized.includes("DOMAIN")) return "URL";
  return "TEXT";
}

function inputRows(analysis, artifact) {
  const sources = [...new Set(
    (analysis.indicators || []).map((indicator) => evidenceSource(indicator.evidenceSource)),
  )];
  return (sources.length ? sources : ["INPUT"]).map((source) => [source, concise(artifact, 86)]);
}

function resultCopy(status, campaign) {
  const isConfirmed = status === "matched_campaign" && campaign?.analystConfirmed === true;
  if (isConfirmed) {
    return {
      kicker: "KNOWN CAMPAIGN",
      heading: "Pause this transfer.",
      context: "CONFIRMED CAMPAIGN MATCH",
      match: "ANALYST CONFIRMED",
    };
  }
  if (["matched_campaign", "possible_match"].includes(status)) {
    return {
      kicker: "POSSIBLE CAMPAIGN MATCH",
      heading: "Pause this transfer.",
      context: "UNCONFIRMED CAMPAIGN EVIDENCE",
      match: `${percent(campaign?.matchScore)}% MATCH SCORE`,
    };
  }
  if (status === "new_unmatched_case") {
    return {
      kicker: "NEW UNMATCHED CASE",
      heading: "Treat this as suspicious.",
      context: "NO CAMPAIGN ASSIGNED",
      match: "NEW CASE",
    };
  }
  return {
    kicker: "NO CONCRETE SCAM CASE",
    heading: "No scam case detected.",
    context: "CONSERVATIVE ANALYSIS",
    match: "NOT A SPECIFIC CASE",
  };
}

function evidenceRows(payload) {
  const analysis = payload.analysis;
  const campaign = payload.campaign;
  const rows = [];
  for (const reason of campaign?.matchedReasons || []) {
    rows.push([
      `${String(reason.role || "evidence").toUpperCase()} MATCH`,
      concise(reason.normalizedValue || reason.reason || "Exact indicator match", 90),
      `${concise(reason.reason, 100)} · weight ${Number(reason.weight || 0).toFixed(2)}`,
      evidenceSource(reason.indicatorType),
      `${percent(reason.scoreContribution)}%`,
    ]);
  }
  rows.push([
    "CLASSIFICATION",
    label(analysis.primaryCategory),
    analysis.specificCase ? "specific case detected" : "general or non-specific content",
    "TEXT",
    `${percent(analysis.confidence)}%`,
  ]);
  rows.push([
    "SEVERITY",
    `${analysis.severity} / 5`,
    concise(analysis.summary, 130),
    "TEXT",
    `${analysis.severity}/5`,
  ]);
  for (const indicator of (analysis.indicators || []).filter((item) => item.matchEligible).slice(0, 4)) {
    rows.push([
      label(indicator.type).toUpperCase(),
      concise(indicator.normalizedValue || indicator.value, 90),
      "validated strong indicator",
      evidenceSource(indicator.evidenceSource),
      "EXACT",
    ]);
  }
  return rows.slice(0, 8);
}

function sourceRows(evidence) {
  return (Array.isArray(evidence) ? evidence : []).slice(0, 5).map((item) => {
    const url = publicUrl(item.url);
    let platform = "Evidence";
    if (url) {
      try {
        platform = new URL(url).hostname.replace(/^www\./u, "");
      } catch {
        platform = "Evidence";
      }
    }
    return [
      platform,
      concise(item.title || "Campaign evidence", 150),
      `${percent(item.membershipScore)}% MEMBER`,
      url,
    ];
  });
}

function impactRows(payload) {
  const { analysis, campaign, status } = payload;
  if (campaign) {
    return [
      [String(campaign.documentCount || 0), "CAMPAIGN DOCUMENTS"],
      [String(campaign.indicatorCount || 0), "CAMPAIGN INDICATORS"],
      [`${campaign.maximumSeverity || 0}/5`, "MAX SEVERITY"],
      [Number(campaign.riskScore || 0).toFixed(1), "RISK SCORE"],
      [formatDate(campaign.firstSeenAt), "FIRST OBSERVED"],
    ];
  }
  const eligibleCount = (analysis.indicators || []).filter((item) => item.matchEligible).length;
  return [
    [status === "not_scam" ? label(analysis.primaryCategory).toUpperCase() : "NEW", status === "not_scam" ? "CLASSIFICATION" : "CASE STATUS"],
    [`${analysis.severity}/5`, "SEVERITY"],
    [`${percent(analysis.confidence)}%`, "ANALYSIS CONF."],
    [String(eligibleCount), "STRONG INDICATORS"],
    ["NOW", "ANALYZED"],
  ];
}

export function campaignCheckResultFromResponse(payload, artifact) {
  if (!payload || !CHECK_STATUSES.has(payload.status) || !payload.analysis) {
    throw new Error("Invalid campaign check response");
  }
  const analysis = payload.analysis;
  const campaign = payload.campaign || null;
  const copy = resultCopy(payload.status, campaign);
  const isNotScam = payload.status === "not_scam";
  const campaignName = campaign?.label || (
    payload.status === "new_unmatched_case"
      ? "NO CAMPAIGN ASSIGNED"
      : "NO CAMPAIGN MATCH REQUIRED"
  );
  const campaignId = campaign?.campaignKey || (
    payload.status === "new_unmatched_case" ? "NEW CASE" : "ANALYSIS COMPLETE"
  );
  const recommendedActions = Array.isArray(payload.recommendedActions)
    ? payload.recommendedActions.filter((item) => typeof item === "string").slice(0, 4)
    : [];

  return {
    id: `campaign-check-${payload.status}`,
    live: true,
    resultStatus: payload.status,
    verdict: isNotScam ? "not_scam" : "risk",
    artifact,
    campaign: concise(campaignName, 70).toUpperCase(),
    campaignId: concise(campaignId, 32).toUpperCase(),
    hasCampaign: Boolean(campaign),
    hasCluster: Boolean(campaign),
    analystConfirmed: campaign?.analystConfirmed === true,
    canPreviewAnonymousReport: !isNotScam,
    match: copy.match,
    confidence: percent(analysis.confidence),
    resultKicker: copy.kicker,
    resultHeading: copy.heading,
    resultContextLabel: copy.context,
    headline: recommendedActions[0] || copy.context,
    subline: concise(analysis.summary, 420),
    inputs: inputRows(analysis, artifact),
    evidence: evidenceRows(payload),
    sources: sourceRows(payload.evidence),
    victims: [],
    impact: impactRows(payload),
    analysis,
    recommendedActions,
  };
}
