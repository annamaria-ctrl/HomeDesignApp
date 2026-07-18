import { Lightbulb } from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";

/** Master on/off switch for every placed ceiling light at once — there's no per-fixture switch yet. */
export function LightsToggle() {
  const lightsOn = useDesignStore((s) => s.lightsOn);
  const setLightsOn = useDesignStore((s) => s.setLightsOn);

  return (
    <button
      type="button"
      onClick={() => setLightsOn(!lightsOn)}
      title={lightsOn ? "Turn lights off" : "Turn lights on"}
      className={`border-studio-line bg-studio-paper/90 flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl transition-all duration-150 ${
        lightsOn
          ? "from-studio-clay to-studio-clay-dark bg-gradient-to-b text-white"
          : "text-studio-ink-soft hover:text-studio-ink"
      }`}
    >
      <Lightbulb size={14} />
      Lights
    </button>
  );
}
