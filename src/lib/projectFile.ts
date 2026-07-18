import type { Wall, Opening, FurnitureItem, Room, RoomFloor, Measurement, WalkthroughStart, CeilingLight, TimeOfDay } from "../types";

export const PROJECT_FILE_VERSION = 2;

export interface ProjectData {
  walls: Wall[];
  openings: Opening[];
  furniture: FurnitureItem[];
  rooms: Room[];
  measurements: Measurement[];
  // added in v2 — optional so v1 files (and any hand-written import) still load fine
  roomFloors?: RoomFloor[];
  lastWallThickness?: number;
  gridSizeM?: number;
  showOverallDimensions?: boolean;
  showCeiling?: boolean;
  walkthroughStart?: WalkthroughStart | null;
  ceilingLights?: CeilingLight[];
  timeOfDay?: TimeOfDay;
  lightsOn?: boolean;
}

export interface ProjectFile extends ProjectData {
  version: number;
  savedAt: string;
}

export function serializeProject(data: ProjectData): string {
  const file: ProjectFile = {
    version: PROJECT_FILE_VERSION,
    savedAt: new Date().toISOString(),
    ...data,
  };
  return JSON.stringify(file, null, 2);
}

export function parseProjectFile(text: string): ProjectData {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || !Array.isArray(data.walls) || !Array.isArray(data.openings)) {
    throw new Error("The file doesn't contain the expected floor plan data.");
  }
  return {
    walls: data.walls,
    openings: data.openings,
    furniture: Array.isArray(data.furniture) ? data.furniture : [],
    rooms: Array.isArray(data.rooms) ? data.rooms : [],
    measurements: Array.isArray(data.measurements) ? data.measurements : [],
    roomFloors: Array.isArray(data.roomFloors) ? data.roomFloors : undefined,
    lastWallThickness: typeof data.lastWallThickness === "number" ? data.lastWallThickness : undefined,
    gridSizeM: typeof data.gridSizeM === "number" ? data.gridSizeM : undefined,
    showOverallDimensions: typeof data.showOverallDimensions === "boolean" ? data.showOverallDimensions : undefined,
    showCeiling: typeof data.showCeiling === "boolean" ? data.showCeiling : undefined,
    walkthroughStart:
      data.walkthroughStart &&
      typeof data.walkthroughStart.x === "number" &&
      typeof data.walkthroughStart.y === "number" &&
      typeof data.walkthroughStart.heading === "number"
        ? { x: data.walkthroughStart.x, y: data.walkthroughStart.y, heading: data.walkthroughStart.heading }
        : undefined,
    ceilingLights: Array.isArray(data.ceilingLights) ? data.ceilingLights : undefined,
    timeOfDay: data.timeOfDay === "day" || data.timeOfDay === "night" ? data.timeOfDay : undefined,
    lightsOn: typeof data.lightsOn === "boolean" ? data.lightsOn : undefined,
  };
}

export function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
