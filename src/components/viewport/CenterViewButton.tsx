import { Maximize2 } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";

/** Re-centers and fits the 2D canvas's camera onto the current floor plan — the same fit Canvas2D already applies automatically whenever a project is opened. */
export function CenterViewButton() {
  const centerView = useDesignStore((s) => s.centerView);

  return (
    <button
      type="button"
      onClick={() => centerView()}
      title="Center view on the whole floor plan"
      className="border-studio-line bg-studio-paper/90 text-studio-ink-soft hover:text-studio-ink flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl transition-all duration-150"
    >
      <Maximize2 size={14} />
      Center view
    </button>
  );
}
