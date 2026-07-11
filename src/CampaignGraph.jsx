"use client";

import { useEffect, useRef } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";

const COLORS = {
  campaign: "#DB676D",
  profile: "#F5F3F0",
  report: "#E9A1A5",
  mention: "#B9B5B6",
  phone: "#C27B80",
  domain: "#D98C91",
  apk: "#D98C91",
  account: "#F1C0C3",
  phrase: "#A9A4A6",
  tracking: "#D98C91",
};

const GROUP_TARGETS = {
  campaign: [0.5, 0.48],
  reports: [0.18, 0.68],
  social: [0.18, 0.27],
  indicators: [0.77, 0.2],
  infrastructure: [0.82, 0.48],
  money: [0.76, 0.78],
  signals: [0.45, 0.16],
};

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export function CampaignGraph({ nodes, links, selectedId, onSelect, relationshipStatuses, expanded = false }) {
  const canvasRef = useRef(null);
  const graphRef = useRef({ nodes: [], transform: { x: 0, y: 0, k: 1 } });
  const selectedRef = useRef(selectedId);
  const statusesRef = useRef(relationshipStatuses);
  const drawRef = useRef(() => {});
  const simulationRef = useRef(null);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    selectedRef.current = selectedId;
    drawRef.current();
  }, [selectedId]);

  useEffect(() => {
    statusesRef.current = relationshipStatuses;
    const simulation = simulationRef.current;
    const linkForce = simulation?.force("link");
    if (linkForce) {
      linkForce
        .distance((link) => {
          const status = statusesRef.current?.[link.id] || link.status;
          return expanded ? (status === "confirmed" ? 102 : 126) : (status === "confirmed" ? 72 : 94);
        })
        .strength((link) => {
          const status = statusesRef.current?.[link.id] || link.status;
          return status === "confirmed" ? 0.72 : status === "rejected" ? 0.05 : 0.34;
        });
      if (!reducedMotionRef.current) simulation.alpha(0.16).restart();
    }
    drawRef.current();
  }, [expanded, relationshipStatuses]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    const fontFamily = getComputedStyle(document.documentElement).fontFamily;
    const nodeCopies = nodes.map((node) => ({ ...node }));
    const linkCopies = links.map((link) => ({ ...link }));
    graphRef.current.nodes = nodeCopies;

    let width = 0;
    let height = 0;
    let pointerStart = null;
    let moved = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedMotionRef.current = reducedMotion;

    function resize() {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(320, bounds.width);
      height = Math.max(320, bounds.height);
      const transform = graphRef.current.transform;
      if (width < 600 && transform.x === 0 && transform.y === 0 && transform.k === 1) {
        transform.x = width * 0.12;
        transform.y = height * 0.1;
        transform.k = 0.76;
      }
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      simulation
        .force("x", forceX((node) => width * (GROUP_TARGETS[node.group]?.[0] ?? 0.5)).strength(0.11))
        .force("y", forceY((node) => height * (GROUP_TARGETS[node.group]?.[1] ?? 0.5)).strength(0.11))
        .alpha(0.7)
        .restart();
      draw();
    }

    function worldPoint(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const transform = graphRef.current.transform;
      return {
        x: (clientX - rect.left - transform.x) / transform.k,
        y: (clientY - rect.top - transform.y) / transform.k,
      };
    }

    function findNode(clientX, clientY) {
      const point = worldPoint(clientX, clientY);
      return [...nodeCopies]
        .reverse()
        .find((node) => Math.hypot(point.x - node.x, point.y - node.y) <= node.size + 8);
    }

    function drawCluster(group, label) {
      const members = nodeCopies.filter((node) => node.group === group && Number.isFinite(node.x));
      if (!members.length) return;
      const xs = members.map((node) => node.x);
      const ys = members.map((node) => node.y);
      const minX = Math.min(...xs) - 38;
      const maxX = Math.max(...xs) + 38;
      const minY = Math.min(...ys) - 30;
      const maxY = Math.max(...ys) + 30;
      roundedRect(context, minX, minY, maxX - minX, maxY - minY, 28);
      context.fillStyle = "rgba(219, 103, 109, 0.025)";
      context.strokeStyle = "rgba(219, 103, 109, 0.12)";
      context.lineWidth = 1;
      context.fill();
      context.stroke();
      context.fillStyle = "rgba(245, 243, 240, 0.35)";
      context.font = `700 10px ${fontFamily}`;
      context.fillText(label, minX + 15, minY + 18);
    }

    function draw() {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const transform = graphRef.current.transform;
      context.translate(transform.x, transform.y);
      context.scale(transform.k, transform.k);

      drawCluster("social", "SOCIAL LISTENING");
      drawCluster("reports", "CUSTOMER REPORTS");
      drawCluster("infrastructure", "INFRASTRUCTURE");
      drawCluster("money", "MONEY FLOW");

      linkCopies.forEach((link) => {
        const currentStatus = statusesRef.current?.[link.id] || link.status;
        const suggested = currentStatus === "suggested";
        const rejected = currentStatus === "rejected";
        context.beginPath();
        context.moveTo(link.source.x, link.source.y);
        context.lineTo(link.target.x, link.target.y);
        context.strokeStyle = rejected
          ? "rgba(255,255,255,0.08)"
          : suggested
            ? "rgba(219,103,109,0.48)"
            : "rgba(255,255,255,0.16)";
        context.lineWidth = link.id === "l5" ? 2 : 1;
        context.setLineDash(suggested ? [5, 6] : rejected ? [2, 8] : []);
        context.stroke();
      });
      context.setLineDash([]);

      nodeCopies.forEach((node) => {
        const selected = node.id === selectedRef.current;
        if (selected) {
          context.beginPath();
          context.arc(node.x, node.y, node.size + 9, 0, Math.PI * 2);
          context.fillStyle = "rgba(219,103,109,0.12)";
          context.fill();
        }
        context.beginPath();
        context.arc(node.x, node.y, node.size, 0, Math.PI * 2);
        context.fillStyle = node.id === "campaign" ? "#DB676D" : "#121011";
        context.strokeStyle = COLORS[node.type] || "#A3A0A1";
        context.lineWidth = selected ? 2 : 1.2;
        context.fill();
        context.stroke();
        context.fillStyle = node.id === "campaign" ? "#16090B" : COLORS[node.type] || "#F5F3F0";
        context.font = `800 ${node.size > 16 ? 11 : 9}px ${fontFamily}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(node.short, node.x, node.y + 0.5);

      if (expanded ? (selected || node.type === "campaign" || node.size >= 13) : (transform.k > 0.75 || selected || node.size >= 18)) {
          context.fillStyle = selected ? "#F5F3F0" : "rgba(245,243,240,0.62)";
          context.font = `600 ${selected ? 12 : 11}px ${fontFamily}`;
          context.textAlign = "center";
          context.textBaseline = "top";
          context.fillText(node.label, node.x, node.y + node.size + 8);
        }
      });
      context.restore();
    }

    drawRef.current = draw;

    const simulation = forceSimulation(nodeCopies)
      .force(
        "link",
        forceLink(linkCopies)
          .id((node) => node.id)
          .distance((link) => {
            const status = statusesRef.current?.[link.id] || link.status;
            return expanded ? (status === "confirmed" ? 102 : 126) : (status === "confirmed" ? 72 : 94);
          })
          .strength((link) => {
            const status = statusesRef.current?.[link.id] || link.status;
            return status === "confirmed" ? 0.72 : status === "rejected" ? 0.05 : 0.34;
          }),
      )
      .force("charge", forceManyBody().strength(expanded ? -310 : -170))
      .force("collision", forceCollide().radius((node) => node.size + (expanded ? 29 : 22)).iterations(2))
      .alphaDecay(reducedMotion ? 0.2 : 0.045)
      .on("tick", draw);
    simulationRef.current = simulation;

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    function pointerDown(event) {
      canvas.setPointerCapture(event.pointerId);
      pointerStart = {
        clientX: event.clientX,
        clientY: event.clientY,
        transformX: graphRef.current.transform.x,
        transformY: graphRef.current.transform.y,
      };
      moved = false;
    }

    function pointerMove(event) {
      if (!pointerStart) return;
      const dx = event.clientX - pointerStart.clientX;
      const dy = event.clientY - pointerStart.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (moved) {
        graphRef.current.transform.x = pointerStart.transformX + dx;
        graphRef.current.transform.y = pointerStart.transformY + dy;
        draw();
      }
    }

    function pointerUp(event) {
      if (!moved) {
        const node = findNode(event.clientX, event.clientY);
        if (node) onSelect(node.id);
      }
      pointerStart = null;
    }

    function wheel(event) {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const transform = graphRef.current.transform;
      const nextScale = Math.min(2.1, Math.max(0.58, transform.k * Math.exp(-event.deltaY * 0.001)));
      const worldX = (event.clientX - rect.left - transform.x) / transform.k;
      const worldY = (event.clientY - rect.top - transform.y) / transform.k;
      transform.x = event.clientX - rect.left - worldX * nextScale;
      transform.y = event.clientY - rect.top - worldY * nextScale;
      transform.k = nextScale;
      draw();
    }

    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("wheel", wheel, { passive: false });

    return () => {
      observer.disconnect();
      simulation.stop();
      simulationRef.current = null;
      drawRef.current = () => {};
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [expanded, links, nodes, onSelect]);

  return <canvas ref={canvasRef} className="campaign-graph-canvas" aria-label="Campaign relationship graph" />;
}
