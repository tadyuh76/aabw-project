"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { AdditiveBlending } from "three";
import { useMemo, useRef } from "react";

const POINT_COUNT = 280;
const LINE_COUNT = 27;
const MAIN_LINE = Math.floor(LINE_COUNT / 2);

function smoothstep(min, max, value) {
  const normalized = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return normalized * normalized * (3 - 2 * normalized);
}

function getWavePoint(x, width, lineIndex, time) {
  const halfWidth = Math.max(width * 0.5, 1);
  const edgeProgress = Math.min(1, Math.abs(x) / halfWidth);
  const fan = smoothstep(0.12, 0.92, edgeProgress);
  const normalizedLine = lineIndex / Math.max(1, LINE_COUNT - 1) - 0.5;

  // The reference funnels the field into the CTA, then lets it bloom at the edges.
  const spread = normalizedLine * (0.38 + fan * 3.05);
  const sharedCurrent =
    Math.sin(x * 0.72 + time * 0.2) * (0.22 + fan * 0.48) +
    Math.sin(x * 0.29 - time * 0.13 + 0.8) * (0.1 + fan * 0.26);
  const contourDrift =
    Math.sin(x * 0.43 - time * 0.11 + lineIndex * 0.19) * fan * 0.2;

  return sharedCurrent + contourDrift + spread;
}

function createPositions(width, lineIndex, time = 0, offsetY = 0) {
  const positions = new Float32Array(POINT_COUNT * 3);

  for (let pointIndex = 0; pointIndex < POINT_COUNT; pointIndex += 1) {
    const progress = pointIndex / (POINT_COUNT - 1);
    const x = (progress - 0.5) * width * 1.22;
    const offset = pointIndex * 3;
    positions[offset] = x;
    positions[offset + 1] = getWavePoint(x, width, lineIndex, time) + offsetY;
    positions[offset + 2] = 0;
  }

  return positions;
}

function WaveLine({ index, reducedMotion, offsetY = 0, glowOnly = false }) {
  const lineRef = useRef(null);
  const viewportWidth = useThree((state) => state.viewport.width);
  const positions = useMemo(
    () => createPositions(viewportWidth, index, 0, offsetY),
    [viewportWidth, index, offsetY],
  );
  const distanceFromMain = Math.abs(index - MAIN_LINE);
  const isMainLine = distanceFromMain === 0;
  const isGlowLine = distanceFromMain <= 2;

  useFrame(({ clock }) => {
    if (reducedMotion || !lineRef.current) return;
    const attribute = lineRef.current.geometry.attributes.position;
    const elapsed = clock.elapsedTime;

    for (let pointIndex = 0; pointIndex < POINT_COUNT; pointIndex += 1) {
      const progress = pointIndex / (POINT_COUNT - 1);
      const x = (progress - 0.5) * viewportWidth * 1.22;
      attribute.setXYZ(
        pointIndex,
        x,
        getWavePoint(x, viewportWidth, index, elapsed) + offsetY,
        0,
      );
    }

    attribute.needsUpdate = true;
  });

  return (
    <line ref={lineRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial
        color={glowOnly ? "#ff5961" : isMainLine ? "#ffd0d2" : "#db676d"}
        transparent
        opacity={glowOnly ? 0.24 : isMainLine ? 1 : isGlowLine ? 0.5 : 0.2}
        blending={AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </line>
  );
}

function WaveField({ reducedMotion }) {
  return (
    <group>
      {Array.from({ length: LINE_COUNT }, (_, index) => (
        <WaveLine key={index} index={index} reducedMotion={reducedMotion} />
      ))}
      {[-0.09, -0.06, -0.03, 0.03, 0.06, 0.09].map((offsetY) => (
        <WaveLine
          key={offsetY}
          index={MAIN_LINE}
          offsetY={offsetY}
          glowOnly
          reducedMotion={reducedMotion}
        />
      ))}
    </group>
  );
}

export function SignalWave({ reducedMotion = false }) {
  return (
    <Canvas
      className="signal-wave-canvas"
      orthographic
      camera={{ position: [0, 0, 10], zoom: 100 }}
      dpr={[1, 1.5]}
      frameloop={reducedMotion ? "demand" : "always"}
      performance={{ min: 0.5 }}
      gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
    >
      <WaveField reducedMotion={reducedMotion} />
    </Canvas>
  );
}
