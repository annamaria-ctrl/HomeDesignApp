import type { Point } from "../types";

export type AlignMode = "left" | "centerH" | "right" | "top" | "middleV" | "bottom";

export interface Alignable {
  id: string;
  start: Point;
  end: Point;
}

/**
 * Figma-style align: for each selected item's own bounding box (its two
 * endpoints), computes how far it needs to move so that the chosen edge (or
 * center) lines up with that same edge across the whole selection.
 */
export function computeAlignmentDeltas(items: Alignable[], mode: AlignMode): Map<string, Point> {
  const boxes = items.map((it) => ({
    id: it.id,
    minX: Math.min(it.start.x, it.end.x),
    maxX: Math.max(it.start.x, it.end.x),
    minY: Math.min(it.start.y, it.end.y),
    maxY: Math.max(it.start.y, it.end.y),
  }));

  let target: number;
  switch (mode) {
    case "left":
      target = Math.min(...boxes.map((b) => b.minX));
      break;
    case "right":
      target = Math.max(...boxes.map((b) => b.maxX));
      break;
    case "centerH":
      target = (Math.min(...boxes.map((b) => b.minX)) + Math.max(...boxes.map((b) => b.maxX))) / 2;
      break;
    case "top":
      target = Math.min(...boxes.map((b) => b.minY));
      break;
    case "bottom":
      target = Math.max(...boxes.map((b) => b.maxY));
      break;
    case "middleV":
      target = (Math.min(...boxes.map((b) => b.minY)) + Math.max(...boxes.map((b) => b.maxY))) / 2;
      break;
  }

  const deltas = new Map<string, Point>();
  for (const b of boxes) {
    let dx = 0;
    let dy = 0;
    if (mode === "left") dx = target - b.minX;
    else if (mode === "right") dx = target - b.maxX;
    else if (mode === "centerH") dx = target - (b.minX + b.maxX) / 2;
    else if (mode === "top") dy = target - b.minY;
    else if (mode === "bottom") dy = target - b.maxY;
    else if (mode === "middleV") dy = target - (b.minY + b.maxY) / 2;
    deltas.set(b.id, { x: dx, y: dy });
  }
  return deltas;
}
