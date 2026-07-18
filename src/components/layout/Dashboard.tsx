import { Sidebar } from "./Sidebar";
import { Viewport } from "./Viewport";
import { AutosaveController } from "./AutosaveController";
import { useIsMobileViewport } from "../../lib/useIsMobileViewport";
import { useDesignStore } from "../../store/useDesignStore";

export function Dashboard() {
  const isMobile = useIsMobileViewport();
  // kept mounted (not conditionally rendered) so its own state — active tab,
  // which Furniture category is expanded — survives leaving and re-entering
  // the walkthrough, instead of resetting every time
  const sidebarHidden = useDesignStore((s) => s.viewMode === "walkthrough");

  if (isMobile) {
    return (
      <div className="app-shell-bg text-studio-ink flex h-screen w-screen flex-col overflow-hidden">
        <div className="border-studio-line/70 bg-studio-paper/80 shrink-0 border-b px-4 py-2 text-center text-[11px] font-medium">
          <span className="text-studio-ink-soft">
            Editing needs a larger screen — this is a view-only preview on mobile.
          </span>
        </div>
        <div className="relative flex-1 overflow-hidden">
          <Viewport readOnly />
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell-bg text-studio-ink flex h-screen w-screen overflow-hidden">
      <div
        className={`shrink-0 overflow-hidden transition-[width,opacity] duration-300 ease-in-out ${
          sidebarHidden ? "w-0 opacity-0" : "w-80 opacity-100"
        }`}
      >
        <Sidebar />
      </div>
      <Viewport />
      <AutosaveController />
    </div>
  );
}
