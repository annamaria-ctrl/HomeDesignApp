// Shared design-state schema — the single source of truth consumed by
// both the 2D editor and the 3D viewport. All measurements are in meters.

export interface Point {
  x: number;
  y: number;
}

export interface Wall {
  id: string;
  start: Point;
  end: Point;
  thickness: number; // meters
  height: number; // meters
}

export type OpeningType = "door" | "window";

export interface Opening {
  id: string;
  wallId: string;
  type: OpeningType;
  offset: number; // distance from wall.start along the wall, in meters
  width: number; // meters
  height: number; // meters
  sillHeight: number; // distance from floor to opening bottom, in meters (0 for doors)
  hingeAtEnd?: boolean; // door only: hinge on the wall.end-side jamb instead of wall.start-side
  swingFlipped?: boolean; // door only: leaf swings to the other side of the wall
}

export type FurnitureCategory =
  | "seating"
  | "table"
  | "storage"
  | "bed"
  | "kitchen"
  | "bathroom"
  | "lighting"
  | "decor"
  | "electronics";

export interface FurnitureItem {
  id: string;
  libraryId: string;
  category: FurnitureCategory;
  label: string;
  position: Point;
  rotation: number; // radians
  width: number; // meters
  depth: number; // meters
  height: number; // meters
  color: string;
  /** Height of the item's own floor (its base) above the room's real floor, in meters — 0 (or omitted) for anything floor-standing. Lets a wall cabinet sit above a base cabinet, or a lamp sit on a console table/cabinet top, instead of every item always resting at floor level. */
  elevation?: number;
}

export interface Room {
  id: string;
  name: string;
  wallIds: string[];
  floorMaterial: string;
}

/** A floor pattern uploaded for one detected (enclosed) room, keyed by DetectedRoom.key from roomDetection.ts. */
export interface RoomFloor {
  key: string;
  textureDataUrl: string;
  tileSizeM: number; // real-world size one tile of the source image represents, for repeat scaling
}

/** Ties a measurement endpoint to a live point on a wall (its centerline at t=0, or either face at t along its length), so the endpoint tracks the wall instead of staying at a fixed spot. */
export interface MeasurementAnchor {
  wallId: string;
  t: number; // 0..1 position along the wall's start->end
  side: -1 | 0 | 1; // which line: 0 = centerline, +1/-1 = the wall's two faces
}

/** A manual dimension annotation drawn with the "Dimensions" tool (2D-only, not a physical object). */
export interface Measurement {
  id: string;
  start: Point;
  end: Point;
  startAnchor?: MeasurementAnchor | null;
  endAnchor?: MeasurementAnchor | null;
}

export type ViewMode = "2d" | "3d" | "walkthrough";

export type ToolType =
  | "select"
  | "wall"
  | "door"
  | "window"
  | "furniture"
  | "measure"
  | "floor"
  | "walkStart"
  | "ceilingLight"
  | "pan";

/** Where the walkthrough camera spawns and which way it's initially facing. */
export interface WalkthroughStart extends Point {
  heading: number; // radians, same 2D-plane convention as FurnitureItem.rotation (atan2, 0 = facing +x)
}

/** A ceiling-mounted light fixture — just a plain bulb for now, real fixture models later. Its on/off state is the shared `lightsOn` master switch, not per-fixture. */
export interface CeilingLight {
  id: string;
  position: Point;
}

export type TimeOfDay = "day" | "night";

export interface DesignState {
  walls: Wall[];
  openings: Opening[];
  furniture: FurnitureItem[];
  rooms: Room[];
  roomFloors: RoomFloor[];
  measurements: Measurement[];
  ceilingLights: CeilingLight[];
  viewMode: ViewMode;
  activeTool: ToolType;
  selectedIds: string[];
  selectedRoomKey: string | null;
  lastWallThickness: number; // meters — remembered from the last drawn/edited wall
  gridSizeM: number; // meters — spacing of the major grid line in the 2D view
  showOverallDimensions: boolean; // 2D-only: show the floor plan's overall width/height
  showCeiling: boolean; // 3D/walkthrough-only: render a ceiling plane over each enclosed room
  walkthroughStart: WalkthroughStart | null; // null means "auto (biggest room's center, facing +x)"
  timeOfDay: TimeOfDay; // 3D/walkthrough-only: which outdoor lighting to render
  lightsOn: boolean; // 3D/walkthrough-only: master switch for every placed ceiling light
}
