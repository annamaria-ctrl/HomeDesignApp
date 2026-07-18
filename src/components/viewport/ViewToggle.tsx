import { Square, Box, Footprints } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";
import type { ViewMode } from "../../types";

const OPTIONS: { id: ViewMode; label: string; icon: typeof Square }[] = [
  { id: "2d", label: "2D", icon: Square },
  { id: "3d", label: "3D", icon: Box },
  { id: "walkthrough", label: "Walkthrough", icon: Footprints },
];

/** `hideWalkthrough` — the walkthrough's WASD/mouse-lock controls need a keyboard and a mouse that can be pointer-locked, neither of which a touchscreen has, so it's not offered there. */
export function ViewToggle({ hideWalkthrough = false }: { hideWalkthrough?: boolean } = {}) {
  const viewMode = useDesignStore((s) => s.viewMode);
  const setViewMode = useDesignStore((s) => s.setViewMode);
  const options = hideWalkthrough ? OPTIONS.filter((o) => o.id !== "walkthrough") : OPTIONS;

  return (
    <div className="border-studio-line bg-studio-paper/90 flex rounded-xl border p-1 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
      {options.map(({ id, label, icon: Icon }) => {
        const isActive = viewMode === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setViewMode(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150 ${
              isActive
                ? "from-studio-clay to-studio-clay-dark bg-gradient-to-b text-white shadow-[0_4px_14px_-4px_rgba(171,90,56,0.6)]"
                : "text-studio-ink-soft hover:text-studio-ink"
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
