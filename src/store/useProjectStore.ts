import { create } from "zustand";
import * as cloud from "../lib/cloudProjects";
import type { ProjectSummary, PersistedDesignState } from "../lib/cloudProjects";
import { useDesignStore, selectPersistedDesignState } from "./useDesignStore";

const DEFAULT_PROJECT_NAME = "Untitled";

interface ProjectStoreState {
  currentProjectId: string | null;
  currentProjectName: string;
  currentProjectIsPublic: boolean;
  projects: ProjectSummary[];
  listStatus: "idle" | "loading" | "error";
  listError: string | null;
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  /** Surfaces failures from load/rename/delete/share — kept separate from saveError so a failed delete doesn't get misread as a failed save. */
  actionError: string | null;

  refreshProjects: () => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  saveCurrentProject: () => Promise<void>;
  saveAsNewProject: (name: string) => Promise<void>;
  /** Renames the currently open project (works before it's ever been saved — just updates the draft title locally in that case). */
  renameCurrentProject: (name: string) => Promise<void>;
  /** Renames any saved project by id, from the projects list, regardless of which project is currently open. */
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  /** Toggles the public view-only link for any saved project by id, regardless of which project is currently open. */
  setProjectPublic: (id: string, isPublic: boolean) => Promise<void>;
  startNewProject: () => void;
  reset: () => void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Supabase's PostgrestError (and its auth/storage error types) carry a
  // `.message` string but aren't `instanceof Error` in this client version —
  // without this, every failed cloud call showed the user a bare "[object
  // Object]" instead of the actual reason (missing table, RLS denial, etc.)
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}

function currentDesignSnapshot(): PersistedDesignState {
  return selectPersistedDesignState(useDesignStore.getState());
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  currentProjectId: null,
  currentProjectName: DEFAULT_PROJECT_NAME,
  currentProjectIsPublic: false,
  projects: [],
  listStatus: "idle",
  listError: null,
  saveStatus: "idle",
  saveError: null,
  actionError: null,

  refreshProjects: async () => {
    set({ listStatus: "loading", listError: null });
    try {
      const projects = await cloud.listProjects();
      set({ projects, listStatus: "idle" });
    } catch (err) {
      set({ listStatus: "error", listError: errorMessage(err) });
    }
  },

  loadProject: async (id) => {
    set({ saveStatus: "idle", saveError: null, actionError: null });
    try {
      const record = await cloud.getProject(id);
      useDesignStore.getState().loadDesign(record.data);
      set({ currentProjectId: record.id, currentProjectName: record.name, currentProjectIsPublic: record.isPublic });
    } catch (err) {
      set({ actionError: errorMessage(err) });
    }
  },

  saveCurrentProject: async () => {
    // guards against a double-click (or any re-entrant call) creating two
    // projects instead of updating one: without this, a second call fired
    // before the first's createProject resolves would still see
    // currentProjectId as null and take the "create" branch too
    if (get().saveStatus === "saving") return;
    const { currentProjectId } = get();
    set({ saveStatus: "saving", saveError: null });
    try {
      if (currentProjectId) {
        await cloud.updateProjectData(currentProjectId, currentDesignSnapshot());
      } else {
        const created = await cloud.createProject(get().currentProjectName || DEFAULT_PROJECT_NAME, currentDesignSnapshot());
        set({ currentProjectId: created.id, currentProjectName: created.name, currentProjectIsPublic: created.isPublic });
      }
      set({ saveStatus: "saved" });
      get().refreshProjects();
    } catch (err) {
      set({ saveStatus: "error", saveError: errorMessage(err) });
    }
  },

  saveAsNewProject: async (name) => {
    if (get().saveStatus === "saving") return;
    set({ saveStatus: "saving", saveError: null });
    try {
      const created = await cloud.createProject(name || DEFAULT_PROJECT_NAME, currentDesignSnapshot());
      set({ currentProjectId: created.id, currentProjectName: created.name, currentProjectIsPublic: created.isPublic, saveStatus: "saved" });
      get().refreshProjects();
    } catch (err) {
      set({ saveStatus: "error", saveError: errorMessage(err) });
    }
  },

  renameCurrentProject: async (name) => {
    const { currentProjectId } = get();
    const trimmed = name.trim() || DEFAULT_PROJECT_NAME;
    if (!currentProjectId) {
      // not saved yet — nothing to rename in the DB, just update the draft title
      set({ currentProjectName: trimmed });
      return;
    }
    await get().renameProject(currentProjectId, trimmed);
  },

  renameProject: async (id, name) => {
    const trimmed = name.trim() || DEFAULT_PROJECT_NAME;
    const previous = get().projects.find((p) => p.id === id)?.name;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      currentProjectName: s.currentProjectId === id ? trimmed : s.currentProjectName,
      actionError: null,
    }));
    try {
      await cloud.renameProject(id, trimmed);
    } catch (err) {
      // the optimistic rename above never made it to the DB — revert so the
      // UI doesn't keep showing a name that isn't actually saved
      set((s) => ({
        projects: previous === undefined ? s.projects : s.projects.map((p) => (p.id === id ? { ...p, name: previous } : p)),
        currentProjectName: s.currentProjectId === id && previous !== undefined ? previous : s.currentProjectName,
        actionError: errorMessage(err),
      }));
    }
  },

  deleteProject: async (id) => {
    set({ actionError: null });
    try {
      await cloud.deleteProject(id);
      if (get().currentProjectId === id) {
        set({ currentProjectId: null, currentProjectName: DEFAULT_PROJECT_NAME });
      }
      get().refreshProjects();
    } catch (err) {
      set({ actionError: errorMessage(err) });
    }
  },

  setProjectPublic: async (id, isPublic) => {
    const previous = get().projects.find((p) => p.id === id)?.isPublic;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, isPublic } : p)),
      currentProjectIsPublic: s.currentProjectId === id ? isPublic : s.currentProjectIsPublic,
      actionError: null,
    }));
    try {
      await cloud.setProjectPublic(id, isPublic);
    } catch (err) {
      set((s) => ({
        projects: previous === undefined ? s.projects : s.projects.map((p) => (p.id === id ? { ...p, isPublic: previous } : p)),
        currentProjectIsPublic: s.currentProjectId === id && previous !== undefined ? previous : s.currentProjectIsPublic,
        actionError: errorMessage(err),
      }));
    }
  },

  startNewProject: () => {
    useDesignStore.getState().loadDesign({ walls: [], openings: [], furniture: [], rooms: [], measurements: [] });
    set({
      currentProjectId: null,
      currentProjectName: DEFAULT_PROJECT_NAME,
      currentProjectIsPublic: false,
      saveStatus: "idle",
      saveError: null,
      actionError: null,
    });
  },

  reset: () =>
    set({
      currentProjectId: null,
      currentProjectName: DEFAULT_PROJECT_NAME,
      currentProjectIsPublic: false,
      projects: [],
      listStatus: "idle",
      listError: null,
      saveStatus: "idle",
      saveError: null,
      actionError: null,
    }),
}));
