import type { Wall, Opening } from "../types";
import { distance } from "./geometry";

const OPENING_OVERLAP_MARGIN_M = 0.03;

/** Clamps `offset` to fit `width` fully on `wall`, and flags overlap with existing openings. */
export function fitOpeningOnWall(
  wall: Wall,
  offset: number,
  width: number,
  openings: Opening[],
  excludeOpeningId?: string,
): { offset: number; valid: boolean } {
  const len = distance(wall.start, wall.end);
  const half = width / 2;
  if (len < width + 0.05) return { offset, valid: false };

  const clamped = Math.max(half, Math.min(len - half, offset));
  for (const o of openings) {
    if (o.wallId !== wall.id || o.id === excludeOpeningId) continue;
    const oHalf = o.width / 2;
    const overlaps =
      clamped - half < o.offset + oHalf + OPENING_OVERLAP_MARGIN_M &&
      clamped + half > o.offset - oHalf - OPENING_OVERLAP_MARGIN_M;
    if (overlaps) return { offset: clamped, valid: false };
  }
  return { offset: clamped, valid: true };
}
