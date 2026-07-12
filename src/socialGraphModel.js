const MAX_SCAM_TYPES_PER_CAMPAIGN = 3;
const MAX_BANK_ROLES_PER_CAMPAIGN = 2;

const TAXONOMY_LABELS = {
  bank_impersonation: { label: "Bank impersonation", type: "tactic" },
  credential_theft: { label: "Credential theft", type: "tactic" },
  phishing: { label: "Phishing", type: "tactic" },
  qr_payment_fraud: { label: "QR payment fraud", type: "tactic" },
  fake_payment_notification: { label: "Fake payment notice", type: "tactic" },
  advance_fee: { label: "Advance-fee scam", type: "tactic" },
  account_takeover: { label: "Account takeover", type: "tactic" },
  malicious_apk: { label: "Malicious APK", type: "tactic" },
  impersonated_bank: { label: "Impersonated bank", type: "bank" },
  receiving_account: { label: "Receiving account", type: "bank" },
  destination_bank: { label: "Destination bank", type: "bank" },
};

const BANK_PATTERNS = [
  ["techcombank", "Techcombank"],
  ["vietcombank", "Vietcombank"],
  ["vcb", "Vietcombank"],
  ["tpbank", "TPBank"],
  ["vpbank", "VPBank"],
  ["bidv", "BIDV"],
  ["mb_bank", "MB Bank"],
  ["mb bank", "MB Bank"],
  ["acb", "ACB"],
];

const INDICATOR_TYPES = {
  bank_account: "account",
  phone: "phone",
  domain: "domain",
  url: "domain",
  social_account: "mention",
  message_template: "phrase",
  email: "indicator",
  qr_payload: "indicator",
  transaction_reference: "indicator",
};

function stableIdPart(value) {
  const normalized = String(value).toLowerCase();
  const readable = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (readable) return readable;
  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `tag-${(hash >>> 0).toString(16)}`;
}

function taxonomyEntry(rawValue, fallbackType) {
  const normalized = String(rawValue || "").toLowerCase();
  if (TAXONOMY_LABELS[normalized]) return TAXONOMY_LABELS[normalized];
  const spaced = normalized.replaceAll("_", " ");
  for (const [needle, label] of BANK_PATTERNS) {
    if (normalized.includes(needle) || spaced.includes(needle)) {
      return { label, type: "bank" };
    }
  }
  const label = spaced.replace(/\b\p{L}/gu, (character) => character.toUpperCase()).trim();
  return label ? { label, type: fallbackType } : null;
}

function shortLabel(type) {
  return {
    campaign: "C",
    evidence: "E",
    account: "₫",
    phone: "☎",
    domain: "↗",
    tactic: "#",
    bank: "B",
    mention: "@",
    phrase: "T",
    indicator: "i",
  }[type] || "•";
}

function addUniqueNode(nodes, nodeIds, node) {
  if (nodeIds.has(node.id)) return;
  nodeIds.add(node.id);
  nodes.push({ ...node, short: node.short || shortLabel(node.type) });
}

function addUniqueLink(links, linkIds, link) {
  if (linkIds.has(link.id)) return;
  linkIds.add(link.id);
  links.push(link);
}

function linkStatus(campaign, fallback = "suggested") {
  return campaign?.analystConfirmed ? "confirmed" : fallback;
}

export function buildSocialListeningGraph({ campaigns = [], detail = null } = {}) {
  const nodes = [];
  const links = [];
  const nodeIds = new Set();
  const linkIds = new Set();
  const selectedCampaignId = detail?.campaign?.id || null;
  const visibleCampaigns = [...campaigns];
  if (selectedCampaignId && !visibleCampaigns.some((campaign) => campaign.id === selectedCampaignId)) {
    visibleCampaigns.push(detail.campaign);
  }

  const registryNodeId = "registry-live-campaigns";
  if (visibleCampaigns.length) {
    addUniqueNode(nodes, nodeIds, {
      id: registryNodeId,
      label: "CheckVar live campaign registry",
      type: "registry",
      group: "campaign",
      size: 22,
      short: "CV",
      detail: `${visibleCampaigns.length} active campaigns in the current scope`,
      status: "live",
    });
  }

  for (const campaign of visibleCampaigns) {
    const campaignNodeId = `campaign-${campaign.id}`;
    addUniqueNode(nodes, nodeIds, {
      id: campaignNodeId,
      label: campaign.label,
      type: "campaign",
      group: "campaign",
      size: Math.min(24, 16 + Math.sqrt(Math.max(1, campaign.documentCount))),
      detail: `${campaign.documentCount} documents · ${campaign.indicatorCount} indicators · risk ${campaign.riskScore}`,
      status: campaign.analystConfirmed ? "confirmed" : "provisional",
    });
    addUniqueLink(links, linkIds, {
      id: `${registryNodeId}-${campaignNodeId}`,
      source: registryNodeId,
      target: campaignNodeId,
      relation: "ACTIVE_CAMPAIGN",
      status: "confirmed",
      weight: 0.62,
    });

    const tags = [
      ...campaign.scamTypes
        .slice(0, MAX_SCAM_TYPES_PER_CAMPAIGN)
        .map((value) => taxonomyEntry(value, "tactic")),
      ...campaign.bankRoles
        .slice(0, MAX_BANK_ROLES_PER_CAMPAIGN)
        .map((value) => taxonomyEntry(value, "bank")),
    ].filter(Boolean);
    for (const tag of tags) {
      const tagId = `${tag.type}-${stableIdPart(tag.label)}`;
      addUniqueNode(nodes, nodeIds, {
        id: tagId,
        label: tag.label,
        type: tag.type,
        group: tag.type === "bank" ? "bank" : "tactic",
        size: 11,
        detail: tag.type === "bank" ? "Stored bank-role signal" : "Stored scam classification",
      });
      addUniqueLink(links, linkIds, {
        id: `${campaignNodeId}-${tagId}`,
        source: campaignNodeId,
        target: tagId,
        relation: tag.type === "bank" ? "BANK_ROLE" : "SCAM_TYPE",
        status: linkStatus(campaign),
        weight: Math.max(0.55, campaign.averageConfidence || 0),
      });
    }
  }

  if (detail?.campaign && nodeIds.has(`campaign-${detail.campaign.id}`)) {
    const campaignNodeId = `campaign-${detail.campaign.id}`;
    for (const evidence of detail.evidence || []) {
      const evidenceNodeId = `evidence-${evidence.documentId}`;
      addUniqueNode(nodes, nodeIds, {
        id: evidenceNodeId,
        label: evidence.title,
        type: "evidence",
        group: "evidence",
        size: 11 + evidence.membershipScore * 4,
        detail: `${evidence.platform || "Source"} · ${(evidence.membershipScore * 100).toFixed(0)}% campaign link`,
        status: evidence.analystConfirmed ? "confirmed" : "observed",
      });
      addUniqueLink(links, linkIds, {
        id: `${campaignNodeId}-${evidenceNodeId}`,
        source: campaignNodeId,
        target: evidenceNodeId,
        relation: "SOURCE_EVIDENCE",
        status: evidence.analystConfirmed ? "confirmed" : "suggested",
        weight: evidence.membershipScore,
      });
    }

    for (const indicator of detail.indicators || []) {
      const type = INDICATOR_TYPES[indicator.kind] || "indicator";
      const indicatorNodeId = `indicator-${indicator.id}`;
      addUniqueNode(nodes, nodeIds, {
        id: indicatorNodeId,
        label: indicator.displayValue,
        type,
        group: "indicator",
        size: indicator.role === "anchor" ? 15 : indicator.role === "shared" ? 13 : 10,
        detail: `${indicator.role} indicator · ${(indicator.weight * 100).toFixed(0)}% stored weight`,
        status: indicator.role,
      });
      addUniqueLink(links, linkIds, {
        id: `${campaignNodeId}-${indicatorNodeId}`,
        source: campaignNodeId,
        target: indicatorNodeId,
        relation: indicator.role.toUpperCase(),
        status: linkStatus(detail.campaign),
        weight: indicator.weight,
      });
    }
  }

  return { nodes, links, campaignCount: visibleCampaigns.length };
}

export function filterSocialListeningGraph(graph, nodeType) {
  if (!graph || nodeType === "ALL") return graph;
  const type = nodeType.toLowerCase();
  const visibleNodes = graph.nodes.filter((node) => node.type === "campaign" || node.type === type);
  const ids = new Set(visibleNodes.map((node) => node.id));
  return {
    ...graph,
    nodes: visibleNodes,
    links: graph.links.filter((link) => ids.has(link.source) && ids.has(link.target)),
  };
}
