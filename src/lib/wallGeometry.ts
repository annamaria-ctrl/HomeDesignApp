import * as THREE from "three";
import type { Point, Wall, Opening } from "../types";
import { distance, angleRad } from "./geometry";

const CORNER_CONNECT_EPS = 0.01; // 1cm — walls snapped to a shared corner share exact coordinates
const MAX_MITER_DIST_M = 4; // sanity cap so a near-parallel (straight-through) joint can't shoot off to infinity

function addP(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}
function scaleP(a: Point, s: number): Point {
  return { x: a.x * s, y: a.y * s };
}
function rot90(a: Point): Point {
  return { x: -a.y, y: a.x };
}

/** Intersection of the infinite line through p1 (direction d1) and through p2 (direction d2), or null if (near-)parallel or absurdly far. */
function lineIntersection(p1: Point, d1: Point, p2: Point, d2: Point): Point | null {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-6) return null;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const t = (dx * d2.y - dy * d2.x) / cross;
  const point = { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
  if (distance(point, p1) > MAX_MITER_DIST_M) return null;
  return point;
}

function crossOf(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (monotone chain), returned counter-clockwise. */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossOf(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && crossOf(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export interface CornerPatch {
  key: string;
  points: Point[]; // convex polygon in world XY, ready to fill/extrude
  wallIds: string[]; // walls meeting at this joint, for e.g. matching selection color
}

interface JointMember {
  wall: Wall;
  outward: Point; // unit direction from the joint, out along the wall
}

/**
 * Where 2+ walls share an endpoint, a flat perpendicular cut on each wall
 * leaves a gap or a crossing sliver at the joint — exact only when the walls
 * happen to meet at a perfect right angle with matching thickness. This
 * computes, per joint, the true mitered corner patch (each wall's left/right
 * face line extended to where it crosses the neighbor's) so any angle and any
 * mix of thicknesses closes flush. Rendered as separate small patches (see
 * Canvas2D.tsx / Scene3D.tsx) rather than by reshaping each wall's own
 * geometry, so a wall's own length always matches its nominal start-to-end
 * distance (what the dimension label shows).
 */
export function computeCornerPatches(walls: Wall[]): CornerPatch[] {
  const joints: { point: Point; members: JointMember[] }[] = [];

  const findJoint = (p: Point) => joints.find((j) => distance(j.point, p) < CORNER_CONNECT_EPS);

  for (const wall of walls) {
    const length = distance(wall.start, wall.end) || 0.0001;
    const dir = { x: (wall.end.x - wall.start.x) / length, y: (wall.end.y - wall.start.y) / length };
    const ends: [Point, Point][] = [
      [wall.start, dir],
      [wall.end, { x: -dir.x, y: -dir.y }],
    ];
    for (const [point, outward] of ends) {
      let joint = findJoint(point);
      if (!joint) {
        joint = { point, members: [] };
        joints.push(joint);
      }
      joint.members.push({ wall, outward });
    }
  }

  const patches: CornerPatch[] = [];
  for (const joint of joints) {
    if (joint.members.length < 2) continue;

    const corners = joint.members.map((m) => {
      const normal = rot90(m.outward);
      return {
        a: addP(joint.point, scaleP(normal, m.wall.thickness / 2)),
        b: addP(joint.point, scaleP(normal, -m.wall.thickness / 2)),
        outward: m.outward,
      };
    });

    const points: Point[] = [];
    for (const c of corners) {
      points.push(c.a, c.b);
    }

    if (corners.length === 2) {
      const [c1, c2] = corners;
      for (const p1 of [c1.a, c1.b]) {
        for (const p2 of [c2.a, c2.b]) {
          const hit = lineIntersection(p1, c1.outward, p2, c2.outward);
          if (hit) points.push(hit);
        }
      }
    }

    const hull = convexHull(points);
    if (hull.length >= 3) {
      patches.push({
        key: `${joint.point.x.toFixed(4)}_${joint.point.y.toFixed(4)}`,
        points: hull,
        wallIds: joint.members.map((m) => m.wall.id),
      });
    }
  }
  return patches;
}

/**
 * Builds a wall's 3D geometry directly in the wall's local frame: local X runs
 * along the wall's length, local Y is height (up), local Z is thickness. Door
 * and window openings on this wall are punched out as holes in that same
 * cross-section before extruding along Z. The mesh is then placed in world
 * space by `wallTransform` below — position at wall.start, rotated about Y so
 * local X points along the wall's direction.
 */
export function buildWallGeometry(wall: Wall, openings: Opening[]): THREE.ExtrudeGeometry {
  const length = distance(wall.start, wall.end) || 0.001;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(length, 0);
  shape.lineTo(length, wall.height);
  shape.lineTo(0, wall.height);
  shape.closePath();

  // A hole edge that exactly touches the outer contour (e.g. a door's sill
  // sitting at y=0, the floor) makes earcut's triangulation degenerate along
  // that shared edge, showing up as a jagged sliver. The fix is to keep every
  // hole edge strictly *inside* the outer contour (inset by EPS) rather than
  // push it outside — a hole that pokes outside the contour gets rejected by
  // earcut entirely, which silently drops the whole cutout.
  const EPS = 0.02;

  for (const o of openings) {
    const half = o.width / 2;
    let x0 = Math.max(0, o.offset - half);
    let x1 = Math.min(length, o.offset + half);
    let y0 = Math.max(0, o.sillHeight);
    let y1 = Math.min(wall.height, o.sillHeight + o.height);
    if (x1 <= x0 || y1 <= y0) continue;

    if (x0 <= EPS) x0 = EPS;
    if (x1 >= length - EPS) x1 = length - EPS;
    if (y0 <= EPS) y0 = EPS;
    if (y1 >= wall.height - EPS) y1 = wall.height - EPS;
    if (x1 <= x0 || y1 <= y0) continue;

    const hole = new THREE.Path();
    hole.moveTo(x0, y0);
    hole.lineTo(x1, y0);
    hole.lineTo(x1, y1);
    hole.lineTo(x0, y1);
    hole.closePath();
    shape.holes.push(hole);
  }

  const geometry = new THREE.ExtrudeGeometry(shape, { depth: wall.thickness, bevelEnabled: false });
  geometry.translate(0, 0, -wall.thickness / 2);
  return geometry;
}

/** Extrudes a corner patch (world XY footprint from computeCornerPatches) straight up to the given height, in world space — no further placement needed. */
export function buildCornerPatchGeometry(patch: CornerPatch, height: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const [first, ...rest] = patch.points;
  shape.moveTo(first.x, -first.y);
  for (const p of rest) shape.lineTo(p.x, -p.y);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** World placement for a wall's local frame (see buildWallGeometry). */
export function wallTransform(wall: Wall): { position: [number, number, number]; rotationY: number } {
  return {
    position: [wall.start.x, 0, wall.start.y],
    rotationY: -angleRad(wall.start, wall.end),
  };
}

export function wallsBoundingBox(walls: Wall[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
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
  return { minX, maxX, minY, maxY };
}
