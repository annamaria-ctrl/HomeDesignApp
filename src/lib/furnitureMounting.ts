/**
 * Catalog items that hang from the ceiling rather than sitting at a manually
 * set height above the floor — currently just curtains/drapes. For these,
 * `height` means the item's own length (how far it hangs down), and its
 * vertical position is always derived from the room's ceiling height instead
 * of the item's own (irrelevant, hidden) elevation field.
 */
const CEILING_HUNG_LIBRARY_IDS = new Set(["curtain-panel", "sheer-curtain"]);

export function isCeilingHung(libraryId: string): boolean {
  return CEILING_HUNG_LIBRARY_IDS.has(libraryId);
}

/** Where a ceiling-hung item's own floor (its base) should sit, given the room's ceiling height and the item's own length — never below the real floor if it's longer than the ceiling is tall. */
export function ceilingHungElevation(ceilingHeight: number, itemHeight: number): number {
  return Math.max(0, ceilingHeight - itemHeight);
}

/** The elevation to actually use for placement/collision — item.elevation for anything normal, or the ceiling-derived one for curtains, so a floor-level collision check doesn't wrongly treat a hanging curtain as sitting on the floor. */
export function effectiveElevation(item: { libraryId: string; height: number; elevation?: number }, ceilingHeight: number): number {
  return isCeilingHung(item.libraryId) ? ceilingHungElevation(ceilingHeight, item.height) : (item.elevation ?? 0);
}
