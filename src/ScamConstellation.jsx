"use client";

import { useMemo, useState } from "react";
import { Cube, Graph, MagnifyingGlass } from "@phosphor-icons/react";
import { CampaignGraph } from "./CampaignGraph.jsx";
import { ScamNetwork3D } from "./ScamNetwork3D.jsx";

function buildConstellation(campaigns) {
  const nodes = [];
  const links = [];
  campaigns.forEach((campaign, index) => {
    const campaignNode = `campaign-${campaign.id}`;
    const reportNode = `report-${campaign.id}`;
    const socialNode = `social-${campaign.id}`;
    const accountNode = `account-${campaign.id}`;
    const domainNode = `domain-${campaign.id}`;
    const phoneNode = `phone-${campaign.id}`;
    const phraseNode = `phrase-${campaign.id}`;
    nodes.push(
      { id: campaignNode, label: campaign.plainName, short: `C${index + 1}`, type: "campaign", group: "campaign", size: 17, detail: `${campaign.status} · ${campaign.confidence}% confidence` },
      { id: reportNode, label: `${campaign.reports} customer reports`, short: "R", type: "report", group: "reports", size: 11, detail: campaign.evidence[0] },
      { id: socialNode, label: `${campaign.plainName} social cluster`, short: "SOC", type: "mention", group: "social", size: 10, detail: "Cross-platform social mentions" },
      { id: accountNode, label: `${campaign.banks[0]} beneficiary cluster`, short: "ACC", type: "account", group: "money", size: 11, detail: campaign.nextAction },
      { id: domainNode, label: `${campaign.id.toLowerCase()}[.]support`, short: "URL", type: "domain", group: "infrastructure", size: 10, detail: "Infrastructure indicator" },
      { id: phoneNode, label: `Rotating phone set ${index + 1}`, short: "TEL", type: "phone", group: "indicators", size: 9, detail: campaign.indicators[0] },
      { id: phraseNode, label: `Shared script family ${index + 1}`, short: "TXT", type: "phrase", group: "signals", size: 9, detail: campaign.summary },
    );
    [reportNode, socialNode, accountNode, domainNode, phoneNode, phraseNode].forEach((target, linkIndex) => {
      links.push({
        id: `${campaign.id}-${linkIndex}`,
        source: target,
        target: campaignNode,
        type: linkIndex > 3 ? "SUGGESTED_MATCH" : "CONFIRMED_SIGNAL",
        status: linkIndex > 3 ? "suggested" : "confirmed",
        confidence: Math.max(78, campaign.confidence - linkIndex),
      });
    });
  });
  for (let index = 0; index < campaigns.length - 1; index += 1) {
    links.push({
      id: `shared-${index}`,
      source: `domain-${campaigns[index].id}`,
      target: `domain-${campaigns[index + 1].id}`,
      type: "SHARED_INFRASTRUCTURE",
      status: index % 2 ? "suggested" : "confirmed",
      confidence: 82 + index,
    });
  }
  return { nodes, links };
}

export function ScamConstellation({ campaigns, timeRange }) {
  const [mode, setMode] = useState("2d");
  const [nodeType, setNodeType] = useState("ALL");
  const graph = useMemo(() => buildConstellation(campaigns), [campaigns]);
  const visibleGraph = useMemo(() => {
    if (nodeType === "ALL") return graph;
    const type = nodeType.toLowerCase();
    const visibleNodes = graph.nodes.filter((node) => node.type === "campaign" || node.type === type);
    const ids = new Set(visibleNodes.map((node) => node.id));
    return { nodes: visibleNodes, links: graph.links.filter((link) => ids.has(link.source) && ids.has(link.target)) };
  }, [graph, nodeType]);
  const [selectedId, setSelectedId] = useState("campaign-CP-2407-19A");
  const selected = visibleGraph.nodes.find((node) => node.id === selectedId) || visibleGraph.nodes[0];
  const statuses = Object.fromEntries(visibleGraph.links.map((link) => [link.id, link.status]));

  return (
    <section className="constellation-section">
      <div className="constellation-heading">
        <div>
          <span>SCAM NETWORK CONSTELLATION</span>
          <h2>See how campaigns reuse the same infrastructure.</h2>
          <p>Explore connected reports, accounts, domains, phones, and shared scripts. Use 2D for investigation and 3D for spatial exploration.</p>
        </div>
        <div className="constellation-controls">
          <label>
            <span>SIGNAL TYPE</span>
            <select value={nodeType} onChange={(event) => setNodeType(event.target.value)}>
              <option>ALL</option><option>REPORT</option><option>MENTION</option><option>ACCOUNT</option><option>DOMAIN</option><option>PHONE</option><option>PHRASE</option>
            </select>
          </label>
          <div className="graph-mode-toggle" aria-label="Graph dimension">
            <button className={mode === "2d" ? "active" : ""} onClick={() => setMode("2d")}><Graph size={16} />2D</button>
            <button className={mode === "3d" ? "active" : ""} onClick={() => setMode("3d")}><Cube size={16} />3D</button>
          </div>
        </div>
      </div>
      <div className={`constellation-stage mode-${mode}`}>
        {mode === "2d" ? (
          <CampaignGraph
            nodes={visibleGraph.nodes}
            links={visibleGraph.links}
            selectedId={selected?.id}
            onSelect={setSelectedId}
            relationshipStatuses={statuses}
            expanded
          />
        ) : (
          <ScamNetwork3D
            nodes={visibleGraph.nodes}
            links={visibleGraph.links}
            selectedId={selected?.id}
            onSelect={setSelectedId}
          />
        )}
        <div className="constellation-legend">
          <span><i className="campaign" />CAMPAIGN</span>
          <span><i className="report" />REPORT</span>
          <span><i className="account" />ACCOUNT</span>
          <span><i className="domain" />DOMAIN</span>
          <span><i className="suggested" />SUGGESTED LINK</span>
        </div>
        <div className="constellation-meta"><MagnifyingGlass size={15} /><span>{visibleGraph.nodes.length} nodes · {visibleGraph.links.length} relationships · last {timeRange} days</span></div>
        {selected && (
          <aside className="constellation-selection">
            <span>{selected.type.toUpperCase()}</span>
            <strong>{selected.label}</strong>
            <p>{selected.detail}</p>
          </aside>
        )}
      </div>
    </section>
  );
}
