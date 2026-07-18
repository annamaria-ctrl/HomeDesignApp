import { LayoutGrid, Eye, LogOut } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Viewport } from "./Viewport";
import { AutosaveController } from "./AutosaveController";
import { useIsMobileViewport } from "../../lib/useIsMobileViewport";
import { useDesignStore } from "../../store/useDesignStore";
import { useAuthStore } from "../../store/useAuthStore";

export function Dashboard() {
  const isMobile = useIsMobileViewport();
  // kept mounted (not conditionally rendered) so its own state — active tab,
  // which Furniture category is expanded — survives leaving and re-entering
  // the walkthrough, instead of resetting every time
  const sidebarHidden = useDesignStore((s) => s.viewMode === "walkthrough");
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);

  if (isMobile) {
    return (
      <div className="app-shell-bg text-studio-ink flex h-screen w-screen flex-col overflow-hidden">
        <div className="border-studio-line/70 bg-studio-paper/80 flex shrink-0 items-center gap-2.5 border-b px-4 py-3 backdrop-blur-xl">
          <div className="from-studio-clay-light to-studio-clay flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br text-white shadow-[0_4px_14px_-3px_rgba(171,90,56,0.55)]">
            <LayoutGrid size={16} strokeWidth={2.25} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-serif text-studio-ink truncate text-[14px] font-medium tracking-tight">
              Home Design
            </div>
            <div className="text-studio-ink-soft flex items-center gap-1 text-[10px] font-medium">
              <Eye size={10} />
              View only — full editing needs a larger screen
            </div>
          </div>
          {user && (
            <button
              type="button"
              onClick={() => signOut()}
              title="Sign out"
              className="text-studio-ink-soft hover:bg-studio-ink/[0.06] hover:text-studio-brick shrink-0 rounded-md p-1.5 transition-colors"
            >
              <LogOut size={16} />
            </button>
          )}
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
