import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../app/api/bank-intelligence/route.js";
import {
  BankIntelligenceError,
  loadBankIntelligence,
  parseCampaignRegistry,
  parseMetricSnapshot,
} from "../src/server/bank-intelligence.js";

const JOB_ID = "18400f6c-f496-46d5-b6f8-ef4ddb401cb7";
const REFRESHED_AT = "2026-07-11T12:25:28.953263+00:00";

const METRIC_ROWS = [
  {
    job_id: JOB_ID,
    metric_scope: "summary",
    metric_key: "global",
    metric_value: {
      document_count: 10,
      unique_indicator_count: 22,
      document_indicator_edge_count: 31,
      average_confidence: 0.97,
      maximum_severity: 5,
    },
    refreshed_at: REFRESHED_AT,
  },
  ...[
    ["scam_report", 3],
    ["impersonation_abuse", 1],
    ["customer_feedback", 1],
    ["news_pr", 3],
    ["noise", 2],
  ].map(([key, count]) => ({
    job_id: JOB_ID,
    metric_scope: "category",
    metric_key: key,
    metric_value: { document_count: count, document_share: count / 10 },
    refreshed_at: REFRESHED_AT,
  })),
  ...[
    [1, 4],
    [2, 1],
    [3, 1],
    [4, 3],
    [5, 1],
  ].map(([level, count]) => ({
    job_id: JOB_ID,
    metric_scope: "severity",
    metric_key: String(level),
    metric_value: { document_count: count, document_share: count / 10 },
    refreshed_at: REFRESHED_AT,
  })),
];

const CAMPAIGN_ROWS = [
  {
    id: "c78d3d5a-a8f7-4e30-bd6a-8340b2407fb4",
    campaign_key: "bank_account:9704000123456",
    label: "Fake bank verification",
    status: "confirmed",
    analyst_confirmed: true,
    risk_score: 5.6,
    document_count: 4,
    indicator_count: 7,
    maximum_severity: 5,
    average_confidence: 0.94,
    scam_types: ["bank_impersonation", "credential_theft"],
    bank_roles: ["impersonated_bank"],
    first_seen_at: "2026-07-01T08:30:00+00:00",
    last_seen_at: "2026-07-11T10:30:00+00:00",
  },
  {
    id: "034cadb8-1ceb-4af1-ad7d-351d88f88682",
    campaign_key: "domain:xac-minh.example",
    label: "Verification landing page",
    status: "provisional",
    analyst_confirmed: false,
    risk_score: 4.4,
    document_count: 2,
    indicator_count: 3,
    maximum_severity: 4,
    average_confidence: 0.82,
    scam_types: ["phishing"],
    bank_roles: [],
    first_seen_at: "2026-07-09T08:30:00+00:00",
    last_seen_at: "2026-07-10T10:30:00+00:00",
  },
];

function responseJson(body, { contentRange, status = 200 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (contentRange) headers["Content-Range"] = contentRange;
  return new Response(JSON.stringify(body), { status, headers });
}

test("parseMetricSnapshot reconciles supported aggregate fields", () => {
  const parsed = parseMetricSnapshot(METRIC_ROWS);
  assert.equal(parsed.snapshot.documentsAnalyzed, 10);
  assert.equal(parsed.snapshot.scamEvidenceDocuments, 4);
  assert.equal(parsed.snapshot.uniqueIndicatorCount, 22);
  assert.equal(parsed.snapshot.evidenceLinkCount, 31);
  assert.equal(parsed.categories.length, 5);
  assert.equal(parsed.severities.length, 5);
  assert.equal(parsed.snapshot.refreshedAt, "2026-07-11T12:25:28.953Z");
});

test("parseMetricSnapshot rejects mixed or unreconciled snapshots", () => {
  assert.throws(
    () => parseMetricSnapshot(METRIC_ROWS.slice(0, -1)),
    BankIntelligenceError,
  );
  const unreconciled = METRIC_ROWS.map((row) =>
    row.metric_scope === "category" && row.metric_key === "scam_report"
      ? { ...row, metric_value: { ...row.metric_value, document_count: 4 } }
      : row
  );
  assert.throws(
    () => parseMetricSnapshot(unreconciled),
    BankIntelligenceError,
  );
});

test("parseCampaignRegistry returns sanitized camelCase summaries", () => {
  const rows = [
    {
      ...CAMPAIGN_ROWS[0],
      label: "  Fake\n bank\u0000 verification  ",
      scam_types: ["bank_impersonation", "bank_impersonation"],
    },
  ];
  const [campaign] = parseCampaignRegistry(rows);

  assert.deepEqual(campaign, {
    id: CAMPAIGN_ROWS[0].id,
    campaignKey: "bank_account:9704000123456",
    label: "Fake bank verification",
    status: "confirmed",
    analystConfirmed: true,
    riskScore: 5.6,
    documentCount: 4,
    indicatorCount: 7,
    maximumSeverity: 5,
    averageConfidence: 0.94,
    scamTypes: ["bank_impersonation"],
    bankRoles: ["impersonated_bank"],
    firstSeenAt: "2026-07-01T08:30:00.000Z",
    lastSeenAt: "2026-07-11T10:30:00.000Z",
  });
  assert.equal(JSON.stringify(campaign).includes("campaign_key"), false);
  assert.throws(
    () => parseCampaignRegistry([{ ...CAMPAIGN_ROWS[0], status: "dismissed" }]),
    BankIntelligenceError,
  );
});

test("loadBankIntelligence maps the active campaign registry without leaking raw rows", async () => {
  const calls = [];
  const result = await loadBankIntelligence({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.pathname.endsWith("analysis_metrics")) {
        return responseJson(METRIC_ROWS);
      }
      return responseJson(CAMPAIGN_ROWS, { contentRange: "0-1/2" });
    },
  });

  assert.equal(result.snapshot.linkedCampaigns, 2);
  assert.equal(result.snapshot.activeCampaigns, 2);
  assert.equal(result.snapshot.highRiskCampaigns, 1);
  assert.equal(calls[1].url.pathname, "/rest/v1/campaigns");
  assert.equal(calls[1].url.searchParams.get("is_active"), "eq.true");
  assert.equal(calls[1].url.searchParams.get("status"), "neq.dismissed");
  assert.equal(calls[1].url.searchParams.has("job_id"), false);
  assert.equal(calls[1].url.searchParams.get("select").includes("metadata"), false);
  assert.equal(
    calls[1].url.searchParams.get("select").includes("anchor_indicator_key"),
    false,
  );
  assert.equal(calls[1].options.headers.Prefer, "count=exact");
  assert.equal(result.campaigns[0].campaignKey, CAMPAIGN_ROWS[0].campaign_key);
  assert.equal(result.campaigns[0].analystConfirmed, true);
  assert.equal(result.campaigns[1].status, "provisional");
  assert.equal(JSON.stringify(result).includes("server-secret"), false);
  assert.equal(JSON.stringify(result).includes("anchor_indicator_key"), false);
});

test("loadBankIntelligence rejects truncated campaign counts", async () => {
  await assert.rejects(
    loadBankIntelligence({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "server-secret",
      fetchImpl: async (url) =>
        url.pathname.endsWith("analysis_metrics")
          ? responseJson(METRIC_ROWS)
          : responseJson([CAMPAIGN_ROWS[0]], { contentRange: "0-0/2" }),
    }),
    BankIntelligenceError,
  );
});

test("loadBankIntelligence reports a not-yet-deployed campaign table as a 503", async () => {
  await assert.rejects(
    loadBankIntelligence({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "server-secret",
      fetchImpl: async (url) =>
        url.pathname.endsWith("analysis_metrics")
          ? responseJson(METRIC_ROWS)
          : responseJson(
            {
              code: "PGRST205",
              message: "Could not find the table public.campaigns in the schema cache",
            },
            { status: 404 },
          ),
    }),
    (error) => {
      assert.equal(error instanceof BankIntelligenceError, true);
      assert.equal(error.status, 503);
      assert.equal(error.message, "Campaign registry is not deployed");
      assert.equal(error.message.includes("public.campaigns"), false);
      return true;
    },
  );
});

test("loadBankIntelligence aborts a stalled upstream request", async () => {
  await assert.rejects(
    loadBankIntelligence({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "server-secret",
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    }),
    BankIntelligenceError,
  );
});

test("bank intelligence route returns cacheable live aggregates", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-secret";
  globalThis.fetch = async (url) =>
    url.pathname.endsWith("analysis_metrics")
      ? responseJson(METRIC_ROWS)
      : responseJson([CAMPAIGN_ROWS[0]], { contentRange: "0-0/1" });

  const response = await GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "live");
  assert.equal(body.snapshot.linkedCampaigns, 1);
  assert.equal(body.snapshot.activeCampaigns, 1);
  assert.equal(body.campaigns[0].campaignKey, CAMPAIGN_ROWS[0].campaign_key);
  assert.equal(
    response.headers.get("cache-control"),
    "public, s-maxage=20, stale-while-revalidate=40",
  );
  assert.equal(JSON.stringify(body).includes("server-secret"), false);
});

test("bank intelligence route returns non-cacheable sanitized 503", async (t) => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalConsoleError = console.error;
  t.after(() => {
    console.error = originalConsoleError;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.error = () => {};

  const response = await GET();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "unavailable" });
});
