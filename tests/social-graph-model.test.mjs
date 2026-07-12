import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSocialListeningGraph,
  filterSocialListeningGraph,
} from "../src/socialGraphModel.js";

const campaign = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Live campaign A",
  analystConfirmed: false,
  riskScore: 5.6,
  documentCount: 2,
  indicatorCount: 3,
  averageConfidence: 0.94,
  scamTypes: ["qr_payment_fraud", "qr_payment_fraud", "romance_bait"],
  bankRoles: ["merchant_acquirer", "mb_bank", "receiving_account"],
};

const detail = {
  campaign,
  evidence: [
    {
      documentId: "22222222-2222-4222-8222-222222222222",
      title: "Live source document",
      platform: "facebook",
      membershipScore: 0.91,
      analystConfirmed: false,
    },
  ],
  indicators: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "bank_account",
      displayValue: "bank account ••••3456",
      role: "anchor",
      weight: 0.98,
    },
  ],
};

test("social graph maps live campaign, evidence, taxonomy, and masked indicators", () => {
  const graph = buildSocialListeningGraph({ campaigns: [campaign], detail });

  assert.equal(graph.campaignCount, 1);
  assert.equal(graph.nodes.some((node) => node.label === "CheckVar live campaign registry"), true);
  assert.equal(graph.nodes.some((node) => node.label === campaign.label), true);
  assert.equal(graph.nodes.some((node) => node.label === "Live source document"), true);
  assert.equal(graph.nodes.some((node) => node.label === "bank account ••••3456"), true);
  assert.equal(graph.nodes.some((node) => node.label === "QR payment fraud"), true);
  assert.equal(graph.nodes.some((node) => node.label === "MB Bank"), true);
  assert.equal(graph.nodes.some((node) => node.label === "Romance Bait"), true);
  assert.equal(graph.nodes.some((node) => node.label === "Merchant Acquirer"), true);
  assert.equal(graph.links.every((link) => typeof link.source === "string" && typeof link.target === "string"), true);
  assert.equal(new Set(graph.links.map((link) => link.id)).size, graph.links.length);
  assert.equal(
    graph.links.find((link) => link.relation === "ANCHOR")?.status,
    "suggested",
  );
  assert.equal(JSON.stringify(graph).includes("CP-2407"), false);
});

test("social graph filtering keeps campaign hubs and only requested live node types", () => {
  const graph = buildSocialListeningGraph({ campaigns: [campaign], detail });
  const filtered = filterSocialListeningGraph(graph, "ACCOUNT");

  assert.deepEqual(new Set(filtered.nodes.map((node) => node.type)), new Set(["campaign", "account"]));
  assert.equal(filtered.links.length, 1);
  assert.equal(filtered.links[0].relation, "ANCHOR");
});

test("social graph includes every live campaign in the current filter scope", () => {
  const campaigns = Array.from({ length: 15 }, (_, index) => ({
    ...campaign,
    id: `campaign-${index}`,
    label: `Live campaign ${index}`,
  }));
  const graph = buildSocialListeningGraph({ campaigns });

  assert.equal(graph.campaignCount, campaigns.length);
  assert.equal(graph.nodes.filter((node) => node.type === "campaign").length, campaigns.length);
});

test("bank operations renders only the live relationship graph", async () => {
  const source = await readFile(new URL("../src/BankReport.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /CampaignGraph|graphNodes|DEEP INVESTIGATION/u);
  assert.match(source, /ScamConstellation/u);
  assert.match(source, /PROTOTYPE CAMPAIGN · DEMO DATA/u);
});
