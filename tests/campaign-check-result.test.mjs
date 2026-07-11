import assert from "node:assert/strict";
import test from "node:test";

import { campaignCheckResultFromResponse } from "../src/campaignCheckResult.js";

function payload(status, { analystConfirmed = false, withCampaign = true } = {}) {
  return {
    status,
    analysis: {
      primaryCategory: status === "not_scam" ? "news_pr" : "scam_report",
      specificCase: status !== "not_scam",
      summary: "Conservative customer evidence analysis.",
      severity: status === "not_scam" ? 1 : 4,
      confidence: 0.91,
      scamTypes: [],
      bankRoles: [],
      indicators: [
        {
          type: "phone",
          value: "0912345678",
          normalizedValue: "0912345678",
          evidenceSource: "text",
          matchEligible: true,
        },
      ],
    },
    campaign: withCampaign
      ? {
          id: "11111111-1111-4111-8111-111111111111",
          campaignKey: "campaign-key",
          label: "Support impersonation",
          status: analystConfirmed ? "confirmed" : "provisional",
          analystConfirmed,
          matchScore: 0.93,
          matchedReasons: [
            {
              indicatorType: "phone",
              normalizedValue: "0912345678",
              role: "anchor",
              weight: 1,
              scoreContribution: 1,
              reason: "Exact anchor phone match",
              reasons: [],
            },
          ],
          documentCount: 4,
          indicatorCount: 7,
          riskScore: 4.8,
          maximumSeverity: 5,
          averageConfidence: 0.95,
          firstSeenAt: "2026-07-01T00:00:00.000Z",
          lastSeenAt: "2026-07-11T00:00:00.000Z",
        }
      : null,
    evidence: [],
    recommendedActions: ["Pause the transfer."],
  };
}

test("unconfirmed matched campaigns are presented as possible matches", () => {
  const result = campaignCheckResultFromResponse(payload("matched_campaign"), "0912345678");
  assert.equal(result.resultKicker, "POSSIBLE CAMPAIGN MATCH");
  assert.equal(result.analystConfirmed, false);
  assert.equal(result.verdict, "risk");
});

test("only analyst-confirmed campaigns receive the known-campaign label", () => {
  const result = campaignCheckResultFromResponse(
    payload("matched_campaign", { analystConfirmed: true }),
    "0912345678",
  );
  assert.equal(result.resultKicker, "KNOWN CAMPAIGN");
  assert.equal(result.analystConfirmed, true);
});

test("new unmatched concrete cases remain risky and reportable", () => {
  const result = campaignCheckResultFromResponse(
    payload("new_unmatched_case", { withCampaign: false }),
    "new case",
  );
  assert.equal(result.verdict, "risk");
  assert.equal(result.resultKicker, "NEW UNMATCHED CASE");
  assert.equal(result.canPreviewAnonymousReport, true);
  assert.equal(result.hasCampaign, false);
});

test("not_scam is the only live clear result", () => {
  const result = campaignCheckResultFromResponse(
    payload("not_scam", { withCampaign: false }),
    "general warning",
  );
  assert.equal(result.verdict, "not_scam");
  assert.equal(result.resultKicker, "NO CONCRETE SCAM CASE");
  assert.equal(result.canPreviewAnonymousReport, false);
});

test("image-only analysis keeps classification and severity in the IMAGE filter", () => {
  const imagePayload = payload("not_scam", { withCampaign: false });
  imagePayload.analysis.indicators = [
    {
      type: "qr_payload",
      value: "000201-test-payload",
      normalizedValue: "000201-test-payload",
      evidenceSource: "qr_decoder",
      matchEligible: true,
    },
    {
      type: "media_hash",
      value: "a".repeat(64),
      normalizedValue: "a".repeat(64),
      evidenceSource: "image",
      matchEligible: true,
    },
  ];
  const result = campaignCheckResultFromResponse(imagePayload, "recipient-qr.png");
  assert.deepEqual(result.inputs, [["IMAGE", "recipient-qr.png"]]);
  assert.equal(result.evidence.every((row) => row[3] === "IMAGE"), true);
});

test("missing campaign dates stay missing and total indicator stats are labeled accurately", () => {
  const campaignPayload = payload("matched_campaign");
  campaignPayload.campaign.firstSeenAt = null;
  const result = campaignCheckResultFromResponse(campaignPayload, "0912345678");
  assert.deepEqual(
    result.impact.find(([, label]) => label === "TOTAL CAMPAIGN SIGNALS"),
    ["7", "TOTAL CAMPAIGN SIGNALS"],
  );
  assert.deepEqual(
    result.impact.find(([, label]) => label === "FIRST OBSERVED"),
    ["NOT RECORDED", "FIRST OBSERVED"],
  );
});
