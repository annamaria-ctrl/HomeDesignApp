import type { Point } from "../types";

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function angleRad(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function snapValueToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function snapPointToGrid(point: Point, step: number): Point {
  return { x: snapValueToStep(point.x, step), y: snapValueToStep(point.y, step) };
}

/**
 * Snaps `point` onto the nearest multiple of `stepDeg` measured from `origin`,
 * but only if it's within `toleranceDeg` of that angle. Otherwise returns the
 * point unchanged.
 */
export function snapAngle(
  origin: Point,
  point: Point,
  stepDeg: number,
  toleranceDeg: number,
): Point {
  const dist = distance(origin, point);
  if (dist === 0) return point;

  const angle = angleRad(origin, point);
  const stepRad = (stepDeg * Math.PI) / 180;
  const snappedAngle = Math.round(angle / stepRad) * stepRad;
  const diffDeg = (Math.abs(angle - snappedAngle) * 180) / Math.PI;

  if (diffDeg > toleranceDeg) return point;

  return {
    x: origin.x + Math.cos(snappedAngle) * dist,
    y: origin.y + Math.sin(snappedAngle) * dist,
  };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  let t = lengthSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const closest = { x: a.x + abx * t, y: a.y + aby * t };
  return distance(p, closest);
}

/** Projects `p` onto segment a-b, clamped to the segment. `t` is 0 at a, 1 at b. */
export function projectPointOnSegment(
  p: Point,
  a: Point,
  b: Point,
): { t: number; point: Point; distance: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  let t = lengthSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  return { t, point, distance: distance(p, point) };
}

export function formatLength(meters: number): string {
  return `${meters.toFixed(2)} m`;
}
