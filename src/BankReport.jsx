"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Bank,
  Check,
  CheckCircle,
  DownloadSimple,
  FileCsv,
  FileText,
  Eye,
  LinkSimple,
  MagnifyingGlass,
  Moon,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  Sun,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { CampaignGraph } from "./CampaignGraph.jsx";
import { BankCharts } from "./BankCharts.jsx";
import { ScamConstellation } from "./ScamConstellation.jsx";
import {
  campaign,
  bankOptions,
  graphLinks,
  graphNodes,
  indicators as initialIndicators,
  nodeDetails,
  evidence,
  overviewActions,
  overviewCampaigns,
  tacticOptions,
  socialPosts,
} from "./bankMockData.js";

const EXPORT_OPTIONS = [
  {
    id: "soc",
    label: "SEND TO SOC",
    note: "Open a remediation case to contain internal exposure and close control gaps.",
    channel: "REMEDIATION CASE · API",
    result: "SOC remediation package prepared for CASE-SOC-2041",
    toastTitle: "SOC HANDOFF READY",
    deliveryNote: "DEMO MODE · NO EXTERNAL SYSTEM CONTACTED",
    icon: ShieldCheck,
    actionIcon: PaperPlaneTilt,
  },
  {
    id: "analysts",
    label: "ESCALATE TO FRAUD ANALYSTS",
    note: "Investigate emerging cases and determine whether they form a structured scam campaign.",
    channel: "INVESTIGATION QUEUE · WEBHOOK",
    result: "Emerging-campaign investigation package prepared for INV-8831",
    toastTitle: "ANALYST HANDOFF READY",
    deliveryNote: "DEMO MODE · NO EXTERNAL SYSTEM CONTACTED",
    icon: MagnifyingGlass,
    actionIcon: ArrowRight,
  },
  {
    id: "banlist",
    label: "EXPORT HIGH-CONFIDENCE SCAM ACCOUNT LIST",
    note: "Package confirmed scam accounts with linked evidence for ban review.",
    channel: "BAN REVIEW · CSV",
    icon: FileCsv,
    actionIcon: DownloadSimple,
  },
];

const BAN_CONFIDENCE_THRESHOLD = 95;

const HIGH_CONFIDENCE_SCAM_ACCOUNTS = [
  {
    bank: "MB",
    account: "•••• 8086",
    accountRef: "BANK-ACCT-0008086",
    confidence: 98,
    evidenceRefs: [
      evidence.phoneRotation.reference,
      evidence.moneyFlow.reference,
      evidence.language.reference,
      evidence.infrastructure.reference,
    ],
    sourceRefs: [socialPosts.telegram.reference, socialPosts.customer.reference],
    decisionAt: "2026-07-11T09:24:00+07:00",
    status: "confirmed",
  },
  {
    bank: "ACB",
    account: "•••• 1042",
    accountRef: "BANK-ACCT-0001042",
    confidence: 96,
    evidenceRefs: [
      evidence.moneyFlow.reference,
      evidence.language.reference,
      evidence.infrastructure.reference,
    ],
    sourceRefs: [socialPosts.telegram.reference, socialPosts.customer.reference],
    decisionAt: "2026-07-11T09:24:00+07:00",
    status: "confirmed",
  },
  {
    bank: "VCB",
    account: "•••• 9214",
    accountRef: "BANK-ACCT-0009214",
    confidence: 91,
    evidenceRefs: [evidence.phoneRotation.reference, evidence.moneyFlow.reference],
    sourceRefs: [socialPosts.customer.reference],
    decisionAt: null,
    status: "suggested",
  },
];

const BAN_READY_ACCOUNTS = HIGH_CONFIDENCE_SCAM_ACCOUNTS.filter(
  (account) => account.status === "confirmed" && account.confidence >= BAN_CONFIDENCE_THRESHOLD,
);
const BAN_READY_EVIDENCE_COUNT = new Set(
  BAN_READY_ACCOUNTS.flatMap((account) => account.evidenceRefs),
).size;
const BAN_READY_SOURCE_COUNT = new Set(
  BAN_READY_ACCOUNTS.flatMap((account) => account.sourceRefs),
).size;

const INITIAL_RELATIONSHIP_STATUSES = Object.fromEntries(
  graphLinks.map((link) => [link.id, link.status]),
);

const REVIEW_EDGE_BY_NODE = {
  "report-12843": "l5",
  "facebook-883": "l3",
  "phone-new": "l17",
  "account-new": "l15",
  phrase: "l13",
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, contained: 4 };
const SNAPSHOT_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
});
const CAMPAIGN_ROLE_GUIDE = [
  ["ANCHOR", "Immediate exact-key match"],
  ["SHARED", "Strong repeated signal"],
  ["SUPPORTING", "Weighted corroboration"],
  ["CONTEXT", "Low-weight context"],
];

function formatSnapshotTime(value) {
  return `${SNAPSHOT_TIME_FORMATTER.format(new Date(value)).toUpperCase()} UTC`;
}

function formatCampaignTime(value) {
  return value ? formatSnapshotTime(value) : "NOT RECORDED";
}

function formatRegistryLabel(value) {
  return value.replaceAll("_", " ").toUpperCase();
}

function LiveCampaignRegistry({ analytics }) {
  const isLive = analytics.status === "live";
  const campaigns = isLive ? analytics.campaigns : [];
  const visibleCampaigns = campaigns.slice(0, 4);

  return (
    <section className="live-campaign-registry" aria-labelledby="live-campaign-registry-title">
      <div className="overview-section-title">
        <div>
          <span id="live-campaign-registry-title">LIVE CAMPAIGN REGISTRY</span>
          <small>Active, non-dismissed Supabase campaigns. The prototype workspace remains separate.</small>
        </div>
        <strong>
          {isLive
            ? `${campaigns.length.toLocaleString("en-US")} ACTIVE`
            : analytics.status === "loading" ? "SYNCING" : "UNAVAILABLE"}
        </strong>
      </div>

      <div className="registry-method">
        <div className="registry-method-copy">
          <span>MATCHING METHOD</span>
          <strong>Deterministic exact normalized-indicator matching.</strong>
          <p>Resolved values join active campaign indicators. Stored role and weight determine the result; no embeddings or semantic clustering are used.</p>
          <div className="registry-thresholds">
            <span>ANCHOR OR ≥0.85 <strong>CAMPAIGN MATCH</strong></span>
            <span>≥0.55 <strong>POSSIBLE MATCH</strong></span>
            <span>BELOW 0.55 <strong>STAYS UNMATCHED</strong></span>
          </div>
        </div>
        <div className="registry-role-guide" aria-label="Campaign indicator roles">
          {CAMPAIGN_ROLE_GUIDE.map(([role, description]) => (
            <div key={role}><strong>{role}</strong><span>{description}</span></div>
          ))}
        </div>
      </div>

      {isLive && visibleCampaigns.length > 0 ? (
        <div className="live-registry-list">
          <div className="live-registry-head" aria-hidden="true">
            <span>CAMPAIGN</span><span>EVIDENCE</span><span>RISK</span><span>LAST SEEN</span>
          </div>
          {visibleCampaigns.map((item) => (
            <article key={item.id}>
              <div className="live-registry-identity">
                <span className={item.analystConfirmed ? "known" : "possible"}>
                  {item.analystConfirmed ? "KNOWN CAMPAIGN" : "POSSIBLE CAMPAIGN MATCH"}
                </span>
                <strong>{item.label}</strong>
                <small>{item.campaignKey}</small>
              </div>
              <div className="live-registry-evidence">
                <strong>{item.documentCount.toLocaleString("en-US")} docs · {item.indicatorCount.toLocaleString("en-US")} indicators</strong>
                <small>{item.scamTypes.length ? item.scamTypes.slice(0, 2).map(formatRegistryLabel).join(" · ") : "NO SCAM TYPE TAGGED"}</small>
              </div>
              <div className="live-registry-risk">
                <strong>{item.riskScore.toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong>
                <small>LEVEL {item.maximumSeverity} MAX · {(item.averageConfidence * 100).toFixed(0)}% AVG CONFIDENCE</small>
              </div>
              <div className="live-registry-last-seen">
                <strong>{formatCampaignTime(item.lastSeenAt)}</strong>
                <small>{item.status.toUpperCase()} · {item.bankRoles.length ? item.bankRoles.slice(0, 2).map(formatRegistryLabel).join(" · ") : "NO BANK ROLE TAGGED"}</small>
              </div>
            </article>
          ))}
          {campaigns.length > visibleCampaigns.length && (
            <p className="live-registry-overflow">Showing the four highest-risk campaigns of {campaigns.length.toLocaleString("en-US")} active records.</p>
          )}
        </div>
      ) : (
        <div className="registry-state">
          <strong>
            {analytics.status === "loading"
              ? "Syncing the campaign registry…"
              : isLive ? "No active campaigns are materialized yet." : "The live campaign registry is unavailable."}
          </strong>
          <p>{isLive ? "Customer checks remain unmatched until active campaign evidence is available." : "No prototype campaign has been substituted here."}</p>
        </div>
      )}
    </section>
  );
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function BankReport() {
  const [theme, setTheme] = useState("light");
  const [bankFilter, setBankFilter] = useState("ALL BANKS");
  const [tacticFilter, setTacticFilter] = useState("ALL TACTICS");
  const [analytics, setAnalytics] = useState({ status: "loading" });
  const [selectedCampaignId, setSelectedCampaignId] = useState(campaign.id);
  const [investigationOpen, setInvestigationOpen] = useState(false);
  const [relationshipStatuses, setRelationshipStatuses] = useState(INITIAL_RELATIONSHIP_STATUSES);
  const [selectedNode, setSelectedNode] = useState("report-12843");
  const [indicators, setIndicators] = useState(initialIndicators);
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [newIndicator, setNewIndicator] = useState({ type: "DOMAIN", value: "vneid-xacminh[.]online" });
  const [exported, setExported] = useState(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceOpenerRef = useRef(null);
  const evidenceCloseRef = useRef(null);
  const caseDetailRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 7000);

    async function syncAnalytics() {
      try {
        const response = await fetch("/api/bank-intelligence", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await response.json();
        const snapshot = payload?.snapshot;
        if (
          !response.ok ||
          payload?.status !== "live" ||
          !snapshot ||
          !Number.isSafeInteger(snapshot.documentsAnalyzed) ||
          !Number.isSafeInteger(snapshot.scamEvidenceDocuments) ||
          !Number.isSafeInteger(snapshot.uniqueIndicatorCount) ||
          !Number.isSafeInteger(snapshot.activeCampaigns) ||
          !Number.isSafeInteger(snapshot.linkedCampaigns) ||
          !Number.isSafeInteger(snapshot.highRiskCampaigns) ||
          Number.isNaN(new Date(snapshot.refreshedAt).getTime()) ||
          !Array.isArray(payload.categories) ||
          !Array.isArray(payload.severities) ||
          !Array.isArray(payload.campaigns)
        ) {
          throw new Error("Invalid bank intelligence response");
        }
        if (active) setAnalytics(payload);
      } catch {
        if (active) setAnalytics({ status: "unavailable" });
      } finally {
        window.clearTimeout(timeout);
      }
    }

    syncAnalytics();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const filteredCampaigns = useMemo(
    () => overviewCampaigns
      .filter((item) => {
        const matchesBank = bankFilter === "ALL BANKS" || item.banks.includes(bankFilter);
        const matchesTactic = tacticFilter === "ALL TACTICS" || item.tactics.includes(tacticFilter);
        return matchesBank && matchesTactic;
      })
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)),
    [bankFilter, tacticFilter],
  );
  const selectedCampaign = filteredCampaigns.find((item) => item.id === selectedCampaignId) || filteredCampaigns[0] || null;
  const filteredActions = overviewActions.filter((action) => filteredCampaigns.some((item) => item.id === action.campaignId));
  const priorityAction = filteredActions[0] || null;
  const overviewMetrics = analytics.status === "live"
    ? [
      { value: analytics.snapshot.activeCampaigns, label: "ACTIVE CAMPAIGNS" },
      { value: analytics.snapshot.scamEvidenceDocuments, label: "SCAM EVIDENCE DOCS" },
      { value: analytics.snapshot.uniqueIndicatorCount, label: "UNIQUE INDICATORS" },
      { value: analytics.snapshot.highRiskCampaigns, label: "HIGH-RISK CAMPAIGNS", urgent: true },
    ]
    : [
      { value: "—", label: "ACTIVE CAMPAIGNS" },
      { value: "—", label: "SCAM EVIDENCE DOCS" },
      { value: "—", label: "UNIQUE INDICATORS" },
      { value: "—", label: "HIGH-RISK CAMPAIGNS", urgent: true },
    ];

  const selectNode = useCallback((id) => {
    setSelectedNode(id);
    setEvidenceOpen(false);
  }, []);
  const selected = useMemo(
    () => graphNodes.find((node) => node.id === selectedNode) || graphNodes[0],
    [selectedNode],
  );
  const selectedDetail = nodeDetails[selected.id] || nodeDetails.campaign;
  const reviewEdgeId = REVIEW_EDGE_BY_NODE[selected.id];
  const reviewEdge = graphLinks.find((link) => link.id === reviewEdgeId);
  const reviewStatus = reviewEdge ? relationshipStatuses[reviewEdge.id] : null;
  const connectedRelationships = useMemo(
    () => graphLinks
      .filter((link) => link.source === selectedNode || link.target === selectedNode)
      .map((link) => {
        const otherId = link.source === selectedNode ? link.target : link.source;
        return {
          ...link,
          status: relationshipStatuses[link.id] || link.status,
          other: graphNodes.find((node) => node.id === otherId),
        };
      }),
    [relationshipStatuses, selectedNode],
  );

  useEffect(() => {
    if (!evidenceOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => evidenceCloseRef.current?.focus());
    function closeOnEscape(event) {
      if (event.key === "Escape") closeEvidence();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [evidenceOpen]);

  function addIndicator(event) {
    event.preventDefault();
    const value = newIndicator.value.trim();
    if (!value) return;
    setIndicators((current) => [
      ...current,
      { type: newIndicator.type, value, state: "NEW", sources: 1 },
    ]);
    setIndicatorOpen(false);
  }

  function updateRelationship(nextStatus) {
    if (!reviewEdgeId) return;
    setRelationshipStatuses((current) => ({ ...current, [reviewEdgeId]: nextStatus }));
  }

  function openEvidence(event) {
    evidenceOpenerRef.current = event.currentTarget;
    setEvidenceOpen(true);
  }

  function closeEvidence() {
    setEvidenceOpen(false);
    window.requestAnimationFrame(() => evidenceOpenerRef.current?.focus());
  }

  function downloadNodeReport() {
    const rows = [
      ["category", "label", "value", "source", "reference", "status"],
      ["node", "campaign", campaign.id, "CheckVar mock intelligence", selected.id, selectedDetail.status],
      ["node", "type", selected.type, "CheckVar graph", selected.id, selectedDetail.status],
      ["node", "label", selected.label, "CheckVar graph", selected.id, selectedDetail.status],
      ["node", "confidence", `${selectedDetail.confidence}%`, "CheckVar analysis", selected.id, selectedDetail.status],
      ...connectedRelationships.map((link) => [
        "relationship",
        link.type,
        link.other?.label || "Unknown node",
        "Campaign graph",
        link.id,
        link.status,
      ]),
      ...selectedDetail.evidence.map((item) => [
        "evidence",
        item.title,
        item.excerpt,
        item.source,
        item.reference,
        "privacy-redacted",
      ]),
      ...selectedDetail.relatedPosts.map((post) => [
        "related_post",
        post.title,
        post.excerpt,
        post.platform,
        post.reference,
        "captured",
      ]),
    ];
    downloadCsv(rows, `checkvar-${campaign.id}-${selected.id}-evidence.csv`);
    setExported({
      type: "csv",
      label: "REPORT FILE",
      title: "REPORT FILE EXPORTED",
      message: `${selected.label} evidence CSV downloaded`,
    });
  }

  function downloadCsv(rows, filename) {
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadBanList() {
    const rows = [
      ["bank", "internal_account_ref", "masked_account", "confidence", "evidence_refs", "source_refs", "campaign_id", "decision", "decision_at", "recommended_action"],
      ...BAN_READY_ACCOUNTS.map((account) => [
        account.bank,
        account.accountRef,
        account.account,
        `${account.confidence}%`,
        account.evidenceRefs.join(" | "),
        account.sourceRefs.join(" | "),
        campaign.id,
        account.status,
        account.decisionAt,
        "BAN_REVIEW",
      ]),
    ];
    downloadCsv(rows, `checkvar-${campaign.id}-high-confidence-account-ban-list.csv`);
    setExported({
      type: "csv",
      label: "BAN LIST",
      title: "BAN LIST EXPORTED",
      message: `${BAN_READY_ACCOUNTS.length} scam accounts exported with ${BAN_READY_EVIDENCE_COUNT} evidence records and ${BAN_READY_SOURCE_COUNT} sources`,
      deliveryNote: "LOCAL CSV · CUSTOMER IDENTITY EXCLUDED",
    });
  }

  function runExport(option) {
    if (option.id === "banlist") {
      downloadBanList();
      return;
    }
    setExported({
      type: option.id,
      label: option.label,
      title: option.toastTitle,
      message: option.result,
      deliveryNote: option.deliveryNote,
    });
  }

  function viewCampaign(id) {
    setSelectedCampaignId(id);
    setInvestigationOpen(false);
    window.requestAnimationFrame(() => caseDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function runOverviewAction(action) {
    viewCampaign(action.campaignId);
    setExported({
      type: "action",
      label: action.priority,
      title: "ACTION REVIEW OPENED",
      message: `${action.title} · ${action.owner}`,
      deliveryNote: "DEMO MODE · NO EXTERNAL SYSTEM CONTACTED",
    });
  }

  return (
    <main className={`bank-shell theme-${theme}`}>
      <div className="noise" aria-hidden="true" />
      <header className="bank-header">
        <a className="bank-brand" href="/">
          CHECKVAR <span>2.0</span>
        </a>
        <div className="bank-mode"><Bank size={15} weight="fill" /> BANK OPERATIONS</div>
        <div className="bank-header-actions">
          <span>ANALYST · {campaign.analyst.toUpperCase()}</span>
          <button
            className="theme-toggle bank-theme-toggle"
            type="button"
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            aria-pressed={theme === "dark"}
            onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={13} weight="fill" /> : <Sun size={13} weight="fill" />}
            <span>{theme === "light" ? "DARK" : "LIGHT"}</span>
          </button>
          <a href="/"><ArrowLeft size={14} /> CUSTOMER VIEW</a>
        </div>
      </header>

      <section className="campaign-report bank-overview">
        <div className="overview-heading">
          <div>
            <span>BANK SCAM OPERATIONS</span>
            <h1>Know what needs attention now.</h1>
            <p>Track active scam campaigns across banks and tactics, then move directly from evidence to the next decision.</p>
          </div>
          <div className="scope-filters" aria-label="Campaign scope filters">
            <label>
              <span>AFFECTED BANK</span>
              <select value={bankFilter} onChange={(event) => setBankFilter(event.target.value)}>
                {bankOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
            <label>
              <span>SCAM TACTIC</span>
              <select value={tacticFilter} onChange={(event) => setTacticFilter(event.target.value)}>
                {tacticOptions.map((option) => <option key={option}>{option}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="overview-priority-grid">
          <section className="situation-strip" aria-label="Overall scam situation">
            <div className="situation-copy">
              <span>GLOBAL DATA SNAPSHOT</span>
              <strong>
                {analytics.status === "live"
                  ? `${analytics.snapshot.activeCampaigns} active campaigns. ${analytics.snapshot.highRiskCampaigns} meet the risk score threshold.`
                  : analytics.status === "loading"
                    ? "Syncing the latest Supabase analytics snapshot…"
                    : "Live analytics are unavailable."}
              </strong>
              <p>
                {analytics.status === "live"
                  ? `Snapshot scope: ${analytics.snapshot.documentsAnalyzed.toLocaleString("en-US")} analyzed sources · ${analytics.snapshot.evidenceLinkCount.toLocaleString("en-US")} document-indicator links · ${(analytics.snapshot.averageConfidence * 100).toFixed(1)}% average confidence · as of ${formatSnapshotTime(analytics.snapshot.refreshedAt)}. Bank and tactic filters apply only to the prototype workspace.`
                  : analytics.status === "loading"
                    ? "Only data-backed totals will appear here."
                    : "No mock totals have been substituted."}
              </p>
            </div>
            <div className="overview-metrics">
              {overviewMetrics.map((metric) => (
                <div className={metric.urgent ? "urgent" : ""} key={metric.label}>
                  <strong>{typeof metric.value === "number" ? metric.value.toLocaleString("en-US") : metric.value}</strong>
                  <span>{metric.label}</span>
                </div>
              ))}
            </div>
          </section>

          <aside className="what-next-card">
            <div className="what-next-kicker"><span>WHAT TO DO NEXT</span><strong>PROTOTYPE</strong></div>
            {priorityAction ? (
              <>
                <h2>{priorityAction.title}</h2>
                <p>{priorityAction.reason}</p>
                <button onClick={() => runOverviewAction(priorityAction)}>{priorityAction.cta}<ArrowRight size={15} weight="bold" /></button>
              </>
            ) : (
              <div className="what-next-clear"><CheckCircle size={25} weight="fill" /><strong>No urgent action in this scope.</strong></div>
            )}
          </aside>
        </div>

        <BankCharts analytics={analytics} />

        <LiveCampaignRegistry analytics={analytics} />

        <div className="activity-grid">
          <section className="activity-card">
            <div className="overview-section-title"><div><span>RECENTLY DETECTED</span><small>Prototype activity for interaction testing.</small></div><strong>DEMO</strong></div>
            <div className="activity-list">
              {filteredCampaigns.slice(0, 3).map((item) => (
                <button key={item.id} onClick={() => viewCampaign(item.id)}>
                  <i className={item.severity} />
                  <span><strong>{item.plainName}</strong><small>{item.banks.join(" · ")} · {item.lastSeen}</small></span>
                  <em>{item.trend}</em><ArrowRight size={14} />
                </button>
              ))}
            </div>
          </section>
          <section className="activity-card">
            <div className="overview-section-title"><div><span>ACTIONED & CONTAINED</span><small>Prototype workflow states; no live action table exists.</small></div><strong>DEMO</strong></div>
            <div className="activity-list">
              {overviewCampaigns.filter((item) => item.status === "MONITORING" || item.status === "CONTAINED").map((item) => (
                <button key={item.id} onClick={() => viewCampaign(item.id)}>
                  <CheckCircle size={16} weight="fill" />
                  <span><strong>{item.plainName}</strong><small>{item.status} · {item.owner}</small></span>
                  <em>{item.trend}</em><ArrowRight size={14} />
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="overview-grid">
          <section className="campaign-list-section">
            <div className="overview-section-title">
              <div><span>PROTOTYPE CAMPAIGN WORKSPACE</span><small>Static campaign interactions are separate from the live aggregate snapshot above.</small></div>
              <strong>DEMO DATA</strong>
            </div>
            {filteredCampaigns.length ? (
              <div className="campaign-list">
                <div className="campaign-list-head" aria-hidden="true">
                  <span>CAMPAIGN</span><span>SCOPE</span><span>SITUATION</span><span>IMPACT</span><span>NEXT</span>
                </div>
                {filteredCampaigns.map((item) => (
                  <article className={selectedCampaign?.id === item.id ? "selected" : ""} key={item.id}>
                    <div className="campaign-identity">
                      <span>{item.id}</span>
                      <strong>{item.plainName}</strong>
                      <small>{item.name}</small>
                    </div>
                    <div className="campaign-scope">
                      <strong>{item.banks.join(" · ")}</strong>
                      <small>{item.tactics.join(" · ")}</small>
                    </div>
                    <div className="campaign-situation">
                      <strong className={item.severity}>{item.status}</strong>
                      <small>{item.trend} this week · {item.lastSeen}</small>
                    </div>
                    <div className="campaign-impact">
                      <strong>{item.exposure}</strong>
                      <small>{item.reports} reports · {item.confidence}% confidence</small>
                    </div>
                    <button onClick={() => viewCampaign(item.id)}>
                      <span>{item.nextAction}</span><ArrowRight size={15} weight="bold" />
                    </button>
                  </article>
                ))}
              </div>
            ) : <div className="overview-empty"><strong>No campaign found.</strong><p>Try a broader bank or scam-tactic filter.</p></div>}
          </section>

          <aside className="next-actions-section">
            <div className="overview-section-title">
              <div><span>NEXT ACTIONS</span><small>Static workflow demo; no live action table exists.</small></div>
              <strong>DEMO DATA</strong>
            </div>
            <div className="next-action-list">
              {filteredActions.map((action) => {
                const actionCampaign = overviewCampaigns.find((item) => item.id === action.campaignId);
                return (
                  <article key={action.id}>
                    <div className="action-meta"><strong className={action.priority.toLowerCase()}>{action.priority}</strong><span>{action.due}</span></div>
                    <h3>{action.title}</h3>
                    <p>{action.reason}</p>
                    <div><span>{actionCampaign?.plainName}</span><small>{action.owner}</small></div>
                    <button onClick={() => runOverviewAction(action)}>{action.cta}<ArrowRight size={14} weight="bold" /></button>
                  </article>
                );
              })}
              {!filteredActions.length && <div className="overview-empty compact"><strong>No open action.</strong><p>Nothing urgent matches the current scope.</p></div>}
            </div>
          </aside>
        </div>

        {selectedCampaign && (
          <section className="specific-scam" id="case-detail" ref={caseDetailRef}>
            <div className="specific-scam-header">
              <div>
                <span>SPECIFIC SCAM / {selectedCampaign.id}</span>
                <h2>{selectedCampaign.plainName}</h2>
                <p>{selectedCampaign.summary}</p>
              </div>
              <div className="case-status">
                <strong className={selectedCampaign.severity}>{selectedCampaign.status}</strong>
                <span>{selectedCampaign.confidence}% CONFIDENCE</span>
              </div>
            </div>
            <div className="specific-scam-grid">
              <section>
                <span>WHO IS AT RISK</span>
                <p>{selectedCampaign.target}</p>
                <div className="case-scope-chips">
                  {selectedCampaign.banks.map((bank) => <strong key={bank}>{bank}</strong>)}
                  {selectedCampaign.tactics.map((tactic) => <em key={tactic}>{tactic}</em>)}
                </div>
              </section>
              <section>
                <span>WHAT CHANGED RECENTLY</span>
                <p>{selectedCampaign.recentChange}</p>
                <small>LAST OBSERVED · {selectedCampaign.lastSeen}</small>
              </section>
              <section>
                <span>EVIDENCE IN THIS CASE</span>
                {selectedCampaign.evidence.map((item) => <strong key={item}>{item}</strong>)}
              </section>
              <section className="case-next-action">
                <span>RECOMMENDED NEXT ACTION</span>
                <h3>{selectedCampaign.nextAction}</h3>
                <p>{selectedCampaign.nextActionReason}</p>
                <button onClick={() => runOverviewAction({ campaignId: selectedCampaign.id, priority: "REVIEW", title: selectedCampaign.nextAction, owner: selectedCampaign.owner })}>OPEN ACTION REVIEW<ArrowRight size={15} weight="bold" /></button>
              </section>
            </div>
            <div className="case-indicators">
              <span>KNOWN INDICATORS</span>
              {selectedCampaign.indicators.map((item) => <strong key={item}>{item}</strong>)}
            </div>
            {selectedCampaign.id === campaign.id && (
              <button className="open-investigation" onClick={() => setInvestigationOpen((current) => !current)}>
                <Eye size={17} weight="bold" /> {investigationOpen ? "HIDE RELATIONSHIP INVESTIGATION" : "OPEN RELATIONSHIP INVESTIGATION"}
              </button>
            )}
          </section>
        )}

        {investigationOpen && selectedCampaign?.id === campaign.id && <section className="deep-investigation">
          <div className="deep-investigation-heading">
            <div><span>DEEP INVESTIGATION</span><h2>{campaign.name}</h2></div>
            <p>Select a signal to review its evidence and confirm or reject suggested relationships.</p>
          </div>
          <div className="bank-workspace">
          <section className="graph-panel">
            <div className="bank-panel-title">
              <div>
                <span>RELATIONSHIP GRAPH</span>
                <small>Social signals + privacy-redacted reports</small>
              </div>
              <div className="graph-legend">
                <span><i className="confirmed" /> CONFIRMED</span>
                <span><i className="suggested" /> SUGGESTED</span>
              </div>
            </div>
            <div className="graph-stage">
              <CampaignGraph
                nodes={graphNodes}
                links={graphLinks}
                selectedId={selectedNode}
                onSelect={selectNode}
                relationshipStatuses={relationshipStatuses}
              />
              <div className="graph-help">SCROLL TO ZOOM · DRAG TO PAN · SELECT A NODE</div>
              <div className="selected-node-chip">
                <span>{selected.type.toUpperCase()}</span>
                <strong>{selected.label}</strong>
              </div>
            </div>
          </section>

          <aside className="relationship-review node-inspector" data-selected-node={selected.id}>
            <div className="review-heading">
              <div>
                <span>NODE INTELLIGENCE / {selected.type.toUpperCase()}</span>
                <strong className={(reviewStatus || "confirmed").toLowerCase()}>{selectedDetail.status}</strong>
              </div>
              <small>{selectedDetail.confidence}%</small>
            </div>
            <h2>{selected.label}</h2>
            <p>{selectedDetail.summary}</p>
            <div className="node-facts">
              {selectedDetail.facts.map((item, index) => (
                <div key={item.label}>
                  <span>0{index + 1} / {item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.note}</small>
                </div>
              ))}
            </div>
            <div className="node-connections">
              <span>CONNECTED RELATIONSHIPS</span>
              {connectedRelationships.slice(0, 3).map((link) => (
                <div key={link.id}>
                  <strong>{link.type.replaceAll("_", " ")}</strong>
                  <small>{link.other?.label}</small>
                  <em className={link.status}>{link.status}</em>
                </div>
              ))}
            </div>
            <div className="related-post-preview">
              <span>RELATED POSTS</span>
              {selectedDetail.relatedPosts.slice(0, 2).map((post) => (
                <article key={post.reference}>
                  <div><strong>{post.platform}</strong><small>{post.age}</small></div>
                  <p>{post.title}</p>
                </article>
              ))}
            </div>
            {reviewEdge && (
              reviewStatus === "suggested" ? (
                <div className="review-actions compact-review-actions">
                  <button className="confirm-link" onClick={() => updateRelationship("confirmed")}>
                    <Check size={17} weight="bold" /> CONFIRM LINK
                  </button>
                  <button className="reject-link" onClick={() => updateRelationship("rejected")}>
                    <X size={16} /> REJECT
                  </button>
                </div>
              ) : (
                <div className={`review-decision ${reviewStatus}`}>
                  {reviewStatus === "confirmed" ? <CheckCircle size={21} weight="fill" /> : <XCircle size={21} weight="fill" />}
                  <div>
                    <strong>{reviewStatus === "confirmed" ? "Relationship confirmed" : "Relationship rejected"}</strong>
                    <span>Decision recorded by {campaign.analyst}</span>
                  </div>
                  <button onClick={() => updateRelationship("suggested")}>UNDO</button>
                </div>
              )
            )}
            <button className="compact-indicator-action" onClick={() => setIndicatorOpen(true)}>
              <Plus size={15} weight="bold" /> ADD NEW INDICATOR
            </button>
            <div className="node-inspector-actions">
              <button className="open-evidence-action" onClick={openEvidence}>
                <Eye size={17} weight="bold" /> OPEN FULL EVIDENCE
              </button>
              <button className="download-report-action" onClick={downloadNodeReport}>
                <DownloadSimple size={17} weight="bold" /> {reviewStatus === "suggested" ? "EXPORT DRAFT FILE" : "EXPORT REPORT FILE"}
              </button>
            </div>
          </aside>
        </div>

          <div className="bank-detail-grid export-only">
          <section className="export-section">
            <div className="section-heading"><div><span>OPERATIONAL ACTIONS</span><small>Turn confirmed campaign evidence into a clear bank response.</small></div></div>
            <div className="package-summary">
              <span>ACTION PACKAGE / {campaign.id}-V3</span>
              <strong>{BAN_READY_ACCOUNTS.length} ban-ready accounts · {BAN_READY_EVIDENCE_COUNT} evidence records · {BAN_READY_SOURCE_COUNT} supporting sources</strong>
              <p>Policy: confirmed + confidence ≥{BAN_CONFIDENCE_THRESHOLD}%. Customer identity fields remain excluded.</p>
            </div>
            <div className="export-options">
              {EXPORT_OPTIONS.map((option, index) => {
                const Icon = option.icon;
                const ActionIcon = option.actionIcon;
                return (
                  <button key={option.id} onClick={() => runExport(option)}>
                    <span className="action-icon" aria-hidden="true"><Icon size={19} /></span>
                    <span className="action-copy">
                      <em>0{index + 1} / {option.channel}</em>
                      <strong>{option.label}</strong>
                      <small>{option.note}</small>
                    </span>
                    <ActionIcon className="action-affordance" size={15} weight="bold" />
                  </button>
                );
              })}
            </div>
          </section>
          </div>
        </section>}

        <ScamConstellation campaigns={filteredCampaigns.length ? filteredCampaigns : overviewCampaigns} timeRange="30" />
      </section>

      <AnimatePresence>
        {indicatorOpen && (
          <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.form className="indicator-modal" onSubmit={addIndicator} initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}>
              <button type="button" className="close-modal" aria-label="Close indicator form" onClick={() => setIndicatorOpen(false)}><X size={18} /></button>
              <p className="eyebrow">NEW CAMPAIGN INDICATOR</p>
              <h3>Add what the scammer changed.</h3>
              <label>INDICATOR TYPE
                <select value={newIndicator.type} onChange={(event) => setNewIndicator((current) => ({ ...current, type: event.target.value }))}>
                  <option>DOMAIN</option><option>PHONE</option><option>ACCOUNT</option><option>QR PAYLOAD</option><option>SOCIAL HANDLE</option>
                </select>
              </label>
              <label>VALUE
                <input value={newIndicator.value} onChange={(event) => setNewIndicator((current) => ({ ...current, value: event.target.value }))} />
              </label>
              <div className="indicator-provenance"><LinkSimple size={17} /><span>Source: {selected.label}</span><strong>REDACTED</strong></div>
              <button className="confirm-link" type="submit"><Plus size={17} weight="bold" /> ADD TO CAMPAIGN</button>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {evidenceOpen && (
          <motion.div
            className="modal-backdrop evidence-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeEvidence();
            }}
          >
            <motion.section
              className="full-evidence-modal"
              role="dialog"
              aria-modal="true"
              aria-label={`Full evidence for ${selected.label}`}
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 24, opacity: 0 }}
            >
              <button ref={evidenceCloseRef} className="close-modal" aria-label="Close full evidence" onClick={closeEvidence}><X size={18} /></button>
              <header className="evidence-modal-header">
                <div><span>FULL EVIDENCE / {selected.type.toUpperCase()}</span><strong>{selectedDetail.status}</strong></div>
                <h2>{selected.label}</h2>
                <p>{selectedDetail.summary}</p>
              </header>
              <div className="evidence-modal-grid">
                <section>
                  <div className="modal-section-title"><FileText size={17} /><span>EVIDENCE RECORDS</span><strong>{selectedDetail.evidence.length}</strong></div>
                  <div className="full-evidence-list">
                    {selectedDetail.evidence.map((item) => (
                      <article key={item.reference}>
                        <div><span>{item.reference}</span><small>{item.captured}</small></div>
                        <h3>{item.title}</h3>
                        <p>{item.excerpt}</p>
                        <strong>{item.source}</strong>
                      </article>
                    ))}
                  </div>
                </section>
                <section>
                  <div className="modal-section-title"><LinkSimple size={17} /><span>RELATED POSTS</span><strong>{selectedDetail.relatedPosts.length}</strong></div>
                  <div className="full-post-list">
                    {selectedDetail.relatedPosts.map((post) => (
                      <article key={post.reference}>
                        <div><span>{post.platform}</span><small>{post.age}</small></div>
                        <h3>{post.title}</h3>
                        <p>{post.excerpt}</p>
                        <strong>{post.reference}</strong>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
              <footer className="evidence-modal-footer">
                <p><ShieldCheck size={17} weight="fill" /> Customer identity fields excluded from this evidence package.</p>
                <button onClick={downloadNodeReport}><DownloadSimple size={17} weight="bold" /> {reviewStatus === "suggested" ? "DOWNLOAD DRAFT CSV" : "DOWNLOAD CSV REPORT"}</button>
              </footer>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {exported && (
          <motion.div className="export-toast" role="status" aria-live="polite" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}>
            <ShieldCheck size={24} weight="fill" />
            <div><span>{exported.title ?? `${exported.label} EXPORT COMPLETE`}</span><strong>{exported.message}</strong><small>{exported.deliveryNote ?? "LOCAL FILE · CUSTOMER IDENTITY EXCLUDED"}</small></div>
            <button aria-label="Close export status" onClick={() => setExported(null)}><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
