import type { MeasurementAnchor, Point, Wall } from "../types";
import { distance, projectPointOnSegment } from "./geometry";

function faceLine(w: Wall, side: 1 | -1): { start: Point; end: Point } {
  const len = distance(w.start, w.end) || 1;
  const dir = { x: (w.end.x - w.start.x) / len, y: (w.end.y - w.start.y) / len };
  const normal = { x: -dir.y, y: dir.x };
  const half = (w.thickness / 2) * side;
  return {
    start: { x: w.start.x + normal.x * half, y: w.start.y + normal.y * half },
    end: { x: w.end.x + normal.x * half, y: w.end.y + normal.y * half },
  };
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * For two (roughly opposite/facing) walls, finds each wall's face that
 * points toward the other, and returns the two points on those faces
 * closest to each other — the walls' clear/interior span, ready to drop
 * straight into a live-anchored Measurement.
 */
export function computeInnerDimension(
  wallA: Wall,
  wallB: Wall,
): { start: Point; end: Point; startAnchor: MeasurementAnchor; endAnchor: MeasurementAnchor } {
  const midA = midpoint(wallA.start, wallA.end);
  const midB = midpoint(wallB.start, wallB.end);

  const facesA: [1 | -1, ReturnType<typeof faceLine>][] = [
    [1, faceLine(wallA, 1)],
    [-1, faceLine(wallA, -1)],
  ];
  const innerA = facesA.reduce((best, cur) =>
    distance(midpoint(cur[1].start, cur[1].end), midB) < distance(midpoint(best[1].start, best[1].end), midB)
      ? cur
      : best,
  );

  const facesB: [1 | -1, ReturnType<typeof faceLine>][] = [
    [1, faceLine(wallB, 1)],
    [-1, faceLine(wallB, -1)],
  ];
  const innerB = facesB.reduce((best, cur) =>
    distance(midpoint(cur[1].start, cur[1].end), midA) < distance(midpoint(best[1].start, best[1].end), midA)
      ? cur
      : best,
  );

  // anchor the measurement at wallA's inner-face midpoint, projected across
  // onto wallB's inner face for the other end — a perpendicular clear-span
  // reading when the two walls face each other squarely
  const pointA = midpoint(innerA[1].start, innerA[1].end);
  const projB = projectPointOnSegment(pointA, innerB[1].start, innerB[1].end);

  return {
    start: pointA,
    end: projB.point,
    startAnchor: { wallId: wallA.id, t: 0.5, side: innerA[0] },
    endAnchor: { wallId: wallB.id, t: projB.t, side: innerB[0] },
  };
}
