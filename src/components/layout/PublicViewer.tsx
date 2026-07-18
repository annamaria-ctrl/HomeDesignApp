import { useEffect, useState } from "react";
import { LayoutGrid, Loader2 } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";
import { getPublicProject } from "../../lib/cloudProjects";
import { isSupabaseConfigured } from "../../lib/supabaseClient";
import { Viewport } from "./Viewport";

/**
 * The whole app when opened via a public share link (?view=<projectId>) —
 * no sign-in, no editing, just the 2D/3D/Walkthrough viewport for one
 * project. Loads into the same useDesignStore Canvas2D/Scene3D already
 * read from, but that store's persist middleware is pointed at a scratch
 * localStorage key for this session (see useDesignStore.ts) specifically so
 * this can never overwrite the current browser's own saved design.
 */
export function PublicViewer({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "not-found">("loading");
  const [projectName, setProjectName] = useState("");
  const loadDesign = useDesignStore((s) => s.loadDesign);

  useEffect(() => {
    let cancelled = false;
    if (!isSupabaseConfigured) {
      setStatus("not-found");
      return;
    }
    getPublicProject(projectId)
      .then((record) => {
        if (cancelled) return;
        loadDesign(record.data);
        setProjectName(record.name);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("not-found");
      });
    return () => {
      cancelled = true;
    };
    // load once for this projectId — loadDesign is a stable store action
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (status === "loading") {
    return (
      <div className="app-shell-bg flex h-screen w-screen items-center justify-center">
        <Loader2 size={22} className="text-studio-clay animate-spin" />
      </div>
    );
  }

  if (status === "not-found") {
    return (
      <div className="app-shell-bg text-studio-ink flex h-screen w-screen items-center justify-center p-6">
        <div className="border-studio-line bg-studio-paper max-w-md rounded-2xl border p-6 text-center shadow-lg">
          <div className="font-serif text-lg font-medium">This design isn't available</div>
          <p className="text-studio-ink-soft mt-2 text-sm">
            The link may be wrong, or the owner has turned off sharing for this project.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell-bg text-studio-ink flex h-screen w-screen flex-col overflow-hidden">
      <div className="border-studio-line/70 bg-studio-paper/80 flex shrink-0 items-center gap-2.5 border-b px-4 py-3 backdrop-blur-xl">
        <div className="from-studio-clay-light to-studio-clay flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-br text-white shadow-[0_4px_14px_-3px_rgba(171,90,56,0.55)]">
          <LayoutGrid size={14} strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <div className="font-serif text-studio-ink truncate text-[14px] font-medium tracking-tight">{projectName}</div>
          <div className="text-studio-ink-soft text-[10px] font-medium">View-only · Home Design</div>
        </div>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <Viewport readOnly />
      </div>
    </div>
  );
}
