import { useEffect, useState } from "react";
import {
  Sofa,
  Armchair,
  Table2,
  Table,
  Archive,
  Box,
  BedDouble,
  Refrigerator,
  ChefHat,
  Bath,
  Lamp,
  LampFloor,
  LampDesk,
  Flower2,
  Sprout,
  Grid2x2,
  Tv,
  Speaker,
  Circle,
  ChevronDown,
  Toilet,
  Frame,
  Rows3,
  Diamond,
  Layers3,
  MonitorSmartphone,
  Router,
  ScreenShare,
  Fan,
  PackageOpen,
  RockingChair,
  Clock,
  Flame,
  BookOpen,
  Gamepad2,
  Cctv,
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
  { key: "charcoal", label: "charcoal upholstered", color: "#4a4a4a" },
  { key: "sage", label: "sage upholstered", color: "#8a9678" },
  { key: "natural-linen", label: "natural linen", color: "#ded2b8" },
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
  { id: "straight-sofa-linen", label: "Straight sofa – linen", category: "seating", icon: Sofa, width: 2.2, depth: 0.9, height: 0.75, color: "#d8d0bc" },
  { id: "loveseat-sage", label: "Loveseat – sage", category: "seating", icon: Sofa, width: 1.6, depth: 0.85, height: 0.72, color: "#9ca382" },
  { id: "wood-dining-chair", label: "Wood dining chair", category: "seating", icon: Armchair, width: 0.45, depth: 0.5, height: 0.85, color: "#7a5738" },
  { id: "chaise-lounge", label: "Chaise lounge", category: "seating", icon: RockingChair, width: 1.6, depth: 0.75, height: 0.75, color: "#c7bca3" },
  { id: "bar-stool", label: "Bar stool", category: "seating", icon: Circle, width: 0.35, depth: 0.35, height: 0.75, color: "#8a7458" },
  { id: "ottoman-bench", label: "Ottoman bench", category: "seating", icon: Circle, width: 1.1, depth: 0.4, height: 0.45, color: "#b9a086" },
  { id: "wingback-chair", label: "Wingback chair", category: "seating", icon: Armchair, width: 0.85, depth: 0.9, height: 1.1, color: "#6b4c3a" },
  { id: "recliner-chair", label: "Recliner chair", category: "seating", icon: Armchair, width: 0.95, depth: 0.95, height: 1.05, color: "#8a7458" },
  { id: "chesterfield-sofa", label: "Chesterfield sofa", category: "seating", icon: Sofa, width: 2.1, depth: 0.95, height: 0.8, color: "#7a4a3a" },
  { id: "sectional-sofa", label: "Sectional sofa", category: "seating", icon: Sofa, width: 2.6, depth: 0.95, height: 0.85, color: "#9ca382" },
  { id: "bean-bag-chair", label: "Bean bag chair", category: "seating", icon: Circle, width: 0.8, depth: 0.8, height: 0.7, color: "#4a4a4a" },
  { id: "rocking-chair", label: "Rocking chair", category: "seating", icon: RockingChair, width: 0.65, depth: 0.9, height: 1.05, color: "#7a5738" },
  { id: "accent-chair-velvet", label: "Accent chair – velvet", category: "seating", icon: Armchair, width: 0.8, depth: 0.78, height: 0.78, color: "#5f4b6b" },
  { id: "swivel-egg-chair", label: "Swivel egg chair", category: "seating", icon: Armchair, width: 0.85, depth: 0.85, height: 1.1, color: "#e8dcc0" },
  { id: "counter-stool", label: "Counter stool", category: "seating", icon: Circle, width: 0.35, depth: 0.35, height: 0.65, color: "#8a7458" },
  { id: "bench-seat-oak", label: "Bench seat – oak", category: "seating", icon: Armchair, width: 1.2, depth: 0.4, height: 0.85, color: "#c9a06a" },

  { id: "dining-table", label: "Dining table", category: "table", icon: Table2, width: 1.6, depth: 0.9, height: 0.75, color: "#6b4c3a" },
  // seats 10 (4+4 along the sides + 1 at each end): 65cm/person along the side, 1.1m depth for comfortable end seating
  { id: "dining-table-10", label: "Dining table for 10", category: "table", icon: Table2, width: 3.0, depth: 1.1, height: 0.75, color: "#6b4c3a" },
  { id: "coffee-table-travertine", label: "Coffee table – travertine", category: "table", icon: Circle, width: 0.9, depth: 0.9, height: 0.35, color: "#ddd0b8" },
  { id: "dining-table-round-4", label: "Round dining table – 4", category: "table", icon: Table2, width: 1.1, depth: 1.1, height: 0.75, color: "#6b4c3a" },
  { id: "dining-table-round-6", label: "Round dining table – 6", category: "table", icon: Table2, width: 1.5, depth: 1.5, height: 0.75, color: "#6b4c3a" },
  { id: "bistro-table", label: "Bistro table – 2", category: "table", icon: Table2, width: 0.7, depth: 0.7, height: 0.75, color: "#ddd0b8" },
  { id: "console-table", label: "Console table", category: "table", icon: Table, width: 1.1, depth: 0.35, height: 0.78, color: "#7a5738" },
  { id: "writing-desk", label: "Writing desk", category: "table", icon: Table, width: 1.2, depth: 0.6, height: 0.75, color: "#6b4c3a" },
  { id: "side-table-wood", label: "Side table – wood", category: "table", icon: Circle, width: 0.5, depth: 0.5, height: 0.45, color: "#8a7458" },
  { id: "nesting-tables", label: "Nesting tables", category: "table", icon: Table, width: 0.7, depth: 0.45, height: 0.45, color: "#ddd0b8" },
  { id: "dining-table-6", label: "Dining table – 6", category: "table", icon: Table2, width: 2.0, depth: 0.95, height: 0.75, color: "#6b4c3a" },
  { id: "coffee-table-glass", label: "Coffee table – glass", category: "table", icon: Circle, width: 1.0, depth: 0.55, height: 0.4, color: "#cfe6ea" },
  { id: "coffee-table-rect-wood", label: "Coffee table – rect. wood", category: "table", icon: Table2, width: 1.1, depth: 0.55, height: 0.4, color: "#6b4c3a" },
  { id: "pub-table", label: "Pub table", category: "table", icon: Table2, width: 0.6, depth: 0.6, height: 1.05, color: "#6b4c3a" },
  { id: "drop-leaf-table", label: "Drop-leaf table", category: "table", icon: Table2, width: 1.2, depth: 0.8, height: 0.75, color: "#8a7458" },
  { id: "trestle-table", label: "Trestle table", category: "table", icon: Table2, width: 2.0, depth: 0.9, height: 0.75, color: "#6b4c3a" },
  { id: "vanity-desk", label: "Vanity desk", category: "table", icon: Table, width: 1.1, depth: 0.45, height: 0.75, color: "#e8dcc0" },
  { id: "drafting-table", label: "Drafting table", category: "table", icon: Table, width: 1.1, depth: 0.7, height: 1.0, color: "#6b4c3a" },
  { id: "accent-table-marble", label: "Accent table – marble", category: "table", icon: Circle, width: 0.45, depth: 0.45, height: 0.5, color: "#f5f5f5" },
  { id: "folding-table", label: "Folding table", category: "table", icon: Table, width: 0.9, depth: 0.6, height: 0.74, color: "#c9a06a" },

  { id: "single-bed", label: "Single bed", category: "bed", icon: BedDouble, width: 0.9, depth: 2.0, height: 0.5, color: "#9c8467" },
  ...BEDS,
  { id: "queen-bed", label: "Queen bed", category: "bed", icon: BedDouble, width: 1.53, depth: 2.03, height: 0.5, color: "#c9a86a" },
  { id: "king-bed", label: "King bed", category: "bed", icon: BedDouble, width: 1.93, depth: 2.03, height: 0.5, color: "#5c5c5c" },
  { id: "bunk-bed", label: "Bunk bed", category: "bed", icon: BedDouble, width: 1.0, depth: 2.0, height: 1.6, color: "#7a5738" },
  { id: "sleigh-bed", label: "Sleigh bed", category: "bed", icon: BedDouble, width: 1.6, depth: 2.1, height: 1.1, color: "#5c4632" },
  { id: "canopy-bed", label: "Canopy bed", category: "bed", icon: BedDouble, width: 1.6, depth: 2.1, height: 0.5, color: "#5c4632" },
  { id: "murphy-bed-closed", label: "Murphy bed (closed)", category: "bed", icon: Archive, width: 1.6, depth: 0.3, height: 2.1, color: "#8a7458" },
  { id: "daybed-frame", label: "Daybed frame", category: "bed", icon: BedDouble, width: 0.95, depth: 2.0, height: 0.55, color: "#9ca382" },
  { id: "crib", label: "Crib", category: "bed", icon: BedDouble, width: 0.7, depth: 1.3, height: 0.9, color: "#f2eee3" },
  { id: "queen-bed-walnut", label: "Queen bed – walnut", category: "bed", icon: BedDouble, width: 1.53, depth: 2.03, height: 0.5, color: "#7a5738" },
  { id: "king-bed-tufted-navy", label: "King bed – tufted navy", category: "bed", icon: BedDouble, width: 1.93, depth: 2.03, height: 0.5, color: "#3a4a5c" },
  { id: "bed-frame-metal-black", label: "Bed frame – metal black", category: "bed", icon: BedDouble, width: 1.53, depth: 2.03, height: 0.5, color: "#2a2a2a" },
  { id: "full-bed", label: "Full bed", category: "bed", icon: BedDouble, width: 1.37, depth: 1.91, height: 0.5, color: "#c9a86a" },
  { id: "toddler-bed", label: "Toddler bed", category: "bed", icon: BedDouble, width: 0.7, depth: 1.4, height: 0.35, color: "#e8dcc0" },

  { id: "wardrobe-modern", label: "Wardrobe", category: "storage", icon: Archive, width: 1.2, depth: 0.6, height: 2.0, color: "#5c5c5c" },
  { id: "bookshelf", label: "Bookshelf", category: "storage", icon: Box, width: 0.9, depth: 0.3, height: 1.9, color: "#c9a06a" },
  { id: "dresser-6drawer", label: "Dresser", category: "storage", icon: Archive, width: 1.4, depth: 0.5, height: 0.85, color: "#5c5c5c" },
  { id: "nightstand", label: "Nightstand", category: "storage", icon: Archive, width: 0.5, depth: 0.4, height: 0.55, color: "#7a5738" },
  { id: "sideboard", label: "Sideboard", category: "storage", icon: Archive, width: 1.6, depth: 0.45, height: 0.8, color: "#5c5c5c" },
  { id: "media-console", label: "Media console", category: "storage", icon: Archive, width: 1.8, depth: 0.4, height: 0.5, color: "#2a2a2a" },
  { id: "ladder-shelf", label: "Ladder shelf", category: "storage", icon: Rows3, width: 0.6, depth: 0.35, height: 1.8, color: "#7a5738" },
  { id: "storage-bench", label: "Storage bench", category: "storage", icon: Archive, width: 1.1, depth: 0.4, height: 0.45, color: "#8a7458" },
  { id: "trunk-chest", label: "Trunk chest", category: "storage", icon: PackageOpen, width: 0.9, depth: 0.45, height: 0.45, color: "#6b4c3a" },
  { id: "display-cabinet", label: "Display cabinet", category: "storage", icon: Archive, width: 1.0, depth: 0.4, height: 1.8, color: "#5c5c5c" },
  { id: "filing-cabinet", label: "Filing cabinet", category: "storage", icon: Archive, width: 0.45, depth: 0.55, height: 0.7, color: "#5c5c5c" },
  { id: "armoire", label: "Armoire", category: "storage", icon: Archive, width: 1.4, depth: 0.65, height: 2.1, color: "#5c4632" },
  { id: "shoe-cabinet", label: "Shoe cabinet", category: "storage", icon: Archive, width: 0.9, depth: 0.35, height: 0.9, color: "#e8e4da" },
  { id: "corner-shelf-unit", label: "Corner shelf unit", category: "storage", icon: Rows3, width: 0.6, depth: 0.6, height: 1.6, color: "#7a5738" },
  { id: "floating-shelf-tower", label: "Floating shelf tower", category: "storage", icon: Rows3, width: 0.5, depth: 0.3, height: 1.6, color: "#5c4632" },
  { id: "cubby-organizer", label: "Cubby organizer", category: "storage", icon: Grid2x2, width: 1.1, depth: 0.35, height: 1.1, color: "#e8e4da" },
  { id: "china-hutch", label: "China hutch", category: "storage", icon: Archive, width: 1.3, depth: 0.5, height: 2.0, color: "#5c4632" },
  { id: "coat-rack", label: "Coat rack", category: "storage", icon: Box, width: 0.4, depth: 0.4, height: 1.8, color: "#3a3a3a" },
  { id: "umbrella-stand", label: "Umbrella stand", category: "storage", icon: Box, width: 0.25, depth: 0.25, height: 0.5, color: "#5c5c5c" },
  { id: "blanket-basket", label: "Blanket basket", category: "storage", icon: Circle, width: 0.5, depth: 0.5, height: 0.4, color: "#c9a06a" },

  { id: "kitchen-island", label: "Kitchen island", category: "kitchen", icon: ChefHat, width: 2.0, depth: 0.9, height: 0.9, color: "#3d3d3d" },
  { id: "fridge-modern", label: "Fridge", category: "kitchen", icon: Refrigerator, width: 0.75, depth: 0.7, height: 1.85, color: "#d8d8d8" },
  { id: "kitchen-range", label: "Range / oven", category: "kitchen", icon: ChefHat, width: 0.76, depth: 0.65, height: 0.9, color: "#2a2a2a" },
  { id: "dishwasher", label: "Dishwasher", category: "kitchen", icon: ChefHat, width: 0.6, depth: 0.6, height: 0.85, color: "#d8d8d8" },
  { id: "bar-cart", label: "Bar cart", category: "kitchen", icon: ChefHat, width: 0.7, depth: 0.4, height: 0.85, color: "#c9a86a" },
  { id: "farmhouse-sink-cabinet", label: "Farmhouse sink cabinet", category: "kitchen", icon: ChefHat, width: 0.9, depth: 0.6, height: 0.9, color: "#f5f5f0" },
  { id: "wine-fridge", label: "Wine fridge", category: "kitchen", icon: Refrigerator, width: 0.45, depth: 0.6, height: 0.85, color: "#2a2a2a" },
  { id: "kitchen-cart", label: "Kitchen cart", category: "kitchen", icon: ChefHat, width: 0.9, depth: 0.5, height: 0.9, color: "#e8e4da" },
  { id: "pantry-cabinet", label: "Pantry cabinet", category: "kitchen", icon: Archive, width: 0.9, depth: 0.6, height: 2.1, color: "#f5f5f0" },
  { id: "kitchen-cabinet-run", label: "Kitchen cabinet run", category: "kitchen", icon: ChefHat, width: 2.4, depth: 0.6, height: 0.9, color: "#5c5c5c" },
  { id: "microwave-cart", label: "Microwave cart", category: "kitchen", icon: ChefHat, width: 0.6, depth: 0.5, height: 0.9, color: "#e8e4da" },
  { id: "double-oven-tower", label: "Double oven tower", category: "kitchen", icon: ChefHat, width: 0.76, depth: 0.65, height: 2.05, color: "#2a2a2a" },
  { id: "breakfast-bar-island", label: "Breakfast bar island", category: "kitchen", icon: ChefHat, width: 2.2, depth: 1.0, height: 1.05, color: "#3d3d3d" },
  { id: "spice-rack-cabinet", label: "Spice rack cabinet", category: "kitchen", icon: Archive, width: 0.4, depth: 0.4, height: 1.9, color: "#f5f5f0" },
  { id: "kitchen-hutch", label: "Kitchen hutch", category: "kitchen", icon: Archive, width: 1.3, depth: 0.5, height: 2.0, color: "#5c4632" },
  { id: "coffee-station-cart", label: "Coffee station cart", category: "kitchen", icon: ChefHat, width: 0.65, depth: 0.4, height: 0.85, color: "#7a5738" },
  { id: "compost-bin-cabinet", label: "Compost bin cabinet", category: "kitchen", icon: ChefHat, width: 0.5, depth: 0.5, height: 0.6, color: "#5c5c5c" },
  { id: "kitchen-peninsula", label: "Kitchen peninsula", category: "kitchen", icon: ChefHat, width: 2.6, depth: 0.9, height: 0.9, color: "#3d3d3d" },
  { id: "undercounter-freezer", label: "Undercounter freezer", category: "kitchen", icon: Refrigerator, width: 0.6, depth: 0.65, height: 0.85, color: "#d8d8d8" },
  { id: "butcher-block-cart", label: "Butcher block cart", category: "kitchen", icon: ChefHat, width: 0.9, depth: 0.5, height: 0.9, color: "#c9a06a" },

  { id: "bathtub-freestanding", label: "Freestanding bathtub", category: "bathroom", icon: Bath, width: 1.7, depth: 0.75, height: 0.55, color: "#f5f5f5" },
  { id: "vanity-sink", label: "Vanity sink", category: "bathroom", icon: Bath, width: 0.9, depth: 0.5, height: 0.85, color: "#f2f2f2" },
  { id: "toilet", label: "Toilet", category: "bathroom", icon: Toilet, width: 0.4, depth: 0.65, height: 0.75, color: "#f5f5f5" },
  { id: "bidet", label: "Bidet", category: "bathroom", icon: Toilet, width: 0.38, depth: 0.55, height: 0.4, color: "#f5f5f5" },
  { id: "shower-enclosure", label: "Shower enclosure", category: "bathroom", icon: Bath, width: 0.9, depth: 0.9, height: 2.0, color: "#e8e4da" },
  { id: "pedestal-sink", label: "Pedestal sink", category: "bathroom", icon: Bath, width: 0.5, depth: 0.45, height: 0.85, color: "#f5f5f5" },
  { id: "double-vanity-sink", label: "Double vanity", category: "bathroom", icon: Bath, width: 1.6, depth: 0.5, height: 0.85, color: "#5c5c5c" },
  { id: "mirror-cabinet", label: "Mirror cabinet", category: "bathroom", icon: Frame, width: 0.6, depth: 0.12, height: 0.7, color: "#e8e4da" },
  { id: "linen-tower", label: "Linen tower", category: "bathroom", icon: Archive, width: 0.5, depth: 0.4, height: 1.7, color: "#f5f5f0" },
  { id: "towel-ladder", label: "Towel ladder", category: "bathroom", icon: Rows3, width: 0.55, depth: 0.3, height: 1.5, color: "#7a5738" },
  { id: "corner-shower", label: "Corner shower", category: "bathroom", icon: Bath, width: 0.9, depth: 0.9, height: 2.0, color: "#e8e4da" },
  { id: "walk-in-shower", label: "Walk-in shower", category: "bathroom", icon: Bath, width: 1.2, depth: 0.9, height: 2.0, color: "#e8e4da" },
  { id: "alcove-bathtub", label: "Alcove bathtub", category: "bathroom", icon: Bath, width: 1.6, depth: 0.75, height: 0.55, color: "#f5f5f5" },
  { id: "towel-warmer-rack", label: "Towel warmer rack", category: "bathroom", icon: Rows3, width: 0.55, depth: 0.15, height: 1.1, color: "#c9c9c9" },
  { id: "bathroom-stool", label: "Bathroom stool", category: "bathroom", icon: Circle, width: 0.32, depth: 0.32, height: 0.45, color: "#f5f5f0" },
  { id: "bath-shelf-unit", label: "Bathroom shelf unit", category: "bathroom", icon: Rows3, width: 0.6, depth: 0.25, height: 1.2, color: "#f5f5f0" },
  { id: "corner-pedestal-sink", label: "Corner pedestal sink", category: "bathroom", icon: Bath, width: 0.4, depth: 0.4, height: 0.85, color: "#f5f5f5" },
  { id: "wall-hung-toilet", label: "Wall-hung toilet", category: "bathroom", icon: Toilet, width: 0.42, depth: 0.55, height: 0.42, color: "#f5f5f5" },
  { id: "vanity-sink-marble", label: "Vanity sink – marble", category: "bathroom", icon: Bath, width: 0.9, depth: 0.5, height: 0.85, color: "#f0ece0" },
  { id: "bathtub-matte-black", label: "Bathtub – matte black", category: "bathroom", icon: Bath, width: 1.7, depth: 0.75, height: 0.55, color: "#1c1c1c" },

  { id: "floor-lamp", label: "Floor lamp", category: "lighting", icon: Lamp, width: 0.4, depth: 0.4, height: 1.6, color: "#e8dcc0" },
  { id: "table-lamp", label: "Table lamp", category: "lighting", icon: Lamp, width: 0.3, depth: 0.3, height: 0.5, color: "#e8dcc0" },
  { id: "arc-lamp", label: "Arc floor lamp", category: "lighting", icon: LampFloor, width: 0.35, depth: 0.35, height: 1.9, color: "#e8dcc0" },
  { id: "torchiere-lamp", label: "Torchiere lamp", category: "lighting", icon: LampFloor, width: 0.35, depth: 0.35, height: 1.65, color: "#e8dcc0" },
  { id: "tripod-lamp", label: "Tripod floor lamp", category: "lighting", icon: LampFloor, width: 0.55, depth: 0.55, height: 1.5, color: "#e8dcc0" },
  { id: "desk-lamp", label: "Desk lamp", category: "lighting", icon: LampDesk, width: 0.25, depth: 0.25, height: 0.4, color: "#3a3a3a" },
  { id: "floor-lantern", label: "Floor lantern", category: "lighting", icon: Lamp, width: 0.3, depth: 0.3, height: 1.1, color: "#3a3a3a" },
  { id: "floor-lamp-brass", label: "Floor lamp – brass", category: "lighting", icon: LampFloor, width: 0.4, depth: 0.4, height: 1.6, color: "#c9a86a" },
  { id: "table-lamp-ceramic", label: "Table lamp – ceramic", category: "lighting", icon: LampDesk, width: 0.3, depth: 0.3, height: 0.5, color: "#dcd0ba" },
  { id: "torchiere-lamp-black", label: "Torchiere lamp – black", category: "lighting", icon: LampFloor, width: 0.35, depth: 0.35, height: 1.65, color: "#2a2a2a" },
  { id: "globe-floor-lamp", label: "Globe floor lamp", category: "lighting", icon: LampFloor, width: 0.35, depth: 0.35, height: 1.6, color: "#f2ece0" },
  { id: "industrial-floor-lamp", label: "Industrial floor lamp", category: "lighting", icon: LampFloor, width: 0.15, depth: 0.15, height: 1.7, color: "#3a3a3a" },
  { id: "pharmacy-floor-lamp", label: "Pharmacy floor lamp", category: "lighting", icon: LampFloor, width: 0.3, depth: 0.3, height: 1.65, color: "#2a2a2a" },
  { id: "reading-lamp-adjustable", label: "Reading lamp – adjustable", category: "lighting", icon: LampDesk, width: 0.25, depth: 0.25, height: 0.5, color: "#3a3a3a" },
  { id: "floor-lamp-linen-drum", label: "Floor lamp – linen drum", category: "lighting", icon: LampFloor, width: 0.5, depth: 0.5, height: 1.55, color: "#e8dcc0" },
  { id: "torchiere-lamp-brass", label: "Torchiere lamp – brass", category: "lighting", icon: LampFloor, width: 0.35, depth: 0.35, height: 1.65, color: "#c9a86a" },
  { id: "lantern-set-small", label: "Lantern set – small", category: "lighting", icon: Lamp, width: 0.25, depth: 0.25, height: 0.8, color: "#3a3a3a" },
  { id: "floor-lamp-black-modern", label: "Floor lamp – black modern", category: "lighting", icon: LampFloor, width: 0.4, depth: 0.4, height: 1.6, color: "#2a2a2a" },
  { id: "task-lamp-clip", label: "Task lamp – clip", category: "lighting", icon: LampDesk, width: 0.2, depth: 0.2, height: 0.35, color: "#2a2a2a" },
  { id: "tripod-lamp-black", label: "Tripod lamp – black", category: "lighting", icon: LampFloor, width: 0.55, depth: 0.55, height: 1.5, color: "#2a2a2a" },

  { id: "potted-plant", label: "Potted plant", category: "decor", icon: Flower2, width: 0.4, depth: 0.4, height: 1.1, color: "#4f6b3a" },
  { id: "area-rug", label: "Area rug", category: "decor", icon: Grid2x2, width: 2.0, depth: 1.4, height: 0.02, color: "#a15c3e" },
  { id: "floor-mirror", label: "Floor mirror", category: "decor", icon: Frame, width: 0.7, depth: 0.05, height: 1.7, color: "#7a5738" },
  { id: "floor-vase-branches", label: "Floor vase with branches", category: "decor", icon: Sprout, width: 0.3, depth: 0.3, height: 1.2, color: "#c9a86a" },
  { id: "leaning-wall-art", label: "Leaning wall art", category: "decor", icon: Frame, width: 0.6, depth: 0.04, height: 0.8, color: "#a15c3e" },
  { id: "decor-sculpture", label: "Decor sculpture", category: "decor", icon: Diamond, width: 0.3, depth: 0.3, height: 0.5, color: "#c9a86a" },
  { id: "room-divider-screen", label: "Room divider screen", category: "decor", icon: Layers3, width: 1.5, depth: 0.03, height: 1.7, color: "#c9a06a" },
  { id: "blanket-ladder", label: "Blanket ladder", category: "decor", icon: Rows3, width: 0.55, depth: 0.3, height: 1.5, color: "#7a5738" },
  { id: "round-area-rug", label: "Round area rug", category: "decor", icon: Grid2x2, width: 1.6, depth: 1.6, height: 0.02, color: "#5f7a54" },
  { id: "potted-plant-large", label: "Large potted plant", category: "decor", icon: Flower2, width: 0.55, depth: 0.55, height: 1.5, color: "#4f6b3a" },
  { id: "grandfather-clock", label: "Grandfather clock", category: "decor", icon: Clock, width: 0.5, depth: 0.3, height: 1.9, color: "#5c4632" },
  { id: "candle-pillar-set", label: "Candle pillar set", category: "decor", icon: Flame, width: 0.35, depth: 0.35, height: 0.25, color: "#e8dcc0" },
  { id: "styling-stack", label: "Styling stack", category: "decor", icon: BookOpen, width: 0.35, depth: 0.35, height: 0.4, color: "#a15c3e" },
  { id: "wall-tapestry", label: "Wall tapestry", category: "decor", icon: Frame, width: 0.7, depth: 0.04, height: 1.0, color: "#c9a06a" },
  { id: "floor-vase-large-ceramic", label: "Large ceramic floor vase", category: "decor", icon: Sprout, width: 0.35, depth: 0.35, height: 1.3, color: "#5f7a54" },
  { id: "abstract-wall-art-large", label: "Abstract wall art – large", category: "decor", icon: Frame, width: 0.8, depth: 0.04, height: 1.0, color: "#3a4a5c" },
  { id: "woven-wall-hanging", label: "Woven wall hanging", category: "decor", icon: Frame, width: 0.6, depth: 0.04, height: 0.9, color: "#e8dcc0" },
  { id: "decor-sculpture-marble", label: "Decor sculpture – marble", category: "decor", icon: Diamond, width: 0.3, depth: 0.3, height: 0.5, color: "#f5f5f0" },
  { id: "runner-rug", label: "Runner rug", category: "decor", icon: Grid2x2, width: 2.4, depth: 0.8, height: 0.02, color: "#5f7a54" },
  { id: "jute-round-rug", label: "Jute round rug", category: "decor", icon: Grid2x2, width: 1.4, depth: 1.4, height: 0.02, color: "#c9a06a" },

  { id: "tv-stand", label: "TV on stand", category: "electronics", icon: Tv, width: 1.3, depth: 0.35, height: 1.3, color: "#2a2a2a" },
  { id: "tower-speaker", label: "Tower speaker", category: "electronics", icon: Speaker, width: 0.25, depth: 0.3, height: 1.0, color: "#3a3a3a" },
  { id: "tv-pole-stand", label: "TV on pole stand", category: "electronics", icon: Tv, width: 1.2, depth: 0.08, height: 1.4, color: "#111214" },
  { id: "soundbar", label: "Soundbar", category: "electronics", icon: Speaker, width: 0.9, depth: 0.12, height: 0.07, color: "#2a2a2a" },
  { id: "desktop-setup", label: "Desktop computer setup", category: "electronics", icon: MonitorSmartphone, width: 1.2, depth: 0.6, height: 1.1, color: "#e8e4da" },
  { id: "smart-speaker", label: "Smart speaker", category: "electronics", icon: Speaker, width: 0.12, depth: 0.12, height: 0.15, color: "#c9c9c9" },
  { id: "robot-vacuum-dock", label: "Robot vacuum + dock", category: "electronics", icon: Circle, width: 0.35, depth: 0.4, height: 0.4, color: "#2a2a2a" },
  { id: "wifi-router", label: "WiFi router", category: "electronics", icon: Router, width: 0.2, depth: 0.12, height: 0.04, color: "#f5f5f5" },
  { id: "projector-screen", label: "Projector screen", category: "electronics", icon: ScreenShare, width: 1.8, depth: 0.1, height: 1.6, color: "#2a2a2a" },
  { id: "air-purifier", label: "Air purifier", category: "electronics", icon: Fan, width: 0.3, depth: 0.3, height: 0.65, color: "#f5f5f0" },
  { id: "gaming-console-stand", label: "Gaming console stand", category: "electronics", icon: Gamepad2, width: 0.6, depth: 0.35, height: 0.2, color: "#2a2a2a" },
  { id: "security-camera-stand", label: "Security camera stand", category: "electronics", icon: Cctv, width: 0.15, depth: 0.15, height: 0.9, color: "#e8e4da" },
  { id: "standing-fan", label: "Standing fan", category: "electronics", icon: Fan, width: 0.45, depth: 0.45, height: 1.2, color: "#e8e4da" },
  { id: "tv-large-stand", label: "TV on stand – large", category: "electronics", icon: Tv, width: 1.7, depth: 0.4, height: 1.5, color: "#2a2a2a" },
  { id: "bluetooth-speaker-small", label: "Bluetooth speaker – small", category: "electronics", icon: Speaker, width: 0.1, depth: 0.1, height: 0.12, color: "#3a3a3a" },
  { id: "speaker-pair-floor", label: "Floor speaker pair", category: "electronics", icon: Speaker, width: 0.25, depth: 0.3, height: 0.95, color: "#2a2a2a" },
  { id: "av-shelf-unit", label: "AV shelf unit", category: "electronics", icon: Archive, width: 1.2, depth: 0.35, height: 0.5, color: "#5c5c5c" },
  { id: "smart-display-stand", label: "Smart display stand", category: "electronics", icon: MonitorSmartphone, width: 0.3, depth: 0.15, height: 0.2, color: "#e8e4da" },
  { id: "air-purifier-large", label: "Air purifier – large", category: "electronics", icon: Fan, width: 0.4, depth: 0.4, height: 0.85, color: "#e8e4da" },
  { id: "wifi-mesh-node", label: "WiFi mesh node", category: "electronics", icon: Router, width: 0.1, depth: 0.1, height: 0.03, color: "#f5f5f5" },
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
