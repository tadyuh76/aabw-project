import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../app/api/check-evidence/route.js";
import {
  CheckEvidenceError,
  canonicalizeUrl,
  casefold,
  checkEvidence,
  normalizeBankAccount,
  normalizeDomain,
  normalizeEvidenceInput,
  normalizePhone,
  scoreMessageSimilarity,
} from "../src/server/check-evidence.js";

const IDS = {
  indicator: "11111111-1111-4111-8111-111111111111",
  document: "22222222-2222-4222-8222-222222222222",
  classification: "33333333-3333-4333-8333-333333333333",
  cluster: "44444444-4444-4444-8444-444444444444",
};

function responseJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function matchingFetch({ indicatorKind = "phone", normalizedValue = "0358280144" } = {}) {
  return async (url) => {
    if (url.pathname.endsWith("/indicators")) {
      const kind = url.searchParams.get("kind");
      const value = url.searchParams.get("normalized_value");
      if (kind === `eq.${indicatorKind}` && value === `eq.${normalizedValue}`) {
        return responseJson([
          { id: IDS.indicator, kind: indicatorKind, normalized_value: normalizedValue },
        ]);
      }
      return responseJson([]);
    }
    if (url.pathname.endsWith("/document_indicators")) {
      return responseJson([
        {
          document_id: IDS.document,
          classification_id: IDS.classification,
          evidence_source: "post_text",
          confidence: 0.99,
          created_at: "2026-07-11T12:01:35.384Z",
        },
      ]);
    }
    if (url.pathname.endsWith("/classifications")) {
      return responseJson([
        {
          id: IDS.classification,
          document_id: IDS.document,
          primary_category: "scam_report",
          scam_types: ["online_sale_scam"],
          severity: 5,
          confidence: 0.99,
          created_at: "2026-07-11T09:23:27.163Z",
        },
      ]);
    }
    if (url.pathname.endsWith("/documents")) {
      return responseJson([
        {
          id: IDS.document,
          canonical_url: "https://facebook.com/public-warning",
          platform: "facebook",
          title: "Public scam warning",
          published_at: null,
          first_seen_at: "2026-07-11T08:00:00.000Z",
          last_seen_at: "2026-07-11T12:01:15.524Z",
          created_at: "2026-07-11T08:00:00.000Z",
        },
      ]);
    }
    if (url.pathname.endsWith("/campaign_cluster_documents")) {
      return responseJson([
        { cluster_id: IDS.cluster, document_id: IDS.document, membership_score: 1 },
      ]);
    }
    if (url.pathname.endsWith("/campaign_clusters")) {
      return responseJson([
        {
          id: IDS.cluster,
          label: "Online sale impersonation",
          risk_score: 6.2,
          document_count: 4,
          indicator_count: 7,
          maximum_severity: 5,
          average_confidence: 0.97,
          first_seen_at: "2026-07-10T00:00:00.000Z",
          last_seen_at: "2026-07-11T12:00:00.000Z",
        },
      ]);
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  };
}

test("normalizers reproduce stored phone, account, link, domain, and message shapes", () => {
  assert.equal(normalizePhone("+84 912 345 678"), "0912345678");
  assert.equal(normalizePhone("84.912.345.678"), "0912345678");
  assert.equal(normalizeBankAccount(" ab-12 34 "), "AB1234");
  assert.equal(
    canonicalizeUrl("hxxps://WWW.Example[.]com/path/?utm_source=x&b=2&a=1#fragment"),
    "https://www.example.com/path?a=1&b=2",
  );
  assert.equal(normalizeDomain("hxxps://WWW.Example[.]com/path"), "example.com");
  assert.equal(casefold("  XÁC   MINH\nNGAY  "), "xác minh ngay");
});

test("input inference keeps the public checked type contract", () => {
  const number = normalizeEvidenceInput("035 828 0144");
  assert.equal(number.checkedType, "number");
  assert.deepEqual(
    number.candidates.map((candidate) => candidate.kind),
    ["phone", "bank_account"],
  );
  assert.equal(normalizeEvidenceInput("035 828 0144", "phone").checkedType, "phone");
  assert.equal(normalizeEvidenceInput("example[.]com/login").checkedType, "link");
  assert.equal(
    normalizeEvidenceInput("VCB-1234-5678", "bank_account").checkedType,
    "number",
  );
  assert.equal(
    normalizeEvidenceInput("Please verify your account immediately").checkedType,
    "message",
  );
  assert.throws(() => normalizeEvidenceInput("hi"), CheckEvidenceError);
});

test("message similarity is exact, conservative for strong variants, and rejects weak overlap", () => {
  const template = "verify your identity before 11 pm using this secure link";
  assert.equal(scoreMessageSimilarity(template, template), 1);
  assert.ok(
    scoreMessageSimilarity(
      "Urgent: verify your identity before 11 pm using this secure link now",
      template,
    ) >= 0.82,
  );
  assert.equal(
    scoreMessageSimilarity("please verify this ordinary purchase", template),
    0,
  );
});

test("phone lookup returns only sanitized, evidence-backed aggregate data", async () => {
  const result = await checkEvidence({
    value: "035 8280144",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl: matchingFetch(),
  });

  assert.equal(result.status, "match");
  assert.deepEqual(result.checked, { type: "number" });
  assert.equal(result.match.matchedKind, "phone");
  assert.equal(result.match.matchMode, "exact");
  assert.equal(result.match.evidenceDocumentCount, 1);
  assert.equal(result.match.sourceCount, 1);
  assert.equal(result.match.maximumSeverity, 5);
  assert.equal(result.match.averageConfidence, 0.99);
  assert.equal(result.match.firstSeen, "2026-07-11T08:00:00.000Z");
  assert.deepEqual(result.match.categories, ["scam_report"]);
  assert.deepEqual(result.match.scamTypes, ["online_sale_scam"]);
  assert.equal(result.match.sources[0].platform, "facebook");
  assert.equal(result.match.cluster.label, "Online sale impersonation");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("server-secret"), false);
  assert.equal(serialized.includes("0358280144"), false);
  assert.equal(serialized.includes("normalized_value"), false);
});

test("a URL can fall back to an exact domain indicator", async () => {
  const result = await checkEvidence({
    value: "hxxps://bad[.]example/path?utm_source=test",
    type: "link",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl: matchingFetch({ indicatorKind: "domain", normalizedValue: "bad.example" }),
  });
  assert.equal(result.status, "match");
  assert.deepEqual(result.checked, { type: "link" });
  assert.equal(result.match.matchedKind, "domain");
  assert.equal(result.match.matchMode, "domain");
});

test("an untyped numeric input falls back from phone to bank-account evidence", async () => {
  const result = await checkEvidence({
    value: "035 8280144",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl: matchingFetch({
      indicatorKind: "bank_account",
      normalizedValue: "0358280144",
    }),
  });
  assert.equal(result.status, "match");
  assert.deepEqual(result.checked, { type: "number" });
  assert.equal(result.match.matchedKind, "bank_account");
});

test("indicator presence without an eligible scam classification is no_match", async () => {
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith("/indicators")) {
      return responseJson([
        { id: IDS.indicator, kind: "phone", normalized_value: "0358280144" },
      ]);
    }
    if (url.pathname.endsWith("/document_indicators")) {
      return responseJson([{ document_id: IDS.document }]);
    }
    if (url.pathname.endsWith("/classifications")) return responseJson([]);
    throw new Error(`Unexpected path ${url.pathname}`);
  };
  const result = await checkEvidence({
    value: "0358280144",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl,
  });
  assert.deepEqual(result, { status: "no_match", checked: { type: "number" } });
});

test("a low-confidence scam classification is no_match", async () => {
  const fetchImpl = async (url) => {
    if (url.pathname.endsWith("/indicators")) {
      if (url.searchParams.get("kind") !== "eq.phone") return responseJson([]);
      return responseJson([
        { id: IDS.indicator, kind: "phone", normalized_value: "0358280144" },
      ]);
    }
    if (url.pathname.endsWith("/document_indicators")) {
      return responseJson([{ document_id: IDS.document }]);
    }
    if (url.pathname.endsWith("/classifications")) {
      assert.equal(url.searchParams.get("confidence"), "gte.0.6");
      // Deliberately simulate an upstream that ignores the filter so the local
      // validation is also exercised.
      return responseJson([
        {
          id: IDS.classification,
          document_id: IDS.document,
          primary_category: "scam_report",
          severity: 5,
          confidence: 0.59,
        },
      ]);
    }
    throw new Error(`Unexpected path ${url.pathname}`);
  };
  const result = await checkEvidence({
    value: "0358280144",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl,
  });
  assert.deepEqual(result, { status: "no_match", checked: { type: "number" } });
});

test("fuzzy message templates only match after eligible linked evidence", async () => {
  const template = "verify your identity before 11 pm using this secure link";
  const baseFetch = matchingFetch({
    indicatorKind: "message_template",
    normalizedValue: template,
  });
  const fetchImpl = async (url, options) => {
    if (url.pathname.endsWith("/indicators")) {
      return responseJson([
        {
          id: IDS.indicator,
          kind: "message_template",
          normalized_value: template,
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          kind: "message_template",
          normalized_value: "your bank publishes a routine monthly security notice",
        },
      ]);
    }
    return baseFetch(url, options);
  };
  const result = await checkEvidence({
    value: "Urgent: verify your identity before 11 pm using this secure link now",
    type: "message",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "server-secret",
    fetchImpl,
  });
  assert.equal(result.status, "match");
  assert.deepEqual(result.checked, { type: "message" });
  assert.equal(result.match.matchedKind, "message_template");
  assert.equal(result.match.matchMode, "fuzzy");
  assert.ok(result.match.similarity >= 0.82 && result.match.similarity < 1);
});

test("missing configuration is a 503 and invalid input is a 400", async () => {
  await assert.rejects(
    checkEvidence({ value: "0358280144" }),
    (error) => error instanceof CheckEvidenceError && error.status === 503,
  );
  await assert.rejects(
    checkEvidence({
      value: "x",
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "secret",
    }),
    (error) => error instanceof CheckEvidenceError && error.status === 400,
  );
});

test("route responses are no-store and sanitized", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "server-secret";
  globalThis.fetch = matchingFetch();
  const response = await POST(
    new Request("http://localhost/api/check-evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "0358280144" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(JSON.stringify(await response.json()).includes("server-secret"), false);

  console.error = () => {};
  const invalidResponse = await POST(
    new Request("http://localhost/api/check-evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    }),
  );
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { status: "invalid" });
  assert.equal(invalidResponse.headers.get("cache-control"), "no-store, max-age=0");
});
