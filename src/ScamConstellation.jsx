"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  Cube,
  Graph,
  MagnifyingGlass,
  Minus,
  Plus,
} from "@phosphor-icons/react";
import { SocialListeningGraph, SOCIAL_NODE_STYLES } from "./SocialListeningGraph.jsx";
import {
  buildSocialListeningGraph,
  filterSocialListeningGraph,
} from "./socialGraphModel.js";

const NODE_FILTERS = ["ALL", "EVIDENCE", "ACCOUNT", "DOMAIN", "PHONE", "TACTIC", "BANK", "MENTION", "INDICATOR"];
const LEGEND_TYPES = ["campaign", "evidence", "account", "domain", "phone", "tactic", "bank", "indicator"];

function LegendShape({ type }) {
  const style = SOCIAL_NODE_STYLES[type];
  return <i className={`social-legend-shape ${style.shape}`} style={{ "--legend-color": style.color }} />;
}

export function ScamConstellation({ campaigns, detail }) {
  const [mode, setMode] = useState("2d");
  const [nodeType, setNodeType] = useState("ALL");
  const graphControlsRef = useRef(null);
  const graph = useMemo(
    () => buildSocialListeningGraph({ campaigns, detail }),
    [campaigns, detail],
  );
  const visibleGraph = useMemo(
    () => filterSocialListeningGraph(graph, nodeType),
    [graph, nodeType],
  );
  const preferredSelection = detail?.campaign?.id ? `campaign-${detail.campaign.id}` : null;
  const [selectedId, setSelectedId] = useState(preferredSelection);
  const selected = visibleGraph.nodes.find((node) => node.id === selectedId) || visibleGraph.nodes[0] || null;

  useEffect(() => {
    if (preferredSelection && visibleGraph.nodes.some((node) => node.id === preferredSelection)) {
      setSelectedId(preferredSelection);
      return;
    }
    if (!visibleGraph.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(visibleGraph.nodes[0]?.id || null);
    }
  }, [preferredSelection, selectedId, visibleGraph.nodes]);

  return (
    <section className="constellation-section social-engine-section">
      <div className="constellation-heading">
        <div>
          <span>LIVE SCAM RELATIONSHIP MAP</span>
          <h2>Follow the same signals across campaigns.</h2>
          <p>The same social-listening canvas engine maps every campaign in the active filter scope and its stored taxonomy. Selecting a campaign expands its capped linked evidence and server-masked indicators.</p>
        </div>
        <div className="constellation-controls">
          <label>
            <span>SIGNAL TYPE</span>
            <select value={nodeType} onChange={(event) => setNodeType(event.target.value)}>
              {NODE_FILTERS.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
          <div className="social-graph-controls" aria-label="Graph controls">
            <button aria-label="Zoom out" onClick={() => graphControlsRef.current?.zoomOut()}><Minus size={15} weight="bold" /></button>
            <button aria-label="Reset graph" onClick={() => graphControlsRef.current?.reset()}><ArrowCounterClockwise size={15} weight="bold" /></button>
            <button aria-label="Zoom in" onClick={() => graphControlsRef.current?.zoomIn()}><Plus size={15} weight="bold" /></button>
          </div>
          <div className="graph-mode-toggle" aria-label="Graph dimension">
            <button className={mode === "2d" ? "active" : ""} onClick={() => setMode("2d")}><Graph size={16} />2D</button>
            <button className={mode === "3d" ? "active" : ""} onClick={() => setMode("3d")}><Cube size={16} />3D</button>
          </div>
        </div>
      </div>
      <div className={`constellation-stage social-engine-stage mode-${mode}`}>
        {visibleGraph.nodes.length ? (
          <SocialListeningGraph
            links={visibleGraph.links}
            mode={mode}
            nodes={visibleGraph.nodes}
            onSelect={setSelectedId}
            ref={graphControlsRef}
            selectedId={selected?.id}
          />
        ) : (
          <div className="social-graph-empty">
            <strong>Live campaign relationships are unavailable.</strong>
            <p>No prototype graph has been substituted for this scope.</p>
          </div>
        )}
        <div className="constellation-legend social-engine-legend">
          {LEGEND_TYPES.map((type) => (
            <span key={type}><LegendShape type={type} />{type.toUpperCase()}</span>
          ))}
          <span><i className="suggested" />SUGGESTED LINK</span>
        </div>
        <div className="constellation-meta"><MagnifyingGlass size={15} /><span>{visibleGraph.nodes.length} nodes · {visibleGraph.links.length} stored relationships · {graph.campaignCount} live campaigns shown</span></div>
        {selected && (
          <aside className="constellation-selection">
            <span>{selected.type.toUpperCase()} · {selected.status?.toUpperCase() || "OBSERVED"}</span>
            <strong>{selected.label}</strong>
            <p>{selected.detail}</p>
          </aside>
        )}
      </div>
    </section>
  );
}
