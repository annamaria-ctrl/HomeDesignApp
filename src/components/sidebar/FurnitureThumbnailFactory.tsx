import { useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { resolveFurnitureComponent } from "../viewport/Scene3D";
import { useFurnitureThumbnailStore } from "../../store/useFurnitureThumbnailStore";
import type { FurnitureItem } from "../../types";

const THUMBNAIL_PX = 160;

/** Renders exactly one frame, reads it back as a PNG, and hands it off — this is the only place that actually touches the canvas's pixels. */
function CaptureFrame({ onCaptured }: { onCaptured: (dataUrl: string) => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    // the Canvas's actual pixel size comes from a ResizeObserver measuring
    // its container, which doesn't resolve synchronously on the same commit
    // this effect fires in — capturing immediately here occasionally grabbed
    // a stale/default-sized buffer instead of the real 160×160 one. Two
    // rAFs reliably lands after that's settled, without a hardcoded delay.
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        gl.render(scene, camera);
        onCaptured(gl.domElement.toDataURL("image/png"));
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // fires once per mount — the parent Canvas below is remounted fresh
    // (via a `key` on the subject's libraryId) for every queued item
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/**
 * Invisible catalog "photo booth": pops the next item off the thumbnail
 * queue, mounts a single off-screen Canvas sized for a small product shot,
 * renders that item's real 3D model (the same one resolveFurnitureComponent
 * picks for the actual 2D/3D/Walkthrough views), captures it as a PNG, caches
 * it, and moves on. Only ever one Canvas/WebGL context exists at a time no
 * matter how big the catalog grows — mount this once near the app root (not
 * inside the Furniture tab itself) so a still-processing queue isn't
 * interrupted by switching sidebar tabs.
 */
export function FurnitureThumbnailFactory() {
  const queue = useFurnitureThumbnailStore((s) => s.queue);
  const setThumbnail = useFurnitureThumbnailStore((s) => s.setThumbnail);
  const skip = useFurnitureThumbnailStore((s) => s.skip);
  const current = queue[0];

  if (!current) return null;

  const Model = resolveFurnitureComponent(current);
  if (!Model) {
    // the queue and resolveFurnitureComponent have drifted apart (an item
    // was enqueued that turns out to have no dedicated model) — drop it
    // rather than getting stuck rendering nothing forever
    skip(current.libraryId);
    return null;
  }

  const previewItem: FurnitureItem = {
    id: "thumbnail-preview",
    libraryId: current.libraryId,
    category: current.category,
    label: "",
    position: { x: 0, y: 0 },
    rotation: Math.PI / 5,
    width: current.width,
    depth: current.depth,
    height: current.height,
    color: current.color,
  };

  // a fixed 3/4-elevated shot direction, scaled by the item's own footprint
  // so a 0.35m lamp and a 3m dining table both roughly fill the frame
  const span = Math.max(current.width, current.depth, current.height, 0.3);
  const distance = span * 1.7 + 0.5;
  const dir = { x: 1, y: 0.8, z: 1.1 };
  const dirLen = Math.hypot(dir.x, dir.y, dir.z);
  const cameraPosition: [number, number, number] = [
    (dir.x / dirLen) * distance,
    (dir.y / dirLen) * distance,
    (dir.z / dirLen) * distance,
  ];

  return (
    <div
      style={{ position: "fixed", top: 0, left: -THUMBNAIL_PX - 50, width: THUMBNAIL_PX, height: THUMBNAIL_PX }}
      aria-hidden
    >
      <Canvas
        key={current.libraryId}
        frameloop="demand"
        gl={{ preserveDrawingBuffer: true, alpha: true }}
        camera={{ position: cameraPosition, fov: 32 }}
      >
        <ambientLight intensity={0.9} />
        <directionalLight position={[3, 5, 2]} intensity={1.1} />
        <directionalLight position={[-2, 2, -3]} intensity={0.35} />
        {/* re-centers the model vertically so the default camera-looks-at-origin
            frames its middle instead of its floor-level base */}
        <group position={[0, -current.height / 2, 0]}>
          <Model item={previewItem} selected={false} />
        </group>
        <CaptureFrame onCaptured={(dataUrl) => setThumbnail(current.libraryId, dataUrl)} />
      </Canvas>
    </div>
  );
}
