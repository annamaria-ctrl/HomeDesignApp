import { useDesignStore } from "../../store/useDesignStore";
import { ViewToggle } from "../viewport/ViewToggle";
import { GridSizeControl } from "../viewport/GridSizeControl";
import { OverallDimensionsToggle } from "../viewport/OverallDimensionsToggle";
import { CeilingToggle } from "../viewport/CeilingToggle";
import { TimeOfDayToggle } from "../viewport/TimeOfDayToggle";
import { LightsToggle } from "../viewport/LightsToggle";
import { CenterViewButton } from "../viewport/CenterViewButton";
import { Canvas2D } from "../viewport/Canvas2D";
import { Scene3D, WalkthroughScene } from "../viewport/Scene3D";
import { PropertiesPanel } from "../viewport/PropertiesPanel";

export function Viewport({ readOnly = false }: { readOnly?: boolean } = {}) {
  const viewMode = useDesignStore((s) => s.viewMode);

  return (
    <div className="relative h-full flex-1 overflow-hidden">
      <div className="absolute left-4 top-4 z-10 flex items-center gap-2">
        <ViewToggle />
        {viewMode === "2d" && !readOnly && <GridSizeControl />}
        {viewMode === "2d" && <OverallDimensionsToggle />}
        {viewMode === "2d" && <CenterViewButton />}
        {/* walkthrough always renders the ceiling (see Scene3D.tsx's WalkthroughScene) — this toggle wouldn't do anything there */}
        {viewMode === "3d" && <CeilingToggle />}
        {viewMode !== "2d" && <TimeOfDayToggle />}
        {viewMode !== "2d" && <LightsToggle />}
      </div>
      {/* editing controls (size/color/rotation/etc.) never make sense when read-only — nothing in this panel is viewable-only */}
      {viewMode !== "walkthrough" && !readOnly && <PropertiesPanel />}

      {viewMode === "2d" && <Canvas2D readOnly={readOnly} />}
      {viewMode === "3d" && <Scene3D readOnly={readOnly} />}
      {viewMode === "walkthrough" && <WalkthroughScene />}
    </div>
  );
}
