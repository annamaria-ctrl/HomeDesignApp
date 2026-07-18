import { useEffect, useRef } from "react";
import { shallow } from "zustand/shallow";
import { useDesignStore, selectPersistedDesignState } from "../../store/useDesignStore";
import { useProjectStore } from "../../store/useProjectStore";

const AUTOSAVE_DEBOUNCE_MS = 1500;

/**
 * Saves the current project to the cloud automatically a short pause after
 * any edit — only once it's already been saved at least once (has a
 * currentProjectId), so a brand-new, never-saved project still needs one
 * explicit "Save to cloud" first; casual/experimental doodles don't silently
 * turn into cloud records just by being drawn.
 *
 * Renders nothing — it only watches useDesignStore from outside React
 * (zustand's own subscribe, not a selector) so it can react to *any*
 * relevant change without re-rendering anything itself. Debounced so a
 * wall-drag's dozens of intermediate updates per second collapse into a
 * single save once you actually pause.
 */
export function AutosaveController() {
  const lastSnapshotRef = useRef(selectPersistedDesignState(useDesignStore.getState()));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = useDesignStore.subscribe((state) => {
      const snapshot = selectPersistedDesignState(state);
      if (shallow(snapshot, lastSnapshotRef.current)) return;
      lastSnapshotRef.current = snapshot;

      if (!useProjectStore.getState().currentProjectId) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        useProjectStore.getState().saveCurrentProject();
      }, AUTOSAVE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return null;
}
