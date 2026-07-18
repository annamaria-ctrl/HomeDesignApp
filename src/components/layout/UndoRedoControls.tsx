import { Undo2, Redo2 } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";

/** Visible buttons for the undo/redo history that already existed as Ctrl+Z / Ctrl+Shift+Z — most people never discover a keyboard-only shortcut. */
export function UndoRedoControls() {
  const canUndo = useDesignStore((s) => s.past.length > 0);
  const canRedo = useDesignStore((s) => s.future.length > 0);
  const undo = useDesignStore((s) => s.undo);
  const redo = useDesignStore((s) => s.redo);

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => undo()}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
        className="text-studio-ink-soft hover:bg-studio-ink/[0.06] hover:text-studio-ink flex items-center justify-center rounded-md p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-30"
      >
        <Undo2 size={15} />
      </button>
      <button
        type="button"
        onClick={() => redo()}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z)"
        className="text-studio-ink-soft hover:bg-studio-ink/[0.06] hover:text-studio-ink flex items-center justify-center rounded-md p-1.5 transition-colors disabled:pointer-events-none disabled:opacity-30"
      >
        <Redo2 size={15} />
      </button>
    </div>
  );
}
