import type { Point, Wall, Opening } from "../types";
import { distance, angleRad } from "./geometry";

interface OBB {
  center: Point;
  halfW: number;
  halfH: number;
  angle: number;
}

function obbAxes(o: OBB): Point[] {
  return [
    { x: Math.cos(o.angle), y: Math.sin(o.angle) },
    { x: -Math.sin(o.angle), y: Math.cos(o.angle) },
  ];
}

function obbCorners(o: OBB): Point[] {
  const cos = Math.cos(o.angle);
  const sin = Math.sin(o.angle);
  const local: [number, number][] = [
    [-o.halfW, -o.halfH],
    [o.halfW, -o.halfH],
    [o.halfW, o.halfH],
    [-o.halfW, o.halfH],
  ];
  return local.map(([lx, ly]) => ({
    x: o.center.x + lx * cos - ly * sin,
    y: o.center.y + lx * sin + ly * cos,
  }));
}

function projectOntoAxis(corners: Point[], axis: Point): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of corners) {
    const p = c.x * axis.x + c.y * axis.y;
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  return { min, max };
}

/** Separating-axis test for two oriented rectangles. Returns the minimum-translation axis+distance (pointing away from `b`) to push `a` out of `b`, or null if they don't overlap. */
function satOverlap(a: OBB, b: OBB): { axis: Point; overlap: number } | null {
  const axes = [...obbAxes(a), ...obbAxes(b)];
  const cornersA = obbCorners(a);
  const cornersB = obbCorners(b);
  let minOverlap = Infinity;
  let minAxis: Point | null = null;

  for (const axis of axes) {
    const pa = projectOntoAxis(cornersA, axis);
    const pb = projectOntoAxis(cornersB, axis);
    // The naive `min(maxA,maxB) - max(minA,minB)` only gives the true
    // penetration depth when neither interval contains the other. If `a`
    // is big enough to fully straddle `b` along this axis (e.g. a long
    // piece of furniture whose span swallows a thin wall's thickness after
    // a rotate/resize lands it there in one jump, with no gradual sweep to
    // catch the overlap early), that formula degenerates to just b's own
    // length — far too small a push, so the iterative resolver crawls
    // toward the wall by tiny steps instead of clearing it. The correct
    // minimal push in either direction is min(pa.max-pb.min, pb.max-pa.min).
    const overlap = Math.min(pa.max - pb.min, pb.max - pa.min);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      minAxis = axis;
    }
  }
  if (!minAxis) return null;

  const d = { x: b.center.x - a.center.x, y: b.center.y - a.center.y };
  if (d.x * minAxis.x + d.y * minAxis.y > 0) minAxis = { x: -minAxis.x, y: -minAxis.y };
  return { axis: minAxis, overlap: minOverlap };
}

function wallOBB(wall: Wall): OBB {
  const len = distance(wall.start, wall.end) || 0.001;
  return {
    center: { x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 },
    halfW: len / 2,
    halfH: wall.thickness / 2,
    angle: angleRad(wall.start, wall.end),
  };
}

const FLOOR_OPENING_SILL_EPSILON_M = 0.01;

/**
 * Splits a wall into the OBBs of its solid, floor-reaching sections only —
 * a door opening (sillHeight ~0) cuts a real gap you can walk or carry
 * furniture through, so it's excluded entirely rather than treated as
 * solid. A window (raised sill) still has solid wall below it at floor
 * level, so it stays solid.
 */
function wallCollisionSegments(wall: Wall, openings: Opening[]): OBB[] {
  const len = distance(wall.start, wall.end) || 0.001;
  const gaps = openings
    .filter((o) => o.wallId === wall.id && o.sillHeight <= FLOOR_OPENING_SILL_EPSILON_M)
    .map((o) => {
      const half = o.width / 2;
      return { start: Math.max(0, o.offset - half), end: Math.min(len, o.offset + half) };
    })
    .sort((a, b) => a.start - b.start);

  if (gaps.length === 0) return [wallOBB(wall)];

  const solids: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const gap of gaps) {
    if (gap.start > cursor) solids.push({ start: cursor, end: gap.start });
    cursor = Math.max(cursor, gap.end);
  }
  if (cursor < len) solids.push({ start: cursor, end: len });

  const angle = angleRad(wall.start, wall.end);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return solids
    .filter((s) => s.end - s.start > 0.01)
    .map((s) => {
      const mid = (s.start + s.end) / 2;
      return {
        center: { x: wall.start.x + mid * cos, y: wall.start.y + mid * sin },
        halfW: (s.end - s.start) / 2,
        halfH: wall.thickness / 2,
        angle,
      };
    });
}

const CHAIR_GAP_M = 0.06; // mirrors Scene3D's DiningTableWithChairs clearance
const CHAIR_SEAT_SIZE_M = 0.42;
const TABLE_CHAIR_MARGIN_M = CHAIR_GAP_M + CHAIR_SEAT_SIZE_M;

const SOFA_CURVED_ARC_RAD = (100 * Math.PI) / 180; // mirrors Scene3D's CurvedSofa geometry
const SOFA_CURVED_SEGMENTS = 5;
const SOFA_CURVED_BACK_THICKNESS = 0.16;

function curvedSofaFootprint(width: number, depth: number): { width: number; depth: number } {
  const radius = width / (2 * Math.sin(SOFA_CURVED_ARC_RAD / 2));
  const segAngle = SOFA_CURVED_ARC_RAD / SOFA_CURVED_SEGMENTS;
  const segChord = 2 * radius * Math.sin(segAngle / 2) + 0.02;
  const zOffset = -((radius + radius * Math.cos(SOFA_CURVED_ARC_RAD / 2)) / 2);

  let maxAbsX = 0;
  let maxAbsZ = 0;
  for (let i = 0; i < SOFA_CURVED_SEGMENTS; i++) {
    const theta = -SOFA_CURVED_ARC_RAD / 2 + segAngle * (i + 0.5);
    const cx = radius * Math.sin(theta);
    const cz = radius * Math.cos(theta) + zOffset;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const pieces = [
      { hx: segChord / 2, hz: depth / 2, cz: 0 }, // seat cushion
      { hx: segChord / 2, hz: SOFA_CURVED_BACK_THICKNESS / 2, cz: depth / 2 - SOFA_CURVED_BACK_THICKNESS / 2 }, // backrest
    ];
    for (const p of pieces) {
      for (const lx of [-p.hx, p.hx]) {
        for (const lzRaw of [-p.hz, p.hz]) {
          const lz = lzRaw + p.cz;
          const wx = cx + lx * cos - lz * sin;
          const wz = cz + lx * sin + lz * cos;
          maxAbsX = Math.max(maxAbsX, Math.abs(wx));
          maxAbsZ = Math.max(maxAbsZ, Math.abs(wz));
        }
      }
    }
  }
  return { width: maxAbsX * 2, depth: maxAbsZ * 2 };
}

/**
 * The stored width/depth of a few furniture pieces don't match what's
 * actually drawn: a dining table's chairs stick out well past its tabletop,
 * and the curved sofa's arc bows out past its nominal rectangle. Collision
 * needs to use this true visual footprint, not the raw item size, or those
 * pieces can still show as clipped through a wall or another piece.
 */
export function furnitureCollisionSize(item: {
  libraryId: string;
  category: string;
  width: number;
  depth: number;
  height: number;
}): { width: number; depth: number } {
  if (item.category === "table" && item.height >= 0.6) {
    return { width: item.width + TABLE_CHAIR_MARGIN_M * 2, depth: item.depth + TABLE_CHAIR_MARGIN_M * 2 };
  }
  if (item.libraryId === "sofa-curved-sage") {
    return curvedSofaFootprint(item.width, item.depth);
  }
  return { width: item.width, depth: item.depth };
}

export interface FurnitureObstacle {
  id: string;
  position: Point;
  width: number;
  depth: number;
  rotation: number;
  /** Vertical range this obstacle actually occupies (elevation = its own height above the floor) — lets an item resolved with a matching range pass freely underneath/above it instead of always treating it as floor-to-ceiling solid. */
  elevation: number;
  height: number;
}

function furnitureOBB(f: FurnitureObstacle): OBB {
  return { center: f.position, halfW: f.width / 2, halfH: f.depth / 2, angle: f.rotation };
}

/**
 * Same as resolveFurniturePlacement below, but takes the wall/opening geometry
 * pre-flattened into OBBs — sweepFurniturePlacement calls this directly so it
 * can compute that once per gesture instead of redoing it on every one of its
 * (potentially dozens of) internal steps, since the walls/openings never
 * change mid-sweep.
 */
function resolveFurniturePlacementWithSegs(
  position: Point,
  width: number,
  depth: number,
  rotation: number,
  wallSegs: OBB[],
  others: FurnitureObstacle[] = [],
  elevationM = 0,
  heightM = Infinity,
): Point {
  let center = { x: position.x, y: position.y };
  const passes = 4;
  const selfBottom = elevationM;
  const selfTop = elevationM + heightM;

  for (let pass = 0; pass < passes; pass++) {
    let anyCollision = false;
    const self: OBB = { center, halfW: width / 2, halfH: depth / 2, angle: rotation };

    for (const seg of wallSegs) {
      const result = satOverlap(self, seg);
      if (!result) continue;
      anyCollision = true;
      // `result.axis` already points away from the obstacle (see satOverlap),
      // so pushing out means moving further along it, not against it
      center = { x: center.x + result.axis.x * result.overlap, y: center.y + result.axis.y * result.overlap };
      self.center = center;
    }
    for (const other of others) {
      // no vertical overlap (e.g. a wall cabinet's own range sits entirely above a
      // base cabinet's) — footprints can freely overlap, so it never collides at all
      if (selfBottom >= other.elevation + other.height || other.elevation >= selfTop) continue;
      const result = satOverlap(self, furnitureOBB(other));
      if (!result) continue;
      anyCollision = true;
      center = { x: center.x + result.axis.x * result.overlap, y: center.y + result.axis.y * result.overlap };
      self.center = center;
    }
    if (!anyCollision) break;
  }

  return center;
}

/**
 * Pushes a furniture rectangle (position/rotation given, in the same 2D world
 * used everywhere else) out of any wall or other furniture piece it
 * overlaps, so dragging or placing it can never leave it clipped through a
 * wall or buried in another item — it stops flush against whatever it hit
 * instead. Resolves over a few passes (a simple, stable-enough iterative
 * solver for the common 1-2 obstacle case, including room corners).
 */
export function resolveFurniturePlacement(
  position: Point,
  width: number,
  depth: number,
  rotation: number,
  walls: Wall[],
  openings: Opening[],
  others: FurnitureObstacle[] = [],
  elevationM = 0,
  heightM = Infinity,
): Point {
  const wallSegs = walls.flatMap((w) => wallCollisionSegments(w, openings));
  return resolveFurniturePlacementWithSegs(position, width, depth, rotation, wallSegs, others, elevationM, heightM);
}

const SWEEP_STEP_M = 0.03; // well under any realistic wall thickness
// a safety net against a runaway loop on corrupted/absurd input, not a real limit — at
// SWEEP_STEP_M increments this still covers moves over 100m, far beyond any real floor
// plan, so the anti-tunneling guarantee above actually holds for every legitimate move
// (capping this low let fast/coalesced mouse drags exceed ~2.4m per tick and tunnel through walls)
const SWEEP_MAX_STEPS = 4000;

/**
 * Moves a furniture rectangle from `from` toward `to`, resolving collisions
 * in small increments along the way instead of just at the final point — a
 * single big jump (a fast drag, or a synthetic multi-meter move) can
 * otherwise land past a thin wall or another item without any one frame's
 * position ever geometrically overlapping it, "tunneling" straight through.
 * Stops advancing as soon as a step gets pushed back, so it settles flush
 * against whatever it hit rather than resuming on the far side.
 *
 * If `breakthroughDistanceM` is positive and the caller keeps dragging well
 * past the point where the piece got stuck (e.g. deliberately hauling it
 * into the next room), it "pops through" to the actual target instead of
 * staying wedged against the wall forever — re-resolved fresh there so it
 * still respects whatever it lands next to. Left at 0, obstacles stay fully
 * solid (used for player movement, where walls should never give way).
 */
export function sweepFurniturePlacement(
  from: Point,
  to: Point,
  width: number,
  depth: number,
  rotation: number,
  walls: Wall[],
  openings: Opening[],
  others: FurnitureObstacle[] = [],
  breakthroughDistanceM = 0,
  elevationM = 0,
  heightM = Infinity,
): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // walls/openings are constant for the whole sweep, so this is computed once
  // here instead of once per step below (up to SWEEP_MAX_STEPS times)
  const wallSegs = walls.flatMap((w) => wallCollisionSegments(w, openings));
  if (dist < 1e-9) return resolveFurniturePlacementWithSegs(to, width, depth, rotation, wallSegs, others, elevationM, heightM);

  const steps = Math.min(SWEEP_MAX_STEPS, Math.max(1, Math.ceil(dist / SWEEP_STEP_M)));
  let current = { x: from.x, y: from.y };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const candidate = { x: from.x + dx * t, y: from.y + dy * t };
    const resolved = resolveFurniturePlacementWithSegs(candidate, width, depth, rotation, wallSegs, others, elevationM, heightM);
    const pushedBack = Math.abs(resolved.x - candidate.x) > 1e-6 || Math.abs(resolved.y - candidate.y) > 1e-6;
    current = resolved;
    if (pushedBack) break;
  }

  if (breakthroughDistanceM > 0 && distance(current, to) > breakthroughDistanceM) {
    return resolveFurniturePlacementWithSegs(to, width, depth, rotation, wallSegs, others, elevationM, heightM);
  }
  return current;
}
