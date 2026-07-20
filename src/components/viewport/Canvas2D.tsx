import { useCallback, useEffect, useRef, useState } from "react";
import { useDesignStore } from "../../store/useDesignStore";
import type { Point, Wall, Opening, OpeningType, ToolType, Measurement, MeasurementAnchor, FurnitureItem, RoomFloor, WalkthroughStart, CeilingLight } from "../../types";
import {
  distance,
  distanceToSegment,
  projectPointOnSegment,
  angleRad,
  snapAngle,
  snapValueToStep,
  snapPointToGrid,
  formatLength,
} from "../../lib/geometry";
import {
  DEFAULT_WALL_HEIGHT,
  GRID_SNAP_M,
  DOOR_DEFAULT_WIDTH,
  DOOR_DEFAULT_HEIGHT,
  DOOR_DEFAULT_SILL,
  WINDOW_DEFAULT_WIDTH,
  WINDOW_DEFAULT_HEIGHT,
  WINDOW_DEFAULT_SILL,
} from "../../lib/constants";
import { computeCornerPatches } from "../../lib/wallGeometry";
import { fitOpeningOnWall } from "../../lib/openingGeometry";
import {
  computeRooms,
  computeRoomFloorPolygons,
  computeDoorThresholdPatches,
  pointInPolygon,
  type DetectedRoom,
  type DoorThresholdPatch,
} from "../../lib/roomDetection";
import {
  resolveFurniturePlacement,
  sweepFurniturePlacement,
  furnitureCollisionSize,
  type FurnitureObstacle,
} from "../../lib/furnitureCollision";

const FURNITURE_BREAKTHROUGH_DISTANCE_M = 0.45;

function furnitureObstacles(items: FurnitureItem[], excludeIds: string[]): FurnitureObstacle[] {
  return items
    .filter((f) => !excludeIds.includes(f.id))
    .map((f) => {
      const size = furnitureCollisionSize(f);
      return { id: f.id, position: f.position, width: size.width, depth: size.depth, rotation: f.rotation };
    });
}

const BASE_PPM = 50; // pixels per meter at zoom = 1
const ANGLE_SNAP_STEP_DEG = 45;
const ANGLE_SNAP_TOLERANCE_DEG = 6;
const ENDPOINT_SNAP_PX = 12;
// minimum screen-pixel movement before a mousedown-on-an-object turns into a
// drag — otherwise ordinary hand/trackpad jitter during a plain click nudges
// the wall/measurement/opening by a hair, which reads as an accidental move
const DRAG_ARM_PX = 4;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;
const MIN_SEGMENT_LENGTH_M = 0.05;
const OPENING_SNAP_PX = 24;
const OPENING_HIT_MARGIN_M = 0.12;
const PASTE_OFFSET_STEP_M = 0.3;

// warm "atelier" canvas palette — mirrors the CSS custom properties in index.css
const COLOR_BG = "#f7f3ea";
const COLOR_GRID_MINOR = "#efe8d9";
const COLOR_GRID_MAJOR = "#e6ddc7";
const COLOR_AXIS = "#8f8064";
const COLOR_INK = "#33291d";
const COLOR_INK_SOFT = "#6d6252";
const COLOR_PAPER = "#faf8f2";
const COLOR_CLAY = "#ab5a38";
const COLOR_CLAY_DARK = "#8a4429";
const COLOR_SAGE = "#5f7a54";
const COLOR_BRICK = "#a1402f";
const COLOR_BRASS = "#a6793f";
const COLOR_BRASS_DARK = "#8a5f2e";
const COLOR_GLASS = "#5a8aa8";
const COLOR_HANDLE = "#2f6fed"; // drag handles at wall/measurement endpoints — a distinct blue so they read as grabbable, separate from the clay selection color
const COLOR_SPACING = "#e8336d"; // Alt-hover spacing readout (Figma-style) — a hot pink so it never gets mistaken for a persistent measurement or the selection outline

const TOOL_SHORTCUTS: Record<string, ToolType> = {
  v: "select",
  s: "wall",
  d: "door",
  o: "window",
  k: "measure",
  f: "floor",
  w: "walkStart",
  l: "ceilingLight",
  h: "pan",
};

interface CameraState {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

interface DrawState {
  pendingStart: Point | null;
  cursorWorld: Point | null;
  /** True whenever the cursor point is magnetized onto another wall — a corner or its face/centerline — same trigger as the measurement tool's magnet ring. */
  snappedToWall: boolean;
  lengthBuffer: string;
}

type DragMode =
  | "none"
  | "pan"
  | "wall-body"
  | "wall-endpoint"
  | "marquee"
  | "opening"
  | "measure"
  | "measure-endpoint"
  | "measure-body"
  | "furniture-body"
  | "furniture-rotate"
  | "walk-start";

interface GroupWallSnapshot {
  id: string;
  start: Point;
  end: Point;
}

interface FurnitureSnapshot {
  id: string;
  position: Point;
  /** Mutated frame-to-frame as collisions resolve — the sweep's "from" each
   * frame, kept here instead of re-read from the store so it can't lag a
   * render behind the native mousemove stream during a fast drag. */
  settled: Point;
}

interface DragState {
  mode: DragMode;
  wallId: string | null;
  endpoint: "start" | "end" | null;
  openingId: string | null;
  groupWalls: GroupWallSnapshot[] | null;
  measurementId: string | null;
  measurementSnapshot: { start: Point; end: Point } | null;
  furnitureSnapshot: FurnitureSnapshot[] | null;
  /** Computed once at drag start and reused every tick — the non-dragged
   * furniture doesn't change mid-gesture, so redoing this per mousemove was
   * pure waste (and non-trivial: each item's collision footprint is derived
   * from its library-specific shape, e.g. a curved sofa's nested geometry). */
  furnitureObstaclesSnapshot: FurnitureObstacle[] | null;
  furnitureRotateId: string | null;
  furnitureRotateStart: number | null;
  furnitureRotatePointerStart: number | null;
  lastScreen: Point;
  dragStartWorld: Point | null;
  marqueeStart: Point | null;
  marqueeCurrent: Point | null;
  marqueeAdditive: boolean;
}

const EMPTY_DRAG_STATE: DragState = {
  mode: "none",
  wallId: null,
  endpoint: null,
  openingId: null,
  groupWalls: null,
  measurementId: null,
  measurementSnapshot: null,
  furnitureSnapshot: null,
  furnitureObstaclesSnapshot: null,
  furnitureRotateId: null,
  furnitureRotateStart: null,
  furnitureRotatePointerStart: null,
  lastScreen: { x: 0, y: 0 },
  dragStartWorld: null,
  marqueeStart: null,
  marqueeCurrent: null,
  marqueeAdditive: false,
};

interface OpeningPreview {
  wallId: string;
  offset: number;
  valid: boolean;
}

function ppm(cam: CameraState) {
  return BASE_PPM * cam.zoom;
}

function worldToScreen(p: Point, cam: CameraState, size: { width: number; height: number }): Point {
  const scale = ppm(cam);
  return {
    x: size.width / 2 + cam.offsetX + p.x * scale,
    y: size.height / 2 + cam.offsetY + p.y * scale,
  };
}

function screenToWorld(p: Point, cam: CameraState, size: { width: number; height: number }): Point {
  const scale = ppm(cam);
  return {
    x: (p.x - size.width / 2 - cam.offsetX) / scale,
    y: (p.y - size.height / 2 - cam.offsetY) / scale,
  };
}

const FIT_CONTENT_MARGIN_PX = 72; // breathing room around the content so its outer walls/dimension labels aren't flush against the viewport edge

/** Centers the camera on the bounding box of every wall + furniture item, zooming to fit it all in the given viewport size (clamped to the normal zoom range). Falls back to the default centered/1x camera when there's nothing to fit. */
function fitCameraToContent(walls: Wall[], furniture: FurnitureItem[], size: { width: number; height: number }): CameraState {
  const points: Point[] = [];
  for (const w of walls) {
    points.push(w.start, w.end);
  }
  for (const f of furniture) {
    points.push(f.position);
  }
  if (points.length === 0 || size.width <= 0 || size.height <= 0) {
    return { offsetX: 0, offsetY: 0, zoom: 1 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(maxX - minX, 0.5);
  const spanY = Math.max(maxY - minY, 0.5);

  const availableWidth = Math.max(size.width - FIT_CONTENT_MARGIN_PX * 2, 40);
  const availableHeight = Math.max(size.height - FIT_CONTENT_MARGIN_PX * 2, 40);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availableWidth / (spanX * BASE_PPM), availableHeight / (spanY * BASE_PPM))));

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return { offsetX: -centerX * BASE_PPM * zoom, offsetY: -centerY * BASE_PPM * zoom, zoom };
}

function computeSnap(
  rawWorld: Point,
  walls: Wall[],
  pendingStart: Point | null,
  zoom: number,
  gridStepM: number,
  excludeWallId?: string | null,
): { point: Point; snappedToWall: boolean; anchor: MeasurementAnchor | null } {
  const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * zoom);
  let nearest: Point | null = null;
  let nearestDist = thresholdWorld;
  let nearestAnchor: MeasurementAnchor | null = null;

  for (const w of walls) {
    if (w.id === excludeWallId) continue;
    for (const [ep, t] of [
      [w.start, 0],
      [w.end, 1],
    ] as [Point, number][]) {
      const d = distance(rawWorld, ep);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = ep;
        nearestAnchor = { wallId: w.id, t, side: 0 };
      }
    }
  }

  if (nearest) return { point: nearest, snappedToWall: true, anchor: nearestAnchor };

  // magnet onto the nearest wall's centerline OR either of its two faces
  // (inner/outer edge) — lets a measurement (or a new wall) land exactly on
  // a wall's outer face, inner face, or its centerline, whichever is closest
  let nearestOnWall: Point | null = null;
  let nearestOnWallDist = thresholdWorld;
  let nearestOnWallAnchor: MeasurementAnchor | null = null;
  for (const w of walls) {
    if (w.id === excludeWallId) continue;
    const len = distance(w.start, w.end) || 1;
    const dir = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
    const normal = { x: -dir.y, y: dir.x };
    const half = w.thickness / 2;
    const lines: [Point, Point, -1 | 0 | 1][] = [
      [w.start, w.end, 0],
      [
        { x: w.start.x + normal.x * half, y: w.start.y + normal.y * half },
        { x: w.end.x + normal.x * half, y: w.end.y + normal.y * half },
        1,
      ],
      [
        { x: w.start.x - normal.x * half, y: w.start.y - normal.y * half },
        { x: w.end.x - normal.x * half, y: w.end.y - normal.y * half },
        -1,
      ],
    ];
    for (const [a, b, side] of lines) {
      const proj = projectPointOnSegment(rawWorld, a, b);
      if (proj.distance < nearestOnWallDist) {
        nearestOnWallDist = proj.distance;
        nearestOnWall = proj.point;
        nearestOnWallAnchor = { wallId: w.id, t: proj.t, side };
      }
    }
  }
  if (nearestOnWall) {
    return { point: nearestOnWall, snappedToWall: true, anchor: nearestOnWallAnchor };
  }

  if (pendingStart) {
    const angled = snapAngle(pendingStart, rawWorld, ANGLE_SNAP_STEP_DEG, ANGLE_SNAP_TOLERANCE_DEG);
    // snapAngle returns the very same object when the angle *doesn't* fall
    // within tolerance — only round the radial distance along a genuinely
    // locked direction; otherwise fall through to the free/soft-grid handling
    // below, or an arbitrary-angle segment would drift off the grid entirely.
    if (angled !== rawWorld) {
      const dist = distance(pendingStart, angled);
      if (dist === 0) return { point: pendingStart, snappedToWall: false, anchor: null };
      const roundedDist = snapValueToStep(dist, gridStepM);
      // soft snap: only pull onto the grid step when already close to it (like
      // Figma's smart guides), otherwise track the raw cursor distance exactly
      // — a coarse user-selected grid should never make dragging feel jumpy.
      const finalDist = Math.abs(dist - roundedDist) <= thresholdWorld ? roundedDist : dist;
      const dir = angleRad(pendingStart, angled);
      return {
        point: {
          x: pendingStart.x + Math.cos(dir) * finalDist,
          y: pendingStart.y + Math.sin(dir) * finalDist,
        },
        snappedToWall: false,
        anchor: null,
      };
    }
  }

  const gridPoint = snapPointToGrid(rawWorld, gridStepM);
  const onGrid = distance(rawWorld, gridPoint) <= thresholdWorld;
  return { point: onGrid ? gridPoint : rawWorld, snappedToWall: false, anchor: null };
}

/**
 * Force-locks a point to the nearest 45°/90° direction from `origin` — used
 * while Shift is held so a wall or measurement's second point can always be
 * made perfectly perpendicular/diagonal, overriding any wall-face magnetism
 * that would otherwise pull it a hair off-axis.
 */
function computeAngleLockedPoint(origin: Point, rawWorld: Point, zoom: number, gridStepM: number): Point {
  const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * zoom);
  const angled = snapAngle(origin, rawWorld, ANGLE_SNAP_STEP_DEG, 180);
  const dist = distance(origin, angled);
  if (dist === 0) return origin;
  const roundedDist = snapValueToStep(dist, gridStepM);
  const finalDist = Math.abs(dist - roundedDist) <= thresholdWorld ? roundedDist : dist;
  const dir = angleRad(origin, angled);
  return { x: origin.x + Math.cos(dir) * finalDist, y: origin.y + Math.sin(dir) * finalDist };
}

/**
 * Snap for translating a whole wall (or group): locks the drag direction to
 * the nearest 45°/90° increment first, then — if that puts a moved endpoint
 * near another wall's endpoint — snaps onto it exactly, like a magnet.
 */
function computeBodyDragSnap(
  rawDelta: Point,
  groupWalls: GroupWallSnapshot[],
  allWalls: Wall[],
  zoom: number,
  gridStepM: number,
): Point {
  const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * zoom);
  let delta = rawDelta;
  const dist = Math.hypot(rawDelta.x, rawDelta.y);
  if (dist > 1e-6) {
    const angle = Math.atan2(rawDelta.y, rawDelta.x);
    const stepRad = (ANGLE_SNAP_STEP_DEG * Math.PI) / 180;
    const snappedAngle = Math.round(angle / stepRad) * stepRad;
    const diffDeg = (Math.abs(angle - snappedAngle) * 180) / Math.PI;
    if (diffDeg <= ANGLE_SNAP_TOLERANCE_DEG) {
      delta = { x: Math.cos(snappedAngle) * dist, y: Math.sin(snappedAngle) * dist };
    }
  }
  // soft grid snap per axis — only pull onto a grid step when already close to
  // one, so a coarse user-selected grid doesn't force jumpy, coarse-only moves
  const griddedX = snapValueToStep(delta.x, gridStepM);
  const griddedY = snapValueToStep(delta.y, gridStepM);
  delta = {
    x: Math.abs(delta.x - griddedX) <= thresholdWorld ? griddedX : delta.x,
    y: Math.abs(delta.y - griddedY) <= thresholdWorld ? griddedY : delta.y,
  };

  const groupIds = new Set(groupWalls.map((g) => g.id));
  let best: { d: number; delta: Point } | null = null;
  for (const gw of groupWalls) {
    for (const ep of [gw.start, gw.end]) {
      const moved = { x: ep.x + delta.x, y: ep.y + delta.y };
      for (const w of allWalls) {
        if (groupIds.has(w.id)) continue;
        for (const target of [w.start, w.end]) {
          const d = distance(moved, target);
          if (d < thresholdWorld && (!best || d < best.d)) {
            best = { d, delta: { x: delta.x + (target.x - moved.x), y: delta.y + (target.y - moved.y) } };
          }
        }
      }
    }
  }
  if (best) delta = best.delta;

  return delta;
}

const WALL_GRAPH_CONNECT_EPS = 0.01;

/**
 * All walls transitively connected (via shared endpoints) to any wall in
 * `seedIds` — so dragging one wall of a room's outline carries its whole
 * joined structure along instead of tearing the corners apart.
 */
function findConnectedWallIds(seedIds: string[], walls: Wall[]): Set<string> {
  const result = new Set<string>(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of walls) {
      if (result.has(w.id)) continue;
      for (const otherId of result) {
        const other = walls.find((x) => x.id === otherId);
        if (!other) continue;
        const touches =
          distance(w.start, other.start) < WALL_GRAPH_CONNECT_EPS ||
          distance(w.start, other.end) < WALL_GRAPH_CONNECT_EPS ||
          distance(w.end, other.start) < WALL_GRAPH_CONNECT_EPS ||
          distance(w.end, other.end) < WALL_GRAPH_CONNECT_EPS;
        if (touches) {
          result.add(w.id);
          changed = true;
          break;
        }
      }
    }
  }
  return result;
}

function hitTestWall(point: Point, walls: Wall[]): Wall | null {
  let closest: Wall | null = null;
  let closestDist = Infinity;
  for (const w of walls) {
    const threshold = Math.max(w.thickness / 2, 0.08) + 0.08;
    const d = distanceToSegment(point, w.start, w.end);
    if (d <= threshold && d < closestDist) {
      closestDist = d;
      closest = w;
    }
  }
  return closest;
}

/** Wall whose length label (the little "X.XX m" chip at its midpoint) contains the given screen point. */
function hitTestWallLabel(
  ctx: CanvasRenderingContext2D,
  screen: Point,
  walls: Wall[],
  cam: CameraState,
  size: { width: number; height: number },
): Wall | null {
  ctx.font = "11px system-ui, sans-serif";
  for (const w of walls) {
    const mid = worldToScreen({ x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 }, cam, size);
    const labelWidth = ctx.measureText(formatLength(distance(w.start, w.end))).width;
    if (
      screen.x >= mid.x - labelWidth / 2 - 4 &&
      screen.x <= mid.x + labelWidth / 2 + 4 &&
      screen.y >= mid.y - 9 &&
      screen.y <= mid.y + 9
    ) {
      return w;
    }
  }
  return null;
}

const CHAIN_CONNECT_EPS = 0.01;

interface OverallDimension {
  start: Point;
  end: Point;
  wallIds: string[];
}

/** The floor plan's outer footprint as at most two dimension lines — overall width and overall height — spanning the bounding box of every wall's endpoints. Degenerate axes (e.g. a single straight wall has zero extent across its own direction) are omitted rather than shown as a zero-length line. */
function computeOverallDimensions(walls: Wall[]): OverallDimension[] {
  if (walls.length === 0) return [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const allWallIds = walls.map((w) => w.id);
  const dims: OverallDimension[] = [];
  if (maxX - minX > CHAIN_CONNECT_EPS) {
    // below the plan
    dims.push({ start: { x: minX, y: maxY }, end: { x: maxX, y: maxY }, wallIds: allWallIds });
  }
  if (maxY - minY > CHAIN_CONNECT_EPS) {
    // right of the plan
    dims.push({ start: { x: maxX, y: maxY }, end: { x: maxX, y: minY }, wallIds: allWallIds });
  }
  return dims;
}

/** Walls whose bounding box overlaps the world-space rectangle between p1 and p2. */
function wallsInRect(walls: Wall[], p1: Point, p2: Point): string[] {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const ids: string[] = [];
  for (const w of walls) {
    const wMinX = Math.min(w.start.x, w.end.x);
    const wMaxX = Math.max(w.start.x, w.end.x);
    const wMinY = Math.min(w.start.y, w.end.y);
    const wMaxY = Math.max(w.start.y, w.end.y);
    if (wMinX <= maxX && wMaxX >= minX && wMinY <= maxY && wMaxY >= minY) {
      ids.push(w.id);
    }
  }
  return ids;
}

/** The two endpoints of an opening's gap, projected onto its host wall's centerline. */
function openingSpan(opening: Opening, wall: Wall): { p1: Point; p2: Point; dir: Point; length: number } {
  const length = distance(wall.start, wall.end) || 0.0001;
  const dir = { x: (wall.end.x - wall.start.x) / length, y: (wall.end.y - wall.start.y) / length };
  const half = opening.width / 2;
  const p1 = {
    x: wall.start.x + dir.x * (opening.offset - half),
    y: wall.start.y + dir.y * (opening.offset - half),
  };
  const p2 = {
    x: wall.start.x + dir.x * (opening.offset + half),
    y: wall.start.y + dir.y * (opening.offset + half),
  };
  return { p1, p2, dir, length };
}

function hitTestOpening(point: Point, openings: Opening[], walls: Wall[]): Opening | null {
  let closest: Opening | null = null;
  let closestDist = Infinity;
  for (const o of openings) {
    const wall = walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const { p1, p2 } = openingSpan(o, wall);
    const threshold = Math.max(wall.thickness / 2, 0.08) + OPENING_HIT_MARGIN_M;
    const d = distanceToSegment(point, p1, p2);
    if (d <= threshold && d < closestDist) {
      closestDist = d;
      closest = o;
    }
  }
  return closest;
}

/** Openings whose gap-span bounding box overlaps the world-space rectangle between p1 and p2. */
function openingsInRect(openings: Opening[], walls: Wall[], p1: Point, p2: Point): string[] {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const ids: string[] = [];
  for (const o of openings) {
    const wall = walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const { p1: a, p2: b } = openingSpan(o, wall);
    const oMinX = Math.min(a.x, b.x);
    const oMaxX = Math.max(a.x, b.x);
    const oMinY = Math.min(a.y, b.y);
    const oMaxY = Math.max(a.y, b.y);
    if (oMinX <= maxX && oMaxX >= minX && oMinY <= maxY && oMaxY >= minY) {
      ids.push(o.id);
    }
  }
  return ids;
}

const MEASUREMENT_HIT_MARGIN_M = 0.12;

/** Resolves an anchor to its live point on the (possibly since-moved) wall, or null if the wall is gone. */
function resolveAnchor(anchor: MeasurementAnchor | null | undefined, walls: Wall[]): Point | null {
  if (!anchor) return null;
  const wall = walls.find((w) => w.id === anchor.wallId);
  if (!wall) return null;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  const normal = { x: -dir.y, y: dir.x };
  const half = (wall.thickness / 2) * anchor.side;
  return {
    x: wall.start.x + dx * anchor.t + normal.x * half,
    y: wall.start.y + dy * anchor.t + normal.y * half,
  };
}

/** A measurement's current endpoints — resolved live from its wall anchors when it has them, otherwise its stored (free) points. */
function resolveMeasurement(m: Measurement, walls: Wall[]): { start: Point; end: Point } {
  return {
    start: resolveAnchor(m.startAnchor, walls) ?? m.start,
    end: resolveAnchor(m.endAnchor, walls) ?? m.end,
  };
}

function hitTestMeasurement(point: Point, measurements: Measurement[], walls: Wall[]): Measurement | null {
  let closest: Measurement | null = null;
  let closestDist = Infinity;
  for (const m of measurements) {
    const { start, end } = resolveMeasurement(m, walls);
    const d = distanceToSegment(point, start, end);
    if (d <= MEASUREMENT_HIT_MARGIN_M && d < closestDist) {
      closestDist = d;
      closest = m;
    }
  }
  return closest;
}

/** Measurements whose bounding box overlaps the world-space rectangle between p1 and p2. */
function measurementsInRect(measurements: Measurement[], walls: Wall[], p1: Point, p2: Point): string[] {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const ids: string[] = [];
  for (const m of measurements) {
    const { start, end } = resolveMeasurement(m, walls);
    const mMinX = Math.min(start.x, end.x);
    const mMaxX = Math.max(start.x, end.x);
    const mMinY = Math.min(start.y, end.y);
    const mMaxY = Math.max(start.y, end.y);
    if (mMinX <= maxX && mMaxX >= minX && mMinY <= maxY && mMaxY >= minY) {
      ids.push(m.id);
    }
  }
  return ids;
}

/** Transforms a world point into a furniture item's own (unrotated) local frame, centered on it. */
function toFurnitureLocal(point: Point, item: FurnitureItem): Point {
  const dx = point.x - item.position.x;
  const dy = point.y - item.position.y;
  const cos = Math.cos(-item.rotation);
  const sin = Math.sin(-item.rotation);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function hitTestFurniture(point: Point, furniture: FurnitureItem[]): FurnitureItem | null {
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    const local = toFurnitureLocal(point, f);
    if (Math.abs(local.x) <= f.width / 2 && Math.abs(local.y) <= f.depth / 2) return f;
  }
  return null;
}

function hitTestCeilingLight(point: Point, lights: CeilingLight[], thresholdWorld: number): CeilingLight | null {
  for (let i = lights.length - 1; i >= 0; i--) {
    if (distance(point, lights[i].position) <= thresholdWorld) return lights[i];
  }
  return null;
}

function furnitureCorners(item: FurnitureItem): Point[] {
  const hw = item.width / 2;
  const hd = item.depth / 2;
  const cos = Math.cos(item.rotation);
  const sin = Math.sin(item.rotation);
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((p) => ({
    x: item.position.x + p.x * cos - p.y * sin,
    y: item.position.y + p.x * sin + p.y * cos,
  }));
}

interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function aabbFromCorners(corners: Point[]): Aabb {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
}

/** A wall's own axis-aligned bounding box, in world units, accounting for its thickness (not just the centerline). */
function wallAabb(wall: Wall): Aabb {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy) || 0.001;
  const nx = (-dy / len) * (wall.thickness / 2);
  const ny = (dx / len) * (wall.thickness / 2);
  return aabbFromCorners([
    { x: wall.start.x + nx, y: wall.start.y + ny },
    { x: wall.start.x - nx, y: wall.start.y - ny },
    { x: wall.end.x + nx, y: wall.end.y + ny },
    { x: wall.end.x - nx, y: wall.end.y - ny },
  ]);
}

/** A single Figma-style spacing tag: a line with end-ticks and a solid pill label, between two already-projected screen points. */
function drawSpacingTag(ctx: CanvasRenderingContext2D, p1: Point, p2: Point, label: string) {
  const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const normal = { x: -(p2.y - p1.y) / segLen, y: (p2.x - p1.x) / segLen };
  const tickLen = 5;

  ctx.strokeStyle = COLOR_SPACING;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  for (const p of [p1, p2]) {
    ctx.beginPath();
    ctx.moveTo(p.x - normal.x * tickLen, p.y - normal.y * tickLen);
    ctx.lineTo(p.x + normal.x * tickLen, p.y + normal.y * tickLen);
    ctx.stroke();
  }

  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const labelWidth = ctx.measureText(label).width;
  ctx.fillStyle = COLOR_SPACING;
  ctx.fillRect(mid.x - labelWidth / 2 - 5, mid.y - 9, labelWidth + 10, 18);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(label, mid.x, mid.y);
}

/**
 * Figma's Alt-hover gap readout: the horizontal gap only makes sense while the
 * two boxes still overlap vertically (otherwise "distance" is ambiguous — it'd
 * have to go diagonal), and vice versa for the vertical gap — so each axis is
 * shown independently, and only when that axis's boxes don't already overlap.
 */
function drawSpacingBetween(ctx: CanvasRenderingContext2D, a: Aabb, b: Aabb, cam: CameraState, size: { width: number; height: number }) {
  const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);

  if (overlapY > 0 && (a.maxX <= b.minX || b.maxX <= a.minX)) {
    const [left, right] = a.maxX <= b.minX ? [a, b] : [b, a];
    const midY = Math.max(a.minY, b.minY) + overlapY / 2;
    const p1 = worldToScreen({ x: left.maxX, y: midY }, cam, size);
    const p2 = worldToScreen({ x: right.minX, y: midY }, cam, size);
    drawSpacingTag(ctx, p1, p2, formatLength(right.minX - left.maxX));
  }

  if (overlapX > 0 && (a.maxY <= b.minY || b.maxY <= a.minY)) {
    const [top, bottom] = a.maxY <= b.minY ? [a, b] : [b, a];
    const midX = Math.max(a.minX, b.minX) + overlapX / 2;
    const p1 = worldToScreen({ x: midX, y: top.maxY }, cam, size);
    const p2 = worldToScreen({ x: midX, y: bottom.minY }, cam, size);
    drawSpacingTag(ctx, p1, p2, formatLength(bottom.minY - top.maxY));
  }
}

const FURNITURE_ROTATE_HANDLE_GAP_PX = 22;

/** World position of the little rotate-handle floating above a selected furniture item's top edge. */
function furnitureRotateHandlePos(item: FurnitureItem, zoom: number): Point {
  const gapWorld = FURNITURE_ROTATE_HANDLE_GAP_PX / (BASE_PPM * zoom);
  const localY = -item.depth / 2 - gapWorld;
  const cos = Math.cos(item.rotation);
  const sin = Math.sin(item.rotation);
  return { x: item.position.x - localY * sin, y: item.position.y + localY * cos };
}

function furnitureInRect(furniture: FurnitureItem[], p1: Point, p2: Point): string[] {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  const ids: string[] = [];
  for (const f of furniture) {
    const corners = furnitureCorners(f);
    const fMinX = Math.min(...corners.map((c) => c.x));
    const fMaxX = Math.max(...corners.map((c) => c.x));
    const fMinY = Math.min(...corners.map((c) => c.y));
    const fMaxY = Math.max(...corners.map((c) => c.y));
    if (fMinX <= maxX && fMaxX >= minX && fMinY <= maxY && fMaxY >= minY) {
      ids.push(f.id);
    }
  }
  return ids;
}

/** Nearest wall to `point` within a screen-px grab radius, plus the offset along it. */
function findWallForOpening(
  point: Point,
  walls: Wall[],
  zoom: number,
): { wall: Wall; offset: number } | null {
  const thresholdWorld = Math.max(OPENING_SNAP_PX / (BASE_PPM * zoom), 0.3);
  let best: { wall: Wall; offset: number; dist: number } | null = null;
  for (const w of walls) {
    const len = distance(w.start, w.end) || 0.0001;
    const proj = projectPointOnSegment(point, w.start, w.end);
    const threshold = Math.max(w.thickness / 2, 0.08) + thresholdWorld;
    if (proj.distance <= threshold && (!best || proj.distance < best.dist)) {
      best = { wall: w, offset: proj.t * len, dist: proj.distance };
    }
  }
  return best ? { wall: best.wall, offset: best.offset } : null;
}

function drawOpeningSymbol(
  ctx: CanvasRenderingContext2D,
  wall: Wall,
  opening: Opening,
  dir: Point,
  cam: CameraState,
  size: { width: number; height: number },
  scale: number,
  isSelected: boolean,
) {
  const half = opening.width / 2;
  const centerWorld = { x: wall.start.x + dir.x * opening.offset, y: wall.start.y + dir.y * opening.offset };
  const jamb1World = { x: centerWorld.x - dir.x * half, y: centerWorld.y - dir.y * half };
  const jamb2World = { x: centerWorld.x + dir.x * half, y: centerWorld.y + dir.y * half };
  const jamb1 = worldToScreen(jamb1World, cam, size);
  const jamb2 = worldToScreen(jamb2World, cam, size);
  const normal = { x: -dir.y, y: dir.x };

  if (opening.type === "window") {
    const color = isSelected ? COLOR_CLAY : COLOR_GLASS;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(jamb1.x, jamb1.y);
    ctx.lineTo(jamb2.x, jamb2.y);
    ctx.stroke();

    const tickLen = Math.max((wall.thickness / 2) * scale, 4);
    for (const j of [jamb1, jamb2]) {
      ctx.beginPath();
      ctx.moveTo(j.x - normal.x * tickLen, j.y - normal.y * tickLen);
      ctx.lineTo(j.x + normal.x * tickLen, j.y + normal.y * tickLen);
      ctx.stroke();
    }
  } else {
    const color = isSelected ? COLOR_CLAY : COLOR_INK_SOFT;
    const hingeWorld = opening.hingeAtEnd ? jamb2World : jamb1World;
    const swingNormal = opening.swingFlipped ? { x: -normal.x, y: -normal.y } : normal;
    const hinge = opening.hingeAtEnd ? jamb2 : jamb1;
    const other = opening.hingeAtEnd ? jamb1 : jamb2;

    const leafTipWorld = {
      x: hingeWorld.x + swingNormal.x * opening.width,
      y: hingeWorld.y + swingNormal.y * opening.width,
    };
    const leafTip = worldToScreen(leafTipWorld, cam, size);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hinge.x, hinge.y);
    ctx.lineTo(leafTip.x, leafTip.y);
    ctx.stroke();

    const radiusPx = opening.width * scale;
    const angleToTip = Math.atan2(leafTip.y - hinge.y, leafTip.x - hinge.x);
    const angleToOther = Math.atan2(other.y - hinge.y, other.x - hinge.x);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(hinge.x, hinge.y, radiusPx, Math.min(angleToTip, angleToOther), Math.max(angleToTip, angleToOther));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function Canvas2D({ readOnly = false }: { readOnly?: boolean } = {}) {
  const [editingWall, setEditingWall] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // read-only (public share link / mobile view) short-circuits every handler
  // below to pan/zoom-only — checked as a ref (not the prop directly) since
  // these handlers are native listeners registered once inside a big effect
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  const sizeRef = useRef({ width: 0, height: 0 });
  const camRef = useRef<CameraState>({ offsetX: 0, offsetY: 0, zoom: 1 });
  // Canvas2D fully remounts every time viewMode switches to "2d" (Viewport
  // only renders it while in that mode) as well as on first app load, so
  // "center on mount" alone covers both "opening a project" and "switching
  // into 2D" — this just guards against re-fitting on every later window resize.
  const hasCenteredOnMountRef = useRef(false);
  const drawRef = useRef<DrawState>({
    pendingStart: null,
    cursorWorld: null,
    snappedToWall: false,
    lengthBuffer: "",
  });
  const dragRef = useRef<DragState>({ ...EMPTY_DRAG_STATE });
  const marqueeHoverIdsRef = useRef<string[]>([]);
  const openingPreviewRef = useRef<OpeningPreview | null>(null);
  const clipboardRef = useRef<{
    walls: Wall[];
    openings: Opening[];
    measurements: Measurement[];
    furniture: FurnitureItem[];
  } | null>(null);
  const pasteCountRef = useRef(0);
  const spacePanPreviousToolRef = useRef<ToolType | null>(null);
  const dragHistoryPushedRef = useRef(false);
  const measurePreviewRef = useRef<{
    start: Point;
    end: Point;
    startMagnet: boolean;
    endMagnet: boolean;
    startAnchor: MeasurementAnchor | null;
    endAnchor: MeasurementAnchor | null;
  } | null>(null);
  const hoveredHandleRef = useRef<{ kind: "wall" | "measure"; id: string; endpoint: "start" | "end" } | null>(null);
  // screen-space point of an active Shift-angle-lock, drawn as a magnet ring
  // so locking a wall/measurement endpoint to 45/90° gives the same visual
  // "caught on something" feedback as snapping onto a wall or corner does
  const dragLockIndicatorRef = useRef<Point | null>(null);
  // world-space point the pending furniture item would land on if clicked right now
  const furniturePreviewRef = useRef<Point | null>(null);
  // live position+heading while dragging with the "walkStart" tool — committed to the store on mouseup
  const walkStartPreviewRef = useRef<WalkthroughStart | null>(null);

  const walls = useDesignStore((s) => s.walls);
  const wallsRef = useRef<Wall[]>(walls);
  const openings = useDesignStore((s) => s.openings);
  const openingsRef = useRef<Opening[]>(openings);
  const measurements = useDesignStore((s) => s.measurements);
  const measurementsRef = useRef<Measurement[]>(measurements);
  const furniture = useDesignStore((s) => s.furniture);
  const furnitureRef = useRef<FurnitureItem[]>(furniture);
  const viewCenterRequest = useDesignStore((s) => s.viewCenterRequest);
  // captures the value seen on mount so the effect below only reacts to a
  // *later* bump (an explicit project load or the "center view" button) —
  // never on initial mount, when sizeRef hasn't been measured by the resize
  // effect yet and every wall/furniture ref is still at its initial value anyway
  const viewCenterRequestSeenRef = useRef(viewCenterRequest);
  const pendingFurniture = useDesignStore((s) => s.pendingFurniture);
  const pendingFurnitureRef = useRef(pendingFurniture);
  const activeTool = useDesignStore((s) => s.activeTool);
  const activeToolRef = useRef(activeTool);
  const selectedIds = useDesignStore((s) => s.selectedIds);
  const selectedIdsRef = useRef(selectedIds);
  const lastWallThickness = useDesignStore((s) => s.lastWallThickness);
  const lastWallThicknessRef = useRef(lastWallThickness);
  const gridSizeM = useDesignStore((s) => s.gridSizeM);
  const gridSizeMRef = useRef(gridSizeM);
  const showOverallDimensions = useDesignStore((s) => s.showOverallDimensions);
  const showOverallDimensionsRef = useRef(showOverallDimensions);
  const roomFloors = useDesignStore((s) => s.roomFloors);
  const roomFloorsRef = useRef(roomFloors);
  const selectedRoomKey = useDesignStore((s) => s.selectedRoomKey);
  const selectedRoomKeyRef = useRef(selectedRoomKey);
  const walkthroughStart = useDesignStore((s) => s.walkthroughStart);
  const walkthroughStartRef = useRef(walkthroughStart);
  const ceilingLights = useDesignStore((s) => s.ceilingLights);
  const ceilingLightsRef = useRef(ceilingLights);
  // detected rooms only need recomputing when the wall layout actually
  // changes, not on every render() call (panning, dragging furniture, etc.)
  const roomsRef = useRef<DetectedRoom[]>([]);
  const roomFloorPolygonsRef = useRef<DetectedRoom[]>([]);
  const doorPatchesRef = useRef<DoorThresholdPatch[]>([]);
  const hoveredRoomKeyRef = useRef<string | null>(null);
  // Alt-hover spacing readout (Figma-style): which furniture/wall the cursor is over
  // while Alt is held and a single furniture item is selected — cleared whenever
  // either condition stops holding, so the overlay only ever shows a real gap
  const altSpacingHoverRef = useRef<{ selectedId: string; targetKind: "furniture" | "wall"; targetId: string } | null>(null);
  const roomImageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // both are pure functions of `walls` alone, but render() runs on essentially
  // every mousemove (panning, any drag, hover) — recomputing an O(wallCount²)
  // joint/chain scan that often was measurable jank on larger plans, so these
  // cache the result and only redo the scan when the wall layout itself changes
  const cornerPatchesRef = useRef<ReturnType<typeof computeCornerPatches>>(computeCornerPatches(walls));
  const overallDimensionsRef = useRef<OverallDimension[]>(computeOverallDimensions(walls));

  // reads walls/openings from refs (not the reactive walls/openings above) so
  // it can be called both from the sync effect below and from a drag-end
  // handler without going stale — see the effect's comment for why this is
  // skipped during a live wall/opening drag instead of run on every tick
  const recomputeRoomsData = useCallback(() => {
    roomsRef.current = computeRooms(wallsRef.current);
    roomFloorPolygonsRef.current = computeRoomFloorPolygons(wallsRef.current, roomsRef.current);
    doorPatchesRef.current = computeDoorThresholdPatches(roomsRef.current, wallsRef.current, openingsRef.current);
  }, []);

  const addWall = useDesignStore((s) => s.addWall);
  const updateWall = useDesignStore((s) => s.updateWall);
  const addOpening = useDesignStore((s) => s.addOpening);
  const updateOpening = useDesignStore((s) => s.updateOpening);
  const addMeasurement = useDesignStore((s) => s.addMeasurement);
  const updateMeasurement = useDesignStore((s) => s.updateMeasurement);
  const addFurniture = useDesignStore((s) => s.addFurniture);
  const updateFurniture = useDesignStore((s) => s.updateFurniture);
  const setPendingFurniture = useDesignStore((s) => s.setPendingFurniture);
  const setSelectedRoomKey = useDesignStore((s) => s.setSelectedRoomKey);
  const setWalkthroughStart = useDesignStore((s) => s.setWalkthroughStart);
  const addCeilingLight = useDesignStore((s) => s.addCeilingLight);
  const removeElements = useDesignStore((s) => s.removeElements);
  const setSelection = useDesignStore((s) => s.setSelection);
  const toggleSelection = useDesignStore((s) => s.toggleSelection);
  const clearSelection = useDesignStore((s) => s.clearSelection);
  const setActiveTool = useDesignStore((s) => s.setActiveTool);
  const pushHistory = useDesignStore((s) => s.pushHistory);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const { width, height } = sizeRef.current;
    const cam = camRef.current;
    const scale = ppm(cam);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, width, height);

    // --- grid ---
    const originX = width / 2 + cam.offsetX;
    const originY = height / 2 + cam.offsetY;
    const minorPx = (gridSizeMRef.current / 2) * scale;
    const majorPx = gridSizeMRef.current * scale;

    if (minorPx > 4) {
      ctx.strokeStyle = COLOR_GRID_MINOR;
      ctx.lineWidth = 1;
      for (let x = originX % minorPx; x < width; x += minorPx) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = originY % minorPx; y < height; y += minorPx) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = COLOR_GRID_MAJOR;
    ctx.lineWidth = 1;
    for (let x = originX % majorPx; x < width; x += majorPx) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = originY % majorPx; y < height; y += majorPx) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = COLOR_AXIS;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(originX - 8, originY);
    ctx.lineTo(originX + 8, originY);
    ctx.moveTo(originX, originY - 8);
    ctx.lineTo(originX, originY + 8);
    ctx.stroke();

    // --- room floor patterns (clipped to each detected room's interior) ---
    const floorToolActive = activeToolRef.current === "floor";
    const fillPatternInWorldPolygon = (worldPoints: Point[], roomFloor: RoomFloor) => {
      let img = roomImageCacheRef.current.get(roomFloor.textureDataUrl);
      if (!img) {
        img = new Image();
        img.src = roomFloor.textureDataUrl;
        img.onload = () => render();
        roomImageCacheRef.current.set(roomFloor.textureDataUrl, img);
      }
      if (!img.complete || img.naturalWidth <= 0) return;
      const pattern = ctx.createPattern(img, "repeat");
      if (!pattern) return;
      const patternScaleX = (roomFloor.tileSizeM * scale) / img.naturalWidth;
      const patternScaleY = (roomFloor.tileSizeM * scale) / img.naturalHeight;
      // anchor the pattern's phase to world (0,0), not canvas (0,0) — so it
      // pans/zooms in lockstep with the room shape (and stays continuous
      // across door-threshold patches) instead of the tiles appearing to
      // slide underneath it as the camera moves
      const worldOrigin = worldToScreen({ x: 0, y: 0 }, cam, { width, height });
      pattern.setTransform(new DOMMatrix().translate(worldOrigin.x, worldOrigin.y).scale(patternScaleX, patternScaleY));
      const screenPoints = worldPoints.map((p) => worldToScreen(p, cam, { width, height }));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (const p of screenPoints.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    };

    for (const room of roomsRef.current) {
      const screenPoints = room.polygon.map((p) => worldToScreen(p, cam, { width, height }));
      const roomFloor = roomFloorsRef.current.find((rf) => rf.key === room.key);

      if (roomFloor) {
        // the dilated polygon (not room.polygon) closes hairline gaps at
        // wall corners/junctions that the detection grid's resolution can
        // leave uncovered — see computeRoomFloorPolygons in roomDetection.ts
        const floorPolygon = roomFloorPolygonsRef.current.find((r) => r.key === room.key)?.polygon ?? room.polygon;
        fillPatternInWorldPolygon(floorPolygon, roomFloor);
        // door-threshold patches fill the wall-thickness gap at each doorway
        // that no room polygon covers on its own (see roomDetection.ts)
        for (const patch of doorPatchesRef.current) {
          if (patch.roomKey === room.key) fillPatternInWorldPolygon(patch.polygon, roomFloor);
        }
      }

      if (floorToolActive && (hoveredRoomKeyRef.current === room.key || selectedRoomKeyRef.current === room.key)) {
        const isSelected = selectedRoomKeyRef.current === room.key;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
        for (const p of screenPoints.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        if (!roomFloor) {
          ctx.fillStyle = isSelected ? "rgba(171,90,56,0.14)" : "rgba(95,122,84,0.12)";
          ctx.fill();
        }
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.strokeStyle = isSelected ? COLOR_CLAY : COLOR_SAGE;
        ctx.setLineDash(isSelected ? [] : [6, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // --- committed walls ---
    const selectedIdsNow = selectedIdsRef.current;
    const marqueeHoverIds = marqueeHoverIdsRef.current;

    // corner patches first (underneath), so wall strokes draw crisply on top —
    // only the sliver that closes the joint gap peeks out from beneath them
    for (const patch of cornerPatchesRef.current) {
      const isSelected = patch.wallIds.some((id) => selectedIdsNow.includes(id) || marqueeHoverIds.includes(id));
      const screenPoints = patch.points.map((p) => worldToScreen(p, cam, { width, height }));
      ctx.fillStyle = isSelected ? COLOR_CLAY : COLOR_INK;
      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (const p of screenPoints.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();
    }

    for (const wall of wallsRef.current) {
      const a = worldToScreen(wall.start, cam, { width, height });
      const b = worldToScreen(wall.end, cam, { width, height });
      const isSelected = selectedIdsNow.includes(wall.id) || marqueeHoverIds.includes(wall.id);

      const wallLen = distance(wall.start, wall.end) || 0.0001;
      const wallDir = { x: (wall.end.x - wall.start.x) / wallLen, y: (wall.end.y - wall.start.y) / wallLen };
      const wallOpenings = openingsRef.current
        .filter((o) => o.wallId === wall.id)
        .sort((o1, o2) => o1.offset - o2.offset);

      // The wall's own segments span exactly [0, wallLen] — its true nominal
      // length, matching the dimension label below. Corner gaps are closed
      // separately by the mitered patches drawn above, so this never
      // inflates the wall's own length.
      const solidSegments: [number, number][] = [];
      let segCursor = 0;
      for (const o of wallOpenings) {
        const gapStart = Math.max(0, o.offset - o.width / 2);
        const gapEnd = Math.min(wallLen, o.offset + o.width / 2);
        if (gapStart > segCursor) solidSegments.push([segCursor, gapStart]);
        segCursor = Math.max(segCursor, gapEnd);
      }
      if (segCursor < wallLen) solidSegments.push([segCursor, wallLen]);

      ctx.lineCap = "butt";
      ctx.lineWidth = Math.max(wall.thickness * scale, 2);
      ctx.strokeStyle = isSelected ? COLOR_CLAY : COLOR_INK;
      for (const [t0, t1] of solidSegments) {
        const p0 = worldToScreen({ x: wall.start.x + wallDir.x * t0, y: wall.start.y + wallDir.y * t0 }, cam, { width, height });
        const p1 = worldToScreen({ x: wall.start.x + wallDir.x * t1, y: wall.start.y + wallDir.y * t1 }, cam, { width, height });
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }

      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const lengthM = distance(wall.start, wall.end);
      const label = formatLength(lengthM);
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelWidth = ctx.measureText(label).width;
      ctx.fillStyle = COLOR_PAPER;
      ctx.fillRect(mid.x - labelWidth / 2 - 4, mid.y - 9, labelWidth + 8, 18);
      ctx.fillStyle = isSelected ? COLOR_CLAY_DARK : COLOR_INK_SOFT;
      ctx.fillText(label, mid.x, mid.y);

      if (isSelected) {
        for (const [ep, endpoint] of [
          [a, "start"],
          [b, "end"],
        ] as [Point, "start" | "end"][]) {
          const hovered =
            hoveredHandleRef.current?.kind === "wall" &&
            hoveredHandleRef.current.id === wall.id &&
            hoveredHandleRef.current.endpoint === endpoint;
          ctx.beginPath();
          ctx.arc(ep.x, ep.y, hovered ? 7 : 5.5, 0, Math.PI * 2);
          ctx.fillStyle = COLOR_HANDLE;
          ctx.fill();
          ctx.lineWidth = hovered ? 2 : 1.5;
          ctx.strokeStyle = COLOR_PAPER;
          ctx.stroke();
        }
      }

      for (const o of wallOpenings) {
        const isOpeningSelected = selectedIdsNow.includes(o.id) || marqueeHoverIds.includes(o.id);
        drawOpeningSymbol(ctx, wall, o, wallDir, cam, { width, height }, scale, isOpeningSelected);
      }
    }

    // --- furniture (top-down silhouettes, drawn on top of the floor/walls) ---
    for (const item of furnitureRef.current) {
      const isSelected = selectedIdsNow.includes(item.id) || marqueeHoverIds.includes(item.id);
      const center = worldToScreen(item.position, cam, { width, height });
      const w = item.width * scale;
      const d = item.depth * scale;

      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(item.rotation);
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = item.color;
      ctx.fillRect(-w / 2, -d / 2, w, d);
      ctx.globalAlpha = 1;
      ctx.lineWidth = isSelected ? 2.5 : 1.25;
      ctx.strokeStyle = isSelected ? COLOR_CLAY : COLOR_INK_SOFT;
      ctx.strokeRect(-w / 2, -d / 2, w, d);

      // front-facing chevron — local +Y (the "south" edge at rotation 0), matching
      // the same local-+Z convention every 3D model's own front-facing details
      // (screens, door handles, control panels) are built against, so front/back
      // reads at a glance in the 2D plan without needing to select the item first
      if (Math.min(w, d) > 22) {
        const chevronSize = Math.min(d * 0.2, w * 0.5, 11);
        const tipY = d / 2 - chevronSize * 0.6;
        ctx.beginPath();
        ctx.moveTo(-chevronSize * 0.55, tipY - chevronSize * 0.6);
        ctx.lineTo(0, tipY);
        ctx.lineTo(chevronSize * 0.55, tipY - chevronSize * 0.6);
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.strokeStyle = isSelected ? COLOR_CLAY : COLOR_INK_SOFT;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.stroke();
      }
      ctx.restore();

      // label stays upright regardless of the item's rotation, for legibility
      if (Math.min(w, d) > 30) {
        ctx.font = "10.5px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = isSelected ? COLOR_CLAY_DARK : COLOR_PAPER;
        ctx.fillText(item.label, center.x, center.y);
      }

      // dimensions pill — only for a selected item, like the wall length chip
      if (isSelected) {
        const bottomLocal = { x: 0, y: item.depth / 2 };
        const bottomWorld = {
          x: item.position.x + bottomLocal.x * Math.cos(item.rotation) - bottomLocal.y * Math.sin(item.rotation),
          y: item.position.y + bottomLocal.x * Math.sin(item.rotation) + bottomLocal.y * Math.cos(item.rotation),
        };
        const bottomScreen = worldToScreen(bottomWorld, cam, { width, height });
        const dimsLabel = `${Math.round(item.width * 100)} × ${Math.round(item.depth * 100)} cm`;
        const labelPos = { x: bottomScreen.x, y: bottomScreen.y + 14 };
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const dimsWidth = ctx.measureText(dimsLabel).width;
        ctx.fillStyle = COLOR_PAPER;
        ctx.fillRect(labelPos.x - dimsWidth / 2 - 4, labelPos.y - 9, dimsWidth + 8, 18);
        ctx.fillStyle = COLOR_CLAY_DARK;
        ctx.fillText(dimsLabel, labelPos.x, labelPos.y);
      }

      // rotate handle — only for a single selected item, like Figma's corner-rotate affordance
      if (isSelected && selectedIdsNow.length === 1 && selectedIdsNow[0] === item.id) {
        const topLocal = { x: 0, y: -item.depth / 2 };
        const topWorld = {
          x: item.position.x + topLocal.x * Math.cos(item.rotation) - topLocal.y * Math.sin(item.rotation),
          y: item.position.y + topLocal.x * Math.sin(item.rotation) + topLocal.y * Math.cos(item.rotation),
        };
        const topScreen = worldToScreen(topWorld, cam, { width, height });
        const handleWorld = furnitureRotateHandlePos(item, cam.zoom);
        const handleScreen = worldToScreen(handleWorld, cam, { width, height });

        ctx.strokeStyle = COLOR_HANDLE;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(topScreen.x, topScreen.y);
        ctx.lineTo(handleScreen.x, handleScreen.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(handleScreen.x, handleScreen.y, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = COLOR_HANDLE;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = COLOR_PAPER;
        ctx.stroke();
      }
    }

    // --- Alt-hover spacing readout (Figma-style gap between the selected item and whatever's under the cursor) ---
    if (altSpacingHoverRef.current) {
      const hover = altSpacingHoverRef.current;
      const selected = furnitureRef.current.find((f) => f.id === hover.selectedId);
      const targetAabb =
        hover.targetKind === "furniture"
          ? (() => {
              const target = furnitureRef.current.find((f) => f.id === hover.targetId);
              return target ? aabbFromCorners(furnitureCorners(target)) : null;
            })()
          : (() => {
              const wall = wallsRef.current.find((w) => w.id === hover.targetId);
              return wall ? wallAabb(wall) : null;
            })();
      if (selected && targetAabb) {
        drawSpacingBetween(ctx, aabbFromCorners(furnitureCorners(selected)), targetAabb, cam, { width, height });
      }
    }

    // --- furniture placement ghost preview (before the click that drops it) ---
    if (activeToolRef.current === "furniture" && pendingFurnitureRef.current && furniturePreviewRef.current) {
      const pending = pendingFurnitureRef.current;
      const p = furniturePreviewRef.current;
      const center = worldToScreen(p, cam, { width, height });
      const w = pending.width * scale;
      const d = pending.depth * scale;
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = pending.color;
      ctx.fillRect(-w / 2, -d / 2, w, d);
      ctx.globalAlpha = 1;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLOR_CLAY;
      ctx.strokeRect(-w / 2, -d / 2, w, d);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // --- overall dimensions across straight runs of connected walls ---
    if (showOverallDimensionsRef.current) {
      for (const dim of overallDimensionsRef.current) {
        const a = worldToScreen(dim.start, cam, { width, height });
        const b = worldToScreen(dim.end, cam, { width, height });
        const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const normal = { x: -(b.y - a.y) / segLen, y: (b.x - a.x) / segLen };
        const offsetPx = 26;
        const oa = { x: a.x + normal.x * offsetPx, y: a.y + normal.y * offsetPx };
        const ob = { x: b.x + normal.x * offsetPx, y: b.y + normal.y * offsetPx };
        const tickLen = 6;

        ctx.strokeStyle = COLOR_INK_SOFT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(oa.x, oa.y);
        ctx.lineTo(ob.x, ob.y);
        ctx.stroke();

        for (const p of [oa, ob]) {
          ctx.beginPath();
          ctx.moveTo(p.x - normal.x * tickLen, p.y - normal.y * tickLen);
          ctx.lineTo(p.x + normal.x * tickLen, p.y + normal.y * tickLen);
          ctx.stroke();
        }

        const mid = { x: (oa.x + ob.x) / 2, y: (oa.y + ob.y) / 2 };
        const label = formatLength(distance(dim.start, dim.end));
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const labelWidth = ctx.measureText(label).width;
        ctx.fillStyle = COLOR_PAPER;
        ctx.fillRect(mid.x - labelWidth / 2 - 4, mid.y - 9, labelWidth + 8, 18);
        ctx.fillStyle = COLOR_INK_SOFT;
        ctx.fillText(label, mid.x, mid.y);
      }
    }

    // --- door/window placement preview ---
    if ((activeToolRef.current === "door" || activeToolRef.current === "window") && openingPreviewRef.current) {
      const preview = openingPreviewRef.current;
      const wall = wallsRef.current.find((w) => w.id === preview.wallId);
      if (wall) {
        const wallLen = distance(wall.start, wall.end) || 0.0001;
        const dir = { x: (wall.end.x - wall.start.x) / wallLen, y: (wall.end.y - wall.start.y) / wallLen };
        const openingWidth = activeToolRef.current === "door" ? DOOR_DEFAULT_WIDTH : WINDOW_DEFAULT_WIDTH;
        const half = openingWidth / 2;
        const centerWorld = { x: wall.start.x + dir.x * preview.offset, y: wall.start.y + dir.y * preview.offset };
        const p1 = worldToScreen({ x: centerWorld.x - dir.x * half, y: centerWorld.y - dir.y * half }, cam, { width, height });
        const p2 = worldToScreen({ x: centerWorld.x + dir.x * half, y: centerWorld.y + dir.y * half }, cam, { width, height });

        ctx.strokeStyle = preview.valid ? COLOR_SAGE : COLOR_BRICK;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    // --- committed measurements ("Kóty") ---
    for (const m of measurementsRef.current) {
      const isSelected = selectedIdsNow.includes(m.id) || marqueeHoverIds.includes(m.id);
      const live = resolveMeasurement(m, wallsRef.current);
      const a = worldToScreen(live.start, cam, { width, height });
      const b = worldToScreen(live.end, cam, { width, height });
      const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const normal = { x: -(b.y - a.y) / segLen, y: (b.x - a.x) / segLen };
      const tickLen = 6;
      const color = isSelected ? COLOR_CLAY : COLOR_BRASS;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.moveTo(p.x - normal.x * tickLen, p.y - normal.y * tickLen);
        ctx.lineTo(p.x + normal.x * tickLen, p.y + normal.y * tickLen);
        ctx.stroke();
      }

      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const label = formatLength(distance(live.start, live.end));
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelWidth = ctx.measureText(label).width;
      ctx.fillStyle = COLOR_PAPER;
      ctx.fillRect(mid.x - labelWidth / 2 - 4, mid.y - 9, labelWidth + 8, 18);
      ctx.fillStyle = isSelected ? COLOR_CLAY_DARK : COLOR_BRASS_DARK;
      ctx.fillText(label, mid.x, mid.y);

      if (isSelected) {
        for (const [ep, endpoint] of [
          [a, "start"],
          [b, "end"],
        ] as [Point, "start" | "end"][]) {
          const hovered =
            hoveredHandleRef.current?.kind === "measure" &&
            hoveredHandleRef.current.id === m.id &&
            hoveredHandleRef.current.endpoint === endpoint;
          ctx.beginPath();
          ctx.arc(ep.x, ep.y, hovered ? 7 : 5.5, 0, Math.PI * 2);
          ctx.fillStyle = COLOR_HANDLE;
          ctx.fill();
          ctx.lineWidth = hovered ? 2 : 1.5;
          ctx.strokeStyle = COLOR_PAPER;
          ctx.stroke();
        }
      }
    }

    // --- measure tool live preview ---
    if (activeToolRef.current === "measure" && measurePreviewRef.current) {
      const { start, end, startMagnet, endMagnet } = measurePreviewRef.current;
      const a = worldToScreen(start, cam, { width, height });
      const b = worldToScreen(end, cam, { width, height });
      const lengthM = distance(start, end);

      if (lengthM > 0.001) {
        ctx.strokeStyle = COLOR_BRASS;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const label = formatLength(lengthM);
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const labelWidth = ctx.measureText(label).width;
        ctx.fillStyle = COLOR_PAPER;
        ctx.fillRect(mid.x - labelWidth / 2 - 4, mid.y - 9, labelWidth + 8, 18);
        ctx.fillStyle = COLOR_BRASS_DARK;
        ctx.fillText(label, mid.x, mid.y);
      }

      // magnet indicator — a ring around whichever end is currently attached
      // to a wall (corner or face), so it's clear where a click will land
      for (const [p, isMagnet] of [
        [a, startMagnet],
        [b, endMagnet],
      ] as [Point, boolean][]) {
        if (!isMagnet) continue;
        ctx.strokeStyle = COLOR_HANDLE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- in-progress wall chain ---
    const draw = drawRef.current;
    // before the first point is placed, there's no chain to preview yet, but
    // the cursor can still be magnetized onto an existing wall — show that
    // same ring immediately, so it's clear where the wall's *start* will land
    if (activeToolRef.current === "wall" && !draw.pendingStart && draw.cursorWorld && draw.snappedToWall) {
      const p = worldToScreen(draw.cursorWorld, cam, { width, height });
      ctx.strokeStyle = COLOR_HANDLE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (activeToolRef.current === "wall" && draw.pendingStart && draw.cursorWorld) {
      const a = worldToScreen(draw.pendingStart, cam, { width, height });
      const b = worldToScreen(draw.cursorWorld, cam, { width, height });

      ctx.strokeStyle = COLOR_CLAY;
      ctx.lineWidth = Math.max(lastWallThicknessRef.current * scale, 2);
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = COLOR_CLAY;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.fill();

      if (draw.snappedToWall) {
        // same magnet-ring style as the measurement tool's, for the same meaning: this endpoint is attached to another wall
        ctx.strokeStyle = COLOR_HANDLE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      const lengthM = distance(draw.pendingStart, draw.cursorWorld);
      const label = draw.lengthBuffer ? `${draw.lengthBuffer} m` : formatLength(lengthM);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 14 };
      ctx.font = "12px system-ui, sans-serif";
      const labelWidth = ctx.measureText(label).width;
      ctx.fillStyle = COLOR_INK;
      ctx.fillRect(mid.x - labelWidth / 2 - 5, mid.y - 10, labelWidth + 10, 20);
      ctx.fillStyle = COLOR_PAPER;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, mid.x, mid.y);
    }

    // --- Shift angle-lock magnet indicator (wall/measurement endpoint drags) ---
    if (dragLockIndicatorRef.current) {
      const p = worldToScreen(dragLockIndicatorRef.current, cam, { width, height });
      ctx.strokeStyle = COLOR_HANDLE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- marquee selection rectangle ---
    const drag = dragRef.current;
    if (drag.mode === "marquee" && drag.marqueeStart && drag.marqueeCurrent) {
      const x0 = Math.min(drag.marqueeStart.x, drag.marqueeCurrent.x);
      const y0 = Math.min(drag.marqueeStart.y, drag.marqueeCurrent.y);
      const rectW = Math.abs(drag.marqueeCurrent.x - drag.marqueeStart.x);
      const rectH = Math.abs(drag.marqueeCurrent.y - drag.marqueeStart.y);

      ctx.fillStyle = "rgba(171, 90, 56, 0.1)";
      ctx.fillRect(x0, y0, rectW, rectH);
      ctx.strokeStyle = COLOR_CLAY;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x0, y0, rectW, rectH);
      ctx.setLineDash([]);
    }

    // --- walkthrough start marker: position + facing direction, always
    // visible once set; while actively dragging it, show the live preview
    // (same point, live heading) instead of the last-committed one ---
    const walkStart = dragRef.current.mode === "walk-start" ? walkStartPreviewRef.current : walkthroughStartRef.current;
    if (walkStart) {
      const p = worldToScreen(walkStart, cam, { width, height });
      const dirLen = 24;
      const tip = { x: p.x + Math.cos(walkStart.heading) * dirLen, y: p.y + Math.sin(walkStart.heading) * dirLen };

      ctx.strokeStyle = COLOR_SAGE;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();

      const headAngle = Math.PI / 7;
      const headLen = 8;
      ctx.fillStyle = COLOR_SAGE;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - headLen * Math.cos(walkStart.heading - headAngle), tip.y - headLen * Math.sin(walkStart.heading - headAngle));
      ctx.lineTo(tip.x - headLen * Math.cos(walkStart.heading + headAngle), tip.y - headLen * Math.sin(walkStart.heading + headAngle));
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = COLOR_PAPER;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLOR_SAGE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- ceiling lights: a plain bulb marker, since it's mounted overhead
    // rather than sitting on the floor like furniture — real fixture models
    // come later, this is just "there's a light here" ---
    for (const light of ceilingLightsRef.current) {
      const isSelected = selectedIdsNow.includes(light.id) || marqueeHoverIds.includes(light.id);
      const p = worldToScreen(light.position, cam, { width, height });
      ctx.fillStyle = isSelected ? COLOR_CLAY : "#e8b84b";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isSelected ? COLOR_CLAY : "#a97e1f";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // filament cross, so it reads as a bulb rather than a plain dot
      ctx.strokeStyle = COLOR_PAPER;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - 2.5, p.y - 2.5);
      ctx.lineTo(p.x + 2.5, p.y + 2.5);
      ctx.moveTo(p.x + 2.5, p.y - 2.5);
      ctx.lineTo(p.x - 2.5, p.y + 2.5);
      ctx.stroke();
    }
  }, []);

  // keep refs in sync with reactive state + redraw when they change
  useEffect(() => {
    wallsRef.current = walls;
    // a live wall/opening drag replaces this array on every mousemove tick (up
    // to ~60/sec) — computeRooms's grid flood-fill (run twice over, for the
    // canonical and dilated-floor passes) is too expensive to redo that often,
    // so mid-drag this only keeps the wall/opening refs (and the cheap line
    // redraw) current; recomputeRoomsData() below runs once the gesture ends
    const dragMode = dragRef.current.mode;
    if (dragMode === "wall-body" || dragMode === "wall-endpoint" || dragMode === "opening") {
      render();
      return;
    }
    recomputeRoomsData();
    render();
    // recomputeRoomsData reads walls/openings via refs that this same effect
    // keeps in sync, so it isn't a meaningful dependency of its own
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walls, openings, render]);

  useEffect(() => {
    roomFloorsRef.current = roomFloors;
    render();
  }, [roomFloors, render]);

  useEffect(() => {
    selectedRoomKeyRef.current = selectedRoomKey;
    render();
  }, [selectedRoomKey, render]);

  useEffect(() => {
    walkthroughStartRef.current = walkthroughStart;
    render();
  }, [walkthroughStart, render]);

  useEffect(() => {
    ceilingLightsRef.current = ceilingLights;
    render();
  }, [ceilingLights, render]);

  // walls-only (openings don't affect either computation), and deliberately
  // NOT gated behind the wall-drag skip in the room-data effect above — these
  // two are cheap enough on their own that live-updating them during a drag
  // is worth it for the corner-fill/dimension-label visuals to track the cursor
  useEffect(() => {
    cornerPatchesRef.current = computeCornerPatches(walls);
    overallDimensionsRef.current = computeOverallDimensions(walls);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walls]);

  // keep anchored measurements glued to their wall as it moves/resizes, so
  // the shown value always matches the current, not the drawn-at, distance
  useEffect(() => {
    for (const m of measurements) {
      const patch: Partial<Measurement> = {};
      const liveStart = resolveAnchor(m.startAnchor, walls);
      if (liveStart && (liveStart.x !== m.start.x || liveStart.y !== m.start.y)) {
        patch.start = liveStart;
      }
      const liveEnd = resolveAnchor(m.endAnchor, walls);
      if (liveEnd && (liveEnd.x !== m.end.x || liveEnd.y !== m.end.y)) {
        patch.end = liveEnd;
      }
      if (Object.keys(patch).length > 0) updateMeasurement(m.id, patch);
    }
    // only re-sync when the walls themselves change — re-running this on every
    // `measurements` change too would be redundant (nothing to sync there)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walls]);

  useEffect(() => {
    openingsRef.current = openings;
    render();
  }, [openings, render]);

  useEffect(() => {
    measurementsRef.current = measurements;
    render();
  }, [measurements, render]);

  useEffect(() => {
    furnitureRef.current = furniture;
    render();
  }, [furniture, render]);

  useEffect(() => {
    if (viewCenterRequest === viewCenterRequestSeenRef.current) return;
    viewCenterRequestSeenRef.current = viewCenterRequest;
    camRef.current = fitCameraToContent(wallsRef.current, furnitureRef.current, sizeRef.current);
    render();
  }, [viewCenterRequest, render]);

  useEffect(() => {
    pendingFurnitureRef.current = pendingFurniture;
  }, [pendingFurniture]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
    render();
  }, [selectedIds, render]);

  useEffect(() => {
    lastWallThicknessRef.current = lastWallThickness;
  }, [lastWallThickness]);

  useEffect(() => {
    gridSizeMRef.current = gridSizeM;
    render();
  }, [gridSizeM, render]);

  useEffect(() => {
    showOverallDimensionsRef.current = showOverallDimensions;
    render();
  }, [showOverallDimensions, render]);

  useEffect(() => {
    activeToolRef.current = activeTool;
    if (activeTool !== "wall") {
      drawRef.current.pendingStart = null;
      drawRef.current.lengthBuffer = "";
    }
    if (activeTool !== "door" && activeTool !== "window") {
      openingPreviewRef.current = null;
    }
    if (activeTool !== "measure") {
      measurePreviewRef.current = null;
    }
    if (activeTool !== "furniture") {
      furniturePreviewRef.current = null;
      setPendingFurniture(null);
    }
    if (activeTool !== "floor") {
      hoveredRoomKeyRef.current = null;
      setSelectedRoomKey(null);
    }
    render();
  }, [activeTool, render, setPendingFurniture, setSelectedRoomKey]);

  // resize handling
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = container.clientWidth;
      const height = container.clientHeight;
      sizeRef.current = { width, height };
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!hasCenteredOnMountRef.current) {
        hasCenteredOnMountRef.current = true;
        camRef.current = fitCameraToContent(wallsRef.current, furnitureRef.current, sizeRef.current);
      }
      render();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [render]);

  // mouse + keyboard interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getScreenPoint = (e: MouseEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const commitSegment = (start: Point, end: Point) => {
      if (distance(start, end) < MIN_SEGMENT_LENGTH_M) return;
      pushHistory();
      addWall({
        start,
        end,
        thickness: lastWallThicknessRef.current,
        height: DEFAULT_WALL_HEIGHT,
      });
    };

    /** Clones the given walls (+ any of their openings) offset by (dx, dy), selecting the new copies. */
    const cloneWithOffset = (
      sourceWalls: Wall[],
      sourceOpenings: Opening[],
      sourceMeasurements: Measurement[],
      sourceFurniture: FurnitureItem[],
      dx: number,
      dy: number,
    ) => {
      if (sourceWalls.length === 0 && sourceMeasurements.length === 0 && sourceFurniture.length === 0) return;
      pushHistory();
      const idMap = new Map<string, string>();
      const newIds: string[] = [];
      for (const w of sourceWalls) {
        const newId = addWall({
          start: { x: w.start.x + dx, y: w.start.y + dy },
          end: { x: w.end.x + dx, y: w.end.y + dy },
          thickness: w.thickness,
          height: w.height,
        });
        idMap.set(w.id, newId);
        newIds.push(newId);
      }
      for (const o of sourceOpenings) {
        const newWallId = idMap.get(o.wallId);
        if (!newWallId) continue;
        const newId = addOpening({
          wallId: newWallId,
          type: o.type,
          offset: o.offset,
          width: o.width,
          height: o.height,
          sillHeight: o.sillHeight,
          hingeAtEnd: o.hingeAtEnd,
          swingFlipped: o.swingFlipped,
        });
        newIds.push(newId);
      }
      for (const m of sourceMeasurements) {
        // an anchor only carries over if the wall it points at was copied in
        // this same batch — otherwise the live-anchor sync effect would snap
        // the clone straight back onto the original wall, undoing the offset
        const remapAnchor = (a: MeasurementAnchor | null | undefined): MeasurementAnchor | null =>
          a && idMap.has(a.wallId) ? { ...a, wallId: idMap.get(a.wallId)! } : null;
        const newId = addMeasurement({
          start: { x: m.start.x + dx, y: m.start.y + dy },
          end: { x: m.end.x + dx, y: m.end.y + dy },
          startAnchor: remapAnchor(m.startAnchor),
          endAnchor: remapAnchor(m.endAnchor),
        });
        newIds.push(newId);
      }
      for (const f of sourceFurniture) {
        const newId = addFurniture({
          libraryId: f.libraryId,
          category: f.category,
          label: f.label,
          position: { x: f.position.x + dx, y: f.position.y + dy },
          rotation: f.rotation,
          width: f.width,
          depth: f.depth,
          height: f.height,
          color: f.color,
        });
        newIds.push(newId);
      }
      setSelection(newIds);
      selectedIdsRef.current = newIds;
      render();
    };

    const onMouseDown = (e: MouseEvent) => {
      const screen = getScreenPoint(e);
      const cam = camRef.current;
      const size = sizeRef.current;
      const rawWorld = screenToWorld(screen, cam, size);
      // lets onMouseMove push exactly one history snapshot for this gesture,
      // the first time it actually moves something (a plain click that only
      // selects shouldn't create a no-op undo step)
      dragHistoryPushedRef.current = false;

      // read-only: every drag pans the view, full stop — no tool branch below
      // (wall/door/furniture/etc.) is ever reachable, regardless of button
      if (e.button === 1 || e.button === 2 || activeToolRef.current === "pan" || readOnlyRef.current) {
        e.preventDefault();
        dragRef.current = { ...EMPTY_DRAG_STATE, mode: "pan", lastScreen: screen };
        return;
      }

      if (e.button !== 0) return;

      if (activeToolRef.current === "wall") {
        const point =
          e.shiftKey && drawRef.current.pendingStart
            ? computeAngleLockedPoint(drawRef.current.pendingStart, rawWorld, cam.zoom, gridSizeMRef.current)
            : computeSnap(rawWorld, wallsRef.current, drawRef.current.pendingStart, cam.zoom, gridSizeMRef.current).point;
        if (!drawRef.current.pendingStart) {
          drawRef.current.pendingStart = point;
        } else {
          commitSegment(drawRef.current.pendingStart, point);
          drawRef.current.pendingStart = point;
        }
        drawRef.current.lengthBuffer = "";
        render();
        return;
      }

      if (activeToolRef.current === "door" || activeToolRef.current === "window") {
        const preview = openingPreviewRef.current;
        if (preview && preview.valid) {
          const isDoor = activeToolRef.current === "door";
          pushHistory();
          addOpening({
            wallId: preview.wallId,
            type: (isDoor ? "door" : "window") as OpeningType,
            offset: preview.offset,
            width: isDoor ? DOOR_DEFAULT_WIDTH : WINDOW_DEFAULT_WIDTH,
            height: isDoor ? DOOR_DEFAULT_HEIGHT : WINDOW_DEFAULT_HEIGHT,
            sillHeight: isDoor ? DOOR_DEFAULT_SILL : WINDOW_DEFAULT_SILL,
          });
          // the just-placed opening isn't in openingsRef yet (store update is async),
          // so clear rather than recompute a preview that can't see it
          openingPreviewRef.current = null;
        }
        render();
        return;
      }

      if (activeToolRef.current === "furniture") {
        const pending = pendingFurnitureRef.current;
        if (pending) {
          const point = furniturePreviewRef.current ?? rawWorld;
          const size = furnitureCollisionSize(pending);
          const settled = resolveFurniturePlacement(
            point,
            size.width,
            size.depth,
            0,
            wallsRef.current,
            openingsRef.current,
            furnitureObstacles(furnitureRef.current, []),
          );
          pushHistory();
          const id = addFurniture({ ...pending, position: settled, rotation: 0 });
          setSelection([id]);
          selectedIdsRef.current = [id];
        }
        render();
        return;
      }

      if (activeToolRef.current === "floor") {
        const hitRoom = roomsRef.current.find((r) => pointInPolygon(rawWorld, r.polygon));
        setSelectedRoomKey(hitRoom ? hitRoom.key : null);
        render();
        return;
      }

      if (activeToolRef.current === "walkStart") {
        // click places it facing the previous heading (or +x); dragging before
        // release aims it, same "drag to set direction" gesture as furniture rotate
        dragRef.current = { ...EMPTY_DRAG_STATE, mode: "walk-start", dragStartWorld: rawWorld, lastScreen: screen };
        walkStartPreviewRef.current = { x: rawWorld.x, y: rawWorld.y, heading: walkthroughStartRef.current?.heading ?? 0 };
        render();
        return;
      }

      if (activeToolRef.current === "ceilingLight") {
        // stays on this tool after each click (like furniture placement) so
        // several lights can be dropped in a row along a hallway/room
        const id = addCeilingLight(rawWorld);
        setSelection([id]);
        selectedIdsRef.current = [id];
        render();
        return;
      }

      if (activeToolRef.current === "measure") {
        const snap = computeSnap(rawWorld, wallsRef.current, null, cam.zoom, gridSizeMRef.current);
        dragRef.current = { ...EMPTY_DRAG_STATE, mode: "measure", lastScreen: screen, dragStartWorld: snap.point };
        measurePreviewRef.current = {
          start: snap.point,
          end: snap.point,
          startMagnet: snap.snappedToWall,
          endMagnet: snap.snappedToWall,
          startAnchor: snap.anchor,
          endAnchor: snap.anchor,
        };
        render();
        return;
      }

      // select tool (and fallback for furniture)

      // endpoint handles of any currently selected wall or measurement take priority
      for (const id of selectedIdsRef.current) {
        const w = wallsRef.current.find((w) => w.id === id);
        if (w) {
          const aScreen = worldToScreen(w.start, cam, size);
          const bScreen = worldToScreen(w.end, cam, size);
          if (distance(screen, aScreen) <= 9) {
            dragRef.current = { ...EMPTY_DRAG_STATE, mode: "wall-endpoint", wallId: w.id, endpoint: "start", lastScreen: screen, dragStartWorld: rawWorld };
            return;
          }
          if (distance(screen, bScreen) <= 9) {
            dragRef.current = { ...EMPTY_DRAG_STATE, mode: "wall-endpoint", wallId: w.id, endpoint: "end", lastScreen: screen, dragStartWorld: rawWorld };
            return;
          }
          continue;
        }
        const m = measurementsRef.current.find((m) => m.id === id);
        if (!m) continue;
        const aScreen = worldToScreen(m.start, cam, size);
        const bScreen = worldToScreen(m.end, cam, size);
        if (distance(screen, aScreen) <= 9) {
          dragRef.current = { ...EMPTY_DRAG_STATE, mode: "measure-endpoint", measurementId: m.id, endpoint: "start", lastScreen: screen, dragStartWorld: rawWorld };
          return;
        }
        if (distance(screen, bScreen) <= 9) {
          dragRef.current = { ...EMPTY_DRAG_STATE, mode: "measure-endpoint", measurementId: m.id, endpoint: "end", lastScreen: screen, dragStartWorld: rawWorld };
          return;
        }
      }

      const hitMeasurement = hitTestMeasurement(rawWorld, measurementsRef.current, wallsRef.current);
      if (hitMeasurement) {
        if (e.shiftKey) {
          toggleSelection(hitMeasurement.id);
          return;
        }
        if (!selectedIdsRef.current.includes(hitMeasurement.id)) {
          setSelection([hitMeasurement.id]);
          selectedIdsRef.current = [hitMeasurement.id];
        }
        dragRef.current = {
          ...EMPTY_DRAG_STATE,
          mode: "measure-body",
          measurementId: hitMeasurement.id,
          measurementSnapshot: { start: hitMeasurement.start, end: hitMeasurement.end },
          lastScreen: screen,
          dragStartWorld: rawWorld,
        };
        return;
      }

      const hitOpening = hitTestOpening(rawWorld, openingsRef.current, wallsRef.current);
      if (hitOpening) {
        if (e.shiftKey) {
          toggleSelection(hitOpening.id);
          return;
        }
        if (!selectedIdsRef.current.includes(hitOpening.id)) {
          setSelection([hitOpening.id]);
          selectedIdsRef.current = [hitOpening.id];
        }
        dragRef.current = {
          ...EMPTY_DRAG_STATE,
          mode: "opening",
          wallId: hitOpening.wallId,
          openingId: hitOpening.id,
          lastScreen: screen,
          dragStartWorld: rawWorld,
        };
        return;
      }

      const ceilingLightHitThreshold = Math.max(ENDPOINT_SNAP_PX / (BASE_PPM * cam.zoom), 0.15);
      const hitCeilingLight = hitTestCeilingLight(rawWorld, ceilingLightsRef.current, ceilingLightHitThreshold);
      if (hitCeilingLight) {
        if (e.shiftKey) {
          toggleSelection(hitCeilingLight.id);
        } else {
          setSelection([hitCeilingLight.id]);
          selectedIdsRef.current = [hitCeilingLight.id];
        }
        render();
        return;
      }

      if (selectedIdsRef.current.length === 1) {
        const soleSelectedFurniture = furnitureRef.current.find((f) => f.id === selectedIdsRef.current[0]);
        if (soleSelectedFurniture) {
          const handleScreen = worldToScreen(furnitureRotateHandlePos(soleSelectedFurniture, cam.zoom), cam, size);
          if (distance(screen, handleScreen) <= 9) {
            dragRef.current = {
              ...EMPTY_DRAG_STATE,
              mode: "furniture-rotate",
              furnitureRotateId: soleSelectedFurniture.id,
              furnitureRotateStart: soleSelectedFurniture.rotation,
              furnitureRotatePointerStart: Math.atan2(
                rawWorld.y - soleSelectedFurniture.position.y,
                rawWorld.x - soleSelectedFurniture.position.x,
              ),
              lastScreen: screen,
              dragStartWorld: rawWorld,
            };
            return;
          }
        }
      }

      const hitFurniture = hitTestFurniture(rawWorld, furnitureRef.current);
      if (hitFurniture) {
        if (e.shiftKey) {
          toggleSelection(hitFurniture.id);
          return;
        }
        if (!selectedIdsRef.current.includes(hitFurniture.id)) {
          setSelection([hitFurniture.id]);
          selectedIdsRef.current = [hitFurniture.id];
        }
        const furnitureSnapshot: FurnitureSnapshot[] = furnitureRef.current
          .filter((f) => selectedIdsRef.current.includes(f.id))
          .map((f) => ({ id: f.id, position: f.position, settled: f.position }));
        dragRef.current = {
          ...EMPTY_DRAG_STATE,
          mode: "furniture-body",
          furnitureSnapshot,
          furnitureObstaclesSnapshot: furnitureObstacles(
            furnitureRef.current,
            furnitureSnapshot.map((s) => s.id),
          ),
          lastScreen: screen,
          dragStartWorld: rawWorld,
        };
        return;
      }

      const hit = hitTestWall(rawWorld, wallsRef.current);
      if (hit) {
        if (e.shiftKey) {
          toggleSelection(hit.id);
          return;
        }

        if (!selectedIdsRef.current.includes(hit.id)) {
          setSelection([hit.id]);
          selectedIdsRef.current = [hit.id];
        }

        const connectedIds = findConnectedWallIds(selectedIdsRef.current, wallsRef.current);
        const groupWalls: GroupWallSnapshot[] = wallsRef.current
          .filter((w) => connectedIds.has(w.id))
          .map((w) => ({ id: w.id, start: w.start, end: w.end }));

        dragRef.current = { ...EMPTY_DRAG_STATE, mode: "wall-body", groupWalls, lastScreen: screen, dragStartWorld: rawWorld };
        return;
      }

      // empty space: begin a marquee drag; a negligible drag resolves to a plain
      // "clear selection" click on mouseup
      dragRef.current = {
        ...EMPTY_DRAG_STATE,
        mode: "marquee",
        lastScreen: screen,
        dragStartWorld: rawWorld,
        marqueeStart: screen,
        marqueeCurrent: screen,
        marqueeAdditive: e.shiftKey,
      };
    };

    const onMouseMove = (e: MouseEvent) => {
      const screen = getScreenPoint(e);
      const cam = camRef.current;
      const size = sizeRef.current;
      const drag = dragRef.current;
      dragLockIndicatorRef.current = null;

      if (drag.mode === "pan") {
        const dx = screen.x - drag.lastScreen.x;
        const dy = screen.y - drag.lastScreen.y;
        cam.offsetX += dx;
        cam.offsetY += dy;
        drag.lastScreen = screen;
        render();
        return;
      }

      if (drag.mode === "wall-endpoint" && drag.wallId && drag.endpoint) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        if (!dragHistoryPushedRef.current) {
          dragHistoryPushedRef.current = true;
          pushHistory();
        }
        const rawWorld = screenToWorld(screen, cam, size);
        const wall = wallsRef.current.find((w) => w.id === drag.wallId);
        if (wall) {
          const fixedPoint = drag.endpoint === "start" ? wall.end : wall.start;
          const originalPoint = drag.endpoint === "start" ? wall.start : wall.end;
          let point: Point;
          if (e.shiftKey) {
            point = computeAngleLockedPoint(fixedPoint, rawWorld, cam.zoom, gridSizeMRef.current);
            dragLockIndicatorRef.current = point;
          } else {
            point = computeSnap(rawWorld, wallsRef.current, fixedPoint, cam.zoom, gridSizeMRef.current, drag.wallId).point;
          }
          updateWall(drag.wallId, { [drag.endpoint]: point } as Partial<Wall>);
          // carry along any other wall that was joined at this corner, so the joint stays closed
          for (const other of wallsRef.current) {
            if (other.id === drag.wallId) continue;
            if (distance(other.start, originalPoint) < WALL_GRAPH_CONNECT_EPS) {
              updateWall(other.id, { start: point });
            } else if (distance(other.end, originalPoint) < WALL_GRAPH_CONNECT_EPS) {
              updateWall(other.id, { end: point });
            }
          }
        }
        render();
        return;
      }

      if (drag.mode === "wall-body" && drag.groupWalls && drag.dragStartWorld) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        if (!dragHistoryPushedRef.current) {
          dragHistoryPushedRef.current = true;
          pushHistory();
        }
        const rawWorld = screenToWorld(screen, cam, size);
        const rawDelta = { x: rawWorld.x - drag.dragStartWorld.x, y: rawWorld.y - drag.dragStartWorld.y };
        const snappedDelta = computeBodyDragSnap(rawDelta, drag.groupWalls, wallsRef.current, cam.zoom, gridSizeMRef.current);
        for (const gw of drag.groupWalls) {
          updateWall(gw.id, {
            start: { x: gw.start.x + snappedDelta.x, y: gw.start.y + snappedDelta.y },
            end: { x: gw.end.x + snappedDelta.x, y: gw.end.y + snappedDelta.y },
          });
        }
        render();
        return;
      }

      if (drag.mode === "measure-endpoint" && drag.measurementId && drag.endpoint) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        if (!dragHistoryPushedRef.current) {
          dragHistoryPushedRef.current = true;
          pushHistory();
        }
        const rawWorld = screenToWorld(screen, cam, size);
        const measurement = measurementsRef.current.find((m) => m.id === drag.measurementId);
        const fixedPoint = measurement ? (drag.endpoint === "start" ? measurement.end : measurement.start) : null;
        if (e.shiftKey && fixedPoint) {
          const point = computeAngleLockedPoint(fixedPoint, rawWorld, cam.zoom, gridSizeMRef.current);
          dragLockIndicatorRef.current = point;
          updateMeasurement(drag.measurementId, {
            [drag.endpoint]: point,
            [drag.endpoint === "start" ? "startAnchor" : "endAnchor"]: null,
          } as Partial<Measurement>);
        } else {
          const snap = computeSnap(rawWorld, wallsRef.current, fixedPoint, cam.zoom, gridSizeMRef.current);
          updateMeasurement(drag.measurementId, {
            [drag.endpoint]: snap.point,
            [drag.endpoint === "start" ? "startAnchor" : "endAnchor"]: snap.anchor,
          } as Partial<Measurement>);
        }
        render();
        return;
      }

      if (drag.mode === "measure-body" && drag.measurementSnapshot && drag.dragStartWorld) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        if (!dragHistoryPushedRef.current) {
          dragHistoryPushedRef.current = true;
          pushHistory();
        }
        const rawWorld = screenToWorld(screen, cam, size);
        const rawDelta = { x: rawWorld.x - drag.dragStartWorld.x, y: rawWorld.y - drag.dragStartWorld.y };
        const dist = Math.hypot(rawDelta.x, rawDelta.y);
        let delta = rawDelta;
        if (dist > 1e-6) {
          const angle = Math.atan2(rawDelta.y, rawDelta.x);
          const stepRad = (ANGLE_SNAP_STEP_DEG * Math.PI) / 180;
          const snappedAngle = Math.round(angle / stepRad) * stepRad;
          const diffDeg = (Math.abs(angle - snappedAngle) * 180) / Math.PI;
          if (diffDeg <= ANGLE_SNAP_TOLERANCE_DEG) {
            delta = { x: Math.cos(snappedAngle) * dist, y: Math.sin(snappedAngle) * dist };
          }
        }
        const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * cam.zoom);
        const griddedX = snapValueToStep(delta.x, gridSizeMRef.current);
        const griddedY = snapValueToStep(delta.y, gridSizeMRef.current);
        delta = {
          x: Math.abs(delta.x - griddedX) <= thresholdWorld ? griddedX : delta.x,
          y: Math.abs(delta.y - griddedY) <= thresholdWorld ? griddedY : delta.y,
        };
        const { start, end } = drag.measurementSnapshot;
        if (drag.measurementId) {
          updateMeasurement(drag.measurementId, {
            start: { x: start.x + delta.x, y: start.y + delta.y },
            end: { x: end.x + delta.x, y: end.y + delta.y },
            // a free body-drag isn't validated against any wall feature, so it detaches
            startAnchor: null,
            endAnchor: null,
          });
        }
        render();
        return;
      }

      if (drag.mode === "furniture-body" && drag.furnitureSnapshot && drag.dragStartWorld) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        if (!dragHistoryPushedRef.current) {
          dragHistoryPushedRef.current = true;
          pushHistory();
        }
        const rawWorld = screenToWorld(screen, cam, size);
        const rawDelta = { x: rawWorld.x - drag.dragStartWorld.x, y: rawWorld.y - drag.dragStartWorld.y };
        const dist = Math.hypot(rawDelta.x, rawDelta.y);
        let delta = rawDelta;
        if (dist > 1e-6) {
          const angle = Math.atan2(rawDelta.y, rawDelta.x);
          const stepRad = (ANGLE_SNAP_STEP_DEG * Math.PI) / 180;
          const snappedAngle = Math.round(angle / stepRad) * stepRad;
          const diffDeg = (Math.abs(angle - snappedAngle) * 180) / Math.PI;
          if (diffDeg <= ANGLE_SNAP_TOLERANCE_DEG) {
            delta = { x: Math.cos(snappedAngle) * dist, y: Math.sin(snappedAngle) * dist };
          }
        }
        const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * cam.zoom);
        const griddedX = snapValueToStep(delta.x, gridSizeMRef.current);
        const griddedY = snapValueToStep(delta.y, gridSizeMRef.current);
        delta = {
          x: Math.abs(delta.x - griddedX) <= thresholdWorld ? griddedX : delta.x,
          y: Math.abs(delta.y - griddedY) <= thresholdWorld ? griddedY : delta.y,
        };
        const obstacles = drag.furnitureObstaclesSnapshot ?? [];
        for (const snap of drag.furnitureSnapshot) {
          const item = furnitureRef.current.find((f) => f.id === snap.id);
          if (!item) continue;
          const desired = { x: snap.position.x + delta.x, y: snap.position.y + delta.y };
          const size = furnitureCollisionSize(item);
          const settled = sweepFurniturePlacement(
            snap.settled,
            desired,
            size.width,
            size.depth,
            item.rotation,
            wallsRef.current,
            openingsRef.current,
            obstacles,
            FURNITURE_BREAKTHROUGH_DISTANCE_M,
          );
          snap.settled = settled;
          updateFurniture(snap.id, { position: settled });
        }
        render();
        return;
      }

      if (
        drag.mode === "furniture-rotate" &&
        drag.furnitureRotateId &&
        drag.furnitureRotateStart !== null &&
        drag.furnitureRotatePointerStart !== null
      ) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        if (!dragHistoryPushedRef.current) {
          dragHistoryPushedRef.current = true;
          pushHistory();
        }
        const item = furnitureRef.current.find((f) => f.id === drag.furnitureRotateId);
        if (item) {
          const rawWorld = screenToWorld(screen, cam, size);
          const pointerAngle = Math.atan2(rawWorld.y - item.position.y, rawWorld.x - item.position.x);
          let rotation = drag.furnitureRotateStart + (pointerAngle - drag.furnitureRotatePointerStart);

          // soft-snap to 15° increments (always when close, or forced with Shift) —
          // makes it easy to land on a tidy angle without losing free rotation
          const stepRad = (15 * Math.PI) / 180;
          const snapped = Math.round(rotation / stepRad) * stepRad;
          const diffDeg = (Math.abs(rotation - snapped) * 180) / Math.PI;
          if (e.shiftKey || diffDeg <= 3) rotation = snapped;

          const itemSize = furnitureCollisionSize(item);
          const settled = resolveFurniturePlacement(
            item.position,
            itemSize.width,
            itemSize.depth,
            rotation,
            wallsRef.current,
            openingsRef.current,
            furnitureObstacles(furnitureRef.current, [item.id]),
          );
          updateFurniture(item.id, { rotation, position: settled });
        }
        render();
        return;
      }

      if (drag.mode === "opening" && drag.wallId && drag.openingId) {
        // lastScreen is pinned to the mousedown point for the whole gesture (never reassigned outside
        // pan mode), so this threshold must only gate arming the drag once — checking it every frame
        // would freeze the drag whenever the cursor happens to pass back near the original pixel
        if (!dragHistoryPushedRef.current && distance(screen, drag.lastScreen) < DRAG_ARM_PX) return;
        const wall = wallsRef.current.find((w) => w.id === drag.wallId);
        const opening = openingsRef.current.find((o) => o.id === drag.openingId);
        if (wall && opening) {
          if (!dragHistoryPushedRef.current) {
            dragHistoryPushedRef.current = true;
            pushHistory();
          }
          const rawWorld = screenToWorld(screen, cam, size);
          const proj = projectPointOnSegment(rawWorld, wall.start, wall.end);
          const wallLen = distance(wall.start, wall.end) || 0.0001;
          const fit = fitOpeningOnWall(wall, proj.t * wallLen, opening.width, openingsRef.current, opening.id);
          updateOpening(opening.id, { offset: fit.offset });
        }
        render();
        return;
      }

      if (drag.mode === "marquee" && drag.marqueeStart) {
        drag.marqueeCurrent = screen;
        const startWorld = screenToWorld(drag.marqueeStart, cam, size);
        const currentWorld = screenToWorld(screen, cam, size);
        marqueeHoverIdsRef.current = [
          ...wallsInRect(wallsRef.current, startWorld, currentWorld),
          ...openingsInRect(openingsRef.current, wallsRef.current, startWorld, currentWorld),
          ...measurementsInRect(measurementsRef.current, wallsRef.current, startWorld, currentWorld),
          ...furnitureInRect(furnitureRef.current, startWorld, currentWorld),
        ];
        render();
        return;
      }

      if (drag.mode === "walk-start" && drag.dragStartWorld) {
        const rawWorld = screenToWorld(screen, cam, size);
        const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * cam.zoom);
        const heading =
          distance(drag.dragStartWorld, rawWorld) > thresholdWorld
            ? angleRad(drag.dragStartWorld, rawWorld)
            : walkStartPreviewRef.current?.heading ?? 0;
        walkStartPreviewRef.current = { x: drag.dragStartWorld.x, y: drag.dragStartWorld.y, heading };
        render();
        return;
      }

      if (drag.mode === "measure" && drag.dragStartWorld) {
        const rawWorld = screenToWorld(screen, cam, size);
        if (e.shiftKey) {
          // force-lock to the nearest 45°/90° from the start point, taking
          // priority over wall magnetism — otherwise a wall's edge can pull
          // the second point just off-axis and there's no way to guarantee
          // a perfectly perpendicular/diagonal measurement near one
          const point = computeAngleLockedPoint(drag.dragStartWorld, rawWorld, cam.zoom, gridSizeMRef.current);
          measurePreviewRef.current = {
            start: drag.dragStartWorld,
            end: point,
            startMagnet: measurePreviewRef.current?.startMagnet ?? false,
            // the ring now marks the angle-lock itself, giving the same "it's
            // caught on something" feedback as a wall/corner magnet would
            endMagnet: true,
            startAnchor: measurePreviewRef.current?.startAnchor ?? null,
            endAnchor: null,
          };
        } else {
          const snap = computeSnap(rawWorld, wallsRef.current, drag.dragStartWorld, cam.zoom, gridSizeMRef.current);
          measurePreviewRef.current = {
            start: drag.dragStartWorld,
            end: snap.point,
            startMagnet: measurePreviewRef.current?.startMagnet ?? false,
            endMagnet: snap.snappedToWall,
            startAnchor: measurePreviewRef.current?.startAnchor ?? null,
            endAnchor: snap.anchor,
          };
        }
        render();
        return;
      }

      if (activeToolRef.current === "door" || activeToolRef.current === "window") {
        const rawWorld = screenToWorld(screen, cam, size);
        const found = findWallForOpening(rawWorld, wallsRef.current, cam.zoom);
        if (found) {
          const width = activeToolRef.current === "door" ? DOOR_DEFAULT_WIDTH : WINDOW_DEFAULT_WIDTH;
          const fit = fitOpeningOnWall(found.wall, found.offset, width, openingsRef.current);
          openingPreviewRef.current = { wallId: found.wall.id, offset: fit.offset, valid: fit.valid };
        } else {
          openingPreviewRef.current = null;
        }
        render();
        return;
      }

      // hover feedback on a selected wall/measurement's endpoint handles —
      // enlarge the handle and show a grab cursor, like hovering a Figma node
      if (activeToolRef.current === "select") {
        let found: { kind: "wall" | "measure"; id: string; endpoint: "start" | "end" } | null = null;
        for (const id of selectedIdsRef.current) {
          const w = wallsRef.current.find((w) => w.id === id);
          if (w) {
            if (distance(screen, worldToScreen(w.start, cam, size)) <= 9) {
              found = { kind: "wall", id: w.id, endpoint: "start" };
              break;
            }
            if (distance(screen, worldToScreen(w.end, cam, size)) <= 9) {
              found = { kind: "wall", id: w.id, endpoint: "end" };
              break;
            }
            continue;
          }
          const m = measurementsRef.current.find((m) => m.id === id);
          if (!m) continue;
          if (distance(screen, worldToScreen(m.start, cam, size)) <= 9) {
            found = { kind: "measure", id: m.id, endpoint: "start" };
            break;
          }
          if (distance(screen, worldToScreen(m.end, cam, size)) <= 9) {
            found = { kind: "measure", id: m.id, endpoint: "end" };
            break;
          }
        }
        hoveredHandleRef.current = found;
        let cursor = found ? "grab" : "";
        if (!found && selectedIdsRef.current.length === 1) {
          const soleSelectedFurniture = furnitureRef.current.find((f) => f.id === selectedIdsRef.current[0]);
          if (
            soleSelectedFurniture &&
            distance(screen, worldToScreen(furnitureRotateHandlePos(soleSelectedFurniture, cam.zoom), cam, size)) <= 9
          ) {
            cursor = "grab";
          }
        }
        canvas.style.cursor = cursor;
      } else if (activeToolRef.current === "floor") {
        const rawWorldHover = screenToWorld(screen, cam, size);
        const hitRoom = roomsRef.current.find((r) => pointInPolygon(rawWorldHover, r.polygon));
        hoveredRoomKeyRef.current = hitRoom ? hitRoom.key : null;
        canvas.style.cursor = hitRoom ? "pointer" : "";
      } else if (canvas.style.cursor) {
        canvas.style.cursor = "";
      }

      // hover / drawing preview
      const rawWorld = screenToWorld(screen, cam, size);
      const snap = computeSnap(rawWorld, wallsRef.current, drawRef.current.pendingStart, cam.zoom, gridSizeMRef.current);
      if (e.shiftKey && activeToolRef.current === "wall" && drawRef.current.pendingStart) {
        const locked = computeAngleLockedPoint(drawRef.current.pendingStart, rawWorld, cam.zoom, gridSizeMRef.current);
        drawRef.current.cursorWorld = locked;
        drawRef.current.snappedToWall = false;
        dragLockIndicatorRef.current = locked;
      } else {
        drawRef.current.cursorWorld = snap.point;
        // broader than an exact-corner check — same "attached to another
        // wall" trigger the measurement tool's magnet ring uses, so a wall
        // landing on another wall's face (a T-junction), not just its
        // corner, shows the same feedback
        drawRef.current.snappedToWall = snap.snappedToWall;
      }

      // before the first click, show where the measurement's start will land
      if (activeToolRef.current === "measure") {
        measurePreviewRef.current = {
          start: snap.point,
          end: snap.point,
          startMagnet: snap.snappedToWall,
          endMagnet: snap.snappedToWall,
          startAnchor: snap.anchor,
          endAnchor: snap.anchor,
        };
      }

      if (activeToolRef.current === "furniture" && pendingFurnitureRef.current) {
        const gridPoint = snapPointToGrid(rawWorld, gridSizeMRef.current);
        const thresholdWorld = ENDPOINT_SNAP_PX / (BASE_PPM * cam.zoom);
        furniturePreviewRef.current = distance(rawWorld, gridPoint) <= thresholdWorld ? gridPoint : rawWorld;
      }

      // Alt-hover spacing readout (Figma-style): with exactly one furniture item
      // selected, holding Alt and hovering another item or a wall shows the gap
      // between them — cleared the moment either condition isn't met anymore
      if (activeToolRef.current === "select" && e.altKey && selectedIdsRef.current.length === 1) {
        const selected = furnitureRef.current.find((f) => f.id === selectedIdsRef.current[0]);
        const hitFurniture = selected
          ? hitTestFurniture(
              rawWorld,
              furnitureRef.current.filter((f) => f.id !== selected.id),
            )
          : null;
        if (selected && hitFurniture) {
          altSpacingHoverRef.current = { selectedId: selected.id, targetKind: "furniture", targetId: hitFurniture.id };
        } else {
          const hitWall = selected ? hitTestWall(rawWorld, wallsRef.current) : null;
          altSpacingHoverRef.current = selected && hitWall ? { selectedId: selected.id, targetKind: "wall", targetId: hitWall.id } : null;
        }
      } else {
        altSpacingHoverRef.current = null;
      }

      render();
    };

    const onMouseUp = () => {
      const drag = dragRef.current;

      if (drag.mode === "marquee" && drag.marqueeStart && drag.marqueeCurrent) {
        const movedPx = distance(drag.marqueeStart, drag.marqueeCurrent);
        if (movedPx < 4) {
          if (!drag.marqueeAdditive) clearSelection();
        } else if (drag.marqueeAdditive) {
          setSelection(Array.from(new Set([...selectedIdsRef.current, ...marqueeHoverIdsRef.current])));
        } else {
          setSelection(marqueeHoverIdsRef.current);
        }
        marqueeHoverIdsRef.current = [];
      }

      if (drag.mode === "measure" && measurePreviewRef.current) {
        const { start, end, startAnchor, endAnchor } = measurePreviewRef.current;
        if (distance(start, end) >= MIN_SEGMENT_LENGTH_M) {
          pushHistory();
          const id = addMeasurement({ start, end, startAnchor, endAnchor });
          setSelection([id]);
        }
        measurePreviewRef.current = null;
      }

      if (drag.mode === "walk-start" && walkStartPreviewRef.current) {
        setWalkthroughStart(walkStartPreviewRef.current);
        setActiveTool("select");
        walkStartPreviewRef.current = null;
      }

      // a wall/opening drag skips the room/floor/door-patch recompute on every
      // intermediate tick (see the walls/openings sync effect) — catch up now
      // that the gesture has actually settled
      const wasRoomAffectingDrag = drag.mode === "wall-body" || drag.mode === "wall-endpoint" || drag.mode === "opening";
      dragRef.current = { ...EMPTY_DRAG_STATE };
      if (wasRoomAffectingDrag) recomputeRoomsData();
      render();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camRef.current;
      const size = sizeRef.current;

      // Figma-style navigation: plain scroll (mouse wheel or trackpad two-finger
      // swipe) pans; Ctrl/Cmd+scroll zooms (this is also how browsers report
      // trackpad pinch-to-zoom, so pinch works for free here too).
      if (!e.ctrlKey && !e.metaKey) {
        cam.offsetX -= e.deltaX;
        cam.offsetY -= e.deltaY;
        render();
        return;
      }

      const screen = getScreenPoint(e);
      const worldBefore = screenToWorld(screen, cam, size);

      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));

      const newScreen = worldToScreen(worldBefore, cam, size);
      cam.offsetX += screen.x - newScreen.x;
      cam.offsetY += screen.y - newScreen.y;
      render();
    };

    const finishChain = () => {
      drawRef.current.pendingStart = null;
      drawRef.current.lengthBuffer = "";
      render();
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (readOnlyRef.current) return;
      if (activeToolRef.current === "wall") finishChain();
    };

    const onDblClick = (e: MouseEvent) => {
      if (readOnlyRef.current) return;
      if (activeToolRef.current === "wall") {
        finishChain();
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const screen = getScreenPoint(e);
      const cam = camRef.current;
      const size = sizeRef.current;
      const wall = hitTestWallLabel(ctx, screen, wallsRef.current, cam, size);
      if (wall) {
        const mid = worldToScreen({ x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 }, cam, size);
        setSelection([wall.id]);
        setEditingValue(distance(wall.start, wall.end).toFixed(2));
        setEditingWall({ id: wall.id, x: mid.x, y: mid.y });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (readOnlyRef.current) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;

      if (activeToolRef.current === "wall" && drawRef.current.pendingStart) {
        if (/^[0-9]$/.test(e.key)) {
          drawRef.current.lengthBuffer += e.key;
          render();
          return;
        }
        if (e.key === "." && !drawRef.current.lengthBuffer.includes(".")) {
          drawRef.current.lengthBuffer += ".";
          render();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          drawRef.current.lengthBuffer = drawRef.current.lengthBuffer.slice(0, -1);
          render();
          return;
        }
        if (e.key === "Enter") {
          const value = parseFloat(drawRef.current.lengthBuffer);
          const cursor = drawRef.current.cursorWorld;
          const start = drawRef.current.pendingStart;
          if (value > 0 && cursor && start) {
            const dir = angleRad(start, cursor);
            const end = { x: start.x + Math.cos(dir) * value, y: start.y + Math.sin(dir) * value };
            commitSegment(start, end);
            drawRef.current.pendingStart = end;
          }
          drawRef.current.lengthBuffer = "";
          render();
          return;
        }
        if (e.key === "Escape") {
          if (drawRef.current.lengthBuffer) {
            drawRef.current.lengthBuffer = "";
          } else {
            finishChain();
          }
          render();
          return;
        }
      }

      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        render();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        render();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        const allIds = [
          ...wallsRef.current.map((w) => w.id),
          ...openingsRef.current.map((o) => o.id),
          ...furnitureRef.current.map((f) => f.id),
          ...measurementsRef.current.map((m) => m.id),
        ];
        setSelection(allIds);
        render();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const copiedWalls = wallsRef.current.filter((w) => selectedIdsRef.current.includes(w.id));
        const wallIdSet = new Set(copiedWalls.map((w) => w.id));
        const copiedOpenings = openingsRef.current.filter((o) => wallIdSet.has(o.wallId));
        const copiedMeasurements = measurementsRef.current.filter((m) => selectedIdsRef.current.includes(m.id));
        const copiedFurniture = furnitureRef.current.filter((f) => selectedIdsRef.current.includes(f.id));
        clipboardRef.current =
          copiedWalls.length > 0 || copiedMeasurements.length > 0 || copiedFurniture.length > 0
            ? { walls: copiedWalls, openings: copiedOpenings, measurements: copiedMeasurements, furniture: copiedFurniture }
            : null;
        pasteCountRef.current = 0;
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        const clipboard = clipboardRef.current;
        if (clipboard) {
          pasteCountRef.current += 1;
          const offset = PASTE_OFFSET_STEP_M * pasteCountRef.current;
          cloneWithOffset(clipboard.walls, clipboard.openings, clipboard.measurements, clipboard.furniture, offset, offset);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const dupWalls = wallsRef.current.filter((w) => selectedIdsRef.current.includes(w.id));
        const wallIdSet = new Set(dupWalls.map((w) => w.id));
        const dupOpenings = openingsRef.current.filter((o) => wallIdSet.has(o.wallId));
        const dupMeasurements = measurementsRef.current.filter((m) => selectedIdsRef.current.includes(m.id));
        const dupFurniture = furnitureRef.current.filter((f) => selectedIdsRef.current.includes(f.id));
        cloneWithOffset(dupWalls, dupOpenings, dupMeasurements, dupFurniture, PASTE_OFFSET_STEP_M, PASTE_OFFSET_STEP_M);
        return;
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        activeToolRef.current !== "wall" &&
        selectedIdsRef.current.length > 0
      ) {
        e.preventDefault();
        pushHistory();
        removeElements(selectedIdsRef.current);
        render();
        return;
      }

      if (e.key === "Escape" && dragRef.current.mode !== "none") {
        // cancel the in-progress drag — like Figma, Escape reverts a
        // reshape/move back to where it started instead of leaving it
        // wherever the cursor happened to be
        const cancelableModes: DragMode[] = [
          "wall-endpoint",
          "wall-body",
          "opening",
          "measure-endpoint",
          "measure-body",
          "furniture-body",
          "furniture-rotate",
        ];
        if (dragHistoryPushedRef.current && cancelableModes.includes(dragRef.current.mode)) {
          const preservedSelection = selectedIdsRef.current;
          undo();
          setSelection(preservedSelection); // undo() clears selection; keep the object selected like Figma does
        }
        dragRef.current = { ...EMPTY_DRAG_STATE };
        dragHistoryPushedRef.current = false;
        measurePreviewRef.current = null;
        walkStartPreviewRef.current = null;
        marqueeHoverIdsRef.current = [];
        render();
        return;
      }

      if (e.key === "Escape" && selectedIdsRef.current.length > 0) {
        clearSelection();
        render();
        return;
      }

      if (e.key === "Escape" && activeToolRef.current === "floor" && selectedRoomKeyRef.current) {
        setSelectedRoomKey(null);
        render();
        return;
      }

      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        selectedIdsRef.current.length > 0
      ) {
        e.preventDefault();
        const step = e.shiftKey ? gridSizeMRef.current : GRID_SNAP_M;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const nudgeIds = new Set(selectedIdsRef.current);
        const wallsToNudge = wallsRef.current.filter((w) => nudgeIds.has(w.id));
        const furnitureToNudge = furnitureRef.current.filter((f) => nudgeIds.has(f.id));
        if (wallsToNudge.length > 0 || furnitureToNudge.length > 0) {
          if (!e.repeat) pushHistory();
          // snapshot original endpoints before any mutation, so connected
          // (but unselected) neighbors can be found and stretched to follow
          // — the moved walls translate, everything hinged on them reshapes
          const originals = wallsToNudge.map((w) => ({ id: w.id, start: w.start, end: w.end }));
          for (const w of wallsToNudge) {
            updateWall(w.id, {
              start: { x: w.start.x + dx, y: w.start.y + dy },
              end: { x: w.end.x + dx, y: w.end.y + dy },
            });
          }
          for (const orig of originals) {
            for (const other of wallsRef.current) {
              if (nudgeIds.has(other.id)) continue;
              if (distance(other.start, orig.start) < WALL_GRAPH_CONNECT_EPS) {
                updateWall(other.id, { start: { x: orig.start.x + dx, y: orig.start.y + dy } });
              } else if (distance(other.end, orig.start) < WALL_GRAPH_CONNECT_EPS) {
                updateWall(other.id, { end: { x: orig.start.x + dx, y: orig.start.y + dy } });
              }
              if (distance(other.start, orig.end) < WALL_GRAPH_CONNECT_EPS) {
                updateWall(other.id, { start: { x: orig.end.x + dx, y: orig.end.y + dy } });
              } else if (distance(other.end, orig.end) < WALL_GRAPH_CONNECT_EPS) {
                updateWall(other.id, { end: { x: orig.end.x + dx, y: orig.end.y + dy } });
              }
            }
          }
          const nudgedIds = furnitureToNudge.map((f) => f.id);
          const nudgeObstacles = furnitureObstacles(furnitureRef.current, nudgedIds);
          for (const f of furnitureToNudge) {
            const size = furnitureCollisionSize(f);
            const settled = resolveFurniturePlacement(
              { x: f.position.x + dx, y: f.position.y + dy },
              size.width,
              size.depth,
              f.rotation,
              wallsRef.current,
              openingsRef.current,
              nudgeObstacles,
            );
            updateFurniture(f.id, { position: settled });
          }
          render();
        }
        return;
      }

      if ((e.key === "r" || e.key === "R") && !mod && selectedIdsRef.current.length > 0) {
        const selectedFurniture = furnitureRef.current.filter((f) => selectedIdsRef.current.includes(f.id));
        if (selectedFurniture.length > 0) {
          e.preventDefault();
          if (!e.repeat) pushHistory();
          const deltaRad = ((e.shiftKey ? -90 : 90) * Math.PI) / 180;
          for (const f of selectedFurniture) {
            const rotation = f.rotation + deltaRad;
            // rotation doesn't affect the collision footprint's width/depth (only
            // its own explicit `rotation` param to resolveFurniturePlacement below
            // does) — furnitureCollisionSize only reads category/libraryId/width/
            // depth/height, all unchanged by the 90° turn, so no override needed
            const size = furnitureCollisionSize(f);
            const settled = resolveFurniturePlacement(
              f.position,
              size.width,
              size.depth,
              rotation,
              wallsRef.current,
              openingsRef.current,
              furnitureObstacles(furnitureRef.current, [f.id]),
            );
            updateFurniture(f.id, { rotation, position: settled });
          }
          render();
          return;
        }
      }

      if (e.code === "Space" && !e.repeat && activeToolRef.current !== "pan") {
        e.preventDefault();
        spacePanPreviousToolRef.current = activeToolRef.current;
        setActiveTool("pan");
        return;
      }

      if (!mod && !e.altKey) {
        const tool = TOOL_SHORTCUTS[e.key.toLowerCase()];
        if (tool) {
          setActiveTool(tool);
          return;
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && spacePanPreviousToolRef.current) {
        setActiveTool(spacePanPreviousToolRef.current);
        spacePanPreviousToolRef.current = null;
      }
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dblclick", onDblClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    render,
    recomputeRoomsData,
    addWall,
    updateWall,
    addOpening,
    updateOpening,
    addMeasurement,
    updateMeasurement,
    removeElements,
    setSelection,
    toggleSelection,
    clearSelection,
    setActiveTool,
    pushHistory,
    undo,
    redo,
  ]);

  function commitWallLengthEdit() {
    if (!editingWall) return;
    const wall = wallsRef.current.find((w) => w.id === editingWall.id);
    const newLength = parseFloat(editingValue.replace(",", "."));
    if (wall && newLength > 0 && isFinite(newLength)) {
      const dir = angleRad(wall.start, wall.end);
      const newEnd = { x: wall.start.x + Math.cos(dir) * newLength, y: wall.start.y + Math.sin(dir) * newLength };
      const originalEnd = wall.end;
      pushHistory();
      updateWall(wall.id, { end: newEnd });
      // carry along any wall that was joined at the moved end, so the corner stays closed
      for (const other of wallsRef.current) {
        if (other.id === wall.id) continue;
        if (distance(other.start, originalEnd) < WALL_GRAPH_CONNECT_EPS) {
          updateWall(other.id, { start: newEnd });
        } else if (distance(other.end, originalEnd) < WALL_GRAPH_CONNECT_EPS) {
          updateWall(other.id, { end: newEnd });
        }
      }
    }
    setEditingWall(null);
  }

  const cursorClass =
    activeTool === "wall" || activeTool === "measure"
      ? "cursor-crosshair"
      : activeTool === "pan"
        ? "cursor-grab"
        : "cursor-default";

  return (
    <div className="bg-studio-bg relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className={`absolute inset-0 ${cursorClass}`} />
      {editingWall && (
        <input
          autoFocus
          inputMode="decimal"
          value={editingValue}
          onChange={(e) => setEditingValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitWallLengthEdit();
            if (e.key === "Escape") setEditingWall(null);
          }}
          onBlur={commitWallLengthEdit}
          className="border-studio-clay bg-studio-paper text-studio-ink absolute z-20 w-16 -translate-x-1/2 -translate-y-1/2 rounded border px-1 py-0.5 text-center text-[11px] shadow-lg focus:outline-none"
          style={{ left: editingWall.x, top: editingWall.y }}
        />
      )}
      {walls.length === 0 && activeTool !== "wall" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-studio-ink-faint text-sm font-medium">
            Select the "Wall" tool and start drawing your floor plan
          </p>
        </div>
      )}
      {activeTool === "wall" && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Click to place wall points · type a length in meters and confirm with Enter · Esc finishes / cancels · right-click
          finishes the chain
        </div>
      )}
      {activeTool === "select" && walls.length > 0 && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Drag to select multiple walls · Shift adds to selection · Delete removes the selected
        </div>
      )}
      {(activeTool === "door" || activeTool === "window") && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Hover over a wall and click to place the {activeTool === "door" ? "door" : "window"} · it snaps to the wall
        </div>
      )}
      {activeTool === "floor" && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Click an enclosed room to set its floor pattern · Esc clears the selection
        </div>
      )}
      {activeTool === "walkStart" && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Click and drag to set where the walkthrough starts and which way it faces
        </div>
      )}
      {activeTool === "ceilingLight" && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Click to add a ceiling light — add as many as you like · switch to Select to click one and delete it
        </div>
      )}
    </div>
  );
}
