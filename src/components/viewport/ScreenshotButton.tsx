import { Camera } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";

/** Captures the current 3D view and downloads it as a PNG — Scene3D watches screenshotRequest the same way Canvas2D watches viewCenterRequest. */
export function ScreenshotButton() {
  const requestScreenshot = useDesignStore((s) => s.requestScreenshot);

  return (
    <button
      type="button"
      onClick={() => requestScreenshot()}
      title="Save a screenshot of the 3D view"
      className="border-studio-line bg-studio-paper/90 text-studio-ink-soft hover:text-studio-ink flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl transition-all duration-150"
    >
      <Camera size={14} />
      Screenshot
    </button>
  );
}
