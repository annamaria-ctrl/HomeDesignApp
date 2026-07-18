import type { Point, Wall, Opening } from "../types";
import { distance } from "./geometry";

export interface DetectedRoom {
  /** Stable-ish identity derived from the room's centroid (rounded), so a floor
   * texture assignment survives minor wall edits without needing real room objects. */
  key: string;
  polygon: Point[];
  area: number;
  centroid: Point;
}

const GRID_STEP = 0.025; // meters — fine enough to reliably separate rooms across a thin wall, and fine enough that grid-quantization "staircase" notches at corners/junctions stay small enough for the floor dilation below to fully hide them under the wall mesh
const MIN_ROOM_AREA_M2 = 0.3; // ignores slivers/noise, not real rooms — small closets/nooks are still real rooms
const KEY_ROUNDING_M = 0.2;

interface Rasterized {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  blocked: Uint8Array;
  outside: Uint8Array;
}

/**
 * Rasterizes the wall layout onto a fine grid and flood-fills from the
 * border to identify "outside" — the groundwork behind computeRooms().
 *
 * `thicknessInsetM` shrinks each wall's effective half-thickness during
 * rasterization, letting the flood fill (and so the resulting polygon) creep
 * slightly into the wall's footprint instead of stopping dead at its inner
 * face. Used at a small value by computeRoomFloorPolygons() below to close
 * hairline gaps at wall corners/junctions that the grid's resolution can
 * otherwise leave uncovered — never for the canonical room list itself,
 * where a wall (door or not) must stay a real separator between rooms.
 */
function rasterize(walls: Wall[], thicknessInsetM: number): Rasterized | null {
  if (walls.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const margin = 1;
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;

  const cols = Math.max(1, Math.ceil((maxX - minX) / GRID_STEP));
  const rows = Math.max(1, Math.ceil((maxY - minY) / GRID_STEP));
  if (cols * rows > 4_000_000) return null;

  // never shrink below this, and never past the wall's own half-thickness —
  // needs to stay comfortably wider than GRID_STEP so a thin remaining
  // barrier can't fall entirely between two sampled cell centers and leak
  const SAFE_MIN_HALF_THICKNESS_M = 0.02;
  const wallBoxes = walls.map((w) => {
    const half = Math.min(w.thickness / 2, Math.max(SAFE_MIN_HALF_THICKNESS_M, w.thickness / 2 - thicknessInsetM));
    const length = distance(w.start, w.end) || 0.0001;
    const dirX = (w.end.x - w.start.x) / length;
    const dirY = (w.end.y - w.start.y) / length;
    return {
      wall: w,
      halfThickness: half,
      length,
      dirX,
      dirY,
      minX: Math.min(w.start.x, w.end.x) - half,
      maxX: Math.max(w.start.x, w.end.x) + half,
      minY: Math.min(w.start.y, w.end.y) - half,
      maxY: Math.max(w.start.y, w.end.y) + half,
    };
  });

  // Iterate per-wall over just its own local bounding box in grid indices,
  // not every cell × every wall — a wall only ever affects a small strip of
  // the grid, so this stays fast even at a fine GRID_STEP over a big floor
  // plan with many walls (the naive cells×walls scan got slow enough at fine
  // resolution to visibly stall the UI on each edit).
  //
  // Tests against the wall's true rectangular footprint (project onto the
  // wall's own axis, clamp to its actual length) rather than distance-to-
  // segment, which rounds off at the endpoints — that rounding carves a
  // quarter-circle bite (radius = half the wall's thickness) out of the
  // "blocked" region at every free-standing wall end, which the flood fill
  // then reads as open room space that never actually exists, leaving a
  // real gap in the floor right at the wall's flat, sharp-cornered tip. The
  // thicker the wall, the bigger that phantom radius — exactly what showed
  // up as a growing gap at thicker walls' ends.
  const blocked = new Uint8Array(cols * rows);
  for (const wb of wallBoxes) {
    const c0 = Math.max(0, Math.floor((wb.minX - minX) / GRID_STEP));
    const c1 = Math.min(cols - 1, Math.ceil((wb.maxX - minX) / GRID_STEP));
    const r0 = Math.max(0, Math.floor((wb.minY - minY) / GRID_STEP));
    const r1 = Math.min(rows - 1, Math.ceil((wb.maxY - minY) / GRID_STEP));
    for (let r = r0; r <= r1; r++) {
      const cy = minY + (r + 0.5) * GRID_STEP;
      const rowBase = r * cols;
      for (let c = c0; c <= c1; c++) {
        const idx = rowBase + c;
        if (blocked[idx]) continue;
        const cx = minX + (c + 0.5) * GRID_STEP;
        const relX = cx - wb.wall.start.x;
        const relY = cy - wb.wall.start.y;
        const u = relX * wb.dirX + relY * wb.dirY;
        if (u < 0 || u > wb.length) continue;
        const v = relX * -wb.dirY + relY * wb.dirX;
        if (Math.abs(v) <= wb.halfThickness) {
          blocked[idx] = 1;
        }
      }
    }
  }

  // multi-source flood fill inward from the border marks everything that's
  // reachable from "outside the building" without crossing a wall
  const outside = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const pushIfOpen = (r: number, c: number) => {
    const idx = r * cols + c;
    if (!blocked[idx] && !outside[idx]) {
      outside[idx] = 1;
      queue.push(idx);
    }
  };
  for (let c = 0; c < cols; c++) {
    pushIfOpen(0, c);
    pushIfOpen(rows - 1, c);
  }
  for (let r = 0; r < rows; r++) {
    pushIfOpen(r, 0);
    pushIfOpen(r, cols - 1);
  }
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    if (r > 0) pushIfOpen(r - 1, c);
    if (r < rows - 1) pushIfOpen(r + 1, c);
    if (c > 0) pushIfOpen(r, c - 1);
    if (c < cols - 1) pushIfOpen(r, c + 1);
  }

  return { cols, rows, minX, minY, blocked, outside };
}

/**
 * Finds enclosed floor areas from the current wall layout — each one
 * separated from its neighbors by every wall in between. Door/window
 * openings are ignored on purpose — a doorway is still a boundary between
 * two rooms, not a gap that merges them into one.
 */
export function computeRooms(walls: Wall[], thicknessInsetM = 0): DetectedRoom[] {
  const grid = rasterize(walls, thicknessInsetM);
  if (!grid) return [];
  const { cols, rows, minX, minY, blocked, outside } = grid;

  const visited = new Uint8Array(cols * rows);
  const rooms: DetectedRoom[] = [];

  for (let start = 0; start < cols * rows; start++) {
    if (blocked[start] || outside[start] || visited[start]) continue;

    const cellSet = new Set<number>();
    const stack = [start];
    visited[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      cellSet.add(idx);
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const neighbors: [number, number][] = [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1],
      ];
      for (const [nr, nc] of neighbors) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nIdx = nr * cols + nc;
        if (blocked[nIdx] || outside[nIdx] || visited[nIdx]) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }

    const area = cellSet.size * GRID_STEP * GRID_STEP;
    if (area < MIN_ROOM_AREA_M2) continue;

    const polygon = traceContour(cellSet, cols, rows, minX, minY, GRID_STEP);
    if (polygon.length < 3) continue;

    let cxSum = 0;
    let cySum = 0;
    for (const idx of cellSet) {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      cxSum += minX + (c + 0.5) * GRID_STEP;
      cySum += minY + (r + 0.5) * GRID_STEP;
    }
    const centroid = { x: cxSum / cellSet.size, y: cySum / cellSet.size };
    const key = `${Math.round(centroid.x / KEY_ROUNDING_M) * KEY_ROUNDING_M}_${Math.round(centroid.y / KEY_ROUNDING_M) * KEY_ROUNDING_M}`;

    rooms.push({ key, polygon, area, centroid });
  }

  return rooms;
}

// Comfortably bigger than GRID_STEP so it reliably pushes past worst-case
// grid-quantization "staircase" notches (an angled or off-grid wall can have
// its rasterized boundary land up to roughly one grid step short of the
// wall's true face). Safe at any size: SAFE_MIN_HALF_THICKNESS_M below
// always keeps at least that much of every wall solid, so this can never
// dilate a room polygon past the wall's far face into the next room.
const FLOOR_DILATE_INSET_M = 0.08;

/**
 * The canonical room polygons from computeRooms() stop exactly at each
 * wall's inner face, at whatever precision the rasterization grid happens
 * to land on — at a corner or multi-wall junction, or anywhere a wall isn't
 * perfectly axis-aligned, that can leave a hairline (or occasionally
 * not-so-hairline) strip uncovered by any room, which shows up as a bare
 * patch in the floor/ceiling texture. Re-running the same flood fill with
 * each wall's blocking thickness nibbled down closes that gap by letting
 * the polygon creep well under every wall, not just at doors — safe because
 * SAFE_MIN_HALF_THICKNESS_M keeps a wall from ever being thinned enough to
 * merge two rooms together. Purely a rendering polygon: room identity/area/
 * click-selection still use the undilated computeRooms() result.
 */
export function computeRoomFloorPolygons(walls: Wall[], rooms: DetectedRoom[]): DetectedRoom[] {
  const dilated = computeRooms(walls, FLOOR_DILATE_INSET_M);
  return rooms.map((room) => {
    const match = dilated.find((d) => pointInPolygon(room.centroid, d.polygon)) ?? dilated.find((d) => d.key === room.key);
    return match ? { ...room, polygon: match.polygon } : room;
  });
}

/** Chains the boundary edges of a cell mask into a closed loop, then drops collinear points. */
function traceContour(cellSet: Set<number>, cols: number, rows: number, minX: number, minY: number, step: number): Point[] {
  const edgeMap = new Map<string, string>();
  const cornerKey = (x: number, y: number) => `${x},${y}`;

  for (const idx of cellSet) {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    const neighborInSet = (nr: number, nc: number) => {
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return false;
      return cellSet.has(nr * cols + nc);
    };
    if (!neighborInSet(r - 1, c)) edgeMap.set(cornerKey(c, r), cornerKey(c + 1, r));
    if (!neighborInSet(r, c + 1)) edgeMap.set(cornerKey(c + 1, r), cornerKey(c + 1, r + 1));
    if (!neighborInSet(r + 1, c)) edgeMap.set(cornerKey(c + 1, r + 1), cornerKey(c, r + 1));
    if (!neighborInSet(r, c - 1)) edgeMap.set(cornerKey(c, r + 1), cornerKey(c, r));
  }
  if (edgeMap.size === 0) return [];

  const globalVisited = new Set<string>();
  let bestLoop: string[] = [];

  for (const startKey of edgeMap.keys()) {
    if (globalVisited.has(startKey)) continue;
    const loopKeys: string[] = [];
    const localVisited = new Set<string>();
    let current = startKey;
    while (!localVisited.has(current)) {
      localVisited.add(current);
      loopKeys.push(current);
      const next = edgeMap.get(current);
      if (!next) break;
      current = next;
    }
    for (const k of loopKeys) globalVisited.add(k);
    if (loopKeys.length > bestLoop.length) bestLoop = loopKeys;
  }

  const points = bestLoop.map((k) => {
    const [ix, iy] = k.split(",").map(Number);
    return { x: minX + ix * step, y: minY + iy * step };
  });
  return simplifyCollinear(points);
}

function simplifyCollinear(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const n = points.length;
  const result: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > 1e-9) result.push(cur);
  }
  return result.length >= 3 ? result : points;
}

export interface DoorThresholdPatch {
  roomKey: string;
  polygon: Point[];
}

const FLOOR_OPENING_SILL_EPSILON_M = 0.01;
const THRESHOLD_PROBE_INSET_M = 0.05;

/**
 * A room's polygon follows each bounding wall's inner face, whether or not
 * that wall has a door cut into it — the flood fill in computeRooms never
 * looks inside a wall's thickness. That's correct for keeping two rooms
 * separate, but it means the doorway's own threshold (the strip of floor
 * spanning the wall's thickness at the opening) belongs to no room at all,
 * leaving a real gap in floor/ceiling coverage right at every door. This
 * computes a small rectangular patch — from the wall's centerline out to
 * each bordering room's own face, so two rooms' patches meet edge-to-edge —
 * to fill exactly that gap, the way a real floor would be cut to fit through.
 */
export function computeDoorThresholdPatches(rooms: DetectedRoom[], walls: Wall[], openings: Opening[]): DoorThresholdPatch[] {
  const patches: DoorThresholdPatch[] = [];

  for (const wall of walls) {
    const doorOpenings = openings.filter((o) => o.wallId === wall.id && o.sillHeight <= FLOOR_OPENING_SILL_EPSILON_M);
    if (doorOpenings.length === 0) continue;

    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const len = Math.hypot(dx, dy) || 0.001;
    const dirX = dx / len;
    const dirY = dy / len;
    const normalX = -dirY;
    const normalY = dirX;
    const half = wall.thickness / 2;

    for (const opening of doorOpenings) {
      const u0 = opening.offset - opening.width / 2;
      const u1 = opening.offset + opening.width / 2;
      const centerX = wall.start.x + dirX * opening.offset;
      const centerY = wall.start.y + dirY * opening.offset;

      for (const side of [1, -1]) {
        const probe = {
          x: centerX + normalX * (half + THRESHOLD_PROBE_INSET_M) * side,
          y: centerY + normalY * (half + THRESHOLD_PROBE_INSET_M) * side,
        };
        const room = rooms.find((r) => pointInPolygon(probe, r.polygon));
        if (!room) continue;

        const p0 = { x: wall.start.x + dirX * u0, y: wall.start.y + dirY * u0 };
        const p1 = { x: wall.start.x + dirX * u1, y: wall.start.y + dirY * u1 };
        patches.push({
          roomKey: room.key,
          polygon: [
            p0,
            p1,
            { x: p1.x + normalX * half * side, y: p1.y + normalY * half * side },
            { x: p0.x + normalX * half * side, y: p0.y + normalY * half * side },
          ],
        });
      }
    }
  }

  return patches;
}

/** Point-in-polygon test (ray casting), used to hit-test a click against a detected room. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
