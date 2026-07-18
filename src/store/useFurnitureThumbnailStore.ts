import { create } from "zustand";
import type { FurnitureCategory } from "../types";

/** Just enough of a catalog item for FurnitureThumbnailFactory to build a throwaway FurnitureItem to render and photograph. */
export interface ThumbnailSubject {
  libraryId: string;
  category: FurnitureCategory;
  width: number;
  depth: number;
  height: number;
  color: string;
}

interface FurnitureThumbnailState {
  /** libraryId -> rendered PNG data URL, kept for the whole session once generated. */
  cache: Record<string, string>;
  /** Processed one at a time by FurnitureThumbnailFactory's single hidden canvas — never rendered many-at-once, so the catalog can grow without piling up live WebGL contexts. */
  queue: ThumbnailSubject[];
  /** No-op if already cached or already queued. */
  enqueue: (subject: ThumbnailSubject) => void;
  setThumbnail: (libraryId: string, dataUrl: string) => void;
  /** Drops the head-of-queue item without caching anything — used when it turns out to have no dedicated 3D model after all. */
  skip: (libraryId: string) => void;
}

export const useFurnitureThumbnailStore = create<FurnitureThumbnailState>((set, get) => ({
  cache: {},
  queue: [],

  enqueue: (subject) => {
    const { cache, queue } = get();
    if (cache[subject.libraryId] || queue.some((s) => s.libraryId === subject.libraryId)) return;
    set({ queue: [...queue, subject] });
  },

  setThumbnail: (libraryId, dataUrl) =>
    set((s) => ({
      cache: { ...s.cache, [libraryId]: dataUrl },
      queue: s.queue.filter((subject) => subject.libraryId !== libraryId),
    })),

  skip: (libraryId) => set((s) => ({ queue: s.queue.filter((subject) => subject.libraryId !== libraryId) })),
}));
