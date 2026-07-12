"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";

export const SOCIAL_NODE_STYLES = {
  registry: { color: "#DB676D", shape: "hexagon" },
  campaign: { color: "#DB676D", shape: "circle" },
  evidence: { color: "#F0B4B7", shape: "circle" },
  account: { color: "#F4D0D2", shape: "square" },
  phone: { color: "#D9898E", shape: "diamond" },
  domain: { color: "#EF9BA0", shape: "triangle" },
  tactic: { color: "#AA8C8F", shape: "hexagon" },
  bank: { color: "#F5F3F0", shape: "square" },
  mention: { color: "#B2ADAF", shape: "diamond" },
  phrase: { color: "#8E898B", shape: "hexagon" },
  indicator: { color: "#9C9395", shape: "hexagon" },
};

const HIGHLIGHT_COLOR = "#DB676D";

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableFraction(value) {
  return stableHash(value) / 0xffffffff;
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function lighten(hex, amount) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  const channel = (shift) => Math.min(255, ((number >> shift) & 255) + amount);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

function shapePath(context, shape, x, y, radius) {
  context.beginPath();
  if (shape === "circle") {
    context.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  const points = shape === "triangle" ? 3 : shape === "hexagon" ? 6 : 4;
  const shapeRadius = shape === "square" ? radius * 1.05 : radius * 1.2;
  for (let index = 0; index < points; index += 1) {
    let angle = (Math.PI * 2 * index) / points - Math.PI / 2;
    if (shape === "diamond") angle += Math.PI / 4;
    const px = x + Math.cos(angle) * shapeRadius;
    const py = y + Math.sin(angle) * shapeRadius;
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
}

function drawNodeShape(context, style, x, y, radius, highlighted, dimmed, light) {
  context.save();
  context.globalAlpha = dimmed ? 0.18 : 1;
  if (highlighted) {
    context.beginPath();
    context.arc(x, y, radius + 9, 0, Math.PI * 2);
    context.fillStyle = hexToRgba(HIGHLIGHT_COLOR, 0.17);
    context.fill();
  }
  shapePath(context, style.shape, x, y, radius);
  if (style.shape === "circle") {
    const gradient = context.createRadialGradient(
      x - radius * 0.32,
      y - radius * 0.32,
      0,
      x,
      y,
      radius,
    );
    gradient.addColorStop(0, lighten(style.color, 35));
    gradient.addColorStop(1, style.color);
    context.fillStyle = gradient;
  } else {
    context.fillStyle = highlighted ? lighten(style.color, 22) : style.color;
  }
  context.fill();
  context.strokeStyle = highlighted
    ? light ? "rgba(28,23,24,.55)" : "rgba(255,255,255,.62)"
    : light ? "rgba(28,23,24,.24)" : "rgba(255,255,255,.18)";
  context.lineWidth = highlighted ? 2 : 1;
  context.stroke();
  context.restore();
}

function resolveNode(linkEnd, byId) {
  return typeof linkEnd === "object" ? linkEnd : byId.get(String(linkEnd));
}

function connectedIds(nodeId, links, byId) {
  const ids = new Set(nodeId ? [nodeId] : []);
  if (!nodeId) return ids;
  for (const link of links) {
    const source = resolveNode(link.source, byId);
    const target = resolveNode(link.target, byId);
    if (source?.id === nodeId && target) ids.add(target.id);
    if (target?.id === nodeId && source) ids.add(source.id);
  }
  return ids;
}

function truncateLabel(value, maximum = 34) {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

export const SocialListeningGraph = forwardRef(function SocialListeningGraph(
  { nodes, links, mode, selectedId, onSelect },
  ref,
) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const simulationRef = useRef(null);
  const graphRef = useRef({ nodes: [], links: [], byId: new Map() });
  const projectedRef = useRef(new Map());
  const drawRef = useRef(() => {});
  const frameRef = useRef(null);
  const modeRef = useRef(mode);
  const selectedRef = useRef(selectedId);
  const hoveredRef = useRef(null);
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1, yaw: -0.28, pitch: -0.12 });
  const dimensionsRef = useRef({ width: 900, height: 620, ratio: 1 });
  const pointerRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);

  function requestDraw() {
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      drawRef.current();
    });
  }

  useImperativeHandle(ref, () => ({
    zoomIn() {
      viewportRef.current.zoom = Math.min(4, viewportRef.current.zoom * 1.28);
      requestDraw();
    },
    zoomOut() {
      viewportRef.current.zoom = Math.max(0.28, viewportRef.current.zoom / 1.28);
      requestDraw();
    },
    reset() {
      viewportRef.current = { x: 0, y: 0, zoom: 1, yaw: -0.28, pitch: -0.12 };
      for (const node of graphRef.current.nodes) {
        node.fx = null;
        node.fy = null;
      }
      simulationRef.current?.alpha(0.45).restart();
      requestDraw();
    },
  }));

  useEffect(() => {
    modeRef.current = mode;
    setTooltip(null);
    hoveredRef.current = null;
    requestDraw();
  }, [mode]);

  useEffect(() => {
    selectedRef.current = selectedId;
    requestDraw();
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;
    const context = canvas.getContext("2d");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nodeCopies = nodes.map((node, index) => {
      const angle = stableFraction(`${node.id}:angle`) * Math.PI * 2;
      const radius = 80 + stableFraction(`${node.id}:radius`) * 210;
      return {
        ...node,
        radius: node.size || 11,
        x: 450 + Math.cos(angle) * radius,
        y: 310 + Math.sin(angle) * radius,
        z: (stableFraction(`${node.id}:depth`) - 0.5) * 360,
        index,
      };
    });
    const linkCopies = links.map((link) => ({ ...link }));
    const byId = new Map(nodeCopies.map((node) => [node.id, node]));
    graphRef.current = { nodes: nodeCopies, links: linkCopies, byId };

    function project(node) {
      const { width, height } = dimensionsRef.current;
      const viewport = viewportRef.current;
      if (modeRef.current === "2d") {
        return {
          x: viewport.x + node.x * viewport.zoom,
          y: viewport.y + node.y * viewport.zoom,
          scale: viewport.zoom,
          depth: 0,
        };
      }
      const cx = width / 2;
      const cy = height / 2;
      const x = node.x - cx;
      const y = node.y - cy;
      const z = node.z || 0;
      const cosY = Math.cos(viewport.yaw);
      const sinY = Math.sin(viewport.yaw);
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const cosX = Math.cos(viewport.pitch);
      const sinX = Math.sin(viewport.pitch);
      const y2 = y * cosX - z1 * sinX;
      const z2 = y * sinX + z1 * cosX;
      const perspective = Math.max(0.45, Math.min(1.7, 720 / (720 - z2)));
      return {
        x: viewport.x + (cx + x1 * perspective) * viewport.zoom,
        y: viewport.y + (cy + y2 * perspective) * viewport.zoom,
        scale: viewport.zoom * perspective,
        depth: z2,
      };
    }

    function draw() {
      const { width, height, ratio } = dimensionsRef.current;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const light = Boolean(canvas.closest(".theme-light"));
      const labelColor = light ? "rgba(28,23,24,.72)" : "rgba(245,243,240,.72)";
      const strongLabelColor = light ? "#1c1718" : "#f5f3f0";
      const edgeColor = light ? "rgba(28,23,24,.13)" : "rgba(255,255,255,.15)";
      const hovered = hoveredRef.current;
      const activeId = hovered;
      const connected = connectedIds(activeId, linkCopies, byId);
      const projected = new Map(nodeCopies.map((node) => [node.id, project(node)]));
      projectedRef.current = projected;

      const campaignNodes = nodeCopies.filter((node) => node.type === "campaign");
      for (const hub of campaignNodes) {
        const hubPoint = projected.get(hub.id);
        const members = linkCopies
          .map((link) => {
            const source = resolveNode(link.source, byId);
            const target = resolveNode(link.target, byId);
            return source?.id === hub.id ? target : target?.id === hub.id ? source : null;
          })
          .filter(Boolean);
        if (!hubPoint || members.length < 2) continue;
        context.save();
        context.lineCap = "round";
        context.strokeStyle = hexToRgba(HIGHLIGHT_COLOR, hub.id === selectedRef.current ? 0.09 : 0.035);
        context.lineWidth = hub.id === selectedRef.current ? 34 : 24;
        for (const member of members) {
          const point = projected.get(member.id);
          if (!point) continue;
          context.beginPath();
          context.moveTo(hubPoint.x, hubPoint.y);
          context.lineTo(point.x, point.y);
          context.stroke();
        }
        context.restore();
      }

      const orderedLinks = [...linkCopies].sort((left, right) => {
        const leftSource = resolveNode(left.source, byId);
        const leftTarget = resolveNode(left.target, byId);
        const rightSource = resolveNode(right.source, byId);
        const rightTarget = resolveNode(right.target, byId);
        const leftDepth = ((projected.get(leftSource?.id)?.depth || 0) + (projected.get(leftTarget?.id)?.depth || 0)) / 2;
        const rightDepth = ((projected.get(rightSource?.id)?.depth || 0) + (projected.get(rightTarget?.id)?.depth || 0)) / 2;
        return leftDepth - rightDepth;
      });
      for (const link of orderedLinks) {
        const source = resolveNode(link.source, byId);
        const target = resolveNode(link.target, byId);
        const sourcePoint = projected.get(source?.id);
        const targetPoint = projected.get(target?.id);
        if (!sourcePoint || !targetPoint) continue;
        const highlighted = activeId && connected.has(source.id) && connected.has(target.id);
        const dimmed = activeId && !highlighted;
        context.save();
        context.globalAlpha = dimmed ? 0.11 : 1;
        context.beginPath();
        context.moveTo(sourcePoint.x, sourcePoint.y);
        context.lineTo(targetPoint.x, targetPoint.y);
        context.strokeStyle = highlighted ? HIGHLIGHT_COLOR : edgeColor;
        context.lineWidth = highlighted ? 2.2 : Math.max(0.8, (link.weight || 0.6) * 1.5);
        context.setLineDash(link.status === "suggested" ? [5, 6] : []);
        context.stroke();
        context.restore();
      }
      context.setLineDash([]);

      const orderedNodes = [...nodeCopies].sort(
        (left, right) => (projected.get(left.id)?.depth || 0) - (projected.get(right.id)?.depth || 0),
      );
      for (const node of orderedNodes) {
        const point = projected.get(node.id);
        if (!point) continue;
        const style = SOCIAL_NODE_STYLES[node.type] || SOCIAL_NODE_STYLES.indicator;
        const highlighted = node.id === hovered || node.id === selectedRef.current;
        const dimmed = activeId && !connected.has(node.id);
        const radius = Math.max(5, node.radius * point.scale);
        drawNodeShape(context, style, point.x, point.y, radius, highlighted, dimmed, light);
        context.save();
        context.globalAlpha = dimmed ? 0.17 : 0.88;
        context.fillStyle = node.type === "campaign" ? "#1a0d0f" : "rgba(20,16,17,.82)";
        context.font = `800 ${Math.max(8, Math.min(12, radius * 0.58))}px ${getComputedStyle(canvas).fontFamily}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(node.short, point.x, point.y + 0.5);
        const showLabel = highlighted || ["registry", "campaign"].includes(node.type) || viewportRef.current.zoom >= 1.06;
        if (showLabel) {
          context.fillStyle = highlighted ? strongLabelColor : labelColor;
          context.font = `${highlighted ? 700 : 600} ${highlighted ? 12 : 11}px ${getComputedStyle(canvas).fontFamily}`;
          context.textBaseline = "top";
          context.fillText(truncateLabel(node.label), point.x, point.y + radius + 8);
        }
        context.restore();
      }
      context.restore();
    }

    drawRef.current = draw;

    const simulation = forceSimulation(nodeCopies)
      .force(
        "link",
        forceLink(linkCopies)
          .id((node) => node.id)
          .distance((link) => link.status === "confirmed" ? 94 : 124)
          .strength((link) => link.status === "confirmed" ? 0.58 : 0.28),
      )
      .force("charge", forceManyBody().strength((node) => node.type === "campaign" ? -620 : -360))
      .force("center", forceCenter(450, 310))
      .force("x", forceX(450).strength(0.035))
      .force("y", forceY(310).strength(0.035))
      .force("collision", forceCollide().radius((node) => node.radius + 22).iterations(2))
      .velocityDecay(0.42)
      .alphaDecay(reducedMotion ? 0.18 : 0.045)
      .on("tick", requestDraw);
    simulationRef.current = simulation;
    simulation.stop();
    const warmupTicks = Math.min(220, Math.max(100, nodeCopies.length * 4));
    for (let index = 0; index < warmupTicks; index += 1) simulation.tick();
    if (!reducedMotion) simulation.alpha(0.24).restart();

    function resize() {
      const bounds = container.getBoundingClientRect();
      const width = Math.max(320, bounds.width);
      const height = Math.max(360, bounds.height);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      dimensionsRef.current = { width, height, ratio };
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      simulation
        .force("center", forceCenter(width / 2, height / 2))
        .force("x", forceX(width / 2).strength(0.035))
        .force("y", forceY(height / 2).strength(0.035))
        .alpha(0.35)
        .restart();
      requestDraw();
    }

    function nodeAt(clientX, clientY) {
      const bounds = canvas.getBoundingClientRect();
      const x = clientX - bounds.left;
      const y = clientY - bounds.top;
      return [...nodeCopies].reverse().find((node) => {
        const point = projectedRef.current.get(node.id);
        if (!point) return false;
        return Math.hypot(x - point.x, y - point.y) <= Math.max(10, node.radius * point.scale + 6);
      });
    }

    function updateHover(event) {
      const bounds = canvas.getBoundingClientRect();
      const node = nodeAt(event.clientX, event.clientY);
      const nextId = node?.id || null;
      if (hoveredRef.current !== nextId) {
        hoveredRef.current = nextId;
        requestDraw();
      }
      canvas.style.cursor = node ? "pointer" : "grab";
      setTooltip(node ? {
        x: Math.min(bounds.width - 230, Math.max(12, event.clientX - bounds.left + 14)),
        y: Math.min(bounds.height - 112, Math.max(12, event.clientY - bounds.top + 14)),
        node,
      } : null);
    }

    function pointerDown(event) {
      canvas.setPointerCapture(event.pointerId);
      const node = nodeAt(event.clientX, event.clientY);
      pointerRef.current = {
        node,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
      };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
        simulation.alphaTarget(0.12).restart();
      }
      setTooltip(null);
    }

    function pointerMove(event) {
      const pointer = pointerRef.current;
      if (!pointer) {
        updateHover(event);
        return;
      }
      const dx = event.clientX - pointer.lastX;
      const dy = event.clientY - pointer.lastY;
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >= 4) {
        pointer.moved = true;
      }
      if (pointer.node && pointer.moved) {
        pointer.node.fx += dx / viewportRef.current.zoom;
        pointer.node.fy += dy / viewportRef.current.zoom;
      } else if (pointer.moved && modeRef.current === "3d") {
        viewportRef.current.yaw += dx * 0.006;
        viewportRef.current.pitch = Math.max(-1.1, Math.min(1.1, viewportRef.current.pitch + dy * 0.006));
      } else if (pointer.moved) {
        viewportRef.current.x += dx;
        viewportRef.current.y += dy;
      }
      pointer.lastX = event.clientX;
      pointer.lastY = event.clientY;
      requestDraw();
    }

    function pointerUp(event) {
      const pointer = pointerRef.current;
      if (!pointer) return;
      if (pointer.node && !pointer.moved) {
        pointer.node.fx = null;
        pointer.node.fy = null;
        onSelect?.(pointer.node.id);
      }
      simulation.alphaTarget(0);
      pointerRef.current = null;
      updateHover(event);
    }

    function pointerLeave() {
      if (!pointerRef.current) {
        hoveredRef.current = null;
        setTooltip(null);
        requestDraw();
      }
    }

    function wheel(event) {
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const cx = event.clientX - bounds.left;
      const cy = event.clientY - bounds.top;
      const viewport = viewportRef.current;
      const nextZoom = Math.min(4, Math.max(0.28, viewport.zoom * Math.exp(-event.deltaY * 0.001)));
      viewport.x = cx - (cx - viewport.x) * (nextZoom / viewport.zoom);
      viewport.y = cy - (cy - viewport.y) * (nextZoom / viewport.zoom);
      viewport.zoom = nextZoom;
      requestDraw();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const shell = canvas.closest(".bank-shell");
    const themeObserver = shell ? new MutationObserver(requestDraw) : null;
    themeObserver?.observe(shell, { attributes: true, attributeFilter: ["class"] });
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("pointerleave", pointerLeave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    resize();

    return () => {
      resizeObserver.disconnect();
      themeObserver?.disconnect();
      simulation.stop();
      simulationRef.current = null;
      drawRef.current = () => {};
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [links, nodes, onSelect]);

  return (
    <div className={`social-listening-graph mode-${mode}`} ref={containerRef}>
      <canvas
        aria-label={`Social-listening campaign relationship graph in ${mode.toUpperCase()}`}
        ref={canvasRef}
      />
      {tooltip && (
        <div className="social-graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <span>{tooltip.node.type.toUpperCase()} · {tooltip.node.status?.toUpperCase() || "OBSERVED"}</span>
          <strong>{tooltip.node.label}</strong>
          <p>{tooltip.node.detail}</p>
        </div>
      )}
      <div className="social-graph-instruction">
        {mode === "3d" ? "DRAG TO ROTATE · SCROLL TO ZOOM · SELECT A NODE" : "DRAG NODES · PAN · SCROLL TO ZOOM"}
      </div>
    </div>
  );
});
