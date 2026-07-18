import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  DesignState,
  WalkthroughStart,
  TimeOfDay,
  Point,
  Wall,
  Opening,
  FurnitureItem,
  Room,
  Measurement,
  ViewMode,
  ToolType,
} from "../types";

/** The library item picked in the sidebar, waiting to be dropped onto the canvas by the "furniture" tool. */
export type PendingFurniture = Pick<FurnitureItem, "libraryId" | "category" | "label" | "width" | "depth" | "height" | "color">;
import type { ProjectData } from "../lib/projectFile";
import { DEFAULT_WALL_THICKNESS } from "../lib/constants";

// The public share-link viewer (?view=<projectId>) loads someone else's
// project into this same store so it can reuse Canvas2D/Scene3D as-is. If
// that persisted to the normal storage key, viewing a shared link would
// silently overwrite the current browser's own in-progress design in
// localStorage — next time they opened the app normally, their own work
// would be gone, replaced by whatever they last viewed. Read once at module
// load (this only ever changes on a full page navigation, not in-SPA) so the
// two modes never share a storage key at all, rather than trying to
// pause/resume persistence at runtime.
const isPublicViewSession =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("view");
const DESIGN_STORAGE_KEY = isPublicViewSession ? "home-design-app:public-view-scratch" : "home-design-app:design";

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const HISTORY_LIMIT = 100;

interface HistorySnapshot {
  walls: Wall[];
  openings: Opening[];
  furniture: FurnitureItem[];
  rooms: Room[];
  measurements: Measurement[];
}

interface HistoryState {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

interface HistoryActions {
  /** Snapshots the current design state so a later `undo()` can restore it. Call this once per logical action (before the mutation), not per intermediate update. */
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

interface FurniturePlacementState {
  pendingFurniture: PendingFurniture | null;
}

/** Not part of the persisted design schema — a counter Canvas2D watches to know when to re-center/fit its camera onto the current content, bumped by loadDesign and by the manual "center view" action. */
interface ViewControlState {
  viewCenterRequest: number;
}

interface DesignActions {
  setViewMode: (mode: ViewMode) => void;
  setActiveTool: (tool: ToolType) => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setGridSizeM: (sizeM: number) => void;
  setShowOverallDimensions: (show: boolean) => void;
  setShowCeiling: (show: boolean) => void;
  /** Sets (or, with null, clears back to "auto") where the walkthrough camera spawns and which way it initially faces. */
  setWalkthroughStart: (start: WalkthroughStart | null) => void;
  setTimeOfDay: (time: TimeOfDay) => void;
  /** Master on/off switch for every placed ceiling light at once — there's no per-fixture switch yet. */
  setLightsOn: (on: boolean) => void;
  addCeilingLight: (position: Point) => string;
  /** The furniture library item currently armed for placement (set when a sidebar item is clicked, cleared once placed). */
  setPendingFurniture: (item: PendingFurniture | null) => void;

  /** Which detected room (by DetectedRoom.key) the "floor" tool currently has selected. */
  setSelectedRoomKey: (key: string | null) => void;
  setRoomFloor: (key: string, textureDataUrl: string, tileSizeM: number) => void;
  setRoomFloorTileSize: (key: string, tileSizeM: number) => void;
  removeRoomFloor: (key: string) => void;

  addWall: (wall: Omit<Wall, "id">) => string;
  updateWall: (id: string, patch: Partial<Omit<Wall, "id">>) => void;
  /** Remembered so newly-drawn walls default to whatever thickness was last used, instead of always the app default. */
  setLastWallThickness: (thicknessM: number) => void;

  addOpening: (opening: Omit<Opening, "id">) => string;
  updateOpening: (id: string, patch: Partial<Omit<Opening, "id">>) => void;

  /** Removes any mix of wall, opening, and/or measurement ids (e.g. from a multi-selection). */
  removeElements: (ids: string[]) => void;

  addMeasurement: (measurement: Omit<Measurement, "id">) => string;
  updateMeasurement: (id: string, patch: Partial<Omit<Measurement, "id">>) => void;

  /** Clears the current floor plan (e.g. before loading a newly-generated one). */
  resetDesign: () => void;

  /** Replaces the whole floor plan with a previously saved project. */
  loadDesign: (data: ProjectData) => void;

  /** Requests that the 2D canvas re-center/fit its camera onto the current content (also triggered automatically by loadDesign). */
  centerView: () => void;

  addFurniture: (item: Omit<FurnitureItem, "id">) => string;
  updateFurniture: (id: string, patch: Partial<Omit<FurnitureItem, "id">>) => void;
  removeFurniture: (id: string) => void;
}

export type DesignStore = DesignState & DesignActions & HistoryState & HistoryActions & FurniturePlacementState & ViewControlState;

/**
 * The single canonical definition of "what counts as a saved project" — used
 * both for the localStorage persist middleware below and, via the same
 * function, for cloud project saves (useProjectStore.ts). Previously this
 * field list was copy-pasted in three places (this partialize, a hand-
 * written Pick<> type in cloudProjects.ts, and a matching object literal in
 * useProjectStore.ts); a field added to one could silently never reach the
 * other two, with no compiler error to catch it. Now there's exactly one
 * place that lists the fields — cloudProjects.ts's PersistedDesignState type
 * is derived from this function's return type instead of re-listing them.
 */
export function selectPersistedDesignState(state: DesignState) {
  return {
    walls: state.walls,
    openings: state.openings,
    furniture: state.furniture,
    rooms: state.rooms,
    roomFloors: state.roomFloors,
    measurements: state.measurements,
    ceilingLights: state.ceilingLights,
    lastWallThickness: state.lastWallThickness,
    gridSizeM: state.gridSizeM,
    showOverallDimensions: state.showOverallDimensions,
    showCeiling: state.showCeiling,
    walkthroughStart: state.walkthroughStart,
    timeOfDay: state.timeOfDay,
    lightsOn: state.lightsOn,
  };
}

export const useDesignStore = create<DesignStore>()(
  persist<DesignStore, [], [], ReturnType<typeof selectPersistedDesignState>>(
    (set, get) => ({
      walls: [],
      openings: [],
      furniture: [],
      rooms: [],
      roomFloors: [],
      measurements: [],
      ceilingLights: [],
      viewMode: "2d",
      activeTool: "select",
      selectedIds: [],
      selectedRoomKey: null,
      lastWallThickness: DEFAULT_WALL_THICKNESS,
      gridSizeM: 1,
      showOverallDimensions: false,
      showCeiling: false,
      walkthroughStart: null,
      timeOfDay: "day",
      lightsOn: false,
      pendingFurniture: null,
      past: [],
      future: [],
      viewCenterRequest: 0,

      pushHistory: () =>
        set((state) => ({
          past: [
            ...state.past,
            {
              walls: state.walls,
              openings: state.openings,
              furniture: state.furniture,
              rooms: state.rooms,
              measurements: state.measurements,
            },
          ].slice(-HISTORY_LIMIT),
          future: [],
        })),
      undo: () =>
        set((state) => {
          if (state.past.length === 0) return state;
          const previous = state.past[state.past.length - 1];
          const current = {
            walls: state.walls,
            openings: state.openings,
            furniture: state.furniture,
            rooms: state.rooms,
            measurements: state.measurements,
          };
          return {
            past: state.past.slice(0, -1),
            future: [...state.future, current].slice(-HISTORY_LIMIT),
            walls: previous.walls,
            openings: previous.openings,
            furniture: previous.furniture,
            rooms: previous.rooms,
            measurements: previous.measurements,
            selectedIds: [],
          };
        }),
      redo: () =>
        set((state) => {
          if (state.future.length === 0) return state;
          const next = state.future[state.future.length - 1];
          const current = {
            walls: state.walls,
            openings: state.openings,
            furniture: state.furniture,
            rooms: state.rooms,
            measurements: state.measurements,
          };
          return {
            future: state.future.slice(0, -1),
            past: [...state.past, current].slice(-HISTORY_LIMIT),
            walls: next.walls,
            openings: next.openings,
            furniture: next.furniture,
            rooms: next.rooms,
            measurements: next.measurements,
            selectedIds: [],
          };
        }),

      setViewMode: (mode) => set({ viewMode: mode }),
      setActiveTool: (tool) => set({ activeTool: tool }),
      setSelection: (ids) => set({ selectedIds: ids }),
      toggleSelection: (id) =>
        set({
          selectedIds: get().selectedIds.includes(id)
            ? get().selectedIds.filter((i) => i !== id)
            : [...get().selectedIds, id],
        }),
      clearSelection: () => set({ selectedIds: [] }),
      setGridSizeM: (sizeM) => set({ gridSizeM: sizeM }),
      setShowOverallDimensions: (show) => set({ showOverallDimensions: show }),
      setShowCeiling: (show) => set({ showCeiling: show }),
      setWalkthroughStart: (start) => set({ walkthroughStart: start }),
      setTimeOfDay: (time) => set({ timeOfDay: time }),
      setLightsOn: (on) => set({ lightsOn: on }),
      addCeilingLight: (position) => {
        const id = makeId("ceilingLight");
        set({ ceilingLights: [...get().ceilingLights, { id, position }] });
        return id;
      },
      setPendingFurniture: (item) => set({ pendingFurniture: item }),

      setSelectedRoomKey: (key) => set({ selectedRoomKey: key }),
      setRoomFloor: (key, textureDataUrl, tileSizeM) =>
        set({
          roomFloors: [...get().roomFloors.filter((rf) => rf.key !== key), { key, textureDataUrl, tileSizeM }],
        }),
      setRoomFloorTileSize: (key, tileSizeM) =>
        set({
          roomFloors: get().roomFloors.map((rf) => (rf.key === key ? { ...rf, tileSizeM } : rf)),
        }),
      removeRoomFloor: (key) => set({ roomFloors: get().roomFloors.filter((rf) => rf.key !== key) }),

      addWall: (wall) => {
        const id = makeId("wall");
        set({ walls: [...get().walls, { ...wall, id }] });
        return id;
      },
      updateWall: (id, patch) =>
        set({
          walls: get().walls.map((w) => (w.id === id ? { ...w, ...patch } : w)),
        }),
      setLastWallThickness: (thicknessM) => set({ lastWallThickness: thicknessM }),

      addOpening: (opening) => {
        const id = makeId("opening");
        set({ openings: [...get().openings, { ...opening, id }] });
        return id;
      },
      updateOpening: (id, patch) =>
        set({
          openings: get().openings.map((o) => (o.id === id ? { ...o, ...patch } : o)),
        }),

      removeElements: (ids) => {
        const idSet = new Set(ids);
        const removedWallIds = new Set(get().walls.filter((w) => idSet.has(w.id)).map((w) => w.id));
        const walls = get().walls.filter((w) => !idSet.has(w.id));
        const openings = get().openings.filter((o) => !idSet.has(o.id) && !removedWallIds.has(o.wallId));
        const measurements = get().measurements.filter((m) => !idSet.has(m.id));
        const furniture = get().furniture.filter((f) => !idSet.has(f.id));
        const ceilingLights = get().ceilingLights.filter((l) => !idSet.has(l.id));
        const remainingIds = new Set([
          ...walls.map((w) => w.id),
          ...openings.map((o) => o.id),
          ...measurements.map((m) => m.id),
          ...furniture.map((f) => f.id),
          ...ceilingLights.map((l) => l.id),
        ]);
        set({
          walls,
          openings,
          measurements,
          furniture,
          ceilingLights,
          selectedIds: get().selectedIds.filter((id) => remainingIds.has(id)),
        });
      },

      addMeasurement: (measurement) => {
        const id = makeId("measure");
        set({ measurements: [...get().measurements, { ...measurement, id }] });
        return id;
      },
      updateMeasurement: (id, patch) =>
        set({
          measurements: get().measurements.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        }),

      resetDesign: () =>
        set({
          walls: [],
          openings: [],
          measurements: [],
          furniture: [],
          rooms: [],
          roomFloors: [],
          ceilingLights: [],
          selectedIds: [],
          selectedRoomKey: null,
          walkthroughStart: null,
        }),

      loadDesign: (data) =>
        set((state) => ({
          walls: data.walls,
          openings: data.openings,
          furniture: data.furniture,
          rooms: data.rooms,
          measurements: data.measurements ?? [],
          roomFloors: data.roomFloors ?? [],
          ceilingLights: data.ceilingLights ?? [],
          lastWallThickness: data.lastWallThickness ?? state.lastWallThickness,
          gridSizeM: data.gridSizeM ?? state.gridSizeM,
          showOverallDimensions: data.showOverallDimensions ?? state.showOverallDimensions,
          showCeiling: data.showCeiling ?? state.showCeiling,
          walkthroughStart: data.walkthroughStart ?? null,
          timeOfDay: data.timeOfDay ?? state.timeOfDay,
          lightsOn: data.lightsOn ?? state.lightsOn,
          selectedIds: [],
          selectedRoomKey: null,
          past: [],
          future: [],
          viewCenterRequest: state.viewCenterRequest + 1,
        })),

      centerView: () => set((state) => ({ viewCenterRequest: state.viewCenterRequest + 1 })),

      addFurniture: (item) => {
        const id = makeId("furniture");
        set({ furniture: [...get().furniture, { ...item, id }] });
        return id;
      },
      updateFurniture: (id, patch) =>
        set({
          furniture: get().furniture.map((f) => (f.id === id ? { ...f, ...patch } : f)),
        }),
      removeFurniture: (id) =>
        set({ furniture: get().furniture.filter((f) => f.id !== id) }),
    }),
    {
      name: DESIGN_STORAGE_KEY,
      partialize: selectPersistedDesignState,
    },
  ),
);
