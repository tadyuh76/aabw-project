"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

const NODE_COLORS = {
  campaign: "#DB676D",
  report: "#f0b4b7",
  mention: "#b2adaf",
  phone: "#d9898e",
  domain: "#ef9ba0",
  apk: "#f1b86d",
  account: "#f4d0d2",
  phrase: "#8e898b",
  tracking: "#bc8a8e",
  profile: "#f5f3f0",
};

function stablePosition(id, index, total) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  const angle = (index / Math.max(1, total)) * Math.PI * 4 + (Math.abs(hash) % 97) / 97;
  const radius = 2.8 + (Math.abs(hash >> 3) % 180) / 100;
  return new THREE.Vector3(
    Math.cos(angle) * radius,
    ((index % 7) - 3) * .62 + ((hash % 11) / 24),
    Math.sin(angle) * radius,
  );
}

function NetworkScene({ nodes, links, selectedId, onSelect, reducedMotion }) {
  const groupRef = useRef(null);
  const positions = useMemo(
    () => new Map(nodes.map((node, index) => [node.id, stablePosition(node.id, index, nodes.length)])),
    [nodes],
  );
  const lineGeometry = useMemo(() => {
    const points = [];
    links.forEach((link) => {
      const source = positions.get(typeof link.source === "object" ? link.source.id : link.source);
      const target = positions.get(typeof link.target === "object" ? link.target.id : link.target);
      if (source && target) points.push(source, target);
    });
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [links, positions]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    if (!reducedMotion) groupRef.current.rotation.y += delta * .045;
    groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, Math.sin(state.clock.elapsedTime * .12) * .08, .02);
  });

  return (
    <group ref={groupRef}>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial color="#7e5559" transparent opacity={.28} />
      </lineSegments>
      {nodes.map((node) => {
        const position = positions.get(node.id);
        const selected = node.id === selectedId;
        const radius = selected ? .2 : node.type === "campaign" ? .16 : .1;
        return (
          <mesh
            key={node.id}
            position={position}
            scale={selected ? 1.35 : 1}
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.(node.id);
            }}
          >
            <sphereGeometry args={[radius, 18, 18]} />
            <meshStandardMaterial
              color={NODE_COLORS[node.type] || "#aaa5a7"}
              emissive={selected ? "#DB676D" : "#000000"}
              emissiveIntensity={selected ? .55 : 0}
              roughness={.44}
              metalness={.12}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export function ScamNetwork3D({ nodes, links, selectedId, onSelect }) {
  return (
    <Canvas camera={{ position: [0, 0, 8.8], fov: 50 }} dpr={[1, 1.6]} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={1.25} />
      <pointLight position={[4, 5, 6]} intensity={20} color="#DB676D" />
      <pointLight position={[-5, -3, 2]} intensity={9} color="#ffffff" />
      <NetworkScene
        nodes={nodes}
        links={links}
        selectedId={selectedId}
        onSelect={onSelect}
        reducedMotion={typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches}
      />
    </Canvas>
  );
}
