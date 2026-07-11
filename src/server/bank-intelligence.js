const METRIC_SCOPES = "in.(summary,category,severity)";
const HIGH_RISK_THRESHOLD = 5;
const CAMPAIGN_STATUSES = new Set(["provisional", "confirmed"]);
const CAMPAIGN_SELECT = [
  "id",
  "campaign_key",
  "label",
  "status",
  "analyst_confirmed",
  "risk_score",
  "document_count",
  "indicator_count",
  "maximum_severity",
  "average_confidence",
  "scam_types",
  "bank_roles",
  "first_seen_at",
  "last_seen_at",
].join(",");

const CATEGORY_LABELS = {
  scam_report: "Scam reports",
  impersonation_abuse: "Impersonation abuse",
  customer_feedback: "Customer feedback",
  news_pr: "News and advisories",
  noise: "Noise",
};

export class BankIntelligenceError extends Error {
  constructor(message, { status = 502 } = {}) {
    super(message);
    this.name = "BankIntelligenceError";
    this.status = status;
  }
}

function asObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return value;
}

function asNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return value;
}

function asBoundedInteger(value, field, minimum, maximum) {
  const number = asNonNegativeInteger(value, field);
  if (number < minimum || number > maximum) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return number;
}

function asBoundedNumber(value, field, minimum, maximum) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return value;
}

function asIsoTimestamp(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return date.toISOString();
}

function asBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return value;
}

function sanitizeText(value, field, maximumLength = 160) {
  if (typeof value !== "string") {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return cleaned.slice(0, maximumLength);
}

function sanitizeTextList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new BankIntelligenceError(`Invalid ${field}`);
  }
  return [...new Set(value.map((item) => sanitizeText(item, field, 80)))].slice(0, 24);
}

function asNullableIsoTimestamp(value, field) {
  return value == null ? null : asIsoTimestamp(value, field);
}

function parseMetricCount(row, field = "document count") {
  const metric = asObject(row.metric_value, "metric value");
  return asNonNegativeInteger(metric.document_count, field);
}

export function parseMetricSnapshot(rows) {
  if (!Array.isArray(rows)) {
    throw new BankIntelligenceError("Metric snapshot is not an array");
  }

  const summaryRow = rows.find(
    (row) => row?.metric_scope === "summary" && row?.metric_key === "global",
  );
  if (!summaryRow || typeof summaryRow.job_id !== "string") {
    throw new BankIntelligenceError("Global metric summary is missing");
  }

  const refreshedAt = asIsoTimestamp(summaryRow.refreshed_at, "refresh timestamp");
  const summaryMetric = asObject(summaryRow.metric_value, "summary metric");
  const currentRows = rows.filter((row) => {
    if (row?.job_id !== summaryRow.job_id) return false;
    try {
      return asIsoTimestamp(row.refreshed_at, "metric timestamp") === refreshedAt;
    } catch {
      return false;
    }
  });

  const categories = currentRows
    .filter((row) => row.metric_scope === "category" && CATEGORY_LABELS[row.metric_key])
    .map((row) => {
      const metric = asObject(row.metric_value, "category metric");
      return {
        key: row.metric_key,
        label: CATEGORY_LABELS[row.metric_key],
        count: parseMetricCount(row),
        share: asBoundedNumber(metric.document_share, "category share", 0, 1),
      };
    })
    .sort((left, right) => right.count - left.count);

  const severities = currentRows
    .filter((row) => row.metric_scope === "severity")
    .map((row) => {
      const level = Number(row.metric_key);
      if (!Number.isSafeInteger(level) || level < 0 || level > 5) {
        throw new BankIntelligenceError("Invalid severity level");
      }
      const metric = asObject(row.metric_value, "severity metric");
      return {
        level,
        label: `Level ${level}`,
        count: parseMetricCount(row),
        share: asBoundedNumber(metric.document_share, "severity share", 0, 1),
      };
    })
    .sort((left, right) => left.level - right.level);

  if (!categories.length || !severities.length) {
    throw new BankIntelligenceError("Metric snapshot is incomplete");
  }

  const categoryTotal = categories.reduce((sum, row) => sum + row.count, 0);
  const severityTotal = severities.reduce((sum, row) => sum + row.count, 0);
  const documentsAnalyzed = asNonNegativeInteger(
    summaryMetric.document_count,
    "analyzed document count",
  );
  if (categoryTotal !== documentsAnalyzed || severityTotal !== documentsAnalyzed) {
    throw new BankIntelligenceError("Metric snapshot totals do not reconcile");
  }

  const scamEvidenceDocuments = categories
    .filter((row) => row.key === "scam_report" || row.key === "impersonation_abuse")
    .reduce((sum, row) => sum + row.count, 0);

  return {
    jobId: summaryRow.job_id,
    snapshot: {
      documentsAnalyzed,
      scamEvidenceDocuments,
      uniqueIndicatorCount: asNonNegativeInteger(
        summaryMetric.unique_indicator_count,
        "unique indicator count",
      ),
      evidenceLinkCount: asNonNegativeInteger(
        summaryMetric.document_indicator_edge_count,
        "evidence link count",
      ),
      averageConfidence: asBoundedNumber(
        summaryMetric.average_confidence,
        "average confidence",
        0,
        1,
      ),
      maximumSeverity: asBoundedInteger(
        summaryMetric.maximum_severity,
        "maximum severity",
        0,
        5,
      ),
      refreshedAt,
    },
    categories,
    severities,
  };
}

export function parseCampaignRegistry(rows) {
  if (!Array.isArray(rows)) {
    throw new BankIntelligenceError("Campaign registry is not an array");
  }

  return rows.map((row) => {
    const campaign = asObject(row, "campaign");
    const status = sanitizeText(campaign.status, "campaign status", 24);
    if (!CAMPAIGN_STATUSES.has(status)) {
      throw new BankIntelligenceError("Invalid campaign status");
    }
    const campaignKey = sanitizeText(campaign.campaign_key, "campaign key", 160);

    return {
      id: sanitizeText(campaign.id, "campaign id", 64),
      campaignKey,
      label: campaign.label == null
        ? campaignKey
        : sanitizeText(campaign.label, "campaign label", 160),
      status,
      analystConfirmed: asBoolean(
        campaign.analyst_confirmed,
        "campaign analyst confirmation",
      ),
      riskScore: asBoundedNumber(campaign.risk_score, "campaign risk score", 0, 100),
      documentCount: asNonNegativeInteger(
        campaign.document_count,
        "campaign document count",
      ),
      indicatorCount: asNonNegativeInteger(
        campaign.indicator_count,
        "campaign indicator count",
      ),
      maximumSeverity: asBoundedInteger(
        campaign.maximum_severity,
        "campaign maximum severity",
        0,
        5,
      ),
      averageConfidence: asBoundedNumber(
        campaign.average_confidence,
        "campaign average confidence",
        0,
        1,
      ),
      scamTypes: sanitizeTextList(campaign.scam_types, "campaign scam type"),
      bankRoles: sanitizeTextList(campaign.bank_roles, "campaign bank role"),
      firstSeenAt: asNullableIsoTimestamp(
        campaign.first_seen_at,
        "campaign first seen timestamp",
      ),
      lastSeenAt: asNullableIsoTimestamp(
        campaign.last_seen_at,
        "campaign last seen timestamp",
      ),
    };
  });
}

function parseContentRangeTotal(response, rows) {
  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  if (!match) {
    throw new BankIntelligenceError("Campaign count is missing");
  }
  const total = Number(match[1]);
  if (!Number.isSafeInteger(total) || total < 0 || total !== rows.length) {
    throw new BankIntelligenceError("Campaign response is incomplete");
  }
  return total;
}

async function readJson(response, field) {
  if (!response.ok) {
    throw new BankIntelligenceError(`${field} request failed`);
  }
  try {
    return await response.json();
  } catch {
    throw new BankIntelligenceError(`${field} response is invalid`);
  }
}

async function readCampaignRegistry(response) {
  if (!response.ok) {
    let errorBody = null;
    try {
      errorBody = await response.json();
    } catch {
      // The public error stays fixed even when Supabase returns a non-JSON body.
    }
    const code = typeof errorBody?.code === "string" ? errorBody.code : "";
    const message = typeof errorBody?.message === "string"
      ? errorBody.message.toLowerCase()
      : "";
    if (
      code === "42P01" ||
      code === "PGRST205" ||
      (message.includes("campaigns") &&
        (message.includes("schema cache") || message.includes("does not exist")))
    ) {
      throw new BankIntelligenceError("Campaign registry is not deployed", {
        status: 503,
      });
    }
    throw new BankIntelligenceError("Campaign registry request failed");
  }
  try {
    return await response.json();
  } catch {
    throw new BankIntelligenceError("Campaign registry response is invalid");
  }
}

export async function loadBankIntelligence({
  fetchImpl = fetch,
  supabaseUrl,
  serviceRoleKey,
  timeoutMs = 5000,
} = {}) {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new BankIntelligenceError("Bank intelligence is not configured", {
      status: 503,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: "application/json",
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  try {
    const metricsUrl = new URL("/rest/v1/analysis_metrics", supabaseUrl);
    metricsUrl.searchParams.set(
      "select",
      "job_id,metric_scope,metric_key,metric_value,refreshed_at",
    );
    metricsUrl.searchParams.set("metric_scope", METRIC_SCOPES);
    metricsUrl.searchParams.set("limit", "100");

    const metricResponse = await fetchImpl(metricsUrl, {
      cache: "no-store",
      headers,
      signal: controller.signal,
    });
    const metricRows = await readJson(metricResponse, "Metric snapshot");
    const parsed = parseMetricSnapshot(metricRows);

    const campaignsUrl = new URL("/rest/v1/campaigns", supabaseUrl);
    campaignsUrl.searchParams.set("select", CAMPAIGN_SELECT);
    campaignsUrl.searchParams.set("is_active", "eq.true");
    campaignsUrl.searchParams.set("status", "neq.dismissed");
    campaignsUrl.searchParams.set("order", "risk_score.desc,last_seen_at.desc");
    campaignsUrl.searchParams.set("limit", "1000");

    const campaignResponse = await fetchImpl(campaignsUrl, {
      cache: "no-store",
      headers: { ...headers, Prefer: "count=exact" },
      signal: controller.signal,
    });
    const campaignRows = await readCampaignRegistry(campaignResponse);
    const campaigns = parseCampaignRegistry(campaignRows);
    const linkedCampaigns = parseContentRangeTotal(campaignResponse, campaigns);
    const highRiskCampaigns = campaigns.filter(
      (campaign) => campaign.riskScore >= HIGH_RISK_THRESHOLD,
    ).length;

    return {
      snapshot: {
        ...parsed.snapshot,
        activeCampaigns: linkedCampaigns,
        linkedCampaigns,
        highRiskCampaigns,
        highRiskThreshold: HIGH_RISK_THRESHOLD,
      },
      categories: parsed.categories,
      severities: parsed.severities,
      campaigns,
    };
  } catch (error) {
    if (error instanceof BankIntelligenceError) throw error;
    throw new BankIntelligenceError("Bank intelligence request failed");
  } finally {
    clearTimeout(timeout);
  }
}
