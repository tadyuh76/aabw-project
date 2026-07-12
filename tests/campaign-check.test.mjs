import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  POST,
  handleCheckRequest,
  parseCheckFormData,
} from "../app/api/check/route.js";
import {
  CHECK_ANALYSIS_SCHEMA,
  CONTEXTUAL_MATCH_SCHEMA,
  CampaignCheckError,
  analyzeCustomerInput,
  createCampaignCheckClients,
  decideCheckStatus,
  ensureCampaignTablesReady,
  findCampaignMatch,
  loadCampaignEvidence,
  loadContextualCandidateProfiles,
  normalizeStrongIndicator,
  rerankCampaignCandidates,
  retrieveContextualCampaignCandidates,
  runCampaignCheck,
  validateCheckInput,
} from "../src/server/campaign-check.js";
import { decodeQrImage, parseEmvQrPayload } from "../src/server/qr-decode.js";

const IDS = {
  campaign: "11111111-1111-4111-8111-111111111111",
  dismissedCampaign: "22222222-2222-4222-8222-222222222222",
  inactiveCampaign: "33333333-3333-4333-8333-333333333333",
  phoneIndicator: "44444444-4444-4444-8444-444444444444",
  emailIndicator: "55555555-5555-4555-8555-555555555555",
  crossProductIndicator: "66666666-6666-4666-8666-666666666666",
  qrIndicator: "77777777-7777-4777-8777-777777777777",
  contextualCampaign: "88888888-8888-4888-8888-888888888888",
  contextualDocument: "99999999-9999-4999-8999-999999999999",
};

function emvField(tag, value) {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

function crc16CcittFalse(value) {
  let crc = 0xffff;
  for (const byte of Buffer.from(value, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function syntheticVietQrPayload(accountIdentifier = "123456789012") {
  const beneficiary = emvField("00", "970436") + emvField("01", accountIdentifier);
  const merchantAccount =
    emvField("00", "A000000727") +
    emvField("01", beneficiary) +
    emvField("02", "QRIBFTTA");
  const body =
    emvField("00", "01") +
    emvField("01", "11") +
    emvField("38", merchantAccount) +
    emvField("53", "704") +
    emvField("58", "VN") +
    "6304";
  return `${body}${crc16CcittFalse(body)}`;
}

const SYNTHETIC_VIETQR_PAYLOAD = syntheticVietQrPayload();

const BASE_MODEL_ANALYSIS = {
  primary_category: "scam_report",
  scam_types: ["bank_impersonation"],
  bank_roles: ["impersonated_bank"],
  specific_case: true,
  summary: "A concrete transfer request uses an impersonated bank identity.",
  severity: 4,
  confidence: 0.91,
  indicators: [],
};

function modelAnalysis(overrides = {}) {
  return { ...BASE_MODEL_ANALYSIS, ...overrides };
}

function fakeOpenAI(output, { refusal = null } = {}) {
  const calls = [];
  const client = {
    responses: {
      create: async (request) => {
        calls.push(request);
        return refusal
          ? {
              output_text: "",
              output: [{ content: [{ type: "refusal", refusal }] }],
            }
          : {
              output_text: typeof output === "string" ? output : JSON.stringify(output),
              output: [],
            };
      },
    },
    // Any accidental OCR detour should fail the test immediately. The server
    // implementation should use only responses.create with native vision.
    ocr: {
      create: async () => {
        throw new Error("An OCR helper must not be called");
      },
    },
  };
  return { client, calls };
}

function fakeOpenAISequence(outputs) {
  const queue = [...outputs];
  const calls = [];
  const client = {
    responses: {
      create: async (request) => {
        calls.push(request);
        if (!queue.length) throw new Error("Unexpected extra OpenAI call");
        const next = queue.shift();
        if (next?.error) throw next.error;
        if (next?.refusal) {
          return {
            output_text: "",
            output: [{ content: [{ type: "refusal", refusal: next.refusal }] }],
          };
        }
        const output = Object.hasOwn(next || {}, "output") ? next.output : next;
        return {
          output_text: typeof output === "string" ? output : JSON.stringify(output),
          output: [],
        };
      },
    },
  };
  return { client, calls };
}

function cloneQuery(query) {
  return {
    table: query.table,
    columns: query.columns,
    filters: query.filters.map((filter) => ({
      ...filter,
      value: Array.isArray(filter.value) ? [...filter.value] : filter.value,
    })),
    orders: query.orders.map((order) => ({ ...order })),
    limit: query.limit,
  };
}

function fakeSupabase(resolver) {
  const calls = [];
  const client = {
    from(table) {
      const query = {
        table,
        columns: null,
        filters: [],
        orders: [],
        limit: null,
      };
      const builder = {
        select(columns) {
          query.columns = columns;
          return builder;
        },
        in(column, value) {
          query.filters.push({ op: "in", column, value: [...value] });
          return builder;
        },
        eq(column, value) {
          query.filters.push({ op: "eq", column, value });
          return builder;
        },
        neq(column, value) {
          query.filters.push({ op: "neq", column, value });
          return builder;
        },
        overlaps(column, value) {
          query.filters.push({ op: "overlaps", column, value: [...value] });
          return builder;
        },
        order(column, value) {
          query.orders.push({ column, value });
          return builder;
        },
        limit(value) {
          query.limit = value;
          return builder;
        },
        then(onFulfilled, onRejected) {
          const snapshot = cloneQuery(query);
          calls.push(snapshot);
          return Promise.resolve()
            .then(() => resolver(snapshot))
            .then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

function findFilter(query, op, column) {
  return query.filters.find((filter) => filter.op === op && filter.column === column);
}

function campaignRow(overrides = {}) {
  return {
    id: IDS.campaign,
    campaign_key: "phone:0912345678",
    anchor_indicator_key: "phone|0912345678",
    label: "Fake bank verification",
    status: "provisional",
    analyst_confirmed: false,
    is_active: true,
    risk_score: 4.8,
    document_count: 4,
    indicator_count: 3,
    maximum_severity: 5,
    average_confidence: 0.93,
    scam_types: ["bank_impersonation"],
    bank_roles: ["impersonated_bank"],
    first_seen_at: "2026-07-01T00:00:00.000Z",
    last_seen_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function matchingAnalysis(overrides = {}) {
  return {
    primaryCategory: "scam_report",
    specificCase: true,
    summary: "A concrete scam case.",
    severity: 4,
    confidence: 0.91,
    scamTypes: ["bank_impersonation"],
    bankRoles: ["impersonated_bank"],
    indicators: [
      {
        type: "phone",
        value: "+84 912 345 678",
        normalizedValue: "0912345678",
        evidenceSource: "text",
        matchEligible: true,
      },
    ],
    ...overrides,
  };
}

function fakeMultipartRequest(values, contentType = "multipart/form-data; boundary=fake") {
  const fields = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value : [value]]),
  );
  return {
    headers: new Headers({ "Content-Type": contentType }),
    async formData() {
      return {
        getAll(name) {
          return fields[name] || [];
        },
        get(name) {
          return fields[name]?.[0] ?? null;
        },
      };
    },
  };
}

function uploadedFile({
  bytes = new Uint8Array([1, 2, 3]),
  name = "evidence.png",
  size = bytes.byteLength,
  type = "image/png",
} = {}) {
  return {
    name,
    size,
    type,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function multipartTextRequest(text = "Please check this transfer request") {
  const formData = new FormData();
  formData.set("text", text);
  return new Request("http://localhost/api/check", {
    method: "POST",
    body: formData,
  });
}

function assertCampaignError(error, { code, status }) {
  assert.equal(error instanceof CampaignCheckError, true);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  return true;
}

test("OpenAI analysis uses strict Responses JSON schema and sends images directly to vision", async () => {
  const imageBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const { client, calls } = fakeOpenAI(modelAnalysis({
    primary_category: "noise",
    specific_case: false,
    summary: "The image does not contain a concrete case.",
    severity: 1,
    confidence: 0.72,
  }));

  const analysis = await analyzeCustomerInput({
    input: {
      text: "",
      url: "",
      image: { bytes: imageBytes, mimeType: "image/png", name: "capture.png" },
    },
    openaiClient: client,
    model: "gpt-5.6-luna",
  });

  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "checkvar_customer_input_analysis");
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema, CHECK_ANALYSIS_SCHEMA);
  assert.equal(request.text.format.schema.additionalProperties, false);
  assert.equal(
    request.text.format.schema.properties.indicators.items.additionalProperties,
    false,
  );
  assert.deepEqual(
    [...request.text.format.schema.required].sort(),
    Object.keys(request.text.format.schema.properties).sort(),
  );
  assert.deepEqual(
    [...request.text.format.schema.properties.indicators.items.required].sort(),
    Object.keys(request.text.format.schema.properties.indicators.items.properties).sort(),
  );
  assert.match(request.instructions, /native vision/i);
  assert.match(request.instructions, /account-opening commissions or referral promotions are not scams/i);
  assert.match(request.instructions, /scam-recovery advice/i);

  const content = request.input[0].content;
  assert.deepEqual(content.map((item) => item.type), ["input_text", "input_image"]);
  assert.equal(
    content[1].image_url,
    `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`,
  );
  assert.equal(content[1].detail, "high");
  assert.equal(Object.hasOwn(content[1], "file_id"), false);
  assert.equal(analysis.primaryCategory, "noise");
  assert.deepEqual(
    analysis.indicators.filter((indicator) => indicator.type === "media_hash"),
    [{
      type: "media_hash",
      value: createHash("sha256").update(imageBytes).digest("hex"),
      normalizedValue: createHash("sha256").update(imageBytes).digest("hex"),
      evidenceSource: "image",
      matchEligible: true,
    }],
  );
});

test("OpenAI refusals and invalid structured responses become sanitized campaign-check errors", async () => {
  const refused = fakeOpenAI(modelAnalysis(), { refusal: "private upstream detail" });
  await assert.rejects(
    analyzeCustomerInput({
      input: { text: "evidence", url: "", image: null },
      openaiClient: refused.client,
    }),
    (error) => {
      assertCampaignError(error, { code: "ANALYSIS_REFUSED", status: 422 });
      assert.equal(error.message.includes("private upstream detail"), false);
      return true;
    },
  );

  const invalid = fakeOpenAI("{not valid JSON");
  await assert.rejects(
    analyzeCustomerInput({
      input: { text: "evidence", url: "", image: null },
      openaiClient: invalid.client,
    }),
    (error) => assertCampaignError(error, { code: "ANALYSIS_INVALID", status: 502 }),
  );
});

test("deterministic QR decoding fails closed and parses valid VietQR fields", async () => {
  const parsed = parseEmvQrPayload(SYNTHETIC_VIETQR_PAYLOAD);
  assert.deepEqual(parsed, {
    crcValid: true,
    payloadFormat: "01",
    initiationMethod: "11",
    globallyUniqueIdentifier: "A000000727",
    bankBin: "970436",
    beneficiaryIdentifier: "123456789012",
    serviceCode: "QRIBFTTA",
    currency: "704",
    country: "VN",
    references: [],
  });
  assert.equal(
    parseEmvQrPayload(`${SYNTHETIC_VIETQR_PAYLOAD.slice(0, -4)}0000`).crcValid,
    false,
  );
  assert.equal(parseEmvQrPayload("not-an-emv-payload"), null);
  assert.equal(
    await decodeQrImage({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
    "",
  );
});

test("strong indicator normalization enforces campaign matching guardrails", () => {
  const validCases = [
    ["bank_account", " 1234 56-7890 ", "1234567890"],
    ["phone", "+84 912 345 678", "0912345678"],
    ["phone", "84.912.345.678", "0912345678"],
    ["email", " Fraud.Agent@Example.COM ", "fraud.agent@example.com"],
    ["domain", "hxxps://WWW.Bad[.]Example/login", "bad.example"],
    ["social_account", "https://zalo.me/fraud.agent", "fraud.agent"],
    ["qr_payload", "00020101021238540010A000000727", "00020101021238540010A000000727"],
    ["qr_payload", "https://example.com/unknown", "https://example.com/unknown"],
    ["transaction_reference", " ab-12.cd-34 ", "AB12CD34"],
    ["media_hash", `sha256:${"a".repeat(64)}`, "a".repeat(64)],
    ["message_template", "  Please TRANSFER the advance fee now. ", "please transfer the advance fee now."],
  ];
  for (const [type, value, expected] of validCases) {
    assert.equal(normalizeStrongIndicator(type, value), expected, `${type}: ${value}`);
  }

  const rejectedCases = [
    ["bank_account", "12345"],
    ["bank_account", "1".repeat(21)],
    ["bank_account", "Vietcombank"],
    ["bank_account", "VCB 123456789"],
    ["phone", "+1 202 555 0123"],
    ["phone", "0412345678"],
    ["phone", "09123"],
    ["social_account", "zalo"],
    ["social_account", "@FACEBOOK"],
    ["social_account", "facebook.com"],
    ["social_account", "zalo.me"],
    ["social_account", "telegram.org"],
    ["social_account", "https://t.me/telegram"],
    ["qr_payload", "unknown"],
    ["qr_payload", "unknown QR payload"],
    ["qr_payload", "not readable"],
    ["qr_payload", "unreadable"],
    ["qr_payload", "QR unreadable"],
    ["qr_payload", "unable to read"],
    ["qr_payload", "unknown / unreadable"],
    ["qr_payload", "unreadable payload"],
    ["qr_payload", "QR not visible"],
    ["qr_payload", "QR payload could not be decoded"],
    ["qr_payload", "unable to decode the QR code"],
    ["qr_payload", "QR visible but payload unknown"],
    ["transaction_reference", "A-12"],
    ["transaction_reference", "QRGD123456789012"],
    ["media_hash", "not-a-hash"],
    ["message_template", "transfer now"],
    ["domain", "Vietcombank"],
    ["url", "https://bad.example"],
  ];
  for (const [type, value] of rejectedCases) {
    assert.equal(normalizeStrongIndicator(type, value), "", `${type}: ${value}`);
  }
});

test("deterministic augmentation recovers exact indicators without trusting model normalization", async () => {
  const input = {
    text: "Urgent transfer request: call +84 912 345 678 or fraud@example.com before sending funds.",
    url: "hxxps://bad[.]example/login?utm_source=message",
    image: {
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "image/jpeg",
      name: "message.jpg",
    },
  };
  const raw = modelAnalysis({
    indicators: [
      {
        type: "phone",
        value: "+84 912 345 678",
        normalized_value: "model-was-wrong",
        evidence_source: "screenshot",
      },
      {
        type: "bank_account",
        value: "Vietcombank",
        normalized_value: "123456789",
        evidence_source: "model",
      },
      {
        type: "qr_payload",
        value: "unknown",
        normalized_value: "invented-payload",
        evidence_source: "image",
      },
      {
        type: "person_alias",
        value: "Mr Scammer",
        normalized_value: "mr scammer",
        evidence_source: "text",
      },
    ],
  });
  const openai = fakeOpenAI(raw);

  const first = await analyzeCustomerInput({ input, openaiClient: openai.client });
  const second = await analyzeCustomerInput({ input, openaiClient: openai.client });
  assert.deepEqual(first.indicators, second.indicators);

  const phoneMatches = first.indicators.filter((indicator) =>
    indicator.type === "phone" && indicator.normalizedValue === "0912345678"
  );
  assert.equal(phoneMatches.length, 1, "model and deterministic phone evidence should deduplicate");
  assert.equal(phoneMatches[0].matchEligible, true);
  assert.equal(phoneMatches[0].evidenceSource, "screenshot");

  const byType = new Map(first.indicators.map((indicator) => [indicator.type, indicator]));
  assert.equal(byType.get("email").normalizedValue, "fraud@example.com");
  assert.equal(byType.get("email").evidenceSource, "text");
  assert.equal(byType.get("domain").normalizedValue, "bad.example");
  assert.equal(byType.get("domain").evidenceSource, "url");
  assert.equal(
    byType.get("media_hash").normalizedValue,
    createHash("sha256").update(input.image.bytes).digest("hex"),
  );
  assert.equal(byType.get("message_template").matchEligible, true);

  assert.deepEqual(byType.get("bank_account"), {
    type: "bank_account",
    value: "Vietcombank",
    normalizedValue: "",
    evidenceSource: "model",
    matchEligible: false,
  });
  assert.equal(byType.get("qr_payload").matchEligible, false);
  assert.equal(byType.get("qr_payload").normalizedValue, "");
  assert.equal(byType.get("person_alias").normalizedValue, "mr scammer");
  assert.equal(byType.get("person_alias").matchEligible, false);
});

test("verified QR output overrides model ambiguity and keeps image-only sources accurate", async () => {
  const input = {
    text: "",
    url: "",
    image: {
      bytes: new Uint8Array([9, 8, 7, 6]),
      mimeType: "image/png",
      name: "recipient-qr.png",
    },
    decodedQrPayload: SYNTHETIC_VIETQR_PAYLOAD,
  };
  const openai = fakeOpenAI(modelAnalysis({
    primary_category: "noise",
    specific_case: false,
    summary: "A receiving QR is shown without a concrete scam case.",
    severity: 1,
    indicators: [
      {
        type: "qr_payload",
        value: "Decoded QR payload",
        normalized_value: SYNTHETIC_VIETQR_PAYLOAD,
        evidence_source: "visible payment code",
      },
      {
        type: "transaction_reference",
        value: "123456789012",
        normalized_value: "123456789012",
        evidence_source: "visible identifier",
      },
      {
        type: "organization_alias",
        value: "Example Bank",
        normalized_value: "example bank",
        evidence_source: "visible bank branding",
      },
    ],
  }));

  const analysis = await analyzeCustomerInput({ input, openaiClient: openai.client });
  const exactQr = analysis.indicators.filter((indicator) =>
    indicator.type === "qr_payload" && indicator.normalizedValue === SYNTHETIC_VIETQR_PAYLOAD
  );
  assert.equal(exactQr.length, 1);
  assert.equal(exactQr[0].matchEligible, true);
  assert.equal(exactQr[0].evidenceSource, "qr_decoder");

  const bankAccount = analysis.indicators.find((indicator) =>
    indicator.type === "bank_account" && indicator.normalizedValue === "123456789012"
  );
  assert.equal(bankAccount?.matchEligible, true);
  assert.equal(bankAccount?.evidenceSource, "qr_decoder");
  const mislabeledReference = analysis.indicators.find((indicator) =>
    indicator.type === "transaction_reference" && indicator.value === "123456789012"
  );
  assert.equal(mislabeledReference?.matchEligible, false);
  assert.equal(mislabeledReference?.normalizedValue, "");
  assert.equal(
    analysis.indicators.find((indicator) => indicator.type === "organization_alias")?.evidenceSource,
    "image",
  );

  const prompt = openai.calls[0].input[0].content.find((item) => item.type === "input_text").text;
  assert.match(prompt, /DETERMINISTIC QR DECODER OUTPUT/u);
  assert.match(prompt, new RegExp(SYNTHETIC_VIETQR_PAYLOAD, "u"));
  assert.equal(openai.calls[0].input[0].content.some((item) => item.type === "input_image"), true);
});

test("status decisions honor anchor and score thresholds without forcing nonspecific input", () => {
  const concrete = matchingAnalysis();
  assert.equal(decideCheckStatus({ analysis: concrete, candidate: null }), "new_unmatched_case");
  assert.equal(
    decideCheckStatus({ analysis: concrete, candidate: { anchorMatch: false, matchScore: 0.5499 } }),
    "new_unmatched_case",
  );
  assert.equal(
    decideCheckStatus({ analysis: concrete, candidate: { anchorMatch: false, matchScore: 0.55 } }),
    "possible_match",
  );
  assert.equal(
    decideCheckStatus({ analysis: concrete, candidate: { anchorMatch: false, matchScore: 0.8499 } }),
    "possible_match",
  );
  assert.equal(
    decideCheckStatus({ analysis: concrete, candidate: { anchorMatch: false, matchScore: 0.85 } }),
    "matched_campaign",
  );
  assert.equal(
    decideCheckStatus({ analysis: concrete, candidate: { anchorMatch: true, matchScore: 0.01 } }),
    "matched_campaign",
  );

  assert.equal(
    decideCheckStatus({
      analysis: { ...concrete, specificCase: false },
      candidate: { anchorMatch: true, matchScore: 1 },
    }),
    "not_scam",
  );
  assert.equal(
    decideCheckStatus({
      analysis: { ...concrete, primaryCategory: "noise", specificCase: false },
      candidate: {
        anchorMatch: true,
        matchScore: 1,
        campaign: { analystConfirmed: false },
      },
    }),
    "possible_match",
  );
  assert.equal(
    decideCheckStatus({
      analysis: { ...concrete, primaryCategory: "noise", specificCase: false },
      candidate: {
        anchorMatch: true,
        matchScore: 1,
        campaign: { analystConfirmed: true },
      },
    }),
    "matched_campaign",
  );
  assert.equal(
    decideCheckStatus({
      analysis: { ...concrete, primaryCategory: "news_pr" },
      candidate: { anchorMatch: true, matchScore: 1 },
    }),
    "not_scam",
  );
  assert.equal(
    decideCheckStatus({
      analysis: { ...concrete, primaryCategory: "customer_feedback" },
      candidate: null,
    }),
    "not_scam",
  );
});

test("contextual campaign relationships can only become possible matches", () => {
  const analysis = matchingAnalysis();
  const contextual = {
    matchMethod: "contextual",
    anchorMatch: true,
    matchScore: 1,
    campaign: campaignRow({ status: "confirmed", analyst_confirmed: true }),
  };
  assert.equal(decideCheckStatus({ analysis, candidate: contextual }), "possible_match");
  assert.equal(
    decideCheckStatus({
      analysis,
      candidate: { ...contextual, matchScore: 0.7499 },
    }),
    "new_unmatched_case",
  );
  assert.equal(
    decideCheckStatus({
      analysis: { ...analysis, specificCase: false },
      candidate: contextual,
    }),
    "not_scam",
  );
});

test("a model-classified specific scam remains a new unmatched case even at lower confidence", () => {
  const concrete = matchingAnalysis({ confidence: 0.59 });
  assert.equal(decideCheckStatus({ analysis: concrete, candidate: null }), "new_unmatched_case");
});

test("Supabase resolution keeps exact kind/value pairs and applies active campaign filters", async () => {
  const analysis = matchingAnalysis({
    indicators: [
      ...matchingAnalysis().indicators,
      {
        type: "email",
        value: "fraud@example.com",
        normalizedValue: "fraud@example.com",
        evidenceSource: "text",
        matchEligible: true,
      },
    ],
  });
  const db = fakeSupabase((query) => {
    if (query.table === "indicators") {
      // Supabase applies the two IN filters independently, so this deliberately
      // includes a cross-product row that must be rejected locally.
      return { data: [
        { id: IDS.phoneIndicator, kind: "phone", normalized_value: "0912345678" },
        { id: IDS.emailIndicator, kind: "email", normalized_value: "fraud@example.com" },
        {
          id: IDS.crossProductIndicator,
          kind: "phone",
          normalized_value: "fraud@example.com",
        },
      ] };
    }
    if (query.table === "campaign_indicators") {
      return { data: [
        {
          campaign_id: IDS.campaign,
          indicator_id: IDS.phoneIndicator,
          role: "shared",
          weight: 0.7,
          reasons: [{ source: "exact phone" }],
          is_active: true,
        },
        {
          campaign_id: IDS.campaign,
          indicator_id: IDS.emailIndicator,
          role: "supporting",
          weight: 0.8,
          reasons: [{ source: "exact email" }],
          is_active: true,
        },
        {
          campaign_id: IDS.dismissedCampaign,
          indicator_id: IDS.crossProductIndicator,
          role: "anchor",
          weight: 1,
          reasons: [{ source: "cross product poison" }],
          is_active: true,
        },
        {
          campaign_id: IDS.inactiveCampaign,
          indicator_id: IDS.phoneIndicator,
          role: "anchor",
          weight: 1,
          reasons: [],
          is_active: false,
        },
      ] };
    }
    if (query.table === "campaigns") {
      // Deliberately ignore query filters so local defenses are exercised too.
      return { data: [
        campaignRow(),
        campaignRow({
          id: IDS.dismissedCampaign,
          campaign_key: "phone:poison",
          status: "dismissed",
        }),
        campaignRow({
          id: IDS.inactiveCampaign,
          campaign_key: "phone:inactive",
          is_active: false,
        }),
      ] };
    }
    throw new Error(`Unexpected table ${query.table}`);
  });

  const candidate = await findCampaignMatch({ analysis, supabaseClient: db.client });
  assert.equal(candidate.campaign.id, IDS.campaign);
  assert.equal(candidate.anchorMatch, false);
  // shared .7 plus supporting (.8 * .75) combines as 1 - (.3 * .4).
  assert.equal(candidate.matchScore, 0.88);
  assert.deepEqual(
    candidate.matchedReasons.map((reason) => ({
      indicatorType: reason.indicatorType,
      normalizedValue: reason.normalizedValue,
      role: reason.role,
      reasons: reason.reasons,
    })),
    [
      {
        indicatorType: "phone",
        normalizedValue: "0912345678",
        role: "shared",
        reasons: [{ source: "exact phone" }],
      },
      {
        indicatorType: "email",
        normalizedValue: "fraud@example.com",
        role: "supporting",
        reasons: [{ source: "exact email" }],
      },
    ],
  );

  const indicatorQuery = db.calls.find((query) => query.table === "indicators");
  assert.deepEqual(findFilter(indicatorQuery, "in", "kind").value, ["phone", "email"]);
  assert.deepEqual(
    findFilter(indicatorQuery, "in", "normalized_value").value,
    ["0912345678", "fraud@example.com"],
  );
  assert.equal(indicatorQuery.limit, 500);

  const linkQuery = db.calls.find((query) => query.table === "campaign_indicators");
  assert.deepEqual(
    findFilter(linkQuery, "in", "indicator_id").value,
    [IDS.phoneIndicator, IDS.emailIndicator],
  );
  assert.equal(findFilter(linkQuery, "eq", "is_active").value, true);

  const campaignQuery = db.calls.find((query) => query.table === "campaigns");
  assert.equal(findFilter(campaignQuery, "eq", "is_active").value, true);
  assert.equal(findFilter(campaignQuery, "neq", "status").value, "dismissed");
});

test("unresolved and ineligible indicators never force a campaign match", async () => {
  let queried = false;
  const noEligible = await findCampaignMatch({
    analysis: matchingAnalysis({
      indicators: [{
        type: "person_alias",
        value: "Mr Scammer",
        normalizedValue: "mr scammer",
        evidenceSource: "text",
        matchEligible: false,
      }],
    }),
    supabaseClient: {
      from() {
        queried = true;
        throw new Error("should not query");
      },
    },
  });
  assert.equal(noEligible, null);
  assert.equal(queried, false);

  const db = fakeSupabase((query) => {
    assert.equal(query.table, "indicators");
    return { data: [] };
  });
  const unresolved = await findCampaignMatch({
    analysis: matchingAnalysis(),
    supabaseClient: db.client,
  });
  assert.equal(unresolved, null);
  assert.deepEqual(db.calls.map((query) => query.table), ["indicators"]);
});

test("contextual retrieval is bounded to active taxonomy-overlap campaigns", async () => {
  const related = campaignRow({
    id: IDS.contextualCampaign,
    campaign_key: "campaign:contextual",
    anchor_indicator_key: "domain|rotated.example",
    scam_types: ["bank_impersonation"],
    bank_roles: ["impersonated_bank"],
    document_count: 8,
  });
  const bankOnly = campaignRow({
    id: IDS.dismissedCampaign,
    campaign_key: "campaign:bank-only",
    scam_types: ["advance_fee"],
    bank_roles: ["impersonated_bank"],
    document_count: 3,
  });
  const fuzzyTaxonomy = campaignRow({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    campaign_key: "campaign:fuzzy-taxonomy",
    scam_types: ["impersonation"],
    bank_roles: ["unrelated"],
    document_count: 2,
  });
  const db = fakeSupabase((query) => {
    assert.equal(query.table, "campaigns");
    return { data: [
      related,
      bankOnly,
      campaignRow({
        id: IDS.inactiveCampaign,
        is_active: false,
        document_count: 20,
      }),
      campaignRow({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "dismissed",
        document_count: 20,
      }),
      fuzzyTaxonomy,
    ] };
  });

  const candidates = await retrieveContextualCampaignCandidates({
    analysis: matchingAnalysis(),
    supabaseClient: db.client,
  });

  assert.deepEqual(candidates.map((item) => item.campaign.id), [
    IDS.contextualCampaign,
    fuzzyTaxonomy.id,
    IDS.dismissedCampaign,
  ]);
  assert.ok(candidates[0].retrieval.score > candidates[1].retrieval.score);
  assert.equal(db.calls.length, 3);
  for (const query of db.calls) {
    assert.equal(findFilter(query, "eq", "is_active").value, true);
    assert.equal(findFilter(query, "neq", "status").value, "dismissed");
    assert.match(query.columns, /scam_types/u);
    assert.match(query.columns, /bank_roles/u);
  }
  const overlapQueries = db.calls.filter((query) => query.filters.some((item) => item.op === "overlaps"));
  assert.equal(overlapQueries.length, 2);
  assert.equal(overlapQueries.every((query) => query.limit === 12), true);
  const scanQuery = db.calls.find((query) => !query.filters.some((item) => item.op === "overlaps"));
  assert.equal(scanQuery.limit, 80);
});

test("contextual aliases bridge stored documents to rotated campaign infrastructure", async () => {
  const bridgedCampaign = campaignRow({
    id: IDS.contextualCampaign,
    campaign_key: "campaign:bridged",
    scam_types: ["legacy_taxonomy"],
    bank_roles: ["legacy_bank_role"],
    document_count: 3,
  });
  const analysis = matchingAnalysis({
    scamTypes: ["friend_impersonation"],
    bankRoles: ["receiving_bank"],
    indicators: [{
      type: "organization_alias",
      value: "VPBank",
      normalizedValue: "vpbank",
      evidenceSource: "text",
      matchEligible: false,
    }],
  });
  const db = fakeSupabase((query) => {
    if (query.table === "campaigns") return { data: [bridgedCampaign] };
    if (query.table === "indicators") {
      return { data: [{ id: "alias-vpbank", kind: "organization_alias", normalized_value: "vpbank" }] };
    }
    if (query.table === "document_indicators") {
      return { data: [{
        document_id: IDS.contextualDocument,
        indicator_id: "alias-vpbank",
        confidence: 0.95,
      }] };
    }
    if (query.table === "campaign_documents") {
      return { data: [{
        campaign_id: IDS.contextualCampaign,
        document_id: IDS.contextualDocument,
        is_active: true,
      }] };
    }
    throw new Error(`Unexpected table ${query.table}`);
  });

  const candidates = await retrieveContextualCampaignCandidates({ analysis, supabaseClient: db.client });
  assert.equal(candidates[0].campaign.id, IDS.contextualCampaign);
  assert.deepEqual(candidates[0].retrieval.bridgeTypes, ["organization_alias"]);
  assert.equal(candidates[0].retrieval.bridgeScore, 1);
  assert.deepEqual(db.calls.map((query) => query.table).sort(), [
    "campaign_documents",
    "campaigns",
    "campaigns",
    "campaigns",
    "document_indicators",
    "indicators",
  ]);
});

test("contextual profiles use capped linked Luna summaries", async () => {
  const candidates = [{
    campaign: {
      ...campaignRow({ id: IDS.contextualCampaign }),
      id: IDS.contextualCampaign,
      label: "VNeID verification loop",
      scamTypes: ["bank_impersonation"],
      bankRoles: ["impersonated_bank"],
      maximumSeverity: 5,
    },
    retrieval: { score: 0.9, scamOverlap: ["bank_impersonation"], bankOverlap: ["impersonated_bank"] },
  }];
  const db = fakeSupabase((query) => {
    if (query.table === "campaign_documents") {
      return { data: [
        {
          campaign_id: IDS.contextualCampaign,
          document_id: IDS.contextualDocument,
          membership_score: 0.93,
          reasons: [],
          is_active: true,
        },
      ] };
    }
    if (query.table === "classifications") {
      return { data: [{
        document_id: IDS.contextualDocument,
        primary_category: "impersonation_abuse",
        scam_types: ["bank_impersonation"],
        bank_roles: ["impersonated_bank"],
        specific_case: true,
        summary: "Fake VNeID support demanded APK installation before an urgent deadline.",
        severity: 5,
        confidence: 0.94,
      }] };
    }
    throw new Error(`Unexpected table ${query.table}`);
  });

  const profiles = await loadContextualCandidateProfiles({ candidates, supabaseClient: db.client });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].evidence.length, 1);
  assert.match(profiles[0].evidence[0].classification.summary, /APK installation/u);
  assert.equal(db.calls.find((query) => query.table === "campaign_documents").limit, 3);
  assert.deepEqual(
    findFilter(db.calls.find((query) => query.table === "classifications"), "in", "document_id").value,
    [IDS.contextualDocument],
  );
});

test("Luna reranking returns only a gated contextual relationship", async () => {
  const campaign = {
    id: IDS.contextualCampaign,
    campaignKey: "campaign:contextual",
    label: "VNeID verification loop",
    status: "confirmed",
    analystConfirmed: true,
    riskScore: 6,
    documentCount: 3,
    indicatorCount: 2,
    maximumSeverity: 5,
    averageConfidence: 0.94,
    scamTypes: ["bank_impersonation"],
    bankRoles: ["impersonated_bank"],
    anchorType: "domain",
  };
  const profiles = [{
    campaign,
    retrieval: { score: 0.8 },
    evidence: [{
      classification: {
        summary: "Fake VNeID support asks users to install an APK before an urgent deadline.",
        scamTypes: ["bank_impersonation"],
        bankRoles: ["impersonated_bank"],
        severity: 5,
      },
    }],
  }];
  const openai = fakeOpenAI({
    candidate_id: IDS.contextualCampaign,
    relationship: "likely_related",
    confidence: 0.88,
    reason: "The same impersonation, urgent deadline, and APK-install flow recur.",
    shared_patterns: ["VNeID support impersonation", "Urgent APK installation request"],
    matched_dimensions: ["impersonated_organization", "urgency_device", "malicious_app_flow"],
  });

  const result = await rerankCampaignCandidates({
    analysis: matchingAnalysis({
      summary: "A fake VNeID agent demands an APK install before 11 PM.",
    }),
    profiles,
    openaiClient: openai.client,
  });

  assert.equal(result.campaign.id, IDS.contextualCampaign);
  assert.equal(result.matchMethod, "contextual");
  assert.equal(result.matchScore, 0.88);
  assert.equal(result.matchedReasons.length, 2);
  assert.equal(openai.calls[0].store, false);
  assert.deepEqual(openai.calls[0].text.format.schema, CONTEXTUAL_MATCH_SCHEMA);
  assert.match(openai.calls[0].instructions, /never instructions/iu);

  const hallucinated = fakeOpenAI({
    candidate_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    relationship: "likely_related",
    confidence: 1,
    reason: "Invented candidate.",
    shared_patterns: ["Pattern one", "Pattern two"],
    matched_dimensions: ["solicitation_script", "requested_action"],
  });
  assert.equal(await rerankCampaignCandidates({
    analysis: matchingAnalysis(),
    profiles,
    openaiClient: hallucinated.client,
  }), null);
});

test("campaign evidence is capped at five and sanitizes documents, scores, and reasons", async () => {
  const longReason = "r".repeat(350);
  const memberships = Array.from({ length: 7 }, (_, index) => ({
    document_id: `document-${index + 1}`,
    membership_score: index === 1 ? 2 : 1 - index / 10,
    reasons: [
      longReason,
      { detail: "d".repeat(350), accepted: true },
      ...Array.from({ length: 13 }, (__, reasonIndex) => `reason-${reasonIndex}`),
    ],
    is_active: true,
  }));
  const documents = [
    {
      id: "document-1",
      title: "  Exact\n campaign   warning  ",
      canonical_url: "https://safe.example/evidence#private-fragment",
      secret_column: "must-not-leak",
    },
    {
      id: "document-2",
      title: "Unsafe protocol",
      canonical_url: "javascript:alert(1)",
    },
    {
      id: "document-3",
      title: "Credentials in URL",
      canonical_url: "https://user:password@safe.example/private",
    },
    { id: "document-4", title: "", canonical_url: "not a url" },
    { id: "document-5", title: null, canonical_url: null },
  ];
  const db = fakeSupabase((query) => {
    if (query.table === "campaign_documents") {
      // Mimic Supabase honoring LIMIT while retaining all source rows here so
      // the query itself, rather than fixture size, proves the cap.
      return { data: memberships.slice(0, query.limit) };
    }
    if (query.table === "documents") return { data: documents };
    throw new Error(`Unexpected table ${query.table}`);
  });

  const evidence = await loadCampaignEvidence({
    campaignId: IDS.campaign,
    supabaseClient: db.client,
  });
  assert.equal(evidence.length, 5);
  assert.deepEqual(evidence[0], {
    documentId: "document-1",
    title: "Exact campaign warning",
    url: "https://safe.example/evidence",
    membershipScore: 1,
    reasons: evidence[0].reasons,
  });
  assert.equal(evidence[0].reasons.length, 12);
  assert.equal(evidence[0].reasons[0].length, 300);
  assert.equal(evidence[0].reasons[1].detail.length, 300);
  assert.equal(evidence[1].url, null);
  assert.equal(evidence[1].membershipScore, 0);
  assert.equal(evidence[2].url, null);
  assert.equal(evidence[3].title, "Campaign evidence");
  assert.equal(evidence[4].title, "Campaign evidence");
  assert.equal(JSON.stringify(evidence).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(evidence).includes("private-fragment"), false);

  const membershipQuery = db.calls.find((query) => query.table === "campaign_documents");
  assert.equal(findFilter(membershipQuery, "eq", "campaign_id").value, IDS.campaign);
  assert.equal(findFilter(membershipQuery, "eq", "is_active").value, true);
  assert.deepEqual(membershipQuery.orders, [
    { column: "membership_score", value: { ascending: false } },
  ]);
  assert.equal(membershipQuery.limit, 5);
  const documentQuery = db.calls.find((query) => query.table === "documents");
  assert.deepEqual(
    findFilter(documentQuery, "in", "id").value,
    ["document-1", "document-2", "document-3", "document-4", "document-5"],
  );
});

test("missing campaign tables return the useful temporary 503 before OpenAI is called", async () => {
  const db = fakeSupabase((query) => {
    assert.equal(query.table, "campaigns");
    return {
      data: null,
      error: {
        code: "PGRST205",
        message: "Could not find public.campaigns and internal deployment details",
      },
    };
  });
  const openai = fakeOpenAI(modelAnalysis());

  await assert.rejects(
    ensureCampaignTablesReady(db.client),
    (error) => {
      assertCampaignError(error, { code: "CAMPAIGN_TABLES_NOT_READY", status: 503 });
      assert.match(error.message, /still being deployed/i);
      assert.equal(error.message.includes("public.campaigns"), false);
      return true;
    },
  );
  await assert.rejects(
    runCampaignCheck({
      input: { text: "concrete scam evidence", url: "", image: null },
      openaiClient: openai.client,
      supabaseClient: db.client,
    }),
    (error) => assertCampaignError(error, { code: "CAMPAIGN_TABLES_NOT_READY", status: 503 }),
  );
  assert.equal(openai.calls.length, 0);
});

test("runCampaignCheck returns the complete matched response contract with exact evidence", async () => {
  const linkReasons = [{ basis: "same normalized phone", source_document: "document-1" }];
  const openai = fakeOpenAI(modelAnalysis({
    indicators: [{
      type: "phone",
      value: "+84 912 345 678",
      normalized_value: "0912345678",
      evidence_source: "text",
    }],
  }));
  const db = fakeSupabase((query) => {
    if (query.table === "campaigns" && query.columns === "id") return { data: [] };
    if (query.table === "campaign_indicators" && query.columns === "campaign_id") {
      return { data: [] };
    }
    if (query.table === "campaign_documents" && query.columns === "campaign_id") {
      return { data: [] };
    }
    if (query.table === "indicators") {
      return { data: [{
        id: IDS.phoneIndicator,
        kind: "phone",
        normalized_value: "0912345678",
      }] };
    }
    if (query.table === "campaign_indicators") {
      return { data: [{
        campaign_id: IDS.campaign,
        indicator_id: IDS.phoneIndicator,
        role: "anchor",
        weight: 0.2,
        reasons: linkReasons,
        is_active: true,
      }] };
    }
    if (query.table === "campaigns") {
      return { data: [campaignRow({ status: "confirmed", analyst_confirmed: true })] };
    }
    if (query.table === "campaign_documents") {
      return { data: [{
        document_id: "document-1",
        membership_score: 0.95,
        reasons: [{ basis: "analyst-linked" }],
        is_active: true,
      }] };
    }
    if (query.table === "documents") {
      return { data: [{
        id: "document-1",
        title: "Bank impersonation report",
        canonical_url: "https://evidence.example/report",
      }] };
    }
    throw new Error(`Unexpected table/query ${query.table} ${query.columns}`);
  });

  const result = await runCampaignCheck({
    input: {
      text: "Call +84 912 345 678 before transferring the requested advance fee.",
      url: "",
      image: null,
    },
    openaiClient: openai.client,
    supabaseClient: db.client,
    model: "gpt-5.6-luna",
  });

  assert.equal(result.status, "matched_campaign");
  assert.equal(result.analysis.primaryCategory, "scam_report");
  assert.equal(result.campaign.id, IDS.campaign);
  assert.equal(result.campaign.status, "confirmed");
  assert.equal(result.campaign.analystConfirmed, true);
  assert.equal(result.campaign.matchMethod, "exact");
  assert.equal(result.campaign.matchScore, 0.2);
  assert.deepEqual(result.campaign.matchedReasons[0].reasons, linkReasons);
  assert.equal(Object.hasOwn(result.campaign, "anchorMatch"), false);
  assert.equal(Object.hasOwn(result.campaign, "complementProduct"), false);
  assert.deepEqual(result.evidence, [{
    documentId: "document-1",
    title: "Bank impersonation report",
    url: "https://evidence.example/report",
    membershipScore: 0.95,
    reasons: [{ basis: "analyst-linked" }],
  }]);
  assert.ok(result.recommendedActions.length > 0);
  assert.match(result.recommendedActions.join(" "), /confirmed campaign evidence/i);
});

test("runCampaignCheck can match a future campaign by deterministically decoded QR payload", async () => {
  const image = {
    bytes: new Uint8Array([11, 22, 33, 44]),
    mimeType: "image/png",
    name: "campaign-qr.png",
  };
  const decoderCalls = [];
  const openai = fakeOpenAI(modelAnalysis({ indicators: [] }));
  const db = fakeSupabase((query) => {
    if (query.table === "campaigns" && query.columns === "id") return { data: [] };
    if (query.table === "campaign_indicators" && query.columns === "campaign_id") {
      return { data: [] };
    }
    if (query.table === "campaign_documents" && query.columns === "campaign_id") {
      return { data: [] };
    }
    if (query.table === "indicators") {
      return { data: [{
        id: IDS.qrIndicator,
        kind: "qr_payload",
        normalized_value: SYNTHETIC_VIETQR_PAYLOAD,
      }] };
    }
    if (query.table === "campaign_indicators") {
      return { data: [{
        campaign_id: IDS.campaign,
        indicator_id: IDS.qrIndicator,
        role: "anchor",
        weight: 0.9,
        reasons: [{ basis: "same decoded QR" }],
        is_active: true,
      }] };
    }
    if (query.table === "campaigns") {
      return { data: [campaignRow()] };
    }
    if (query.table === "campaign_documents") return { data: [] };
    throw new Error(`Unexpected table/query ${query.table} ${query.columns}`);
  });

  const result = await runCampaignCheck({
    input: { text: "This recipient already took the payment and blocked contact.", url: "", image },
    openaiClient: openai.client,
    supabaseClient: db.client,
    qrDecoder: async (receivedImage) => {
      decoderCalls.push(receivedImage);
      return SYNTHETIC_VIETQR_PAYLOAD;
    },
  });

  assert.deepEqual(decoderCalls, [image]);
  assert.equal(result.status, "matched_campaign");
  assert.equal(result.campaign.matchScore, 0.9);
  assert.equal(result.campaign.matchMethod, "exact");
  assert.equal(result.campaign.analystConfirmed, false);
  assert.equal(result.campaign.matchedReasons[0].indicatorType, "qr_payload");
  assert.equal(result.campaign.matchedReasons[0].normalizedValue, SYNTHETIC_VIETQR_PAYLOAD);
  assert.equal(
    result.analysis.indicators.some((indicator) =>
      indicator.type === "qr_payload" &&
      indicator.normalizedValue === SYNTHETIC_VIETQR_PAYLOAD &&
      indicator.matchEligible),
    true,
  );
});

test("runCampaignCheck recognizes rotated infrastructure as likely related, never known", async () => {
  const candidateRow = campaignRow({
    id: IDS.contextualCampaign,
    campaign_key: "campaign:vneid-loop",
    label: "VNeID verification loop",
    status: "confirmed",
    analyst_confirmed: true,
    anchor_indicator_key: "domain|old-vneid.example",
    document_count: 4,
    scam_types: ["bank_impersonation"],
    bank_roles: ["impersonated_bank"],
  });
  const openai = fakeOpenAISequence([
    { output: modelAnalysis({
      summary: "A fake VNeID support agent uses a new domain but repeats an urgent APK-install request.",
      indicators: [{
        type: "domain",
        value: "new-vneid.example",
        normalized_value: "new-vneid.example",
        evidence_source: "text",
      }],
    }) },
    { output: {
      candidate_id: IDS.contextualCampaign,
      relationship: "likely_related",
      confidence: 0.91,
      reason: "The VNeID impersonation, urgent deadline, and APK-install flow recur despite a new domain.",
      shared_patterns: ["VNeID support impersonation", "Urgent APK installation request"],
      matched_dimensions: ["impersonated_organization", "urgency_device", "malicious_app_flow"],
    } },
  ]);
  const db = fakeSupabase((query) => {
    if (query.table === "campaigns" && query.columns === "id") return { data: [] };
    if (query.table === "campaign_indicators" && query.columns === "campaign_id") return { data: [] };
    if (query.table === "campaign_documents" && query.columns === "campaign_id") return { data: [] };
    if (query.table === "indicators") return { data: [] };
    if (query.table === "campaigns" && query.filters.some((item) => item.op === "overlaps")) {
      return { data: [candidateRow] };
    }
    if (query.table === "campaigns") return { data: [candidateRow] };
    if (
      query.table === "campaign_documents" &&
      query.columns.startsWith("campaign_id,")
    ) {
      return { data: [{
        campaign_id: IDS.contextualCampaign,
        document_id: IDS.contextualDocument,
        membership_score: 0.95,
        reasons: [],
        is_active: true,
      }] };
    }
    if (query.table === "classifications") {
      return { data: [{
        document_id: IDS.contextualDocument,
        primary_category: "impersonation_abuse",
        scam_types: ["bank_impersonation"],
        bank_roles: ["impersonated_bank"],
        specific_case: true,
        summary: "Fake VNeID support imposes an urgent deadline and asks the target to install an APK.",
        severity: 5,
        confidence: 0.95,
      }] };
    }
    if (query.table === "campaign_documents") {
      return { data: [{
        document_id: IDS.contextualDocument,
        membership_score: 0.95,
        reasons: [{ basis: "stored campaign membership" }],
        is_active: true,
      }] };
    }
    if (query.table === "documents") {
      return { data: [{
        id: IDS.contextualDocument,
        title: "VNeID impersonation warning",
        canonical_url: "https://evidence.example/vneid",
      }] };
    }
    throw new Error(`Unexpected table/query ${query.table} ${query.columns}`);
  });

  const result = await runCampaignCheck({
    input: {
      text: "Use new-vneid.example and install this APK before 11 PM to keep VNeID active.",
      url: "",
      image: null,
    },
    openaiClient: openai.client,
    supabaseClient: db.client,
  });

  assert.equal(result.status, "possible_match");
  assert.equal(result.campaign.id, IDS.contextualCampaign);
  assert.equal(result.campaign.analystConfirmed, true);
  assert.equal(result.campaign.matchMethod, "contextual");
  assert.equal(result.campaign.matchScore, 0.91);
  assert.equal(result.evidence.length, 1);
  assert.equal(openai.calls.length, 2);
  assert.match(result.recommendedActions.join(" "), /possible campaign match/i);
});

test("input validation and multipart parsing enforce required fields, URL rules, and image limits", async () => {
  assert.throws(
    () => validateCheckInput(),
    (error) => assertCampaignError(error, { code: "INPUT_REQUIRED", status: 400 }),
  );
  assert.throws(
    () => validateCheckInput({ url: "javascript:alert(1)" }),
    (error) => assertCampaignError(error, { code: "INVALID_URL", status: 400 }),
  );
  assert.throws(
    () => validateCheckInput({ text: "x".repeat(8_001) }),
    (error) => assertCampaignError(error, { code: "INPUT_TOO_LARGE", status: 413 }),
  );

  await assert.rejects(
    parseCheckFormData(new Request("http://localhost/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })),
    (error) => assertCampaignError(error, { code: "MULTIPART_REQUIRED", status: 415 }),
  );

  const emptyForm = new FormData();
  await assert.rejects(
    parseCheckFormData(new Request("http://localhost/api/check", {
      method: "POST",
      body: emptyForm,
    })),
    (error) => assertCampaignError(error, { code: "INPUT_REQUIRED", status: 400 }),
  );

  await assert.rejects(
    parseCheckFormData(fakeMultipartRequest({ image: uploadedFile({ type: "application/pdf" }) })),
    (error) => assertCampaignError(error, { code: "UNSUPPORTED_IMAGE_TYPE", status: 415 }),
  );
  await assert.rejects(
    parseCheckFormData(fakeMultipartRequest({
      image: [uploadedFile(), uploadedFile({ name: "second.png" })],
    })),
    (error) => assertCampaignError(error, { code: "TOO_MANY_IMAGES", status: 400 }),
  );

  let oversizedRead = false;
  const oversized = uploadedFile({ size: 8 * 1024 * 1024 + 1 });
  oversized.arrayBuffer = async () => {
    oversizedRead = true;
    return new ArrayBuffer(0);
  };
  await assert.rejects(
    parseCheckFormData(fakeMultipartRequest({ image: oversized })),
    (error) => assertCampaignError(error, { code: "IMAGE_TOO_LARGE", status: 413 }),
  );
  assert.equal(oversizedRead, false, "oversized files should be rejected before reading bytes");

  const parsed = await parseCheckFormData(fakeMultipartRequest({
    text: "  transfer request  ",
    url: "https://example.com/evidence",
    image: uploadedFile({ bytes: new Uint8Array([7, 8, 9]), name: "qr.png" }),
  }));
  assert.equal(parsed.text, "transfer request");
  assert.equal(parsed.url, "https://example.com/evidence");
  assert.deepEqual([...parsed.image.bytes], [7, 8, 9]);
  assert.equal(parsed.image.mimeType, "image/png");
  assert.equal(parsed.image.name, "qr.png");
});

test("missing server configuration is explicit and no service/OpenAI key is referenced by client code", async () => {
  assert.throws(
    () => createCampaignCheckClients(),
    (error) => assertCampaignError(error, { code: "CAMPAIGN_DATA_NOT_CONFIGURED", status: 503 }),
  );
  assert.throws(
    () => createCampaignCheckClients({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "server-only-secret",
    }),
    (error) => assertCampaignError(error, { code: "ANALYSIS_NOT_CONFIGURED", status: 503 }),
  );

  const [serverSource, routeSource, clientSource] = await Promise.all([
    readFile(new URL("../src/server/campaign-check.js", import.meta.url), "utf8"),
    readFile(new URL("../app/api/check/route.js", import.meta.url), "utf8"),
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(
    `${serverSource}\n${routeSource}`,
    /NEXT_PUBLIC_(?:SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY)/u,
  );
  assert.doesNotMatch(clientSource, /SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY/u);
  assert.doesNotMatch(
    clientSource,
    /server\/campaign-check|from\s+["']openai["']|@supabase\/supabase-js/u,
  );
  assert.doesNotMatch(serverSource, /tesseract|ocr[-_/ ]?space|sharp\s*from/iu);
});

test("successful route responses are no-store and keep server keys out of the response", async (t) => {
  const original = {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  };
  t.after(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("SUPABASE_URL", original.supabaseUrl);
    restore("SUPABASE_SERVICE_ROLE_KEY", original.serviceRoleKey);
    restore("OPENAI_API_KEY", original.openaiApiKey);
    restore("OPENAI_MODEL", original.model);
  });

  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-value";
  process.env.OPENAI_API_KEY = "openai-secret-value";
  process.env.OPENAI_MODEL = "gpt-5.6-luna";
  let clientConfig;
  let runArguments;
  const expected = {
    status: "new_unmatched_case",
    analysis: matchingAnalysis(),
    campaign: null,
    evidence: [],
    recommendedActions: ["Pause the transfer."],
  };

  const response = await handleCheckRequest(multipartTextRequest(), {
    createClients(config) {
      clientConfig = config;
      return {
        openaiClient: { fake: "openai" },
        supabaseClient: { fake: "supabase" },
      };
    },
    async runCheck(args) {
      runArguments = args;
      return expected;
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.deepEqual(clientConfig, {
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-secret-value",
    openaiApiKey: "openai-secret-value",
  });
  assert.equal(runArguments.input.text, "Please check this transfer request");
  assert.equal(runArguments.model, "gpt-5.6-luna");
  assert.deepEqual(body, expected);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("service-role-secret-value"), false);
  assert.equal(serialized.includes("openai-secret-value"), false);
});

test("known and unexpected route errors are sanitized and no-store", async (t) => {
  const originalConsoleError = console.error;
  const logCalls = [];
  console.error = (...args) => logCalls.push(args);
  t.after(() => {
    console.error = originalConsoleError;
  });

  const unavailable = await handleCheckRequest(multipartTextRequest(), {
    createClients: () => ({ openaiClient: {}, supabaseClient: {} }),
    runCheck: async () => {
      throw new CampaignCheckError(
        "Campaign tables are still being deployed. Try again shortly.",
        { code: "CAMPAIGN_TABLES_NOT_READY", status: 503 },
      );
    },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(unavailable.headers.get("pragma"), "no-cache");
  assert.deepEqual(await unavailable.json(), {
    status: "error",
    error: {
      code: "CAMPAIGN_TABLES_NOT_READY",
      message: "Campaign tables are still being deployed. Try again shortly.",
    },
  });

  const secret = "openai-secret-must-not-leak";
  const unexpected = await handleCheckRequest(multipartTextRequest(), {
    createClients: () => {
      throw new Error(`upstream failed with ${secret}`);
    },
    runCheck: async () => {
      throw new Error("unreachable");
    },
  });
  const unexpectedBody = await unexpected.json();
  assert.equal(unexpected.status, 502);
  assert.equal(unexpected.headers.get("cache-control"), "no-store, max-age=0");
  assert.deepEqual(unexpectedBody, {
    status: "error",
    error: {
      code: "CHECK_UNAVAILABLE",
      message: "The evidence check is temporarily unavailable.",
    },
  });
  assert.equal(JSON.stringify(unexpectedBody).includes(secret), false);
  assert.equal(JSON.stringify(logCalls).includes(secret), false);

  const invalidPost = await POST(new Request("http://localhost/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }));
  assert.equal(invalidPost.status, 415);
  assert.equal(invalidPost.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(invalidPost.headers.get("pragma"), "no-cache");
  assert.deepEqual(await invalidPost.json(), {
    status: "error",
    error: {
      code: "MULTIPART_REQUIRED",
      message: "Use multipart form data for this check.",
    },
  });
});
