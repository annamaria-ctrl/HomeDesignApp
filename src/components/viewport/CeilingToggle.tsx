import { PanelTop } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";

export function CeilingToggle() {
  const showCeiling = useDesignStore((s) => s.showCeiling);
  const setShowCeiling = useDesignStore((s) => s.setShowCeiling);

  return (
    <button
      type="button"
      onClick={() => setShowCeiling(!showCeiling)}
      title="Show ceiling"
      className={`border-studio-line bg-studio-paper/90 flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl transition-all duration-150 ${
        showCeiling
          ? "from-studio-clay to-studio-clay-dark bg-gradient-to-b text-white"
          : "text-studio-ink-soft hover:text-studio-ink"
      }`}
    >
      <PanelTop size={14} />
      Ceiling
    </button>
  );
}
