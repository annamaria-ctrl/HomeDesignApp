import { useEffect, useState } from "react";
import {
  Sofa,
  Armchair,
  Table2,
  Archive,
  Box,
  BedDouble,
  Refrigerator,
  ChefHat,
  Bath,
  Lamp,
  Flower2,
  Grid2x2,
  Tv,
  Speaker,
  Circle,
  ChevronDown,
} from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";
import { useFurnitureThumbnailStore } from "../../store/useFurnitureThumbnailStore";
import { resolveFurnitureComponent } from "../viewport/Scene3D";
import type { FurnitureCategory } from "../../types";

interface LibraryItem {
  id: string;
  label: string;
  category: FurnitureCategory;
  icon: typeof Sofa;
  width: number;
  depth: number;
  height: number;
  color: string;
}

const CATEGORY_LABELS: Record<FurnitureCategory, string> = {
  seating: "Seating",
  table: "Tables",
  storage: "Storage",
  bed: "Beds",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
  lighting: "Lighting",
  decor: "Decor",
  electronics: "Electronics",
};

// shown next to each collapsed category header — kept for every category
// (not just the ones with items today) so the header already looks right
// the moment storage/kitchen/bathroom/etc. get their first modeled item
const CATEGORY_ICONS: Record<FurnitureCategory, typeof Sofa> = {
  seating: Sofa,
  table: Table2,
  storage: Archive,
  bed: BedDouble,
  kitchen: Refrigerator,
  bathroom: Bath,
  lighting: Lamp,
  decor: Box,
  electronics: Tv,
};

// explicit rather than derived from LIBRARY_ITEMS' own order, so adding a new
// item never accidentally reshuffles which category shows up where — a
// category simply doesn't render at all while it has no items in it yet
// (e.g. "electronics", reserved for later)
const CATEGORY_ORDER: FurnitureCategory[] = [
  "seating",
  "table",
  "storage",
  "bed",
  "kitchen",
  "bathroom",
  "lighting",
  "decor",
  "electronics",
];

const BED_VARIANTS: { key: string; label: string; color: string }[] = [
  { key: "wood", label: "light wood", color: "#d7b98c" },
  { key: "white", label: "white", color: "#f2eee3" },
  { key: "beige", label: "beige upholstered", color: "#b9a086" },
];

// one entry per color, not per color × width — width/depth/height are all
// freely adjustable after placement from the properties panel, so a whole
// grid of near-identical catalog entries (previously 4 widths × 3 colors)
// was only duplicating what resizing already does
const BEDS: LibraryItem[] = BED_VARIANTS.map((variant) => ({
  id: `double-bed-${variant.key}`,
  label: `Double bed – ${variant.label}`,
  category: "bed" as const,
  icon: BedDouble,
  width: 1.6,
  depth: 2.0,
  height: 0.5,
  color: variant.color,
}));

// Every entry here has its own dedicated 3D model (see Scene3D.tsx's
// resolveFurnitureComponent) — items that only ever rendered as a plain box
// were removed rather than kept around looking like a placeholder; they can
// come back once they have a real model to show in both the catalog preview
// and the actual 2D/3D/Walkthrough views.
const LIBRARY_ITEMS: LibraryItem[] = [
  // current 2026 trends (quiet luxury / organic modern): bouclé, rounded shapes, rattan, travertine — see Scene3D for the full 3D models
  { id: "armchair-boucle", label: "Bouclé armchair", category: "seating", icon: Armchair, width: 0.85, depth: 0.8, height: 0.75, color: "#dcd0ba" },
  { id: "sofa-curved-sage", label: "Curved sofa – sage", category: "seating", icon: Sofa, width: 2.4, depth: 0.95, height: 0.72, color: "#9ca382" },
  { id: "rattan-chair", label: "Rattan chair", category: "seating", icon: Armchair, width: 0.75, depth: 0.75, height: 0.95, color: "#c9a06a" },
  { id: "woven-pouf", label: "Woven pouf", category: "seating", icon: Circle, width: 0.45, depth: 0.45, height: 0.4, color: "#b89468" },
  { id: "dining-table", label: "Dining table", category: "table", icon: Table2, width: 1.6, depth: 0.9, height: 0.75, color: "#6b4c3a" },
  // seats 10 (4+4 along the sides + 1 at each end): 65cm/person along the side, 1.1m depth for comfortable end seating
  { id: "dining-table-10", label: "Dining table for 10", category: "table", icon: Table2, width: 3.0, depth: 1.1, height: 0.75, color: "#6b4c3a" },
  { id: "coffee-table-travertine", label: "Coffee table – travertine", category: "table", icon: Circle, width: 0.9, depth: 0.9, height: 0.35, color: "#ddd0b8" },
  { id: "single-bed", label: "Single bed", category: "bed", icon: BedDouble, width: 0.9, depth: 2.0, height: 0.5, color: "#9c8467" },
  ...BEDS,
  { id: "wardrobe-modern", label: "Wardrobe", category: "storage", icon: Archive, width: 1.2, depth: 0.6, height: 2.0, color: "#5c5c5c" },
  { id: "bookshelf", label: "Bookshelf", category: "storage", icon: Box, width: 0.9, depth: 0.3, height: 1.9, color: "#c9a06a" },
  { id: "kitchen-island", label: "Kitchen island", category: "kitchen", icon: ChefHat, width: 2.0, depth: 0.9, height: 0.9, color: "#3d3d3d" },
  { id: "fridge-modern", label: "Fridge", category: "kitchen", icon: Refrigerator, width: 0.75, depth: 0.7, height: 1.85, color: "#d8d8d8" },
  { id: "bathtub-freestanding", label: "Freestanding bathtub", category: "bathroom", icon: Bath, width: 1.7, depth: 0.75, height: 0.55, color: "#f5f5f5" },
  { id: "vanity-sink", label: "Vanity sink", category: "bathroom", icon: Bath, width: 0.9, depth: 0.5, height: 0.85, color: "#f2f2f2" },
  { id: "floor-lamp", label: "Floor lamp", category: "lighting", icon: Lamp, width: 0.4, depth: 0.4, height: 1.6, color: "#e8dcc0" },
  { id: "table-lamp", label: "Table lamp", category: "lighting", icon: Lamp, width: 0.3, depth: 0.3, height: 0.5, color: "#e8dcc0" },
  { id: "potted-plant", label: "Potted plant", category: "decor", icon: Flower2, width: 0.4, depth: 0.4, height: 1.1, color: "#4f6b3a" },
  { id: "area-rug", label: "Area rug", category: "decor", icon: Grid2x2, width: 2.0, depth: 1.4, height: 0.02, color: "#a15c3e" },
  { id: "tv-stand", label: "TV on stand", category: "electronics", icon: Tv, width: 1.3, depth: 0.35, height: 1.3, color: "#2a2a2a" },
  { id: "tower-speaker", label: "Tower speaker", category: "electronics", icon: Speaker, width: 0.25, depth: 0.3, height: 1.0, color: "#3a3a3a" },
];

// every category shows up, even ones with nothing in them yet — an empty
// category still tells you it's coming, rather than looking like it was never planned
const CATEGORIES = CATEGORY_ORDER;

export function ElementLibrary() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<FurnitureCategory | null>(null);
  const setActiveTool = useDesignStore((s) => s.setActiveTool);
  const setPendingFurniture = useDesignStore((s) => s.setPendingFurniture);
  const thumbnails = useFurnitureThumbnailStore((s) => s.cache);
  const enqueueThumbnail = useFurnitureThumbnailStore((s) => s.enqueue);

  useEffect(() => {
    for (const item of LIBRARY_ITEMS) {
      if (resolveFurnitureComponent({ libraryId: item.id, category: item.category, height: item.height })) {
        enqueueThumbnail({ libraryId: item.id, category: item.category, width: item.width, depth: item.depth, height: item.height, color: item.color });
      }
    }
    // the catalog is a static module-level array — this only ever needs to run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelect(item: LibraryItem) {
    setSelectedId(item.id);
    setPendingFurniture({
      libraryId: item.id,
      category: item.category,
      label: item.label,
      width: item.width,
      depth: item.depth,
      height: item.height,
      color: item.color,
    });
    setActiveTool("furniture");
  }

  return (
    <div className="flex flex-col gap-2">
      {CATEGORIES.map((category) => {
        const items = LIBRARY_ITEMS.filter((i) => i.category === category);
        const isExpanded = expandedCategory === category;
        const CategoryIcon = CATEGORY_ICONS[category];
        return (
          <div key={category} className="border-studio-line overflow-hidden rounded-xl border">
            <button
              type="button"
              onClick={() => setExpandedCategory(isExpanded ? null : category)}
              className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12.5px] font-semibold transition-colors ${
                isExpanded ? "bg-studio-paper-alt text-studio-clay-dark" : "bg-studio-paper text-studio-ink hover:bg-studio-paper-alt"
              }`}
            >
              <CategoryIcon size={15} strokeWidth={1.75} />
              <span className="flex-1">{CATEGORY_LABELS[category]}</span>
              <span className="text-studio-ink-faint text-[10.5px] font-medium">{items.length}</span>
              <ChevronDown size={14} className={`transition-transform ${isExpanded ? "rotate-180" : ""}`} />
            </button>
            {isExpanded && items.length === 0 && (
              <div className="border-studio-line text-studio-ink-faint border-t px-3 py-4 text-center text-[11px]">
                No items yet — coming soon
              </div>
            )}
            {isExpanded && items.length > 0 && (
              <div className="border-studio-line grid grid-cols-2 gap-2 border-t p-2">
                {items.map((item) => {
                  const Icon = item.icon;
                  const isSelected = selectedId === item.id;
                  const thumbnail = thumbnails[item.id];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelect(item)}
                      title={`${item.width.toFixed(2)} × ${item.depth.toFixed(2)} m`}
                      className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] font-medium transition-all duration-150 ${
                        isSelected
                          ? "border-studio-clay/35 from-studio-clay/20 to-studio-clay/5 text-studio-clay-dark bg-gradient-to-b shadow-[0_0_0_1px_rgba(171,90,56,0.12),0_8px_18px_-10px_rgba(171,90,56,0.45)]"
                          : "border-studio-line bg-studio-paper text-studio-ink-soft hover:border-studio-line-strong hover:bg-studio-paper-alt hover:text-studio-ink"
                      }`}
                    >
                      {thumbnail ? (
                        <span className="bg-studio-bg/60 flex h-16 w-16 items-center justify-center overflow-hidden rounded-md">
                          <img src={thumbnail} alt="" className="h-full w-full object-contain" />
                        </span>
                      ) : (
                        <span
                          className="flex h-16 w-16 items-center justify-center rounded-md"
                          style={{ backgroundColor: `${item.color}26`, color: item.color }}
                        >
                          <Icon size={20} strokeWidth={1.75} />
                        </span>
                      )}
                      <span className="text-center leading-tight">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
