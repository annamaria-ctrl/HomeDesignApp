import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT_PX = 768;

/** True on a narrow (phone/small-tablet) viewport — the precise mouse-driven 2D drawing tools and small drag targets aren't usable at that size, so those screens get a view-only experience instead of the full editor. */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT_PX);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
