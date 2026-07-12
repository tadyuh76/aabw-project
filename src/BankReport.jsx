"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Bank,
  CheckCircle,
  Moon,
  ShieldCheck,
  Sun,
  X,
} from "@phosphor-icons/react";
import { BankCharts } from "./BankCharts.jsx";
import { ScamConstellation } from "./ScamConstellation.jsx";
import {
  campaign,
  bankOptions,
  overviewActions,
  overviewCampaigns,
  tacticOptions,
} from "./bankMockData.js";

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
const BANK_PATTERNS = {
  MB: /\bmb(?: bank)?\b/u,
  VCB: /\b(?:vcb|vietcombank)\b/u,
  ACB: /\bacb\b/u,
  TPBANK: /\b(?:tpbank|tp bank)\b/u,
  TECHCOMBANK: /\btechcombank\b/u,
  BIDV: /\bbidv\b/u,
  VPBANK: /\b(?:vpbank|vp bank)\b/u,
};
const TACTIC_PATTERNS = {
  IMPERSONATION: /imperson|gia danh|gi danh|m o danh|fake support/u,
  PHISHING: /phishing|credential|fake login/u,
  "QR RELAY": /\bqr\b/u,
  VISHING: /vishing|voice call|caller/u,
  "ADVANCE FEE": /advance fee|deposit scam|upfront fee/u,
  "ACCOUNT TAKEOVER": /account takeover|chi m quy|credential theft/u,
  "MALICIOUS APK": /malicious apk|\bapk\b|malware/u,
};
const TAXONOMY_LABELS = {
  bank_impersonation: "BANK IMPERSONATION",
  credential_theft: "CREDENTIAL THEFT",
  phishing: "PHISHING",
  qr_payment_fraud: "QR PAYMENT FRAUD",
  fake_payment_notification: "FAKE PAYMENT NOTICE",
  impersonated_bank: "IMPERSONATED BANK",
  receiving_account: "RECEIVING ACCOUNT",
  destination_bank: "DESTINATION BANK",
};

function formatSnapshotTime(value) {
  return `${SNAPSHOT_TIME_FORMATTER.format(new Date(value)).toUpperCase()} UTC`;
}

function formatCampaignTime(value) {
  return value ? formatSnapshotTime(value) : "NOT RECORDED";
}

function campaignTaxonomyText(campaign) {
  return [...campaign.scamTypes, ...campaign.bankRoles, campaign.label]
    .join(" ")
    .replaceAll("_", " ")
    .toLowerCase();
}

function campaignHasBank(campaign, bank) {
  return bank === "ALL BANKS" || BANK_PATTERNS[bank]?.test(campaignTaxonomyText(campaign));
}

function campaignHasTactic(campaign, tactic) {
  return tactic === "ALL TACTICS" || TACTIC_PATTERNS[tactic]?.test(campaignTaxonomyText(campaign));
}

function formatRegistryLabel(value, fallback) {
  const normalized = String(value || "").toLowerCase();
  if (TAXONOMY_LABELS[normalized]) return TAXONOMY_LABELS[normalized];
  for (const [bank, pattern] of Object.entries(BANK_PATTERNS)) {
    if (pattern.test(normalized.replaceAll("_", " "))) return bank;
  }
  return fallback;
}

function registryLabels(values, fallback) {
  return [...new Set(values.map((value) => formatRegistryLabel(value, fallback)))].slice(0, 2);
}

function campaignSeverity(campaign) {
  if (campaign.maximumSeverity >= 5) return "critical";
  if (campaign.maximumSeverity === 4) return "high";
  if (campaign.maximumSeverity === 3) return "medium";
  return "low";
}

function deriveLiveAction(campaign) {
  if (!campaign) return null;
  if (!campaign.analystConfirmed) {
    return {
      campaignId: campaign.id,
      priority: campaign.riskScore >= 5 ? "URGENT" : "REVIEW",
      title: "Confirm the strongest campaign link",
      reason: `${campaign.documentCount} source documents and ${campaign.indicatorCount} exact indicators are linked, but an analyst has not confirmed this campaign yet.`,
      owner: "Fraud Analysis",
      cta: "OPEN LIVE EVIDENCE",
    };
  }
  if (campaign.maximumSeverity >= 5) {
    return {
      campaignId: campaign.id,
      priority: "URGENT",
      title: "Escalate this confirmed high-severity campaign",
      reason: `The campaign is analyst-confirmed, reaches severity level ${campaign.maximumSeverity}, and was last observed ${formatCampaignTime(campaign.lastSeenAt)}.`,
      owner: "Fraud Operations",
      cta: "OPEN LIVE EVIDENCE",
    };
  }
  return {
    campaignId: campaign.id,
    priority: "REVIEW",
    title: "Review the newest linked evidence",
    reason: `${campaign.documentCount} source documents currently support this active campaign.`,
    owner: "Fraud Analysis",
    cta: "OPEN LIVE EVIDENCE",
  };
}

function LiveCampaignRegistry({ analytics, campaigns, selectedId, onSelect }) {
  const isLive = analytics.status === "live";
  const visibleCampaigns = campaigns.slice(0, 8);

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
          <span>CUSTOMER CAMPAIGN RESOLUTION</span>
          <strong>Exact signals first, bounded Luna comparison second.</strong>
          <p>Exact normalized indicators remain authoritative. When infrastructure rotates, stored taxonomy retrieves a small candidate set and Luna compares linked evidence summaries; no embeddings or semantic clustering are used.</p>
          <div className="registry-thresholds">
            <span>EXACT + CONFIRMED <strong>KNOWN CAMPAIGN</strong></span>
            <span>CONTEXT ≥0.75 <strong>LIKELY RELATED</strong></span>
            <span>BELOW GATES <strong>NEW / UNMATCHED</strong></span>
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
            <button
              className={`live-registry-row${selectedId === item.id ? " selected" : ""}`}
              key={item.id}
              onClick={() => onSelect(item.id)}
              type="button"
            >
              <div className="live-registry-identity">
                <span className={item.analystConfirmed ? "known" : "possible"}>
                  {item.analystConfirmed ? "KNOWN CAMPAIGN" : "PROVISIONAL CAMPAIGN"}
                </span>
                <strong>{item.label}</strong>
                <small>{item.campaignKey}</small>
              </div>
              <div className="live-registry-evidence">
                <strong>{item.documentCount.toLocaleString("en-US")} docs · {item.indicatorCount.toLocaleString("en-US")} total signals</strong>
                <small>{item.scamTypes.length ? registryLabels(item.scamTypes, "OTHER DETECTED TACTIC").join(" · ") : "NO SCAM TYPE TAGGED"}</small>
              </div>
              <div className="live-registry-risk">
                <strong>{item.riskScore.toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong>
                <small>LEVEL {item.maximumSeverity} MAX · {(item.averageConfidence * 100).toFixed(0)}% AVG CONFIDENCE</small>
              </div>
              <div className="live-registry-last-seen">
                <strong>{formatCampaignTime(item.lastSeenAt)}</strong>
                <small>{item.status.toUpperCase()} · {item.bankRoles.length ? registryLabels(item.bankRoles, "OTHER BANK SIGNAL").join(" · ") : "NO BANK ROLE TAGGED"}</small>
              </div>
            </button>
          ))}
          {campaigns.length > visibleCampaigns.length && (
            <p className="live-registry-overflow">Showing the eight highest-risk campaigns of {campaigns.length.toLocaleString("en-US")} active records in scope.</p>
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

function LiveCampaignDetail({ campaign, detailState, detailRef, action, onAction }) {
  if (!campaign) return null;
  const detail = detailState.status === "live" ? detailState.data : null;
  const source = detail?.campaign || campaign;
  const tacticLabels = registryLabels(source.scamTypes, "OTHER DETECTED TACTIC");
  const bankLabels = registryLabels(source.bankRoles, "OTHER BANK SIGNAL");

  return (
    <section className="specific-scam live-specific-scam" id="live-campaign-detail" ref={detailRef}>
      <div className="specific-scam-header">
        <div>
          <span>LIVE CAMPAIGN / {source.id.slice(0, 8).toUpperCase()}</span>
          <h2>{source.label}</h2>
          <p>This active Supabase campaign links {source.documentCount.toLocaleString("en-US")} source documents through {source.indicatorCount.toLocaleString("en-US")} exact stored indicators.</p>
        </div>
        <div className="case-status">
          <strong className={campaignSeverity(source)}>{source.analystConfirmed ? "ANALYST CONFIRMED" : "PROVISIONAL"}</strong>
          <span>RISK {source.riskScore.toLocaleString("en-US", { maximumFractionDigits: 2 })} · {(source.averageConfidence * 100).toFixed(0)}% AVG CONFIDENCE</span>
        </div>
      </div>
      <div className="specific-scam-grid">
        <section>
          <span>CAMPAIGN SCOPE</span>
          <p>Stored classification and bank-role tags attached to the campaign evidence.</p>
          <div className="case-scope-chips">
            {bankLabels.map((label) => <strong key={label}>{label}</strong>)}
            {tacticLabels.map((label) => <em key={label}>{label}</em>)}
          </div>
        </section>
        <section>
          <span>OBSERVATION WINDOW</span>
          <p>First observed {formatCampaignTime(source.firstSeenAt)}.</p>
          <small>LAST OBSERVED · {formatCampaignTime(source.lastSeenAt)}</small>
        </section>
        <section>
          <span>LIVE EVIDENCE</span>
          {detailState.status === "loading" && <p>Loading linked source documents…</p>}
          {detailState.status === "unavailable" && <p>Linked evidence is temporarily unavailable. No demo evidence has been substituted.</p>}
          {detail && detail.evidence.length === 0 && <p>No active source documents are linked yet.</p>}
          {detail?.evidence.slice(0, 4).map((item) => (
            <strong className="live-evidence-entry" key={item.documentId}>
              {item.title}
              <small>{(item.platform || "SOURCE").toUpperCase()} · {(item.membershipScore * 100).toFixed(0)}% LINK{item.analystConfirmed ? " · CONFIRMED" : ""}</small>
            </strong>
          ))}
        </section>
        <section className="case-next-action">
          <span>RECOMMENDED NEXT ACTION</span>
          <h3>{action.title}</h3>
          <p>{action.reason}</p>
          <button onClick={onAction}>{action.cta}<ArrowRight size={15} weight="bold" /></button>
        </section>
      </div>
      <div className="case-indicators live-case-indicators">
        <span>EXACT INDICATORS</span>
        {detailState.status === "loading" && <small>Loading…</small>}
        {detail?.indicators.length === 0 && <small>No active indicators are linked.</small>}
        {detail?.indicators.slice(0, 10).map((item) => (
          <strong key={item.id}>{item.displayValue} · {item.role.toUpperCase()}</strong>
        ))}
      </div>
    </section>
  );
}

export function BankReport() {
  const [theme, setTheme] = useState("light");
  const [bankFilter, setBankFilter] = useState("ALL BANKS");
  const [tacticFilter, setTacticFilter] = useState("ALL TACTICS");
  const [analytics, setAnalytics] = useState({ status: "loading" });
  const [selectedLiveCampaignId, setSelectedLiveCampaignId] = useState(null);
  const [liveDetailState, setLiveDetailState] = useState({ status: "idle" });
  const [selectedCampaignId, setSelectedCampaignId] = useState(campaign.id);
  const [exported, setExported] = useState(null);
  const caseDetailRef = useRef(null);
  const liveCampaignDetailRef = useRef(null);

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

  const filteredLiveCampaigns = useMemo(
    () => analytics.status === "live"
      ? analytics.campaigns.filter(
        (item) => campaignHasBank(item, bankFilter) && campaignHasTactic(item, tacticFilter),
      )
      : [],
    [analytics, bankFilter, tacticFilter],
  );

  useEffect(() => {
    if (!filteredLiveCampaigns.length) {
      setSelectedLiveCampaignId(null);
      return;
    }
    if (!filteredLiveCampaigns.some((item) => item.id === selectedLiveCampaignId)) {
      setSelectedLiveCampaignId(filteredLiveCampaigns[0].id);
    }
  }, [filteredLiveCampaigns, selectedLiveCampaignId]);

  const selectedLiveCampaign = filteredLiveCampaigns.find(
    (item) => item.id === selectedLiveCampaignId,
  ) || null;
  const livePriorityAction = deriveLiveAction(selectedLiveCampaign || filteredLiveCampaigns[0]);

  useEffect(() => {
    if (!selectedLiveCampaignId) {
      setLiveDetailState({ status: "idle" });
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    setLiveDetailState({ status: "loading" });

    async function syncCampaignDetail() {
      try {
        const response = await fetch(`/api/bank-intelligence/${encodeURIComponent(selectedLiveCampaignId)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const payload = await response.json();
        if (
          !response.ok ||
          payload?.status !== "live" ||
          payload?.campaign?.id !== selectedLiveCampaignId ||
          !Array.isArray(payload.indicators) ||
          !Array.isArray(payload.evidence)
        ) {
          throw new Error("Invalid live campaign detail response");
        }
        if (active) setLiveDetailState({ status: "live", data: payload });
      } catch {
        if (active) setLiveDetailState({ status: "unavailable" });
      } finally {
        window.clearTimeout(timeout);
      }
    }

    syncCampaignDetail();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [selectedLiveCampaignId]);

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

  function viewCampaign(id) {
    setSelectedCampaignId(id);
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

  function viewLiveCampaign(id) {
    setSelectedLiveCampaignId(id);
    window.requestAnimationFrame(() => liveCampaignDetailRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    }));
  }

  function runLiveAction() {
    if (!livePriorityAction) return;
    viewLiveCampaign(livePriorityAction.campaignId);
    setExported({
      type: "action",
      label: livePriorityAction.priority,
      title: "LIVE EVIDENCE REVIEW OPENED",
      message: `${livePriorityAction.title} · ${livePriorityAction.owner}`,
      deliveryNote: "DEMO ACTION · NO WORKFLOW TABLE UPDATED",
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
          <span>ANALYST MODE · DEMO WORKFLOWS LABELED</span>
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
                  ? `Snapshot scope: ${analytics.snapshot.documentsAnalyzed.toLocaleString("en-US")} analyzed sources · ${analytics.snapshot.evidenceLinkCount.toLocaleString("en-US")} document-indicator links · ${(analytics.snapshot.averageConfidence * 100).toFixed(1)}% average confidence · as of ${formatSnapshotTime(analytics.snapshot.refreshedAt)}. Filters now scope the live campaign registry and linked evidence.`
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
            <div className="what-next-kicker"><span>WHAT TO DO NEXT</span><strong>LIVE DATA</strong></div>
            {livePriorityAction ? (
              <>
                <h2>{livePriorityAction.title}</h2>
                <p>{livePriorityAction.reason}</p>
                <button onClick={runLiveAction}>{livePriorityAction.cta}<ArrowRight size={15} weight="bold" /></button>
              </>
            ) : (
              <div className="what-next-clear"><CheckCircle size={25} weight="fill" /><strong>{analytics.status === "loading" ? "Syncing live campaign actions…" : "No live campaign matches this scope."}</strong></div>
            )}
          </aside>
        </div>

        <BankCharts analytics={analytics} />

        <LiveCampaignRegistry
          analytics={analytics}
          campaigns={filteredLiveCampaigns}
          selectedId={selectedLiveCampaignId}
          onSelect={viewLiveCampaign}
        />

        {selectedLiveCampaign && livePriorityAction && (
          <LiveCampaignDetail
            action={livePriorityAction}
            campaign={selectedLiveCampaign}
            detailRef={liveCampaignDetailRef}
            detailState={liveDetailState}
            onAction={runLiveAction}
          />
        )}

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
                <span>PROTOTYPE CAMPAIGN · DEMO DATA / {selectedCampaign.id}</span>
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
              <span>DEMO INDICATORS</span>
              {selectedCampaign.indicators.map((item) => <strong key={item}>{item}</strong>)}
            </div>
          </section>
        )}

        <ScamConstellation
          campaigns={analytics.status === "live" ? filteredLiveCampaigns : []}
          detail={liveDetailState.status === "live" ? liveDetailState.data : null}
        />
      </section>

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
