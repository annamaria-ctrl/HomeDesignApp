import {
  MousePointer2,
  Minus,
  DoorOpen,
  RectangleHorizontal,
  Ruler,
  Grid2x2,
  Footprints,
  Lightbulb,
  Hand,
} from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";
import type { ToolType } from "../../types";

// keyboard shortcut letters are kept as-is (not re-mnemonicized for English)
// since they're live key bindings handled in Canvas2D.tsx's TOOL_SHORTCUTS.
// Furniture has no button here — picking an item in the Furniture tab (the
// sidebar's "Library" tab) arms placement and switches activeTool itself.
const TOOLS: { id: ToolType; label: string; icon: typeof MousePointer2; key: string }[] = [
  { id: "select", label: "Select", icon: MousePointer2, key: "V" },
  { id: "wall", label: "Wall", icon: Minus, key: "S" },
  { id: "door", label: "Door", icon: DoorOpen, key: "D" },
  { id: "window", label: "Window", icon: RectangleHorizontal, key: "O" },
  { id: "measure", label: "Dimensions", icon: Ruler, key: "K" },
  { id: "floor", label: "Floor", icon: Grid2x2, key: "F" },
  { id: "walkStart", label: "Walk start", icon: Footprints, key: "W" },
  { id: "ceilingLight", label: "Ceiling light", icon: Lightbulb, key: "L" },
  { id: "pan", label: "Pan", icon: Hand, key: "H" },
];

export function ToolPanel() {
  const activeTool = useDesignStore((s) => s.activeTool);
  const setActiveTool = useDesignStore((s) => s.setActiveTool);

  return (
    <div>
      <div className="text-studio-ink-soft mb-2.5 px-0.5 text-[10.5px] font-semibold uppercase tracking-wider">
        Tools
      </div>
      <div className="grid grid-cols-3 gap-2">
        {TOOLS.map(({ id, label, icon: Icon, key }) => {
          const isActive = activeTool === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTool(id)}
              title={`${label} (${key})`}
              className={`group relative flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] font-medium transition-all duration-150 ${
                isActive
                  ? "border-studio-clay/35 from-studio-clay/20 to-studio-clay/5 text-studio-clay-dark bg-gradient-to-b shadow-[0_0_0_1px_rgba(171,90,56,0.12),0_8px_18px_-10px_rgba(171,90,56,0.45)]"
                  : "border-studio-line bg-studio-paper text-studio-ink-soft hover:border-studio-line-strong hover:bg-studio-paper-alt hover:text-studio-ink"
              }`}
            >
              <span
                className={`pointer-events-none absolute right-1.5 top-1.5 rounded text-[9px] font-semibold leading-none transition-opacity ${
                  isActive ? "text-studio-clay/70" : "text-studio-ink-faint opacity-0 group-hover:opacity-100"
                }`}
              >
                {key}
              </span>
              <Icon size={18} strokeWidth={1.75} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
