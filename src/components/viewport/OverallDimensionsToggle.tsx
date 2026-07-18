import { Ruler } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";

export function OverallDimensionsToggle() {
  const showOverallDimensions = useDesignStore((s) => s.showOverallDimensions);
  const setShowOverallDimensions = useDesignStore((s) => s.setShowOverallDimensions);

  return (
    <button
      type="button"
      onClick={() => setShowOverallDimensions(!showOverallDimensions)}
      title="Show the floor plan's overall width and height"
      className={`border-studio-line bg-studio-paper/90 flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl transition-all duration-150 ${
        showOverallDimensions
          ? "from-studio-clay to-studio-clay-dark bg-gradient-to-b text-white"
          : "text-studio-ink-soft hover:text-studio-ink"
      }`}
    >
      <Ruler size={14} />
      Overall dimensions
    </button>
  );
}
