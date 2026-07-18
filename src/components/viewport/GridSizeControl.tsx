import { useDesignStore } from "../../store/useDesignStore";

const GRID_SIZE_OPTIONS_M = [0.5, 1];

function formatGridSize(m: number): string {
  return m < 1 ? `${Math.round(m * 100)}cm` : `${m}m`;
}

export function GridSizeControl() {
  const gridSizeM = useDesignStore((s) => s.gridSizeM);
  const setGridSizeM = useDesignStore((s) => s.setGridSizeM);

  return (
    <div className="border-studio-line bg-studio-paper/90 flex items-center gap-1 rounded-xl border p-1 shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
      <span className="text-studio-ink-soft pl-1.5 text-[10px] font-semibold uppercase tracking-wider">Grid</span>
      {GRID_SIZE_OPTIONS_M.map((size) => {
        const isActive = gridSizeM === size;
        return (
          <button
            key={size}
            type="button"
            onClick={() => setGridSizeM(size)}
            className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-all duration-150 ${
              isActive
                ? "from-studio-clay to-studio-clay-dark bg-gradient-to-b text-white shadow-[0_4px_14px_-4px_rgba(171,90,56,0.6)]"
                : "text-studio-ink-soft hover:text-studio-ink"
            }`}
          >
            {formatGridSize(size)}
          </button>
        );
      })}
    </div>
  );
}
