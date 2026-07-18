import { useEffect, useRef } from "react";
import { useDesignStore } from "../../store/useDesignStore";
import { useIsMobileViewport } from "../../lib/useIsMobileViewport";
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
  const setViewMode = useDesignStore((s) => s.setViewMode);
  const isMobile = useIsMobileViewport();
  const hasSetMobileDefaultRef = useRef(false);

  // 3D's orbit already has touch support (drei's OrbitControls touches prop);
  // 2D's pan/zoom is mouse/wheel-only, so it's a much rougher first
  // impression on a phone — this only overrides the *default* once per
  // mobile session, not a manual switch back to 2D afterward
  useEffect(() => {
    if (isMobile && !hasSetMobileDefaultRef.current) {
      hasSetMobileDefaultRef.current = true;
      if (viewMode === "2d") setViewMode("3d");
    }
    // walkthrough has no touch equivalent for WASD/mouse-look at all, so
    // it's never a valid state on mobile, unlike the one-time 2D default above
    if (isMobile && viewMode === "walkthrough") setViewMode("3d");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, viewMode]);

  return (
    <div className="relative h-full flex-1 overflow-hidden">
      <div className="absolute left-2 right-2 top-2 z-10 flex flex-wrap items-center gap-2 sm:left-4 sm:right-auto sm:top-4">
        <ViewToggle hideWalkthrough={isMobile} />
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
