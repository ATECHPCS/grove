import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Maximize2, Minus, Pause, Play, Plus } from "lucide-react";
import type { MemoryEntity, MemoryRelation } from "../../api/memory";
import { selectVisibleRelations } from "./memoryGraphRelations";

const COLORS = ["#55b98b", "#b37ad9", "#e8bd58", "#e98273", "#69a8d8", "#8bc46b"];
const MIN_ZOOM = 0.65;
const MAX_ZOOM = 2.2;

interface SpatialNode {
  id: string;
  entity: MemoryEntity;
  color: string;
  radius: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  phase: number;
}

interface SpatialLink {
  relation: MemoryRelation;
  source: SpatialNode;
  target: SpatialNode;
  width: number;
  opacity: number;
}

interface SpatialScene {
  nodes: SpatialNode[];
  links: SpatialLink[];
  bounds: { x: number; y: number; z: number };
  spaceRadius: number;
}

interface ProjectedNode {
  node: SpatialNode;
  x: number;
  y: number;
  z: number;
  scale: number;
  radius: number;
}

interface ProjectedLink {
  link: SpatialLink;
  source: ProjectedNode;
  target: ProjectedNode;
  depth: number;
  width: number;
}

interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

interface HoverTarget {
  kind: "node" | "relation";
  id: string;
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  mode: "node" | "orbit" | "pan";
  startX: number;
  startY: number;
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  nodeId?: string;
  nodeX?: number;
  nodeY?: number;
  nodeZ?: number;
  moved: boolean;
}

export function MemoryGraph({
  entities,
  relations,
  onOpen,
  categoryColors,
  activeCategory,
  summary,
}: {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
  onOpen: (entityId: string) => void;
  categoryColors: ReadonlyMap<string, string>;
  activeCategory?: string | null;
  summary?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<Camera>(defaultCamera());
  const dragRef = useRef<DragState | null>(null);
  const projectedNodesRef = useRef<ProjectedNode[]>([]);
  const projectedLinksRef = useRef<ProjectedLink[]>([]);
  const hoverRef = useRef<HoverTarget | null>(null);
  const dirtyRef = useRef(true);
  const motionEnabledRef = useRef(true);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 720, height: 480 });

  const scene = useMemo(
    () => buildSpatialScene(entities, relations, categoryColors, activeCategory, containerSize),
    [activeCategory, categoryColors, containerSize, entities, relations],
  );
  const activeColor = activeCategory ? categoryColors.get(activeCategory) : undefined;

  useEffect(() => {
    motionEnabledRef.current = motionEnabled;
    dirtyRef.current = true;
  }, [motionEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let width = 0;
    let height = 0;
    let frame = 0;
    let lastFrame = performance.now();
    let lastDraw = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      const bounds = container.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      dirtyRef.current = true;
    };

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const elapsed = Math.min(80, now - lastFrame);
      lastFrame = now;
      const simulating = motionEnabledRef.current && !reducedMotion && !dragRef.current && !hoverRef.current;
      if (simulating) {
        simulateSpatialScene(scene, elapsed, now, true);
        dirtyRef.current = true;
      }
      if (!dirtyRef.current || now - lastDraw < 24) return;
      lastDraw = now;
      dirtyRef.current = false;
      drawScene(canvas, width, height, scene, cameraRef.current, hoverRef.current, projectedNodesRef, projectedLinksRef);
    };

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      const bounds = container.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(bounds.width));
      const nextHeight = Math.max(1, Math.round(bounds.height));
      setContainerSize((current) => current.width === nextWidth && current.height === nextHeight
        ? current
        : { width: nextWidth, height: nextHeight });
    });
    observer.observe(container);
    frame = requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scene]);

  const updateHover = (target: HoverTarget | null) => {
    const current = hoverRef.current;
    if (current?.kind === target?.kind && current?.id === target?.id && current?.x === target?.x && current?.y === target?.y) return;
    hoverRef.current = target;
    setHover(target);
    dirtyRef.current = true;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const camera = cameraRef.current;
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = hitTest(event.clientX - bounds.left, event.clientY - bounds.top, projectedNodesRef.current, projectedLinksRef.current);
    const node = target?.kind === "node" ? scene.nodes.find((item) => item.id === target.id) : undefined;
    dragRef.current = {
      pointerId: event.pointerId,
      mode: event.shiftKey ? "pan" : node ? "node" : "orbit",
      startX: event.clientX,
      startY: event.clientY,
      yaw: camera.yaw,
      pitch: camera.pitch,
      panX: camera.panX,
      panY: camera.panY,
      nodeId: node?.id,
      nodeX: node?.x,
      nodeY: node?.y,
      nodeZ: node?.z,
      moved: false,
    };
    dirtyRef.current = true;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.mode === "node" && drag.nodeId) {
        const node = scene.nodes.find((item) => item.id === drag.nodeId);
        if (node) {
          const camera = cameraRef.current;
          const worldDx = dx / Math.max(camera.zoom, 0.1);
          const worldDy = dy / Math.max(camera.zoom, 0.1);
          const cosYaw = Math.cos(camera.yaw);
          const sinYaw = Math.sin(camera.yaw);
          const cosPitch = Math.cos(camera.pitch);
          const sinPitch = Math.sin(camera.pitch);
          node.x = (drag.nodeX ?? node.x) + worldDx * cosYaw - worldDy * sinYaw * sinPitch;
          node.y = (drag.nodeY ?? node.y) + worldDy * cosPitch;
          node.z = (drag.nodeZ ?? node.z) - worldDx * sinYaw - worldDy * cosYaw * sinPitch;
          node.vx = 0;
          node.vy = 0;
          node.vz = 0;
        }
      } else if (drag.mode === "orbit") {
        cameraRef.current.yaw = drag.yaw + dx * 0.006;
        cameraRef.current.pitch = clamp(drag.pitch + dy * 0.005, -1.08, 1.08);
      } else {
        cameraRef.current.panX = drag.panX + dx;
        cameraRef.current.panY = drag.panY + dy;
      }
      dirtyRef.current = true;
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const target = hitTest(x, y, projectedNodesRef.current, projectedLinksRef.current);
    updateHover(target ? { ...target, x, y } : null);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const target = hitTest(event.clientX - bounds.left, event.clientY - bounds.top, projectedNodesRef.current, projectedLinksRef.current);
      if (target?.kind === "node") onOpen(target.id);
    }
    dirtyRef.current = true;
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dirtyRef.current = true;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    cameraRef.current.zoom = clamp(
      cameraRef.current.zoom * (event.deltaY > 0 ? 0.9 : 1.1),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    dirtyRef.current = true;
  };

  const changeZoom = (factor: number) => {
    cameraRef.current.zoom = clamp(cameraRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    dirtyRef.current = true;
  };

  const resetView = () => {
    cameraRef.current = defaultCamera();
    dirtyRef.current = true;
  };

  const hoveredNode = hover?.kind === "node" ? scene.nodes.find((node) => node.id === hover.id) : null;
  const hoveredLink = hover?.kind === "relation" ? scene.links.find((link) => link.relation.id === hover.id) : null;

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[420px] overflow-hidden bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--color-highlight)_8%,transparent),transparent_58%)]"
      style={activeColor ? { background: `radial-gradient(circle at center, color-mix(in srgb, ${activeColor} 10%, transparent), transparent 58%)` } : undefined}
      data-memory-node-radii={scene.nodes.map((node) => `${node.entity.score}:${node.radius.toFixed(2)}`).join(",")}
      data-memory-relation-widths={scene.links.map((link) => `${link.relation.score}:${link.width.toFixed(2)}`).join(",")}
    >
      {summary && (
        <p className="pointer-events-none absolute left-4 top-4 z-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]/90 px-3 py-2 text-xs text-[var(--color-text-muted)] shadow-sm backdrop-blur-sm">
          {summary}
        </p>
      )}
      <canvas
        ref={canvasRef}
        className="h-full w-full cursor-grab select-none active:cursor-grabbing"
        role="img"
        aria-label="Interactive three-dimensional Memory relation map"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => { if (!dragRef.current) updateHover(null); }}
        onWheel={handleWheel}
        onDoubleClick={resetView}
      />

      {hoveredNode && hover && (
        <MemoryDocumentPreview
          entity={hoveredNode.entity}
          x={hover.x}
          y={hover.y}
          color={hoveredNode.color}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
      )}

      {hoveredLink && hover && (
        <div
          className="pointer-events-none absolute z-20 max-w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-3 py-2.5 shadow-lg backdrop-blur-md"
          style={{ left: Math.min(hover.x + 14, Math.max(12, containerSize.width - 270)), top: Math.max(12, hover.y - 18) }}
        >
          <p className="text-xs font-medium text-[var(--color-text)]">{humanize(hoveredLink.relation.relation_type)}</p>
          <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Relation score {hoveredLink.relation.score}</p>
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-10 inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/92 p-1 shadow-sm backdrop-blur-sm">
        <button type="button" onClick={() => changeZoom(1.15)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Zoom in" aria-label="Zoom in"><Plus className="h-4 w-4" /></button>
        <button type="button" onClick={() => changeZoom(1 / 1.15)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Zoom out" aria-label="Zoom out"><Minus className="h-4 w-4" /></button>
        <span className="mx-0.5 h-5 w-px bg-[var(--color-border)]" />
        <button type="button" onClick={() => setMotionEnabled((current) => !current)} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title={motionEnabled ? "Pause node motion" : "Resume node motion"} aria-label={motionEnabled ? "Pause node motion" : "Resume node motion"}>{motionEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button type="button" onClick={resetView} className="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]" title="Reset view" aria-label="Reset graph view"><Maximize2 className="h-4 w-4" /></button>
      </div>
      <p className="pointer-events-none absolute bottom-5 right-5 text-[10px] text-[var(--color-text-muted)]/75">Drag a node to reposition · Drag background to orbit · Scroll to zoom</p>
    </div>
  );
}

function MemoryDocumentPreview({
  entity,
  x,
  y,
  color,
  containerWidth,
  containerHeight,
}: {
  entity: MemoryEntity;
  x: number;
  y: number;
  color: string;
  containerWidth: number;
  containerHeight: number;
}) {
  const width = Math.min(360, containerWidth - 28);
  const left = x < containerWidth / 2
    ? Math.min(x + 22, containerWidth - width - 14)
    : Math.max(14, x - width - 22);
  const top = clamp(y - 76, 14, Math.max(14, containerHeight - 280));
  return (
    <article
      className="pointer-events-none absolute z-20 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]/97 shadow-[0_18px_45px_rgba(0,0,0,0.16)] backdrop-blur-xl"
      style={{ left, top, width }}
      aria-label={`Preview ${entity.title}`}
    >
      <div className="h-1" style={{ background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 45%, transparent), transparent)` }} />
      <div className="px-5 pb-4 pt-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Memory document</p>
            <h3 className="mt-1.5 text-lg font-semibold leading-snug tracking-tight text-[var(--color-text)]">{entity.title}</h3>
          </div>
          <span className="mt-0.5 rounded-full px-2 py-1 text-[10px] font-medium tabular-nums" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}>{entity.score}</span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--color-text-muted)]">{entity.description}</p>
        {entity.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {entity.tags.slice(0, 4).map((tag) => (
              <span key={`${tag.key}:${tag.value}`} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] text-[var(--color-text-muted)]">
                {tag.icon ? `${tag.icon} ` : ""}{humanize(tag.key)} · {tag.value}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-5 py-2.5 text-[10px] text-[var(--color-text-muted)]">
        <span>Updated {relativePreviewDate(entity.updated_at)}</span>
        <span>Click node for full document</span>
      </div>
    </article>
  );
}

function buildSpatialScene(
  entities: MemoryEntity[],
  relations: MemoryRelation[],
  categoryColors: ReadonlyMap<string, string>,
  activeCategory?: string | null,
  viewport = { width: 720, height: 480 },
): SpatialScene {
  const nodeScores = entities.map((entity) => entity.score);
  const nodeMin = nodeScores.length > 0 ? Math.min(...nodeScores) : 0;
  const nodeMax = nodeScores.length > 0 ? Math.max(...nodeScores) : 100;
  const count = Math.max(entities.length, 1);
  const density = count <= 8 ? 0.82 : count <= 30 ? 1 : 1.12;
  const bounds = {
    x: clamp(viewport.width * 0.38 * density, 250, 720),
    y: clamp(viewport.height * 0.36 * density, 190, 440),
    z: clamp(Math.min(viewport.width, viewport.height) * 0.28 * density, 150, 360),
  };
  const spaceRadius = Math.max(bounds.x, bounds.y, bounds.z);
  const nodes = entities.map((entity): SpatialNode => {
    // A deterministic point inside a volume, rather than a point on a sphere.
    // The cubic root keeps density even throughout the available 3D space.
    const radialSeed = stableRandom(entity.entity_id, 1);
    const azimuth = stableRandom(entity.entity_id, 2) * Math.PI * 2;
    const vertical = stableRandom(entity.entity_id, 3) * 2 - 1;
    const ring = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    const distance = 0.18 + 0.78 * Math.cbrt(radialSeed);
    return {
      id: entity.entity_id,
      entity,
      color: categoryColors.get(activeCategory ?? primaryCategory(entity)) ?? COLORS[0],
      radius: nodeRadius(entity.score, nodeMin, nodeMax, count),
      x: Math.cos(azimuth) * ring * distance * bounds.x,
      y: vertical * distance * bounds.y,
      z: Math.sin(azimuth) * ring * distance * bounds.z,
      vx: 0,
      vy: 0,
      vz: 0,
      phase: stableRandom(entity.entity_id, 4) * Math.PI * 2,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visibleRelations = selectVisibleRelations(relations, byId, 3);
  const relationScores = visibleRelations.map((relation) => relation.score);
  const relationMin = relationScores.length > 0 ? Math.min(...relationScores) : 0;
  const relationMax = relationScores.length > 0 ? Math.max(...relationScores) : 100;
  const links = visibleRelations.flatMap((relation): SpatialLink[] => {
    const source = byId.get(relation.source_entity_id);
    const target = byId.get(relation.target_entity_id);
    if (!source || !target) return [];
    const salience = scoreSalience(relation.score, relationMin, relationMax);
    return [{
      relation,
      source,
      target,
      width: 0.4 + salience * 1.15,
      opacity: 0.14 + salience * 0.28,
    }];
  });
  const scene = { nodes, links, bounds, spaceRadius };
  // Settle the initial layout before the first paint without freezing it into a
  // permanent arrangement. Runtime motion continues from this physical state.
  for (let step = 0; step < 140; step += 1) simulateSpatialScene(scene, 16.67, step * 16.67, false);
  return scene;
}

function drawScene(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  scene: SpatialScene,
  camera: Camera,
  hover: HoverTarget | null,
  projectedNodesRef: { current: ProjectedNode[] },
  projectedLinksRef: { current: ProjectedLink[] },
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixelRatio = canvas.width / Math.max(width, 1);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const styles = getComputedStyle(canvas);
  const border = styles.getPropertyValue("--color-border").trim() || "#d8d8d8";
  const textMuted = styles.getPropertyValue("--color-text-muted").trim() || "#7b7b7b";
  const highlight = styles.getPropertyValue("--color-highlight").trim() || "#0d9f72";
  drawSpatialBackdrop(context, width, height, border);

  const projectedNodes = scene.nodes
    .map((node) => projectNode(node, width, height, camera))
    .sort((left, right) => left.z - right.z);
  const projectedById = new Map(projectedNodes.map((node) => [node.node.id, node]));
  const projectedLinks = scene.links.flatMap((link): ProjectedLink[] => {
    const source = projectedById.get(link.source.id);
    const target = projectedById.get(link.target.id);
    if (!source || !target) return [];
    return [{
      link,
      source,
      target,
      depth: (source.z + target.z) / 2,
      width: link.width * (0.88 + ((source.scale + target.scale) / 2) * 0.12) * Math.sqrt(camera.zoom),
    }];
  }).sort((left, right) => left.depth - right.depth);
  projectedNodesRef.current = projectedNodes;
  projectedLinksRef.current = projectedLinks;
  canvas.dataset.memoryCamera = JSON.stringify(camera);
  canvas.dataset.memoryProjectedNodes = JSON.stringify(projectedNodes.map((node) => ({ id: node.node.id, x: Math.round(node.x), y: Math.round(node.y), radius: Number(node.radius.toFixed(2)) })));
  canvas.dataset.memoryProjectedRelations = JSON.stringify(projectedLinks.map((link) => ({ id: link.link.relation.id, x1: Math.round(link.source.x), y1: Math.round(link.source.y), x2: Math.round(link.target.x), y2: Math.round(link.target.y), width: Number(link.width.toFixed(2)) })));

  const focusedNodeId = hover?.kind === "node" ? hover.id : null;
  const focusedRelationId = hover?.kind === "relation" ? hover.id : null;
  const focusedNodeColor = focusedNodeId ? scene.nodes.find((node) => node.id === focusedNodeId)?.color : undefined;
  for (const projected of projectedLinks) {
    const { link, source, target } = projected;
    const relatedToNode = focusedNodeId === source.node.id || focusedNodeId === target.node.id;
    const isFocused = focusedRelationId === link.relation.id || relatedToNode;
    const hasFocus = Boolean(focusedNodeId || focusedRelationId);
    context.beginPath();
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.lineCap = "round";
    context.lineWidth = projected.width + (isFocused ? 0.8 : 0);
    context.strokeStyle = isFocused ? (focusedNodeColor ?? highlight) : textMuted;
    context.globalAlpha = hasFocus ? (isFocused ? 0.92 : 0.09) : link.opacity * depthOpacity(projected.depth, scene.spaceRadius);
    context.stroke();
  }

  const connectedIds = new Set<string>();
  if (focusedNodeId) {
    connectedIds.add(focusedNodeId);
    for (const link of scene.links) {
      if (link.source.id === focusedNodeId) connectedIds.add(link.target.id);
      if (link.target.id === focusedNodeId) connectedIds.add(link.source.id);
    }
  }
  if (focusedRelationId) {
    const link = scene.links.find((item) => item.relation.id === focusedRelationId);
    if (link) { connectedIds.add(link.source.id); connectedIds.add(link.target.id); }
  }

  for (const projected of projectedNodes) {
    const { node } = projected;
    const focused = focusedNodeId === node.id;
    const dimmed = connectedIds.size > 0 && !connectedIds.has(node.id);
    const opacity = dimmed ? 0.16 : depthOpacity(projected.z, scene.spaceRadius);
    context.globalAlpha = opacity * (focused ? 0.22 : 0.08);
    context.fillStyle = node.color;
    context.beginPath();
    context.arc(projected.x, projected.y, projected.radius + (focused ? 4 : 2), 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = opacity;
    context.fillStyle = node.color;
    context.beginPath();
    context.arc(projected.x, projected.y, projected.radius, 0, Math.PI * 2);
    context.fill();
    if (focused) {
      context.globalAlpha = 0.92;
      context.strokeStyle = node.color;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(projected.x, projected.y, projected.radius + 3, 0, Math.PI * 2);
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

function drawSpatialBackdrop(context: CanvasRenderingContext2D, width: number, height: number, color: string) {
  context.save();
  context.fillStyle = color;
  for (let index = 0; index < 72; index += 1) {
    const x = stableRandom(`backdrop-${index}`, 1) * width;
    const y = stableRandom(`backdrop-${index}`, 2) * height;
    const radius = 0.45 + stableRandom(`backdrop-${index}`, 3) * 0.75;
    context.globalAlpha = 0.08 + stableRandom(`backdrop-${index}`, 4) * 0.1;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function simulateSpatialScene(scene: SpatialScene, elapsed: number, now: number, wandering: boolean) {
  const { nodes, links, bounds } = scene;
  if (nodes.length < 2) return;
  const step = clamp(elapsed / 16.67, 0.25, 2);
  const forces = new Float64Array(nodes.length * 3);
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const repulsion = 980 + Math.min(nodes.length, 80) * 22;

  // Nodes repel one another in all three axes. This is what lets a large set
  // occupy the volume instead of collapsing into the center of the viewport.
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let dz = right.z - left.z;
      let distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared < 0.01) {
        dx = stableRandom(`${left.id}-${right.id}`, 5) - 0.5;
        dy = stableRandom(`${left.id}-${right.id}`, 6) - 0.5;
        dz = stableRandom(`${left.id}-${right.id}`, 7) - 0.5;
        distanceSquared = dx * dx + dy * dy + dz * dz;
      }
      const distance = Math.sqrt(distanceSquared);
      const inverseDistance = 1 / Math.max(distance, 0.01);
      const minimumDistance = left.radius + right.radius + 22;
      const collision = distance < minimumDistance ? (minimumDistance - distance) * 0.035 : 0;
      const magnitude = repulsion / (distanceSquared + 900) + collision;
      const fx = dx * inverseDistance * magnitude;
      const fy = dy * inverseDistance * magnitude;
      const fz = dz * inverseDistance * magnitude;
      forces[leftIndex * 3] -= fx;
      forces[leftIndex * 3 + 1] -= fy;
      forces[leftIndex * 3 + 2] -= fz;
      forces[rightIndex * 3] += fx;
      forces[rightIndex * 3 + 1] += fy;
      forces[rightIndex * 3 + 2] += fz;
    }
  }

  // Relations behave as springs. Strong relations pull closer and respond more
  // firmly, while weak relations remain longer and visually looser.
  for (const link of links) {
    const sourceIndex = indices.get(link.source.id);
    const targetIndex = indices.get(link.target.id);
    if (sourceIndex === undefined || targetIndex === undefined) continue;
    const dx = link.target.x - link.source.x;
    const dy = link.target.y - link.source.y;
    const dz = link.target.z - link.source.z;
    const distance = Math.max(1, Math.hypot(dx, dy, dz));
    const normalizedScore = clamp(link.relation.score / 100, 0, 1);
    const linkScale = Math.min(bounds.x, bounds.y);
    const targetDistance = linkScale * (0.5 + (1 - normalizedScore) * 0.42);
    const magnitude = (distance - targetDistance) * (0.0009 + normalizedScore * 0.0013);
    const fx = dx / distance * magnitude;
    const fy = dy / distance * magnitude;
    const fz = dz / distance * magnitude;
    forces[sourceIndex * 3] += fx;
    forces[sourceIndex * 3 + 1] += fy;
    forces[sourceIndex * 3 + 2] += fz;
    forces[targetIndex * 3] -= fx;
    forces[targetIndex * 3 + 1] -= fy;
    forces[targetIndex * 3 + 2] -= fz;
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const offset = index * 3;
    const normalizedDistance = Math.hypot(
      node.x / Math.max(bounds.x, 1),
      node.y / Math.max(bounds.y, 1),
      node.z / Math.max(bounds.z, 1),
    );
    const outside = Math.max(0, normalizedDistance - 1.04);
    const centerStrength = 0.000025 + outside * 0.0012;
    forces[offset] -= node.x * centerStrength;
    forces[offset + 1] -= node.y * centerStrength;
    forces[offset + 2] -= node.z * centerStrength;

    if (wandering) {
      const time = now * 0.00022;
      forces[offset] += Math.sin(time + node.phase) * 0.006;
      forces[offset + 1] += Math.cos(time * 0.83 + node.phase * 1.37) * 0.005;
      forces[offset + 2] += Math.sin(time * 0.71 + node.phase * 2.11) * 0.006;
    }

    const mass = 0.85 + node.radius * 0.09;
    const damping = Math.pow(0.9, step);
    node.vx = (node.vx + forces[offset] / mass * step) * damping;
    node.vy = (node.vy + forces[offset + 1] / mass * step) * damping;
    node.vz = (node.vz + forces[offset + 2] / mass * step) * damping;
    const speed = Math.hypot(node.vx, node.vy, node.vz);
    if (speed > 1.15) {
      const scale = 1.15 / speed;
      node.vx *= scale;
      node.vy *= scale;
      node.vz *= scale;
    }
    node.x += node.vx * step;
    node.y += node.vy * step;
    node.z += node.vz * step;
  }
}

function projectNode(node: SpatialNode, width: number, height: number, camera: Camera): ProjectedNode {
  const point = projectPoint(node.x, node.y, node.z, width, height, camera);
  return { node, ...point, radius: node.radius * (0.82 + point.scale * 0.18) * Math.sqrt(camera.zoom) };
}

function projectPoint(x: number, y: number, z: number, width: number, height: number, camera: Camera) {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const xYaw = x * cosYaw - z * sinYaw;
  const zYaw = x * sinYaw + z * cosYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const yPitch = y * cosPitch - zYaw * sinPitch;
  const zPitch = y * sinPitch + zYaw * cosPitch;
  const focalLength = 760;
  const perspective = clamp(focalLength / (focalLength - zPitch), 0.58, 1.55);
  return {
    x: width / 2 + camera.panX + xYaw * perspective * camera.zoom,
    y: height / 2 + camera.panY + yPitch * perspective * camera.zoom,
    z: zPitch,
    scale: perspective,
  };
}

function hitTest(x: number, y: number, nodes: ProjectedNode[], links: ProjectedLink[]) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (Math.hypot(x - node.x, y - node.y) <= node.radius + 7) return { kind: "node" as const, id: node.node.id };
  }
  let nearest: { id: string; distance: number } | null = null;
  for (const link of links) {
    const distance = distanceToSegment(x, y, link.source.x, link.source.y, link.target.x, link.target.y);
    const threshold = Math.max(6, link.width + 3);
    if (distance <= threshold && (!nearest || distance < nearest.distance)) nearest = { id: link.link.relation.id, distance };
  }
  return nearest ? { kind: "relation" as const, id: nearest.id } : null;
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function nodeRadius(score: number, minimum: number, maximum: number, count: number) {
  const salience = scoreSalience(score, minimum, maximum);
  const [small, large] = count <= 12 ? [2.5, 5.5] : count <= 40 ? [2.2, 4.8] : [1.8, 4];
  return small + (large - small) * salience;
}

function scoreSalience(score: number, minimum: number, maximum: number) {
  const absolute = clamp(score / 100, 0, 1);
  if (maximum - minimum < 0.5) return absolute;
  const relative = clamp((score - minimum) / (maximum - minimum), 0, 1);
  return relative * 0.85 + absolute * 0.15;
}

function depthOpacity(depth: number, radius: number) {
  return clamp(0.52 + ((depth + radius) / Math.max(radius * 2, 1)) * 0.48, 0.42, 1);
}

function stableRandom(value: string, salt: number) {
  let hash = 0;
  const input = `${salt}:${value}`;
  for (let index = 0; index < input.length; index += 1) hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

function defaultCamera(): Camera {
  return { yaw: -0.42, pitch: -0.16, zoom: 1, panX: 0, panY: 0 };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativePreviewDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function primaryCategory(entity: MemoryEntity) {
  return entity.tags[0]?.key || "Uncategorized";
}
