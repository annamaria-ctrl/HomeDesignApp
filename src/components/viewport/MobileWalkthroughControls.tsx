import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const JOYSTICK_RADIUS_PX = 46;
// left-side, bottom-heavy zone claims the joystick; a touch starting anywhere
// else is a look-drag — simple enough to not need per-element hit-testing
const JOYSTICK_ZONE_WIDTH_FRACTION = 0.45;
const JOYSTICK_ZONE_TOP_FRACTION = 0.35;
const LOOK_SENSITIVITY = 0.0032;

interface MobileWalkthroughControlsProps {
  /** Normalized [-1, 1] strafe (x) / forward (y) — read every frame by useWalkthroughMovement, written here on touchmove. */
  moveInputRef: RefObject<{ x: number; y: number }>;
  /** Accumulated look rotation in radians, already scaled — read and zeroed every frame by useTouchLook. */
  lookDeltaRef: RefObject<{ x: number; y: number }>;
}

/**
 * On-screen touch controls for the walkthrough, standing in for keyboard +
 * mouse-lock on a phone: a virtual joystick (bottom-left) for movement, and
 * drag-anywhere-else to look around, the same two-thumb scheme mobile games
 * use. Pure DOM (not part of the r3f scene) — touch listeners live on
 * `window` so they fire regardless of what's rendered on top, and the two
 * inputs are told apart purely by where each touch *started*.
 */
export function MobileWalkthroughControls({ moveInputRef, lookDeltaRef }: MobileWalkthroughControlsProps) {
  const [stickOffset, setStickOffset] = useState({ x: 0, y: 0 });
  const [stickActive, setStickActive] = useState(false);
  const joystickTouchId = useRef<number | null>(null);
  const joystickOrigin = useRef({ x: 0, y: 0 });
  const lookTouchId = useRef<number | null>(null);
  const lookLast = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const isJoystickZone = (x: number, y: number) =>
      x < window.innerWidth * JOYSTICK_ZONE_WIDTH_FRACTION && y > window.innerHeight * JOYSTICK_ZONE_TOP_FRACTION;

    function onTouchStart(e: TouchEvent) {
      for (const t of Array.from(e.changedTouches)) {
        if (joystickTouchId.current === null && isJoystickZone(t.clientX, t.clientY)) {
          joystickTouchId.current = t.identifier;
          joystickOrigin.current = { x: t.clientX, y: t.clientY };
          setStickOffset({ x: 0, y: 0 });
          setStickActive(true);
        } else if (lookTouchId.current === null && t.identifier !== joystickTouchId.current) {
          lookTouchId.current = t.identifier;
          lookLast.current = { x: t.clientX, y: t.clientY };
        }
      }
    }

    function onTouchMove(e: TouchEvent) {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === joystickTouchId.current) {
          const dx = t.clientX - joystickOrigin.current.x;
          const dy = t.clientY - joystickOrigin.current.y;
          const dist = Math.hypot(dx, dy) || 1;
          const clamped = Math.min(dist, JOYSTICK_RADIUS_PX);
          const nx = (dx / dist) * clamped;
          const ny = (dy / dist) * clamped;
          setStickOffset({ x: nx, y: ny });
          // screen-down is positive y, but "forward" should be pushing the
          // stick up, hence the flip here
          moveInputRef.current.x = nx / JOYSTICK_RADIUS_PX;
          moveInputRef.current.y = -ny / JOYSTICK_RADIUS_PX;
        } else if (t.identifier === lookTouchId.current) {
          const dx = t.clientX - lookLast.current.x;
          const dy = t.clientY - lookLast.current.y;
          lookLast.current = { x: t.clientX, y: t.clientY };
          lookDeltaRef.current.x += dx * LOOK_SENSITIVITY;
          lookDeltaRef.current.y += dy * LOOK_SENSITIVITY;
        }
      }
    }

    function onTouchEnd(e: TouchEvent) {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === joystickTouchId.current) {
          joystickTouchId.current = null;
          setStickOffset({ x: 0, y: 0 });
          setStickActive(false);
          moveInputRef.current.x = 0;
          moveInputRef.current.y = 0;
        }
        if (t.identifier === lookTouchId.current) {
          lookTouchId.current = null;
        }
      }
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [moveInputRef, lookDeltaRef]);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 touch-none select-none">
      <div
        className="border-studio-paper/50 absolute rounded-full border-2 bg-black/10 backdrop-blur-[2px]"
        style={{ left: 24, bottom: 24, width: JOYSTICK_RADIUS_PX * 2, height: JOYSTICK_RADIUS_PX * 2 }}
      >
        <div
          className="bg-studio-paper/85 border-studio-line absolute rounded-full border shadow-[0_4px_14px_-4px_rgba(0,0,0,0.5)]"
          style={{
            width: JOYSTICK_RADIUS_PX,
            height: JOYSTICK_RADIUS_PX,
            left: JOYSTICK_RADIUS_PX / 2 + stickOffset.x,
            top: JOYSTICK_RADIUS_PX / 2 + stickOffset.y,
            transition: stickActive ? "none" : "left 150ms ease-out, top 150ms ease-out",
          }}
        />
      </div>
      <div className="text-studio-paper/80 absolute bottom-8 right-6 max-w-[38%] text-right text-[11px] font-medium leading-tight [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
        Drag to look around
      </div>
    </div>
  );
}
