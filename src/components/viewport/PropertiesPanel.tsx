import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  FlipHorizontal,
  RefreshCw,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Ruler,
  RotateCcw,
  RotateCw,
  Upload,
  Trash2,
} from "lucide-react";
import { useDesignStore } from "../../store/useDesignStore";
import { fitOpeningOnWall } from "../../lib/openingGeometry";
import { computeAlignmentDeltas, type AlignMode, type Alignable } from "../../lib/alignment";
import { computeInnerDimension } from "../../lib/innerDimension";
import { computeRooms } from "../../lib/roomDetection";
import { resolveFurniturePlacement, furnitureCollisionSize, type FurnitureObstacle } from "../../lib/furnitureCollision";
import { isCeilingHung } from "../../lib/furnitureMounting";
import type { FurnitureItem } from "../../types";

function furnitureObstacles(items: FurnitureItem[], excludeIds: string[]): FurnitureObstacle[] {
  return items
    .filter((f) => !excludeIds.includes(f.id))
    .map((f) => {
      const size = furnitureCollisionSize(f);
      return {
        id: f.id,
        position: f.position,
        width: size.width,
        depth: size.depth,
        rotation: f.rotation,
        elevation: f.elevation ?? 0,
        height: f.height,
      };
    });
}

const ALIGN_OPTIONS: { mode: AlignMode; label: string; icon: typeof AlignHorizontalJustifyStart }[] = [
  { mode: "left", label: "Align left", icon: AlignHorizontalJustifyStart },
  { mode: "centerH", label: "Align center (horizontal)", icon: AlignHorizontalJustifyCenter },
  { mode: "right", label: "Align right", icon: AlignHorizontalJustifyEnd },
  { mode: "top", label: "Align top", icon: AlignVerticalJustifyStart },
  { mode: "middleV", label: "Align center (vertical)", icon: AlignVerticalJustifyCenter },
  { mode: "bottom", label: "Align bottom", icon: AlignVerticalJustifyEnd },
];

const MIN_THICKNESS_CM = 5;
const MAX_THICKNESS_CM = 50;
const MIN_HEIGHT_CM = 200;
const MAX_HEIGHT_CM = 400;
const MIN_OPENING_WIDTH_CM = 40;
const MAX_OPENING_WIDTH_CM = 300;
const THICKNESS_PRESETS_CM = [10, 15, 20, 30, 50];
const MIN_FURNITURE_SIZE_CM = 5;
const MAX_FURNITURE_WIDTH_CM = 500;
const MAX_FURNITURE_HEIGHT_CM = 300;
const FURNITURE_COLOR_PRESETS = [
  "#8a6a4a", // warm wood
  "#f2eee3", // white
  "#dcd0ba", // bouclé/oatmeal
  "#9ca382", // sage
  "#ab5a38", // terracotta
  "#ddd0b8", // travertine
  "#4a3b2c", // charcoal
  "#c9a06a", // rattan
];
const DEFAULT_FLOOR_TILE_SIZE_M = 1;
const MIN_FLOOR_TILE_CM = 10;
const MAX_FLOOR_TILE_CM = 500;
const FLOOR_TEXTURE_MAX_DIM_PX = 512;

/** Downscales+recompresses an uploaded image before it goes into localStorage, so a multi-MB photo doesn't blow the quota. */
function readAndDownscaleImage(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Failed to load the image"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D is not available"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function NumberField({
  label,
  valueCm,
  min,
  max,
  unit = "cm",
  onCommit,
}: {
  label: string;
  valueCm: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (cm: number) => void;
}) {
  const [draft, setDraft] = useState(String(valueCm));

  useEffect(() => {
    setDraft(String(valueCm));
  }, [valueCm]);

  function commit() {
    const parsed = Math.round(Number(draft));
    const cm = Math.min(max, Math.max(min, parsed || min));
    setDraft(String(cm));
    onCommit(cm);
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
  }

  return (
    <label className="flex items-center gap-2">
      <span className="text-studio-ink-soft flex-1">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="tabular-nums border-studio-line bg-studio-bg/60 text-studio-ink focus:border-studio-clay/60 w-16 rounded-md border px-2 py-1 text-right transition-colors focus:outline-none"
      />
      <span className="text-studio-ink-faint">{unit}</span>
    </label>
  );
}

export function PropertiesPanel() {
  const walls = useDesignStore((s) => s.walls);
  const openings = useDesignStore((s) => s.openings);
  const measurements = useDesignStore((s) => s.measurements);
  const furniture = useDesignStore((s) => s.furniture);
  const selectedIds = useDesignStore((s) => s.selectedIds);
  const updateWall = useDesignStore((s) => s.updateWall);
  const updateOpening = useDesignStore((s) => s.updateOpening);
  const updateMeasurement = useDesignStore((s) => s.updateMeasurement);
  const updateFurniture = useDesignStore((s) => s.updateFurniture);
  const addMeasurement = useDesignStore((s) => s.addMeasurement);
  const setSelection = useDesignStore((s) => s.setSelection);
  const setLastWallThickness = useDesignStore((s) => s.setLastWallThickness);
  const pushHistory = useDesignStore((s) => s.pushHistory);
  const selectedRoomKey = useDesignStore((s) => s.selectedRoomKey);
  const roomFloors = useDesignStore((s) => s.roomFloors);
  const setRoomFloor = useDesignStore((s) => s.setRoomFloor);
  const setRoomFloorTileSize = useDesignStore((s) => s.setRoomFloorTileSize);
  const removeRoomFloor = useDesignStore((s) => s.removeRoomFloor);

  const selectedWalls = walls.filter((w) => selectedIds.includes(w.id));
  const selectedOpenings = openings.filter((o) => selectedIds.includes(o.id));
  const selectedMeasurements = measurements.filter((m) => selectedIds.includes(m.id));
  const selectedFurniture = furniture.filter((f) => selectedIds.includes(f.id));
  const alignableCount = selectedWalls.length + selectedMeasurements.length;

  const rooms = useMemo(() => computeRooms(walls), [walls]);
  const selectedRoom = selectedRoomKey ? rooms.find((r) => r.key === selectedRoomKey) : undefined;
  const selectedRoomFloor = selectedRoomKey ? roomFloors.find((rf) => rf.key === selectedRoomKey) : undefined;
  // every distinct pattern already used somewhere, minus the current room's
  // own — so a room can pick up a floor another room already has instead of
  // uploading (and re-compressing) the same image file a second time
  const reusableFloorTextures = useMemo(() => {
    const seen = new Set<string>();
    const unique: typeof roomFloors = [];
    for (const rf of roomFloors) {
      if (rf.key === selectedRoomKey || seen.has(rf.textureDataUrl)) continue;
      seen.add(rf.textureDataUrl);
      unique.push(rf);
    }
    return unique;
  }, [roomFloors, selectedRoomKey]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (
    selectedWalls.length === 0 &&
    selectedOpenings.length === 0 &&
    selectedMeasurements.length === 0 &&
    selectedFurniture.length === 0 &&
    !selectedRoom
  )
    return null;

  const thicknessCm = selectedWalls.length > 0 ? Math.round(selectedWalls[0].thickness * 100) : 0;
  const heightCm = selectedWalls.length > 0 ? Math.round(selectedWalls[0].height * 100) : 0;
  const rotationDeg =
    selectedFurniture.length > 0 ? Math.round(((selectedFurniture[0].rotation * 180) / Math.PI) % 360) : 0;
  const furnitureWidthCm = selectedFurniture.length > 0 ? Math.round(selectedFurniture[0].width * 100) : 0;
  const furnitureDepthCm = selectedFurniture.length > 0 ? Math.round(selectedFurniture[0].depth * 100) : 0;
  const furnitureHeightCm = selectedFurniture.length > 0 ? Math.round(selectedFurniture[0].height * 100) : 0;
  const furnitureElevationCm = selectedFurniture.length > 0 ? Math.round((selectedFurniture[0].elevation ?? 0) * 100) : 0;
  // curtains/drapes always hang from the ceiling down — their vertical position is
  // derived automatically (see Scene3D's effectiveElevation), so the Elevation field
  // would just be dead weight, and "Height" reads more sensibly relabeled as "Length"
  const selectedAllCeilingHung = selectedFurniture.length > 0 && selectedFurniture.every((f) => isCeilingHung(f.libraryId));
  const furnitureColor = selectedFurniture.length > 0 ? selectedFurniture[0].color : "#8b7355";

  function resolveGeometryChange(
    item: FurnitureItem,
    changes: Partial<Pick<FurnitureItem, "width" | "depth" | "height" | "rotation">>,
  ) {
    const merged = { ...item, ...changes };
    const size = furnitureCollisionSize(merged);
    const obstacles = furnitureObstacles(furniture, [item.id]);
    return resolveFurniturePlacement(
      merged.position,
      size.width,
      size.depth,
      merged.rotation,
      walls,
      openings,
      obstacles,
      merged.elevation ?? 0,
      merged.height,
    );
  }

  function applyFurnitureWidth(cm: number) {
    pushHistory();
    for (const f of selectedFurniture) {
      const width = cm / 100;
      updateFurniture(f.id, { width, position: resolveGeometryChange(f, { width }) });
    }
  }

  function applyFurnitureDepth(cm: number) {
    pushHistory();
    for (const f of selectedFurniture) {
      const depth = cm / 100;
      updateFurniture(f.id, { depth, position: resolveGeometryChange(f, { depth }) });
    }
  }

  function applyFurnitureHeight(cm: number) {
    pushHistory();
    for (const f of selectedFurniture) {
      const height = cm / 100;
      updateFurniture(f.id, { height, position: resolveGeometryChange(f, { height }) });
    }
  }

  function applyFurnitureElevation(cm: number) {
    pushHistory();
    const elevation = cm / 100;
    for (const f of selectedFurniture) updateFurniture(f.id, { elevation });
  }

  function applyFurnitureColor(color: string) {
    pushHistory();
    for (const f of selectedFurniture) updateFurniture(f.id, { color });
  }

  async function handleFloorFile(file: File) {
    if (!selectedRoomKey) return;
    const dataUrl = await readAndDownscaleImage(file, FLOOR_TEXTURE_MAX_DIM_PX);
    setRoomFloor(selectedRoomKey, dataUrl, selectedRoomFloor?.tileSizeM ?? DEFAULT_FLOOR_TILE_SIZE_M);
  }

  function applyFloorTileSize(cm: number) {
    if (!selectedRoomKey) return;
    setRoomFloorTileSize(selectedRoomKey, cm / 100);
  }

  function applyRotationDeg(deg: number) {
    pushHistory();
    const rad = (deg * Math.PI) / 180;
    for (const f of selectedFurniture) {
      updateFurniture(f.id, { rotation: rad, position: resolveGeometryChange(f, { rotation: rad }) });
    }
  }

  function nudgeRotation(deltaDeg: number) {
    pushHistory();
    const rad = (deltaDeg * Math.PI) / 180;
    for (const f of selectedFurniture) {
      const rotation = f.rotation + rad;
      updateFurniture(f.id, { rotation, position: resolveGeometryChange(f, { rotation }) });
    }
  }

  function applyAlign(mode: AlignMode) {
    const items: Alignable[] = [
      ...selectedWalls.map((w) => ({ id: w.id, start: w.start, end: w.end })),
      ...selectedMeasurements.map((m) => ({ id: m.id, start: m.start, end: m.end })),
    ];
    const deltas = computeAlignmentDeltas(items, mode);
    pushHistory();
    for (const w of selectedWalls) {
      const d = deltas.get(w.id);
      if (!d) continue;
      updateWall(w.id, {
        start: { x: w.start.x + d.x, y: w.start.y + d.y },
        end: { x: w.end.x + d.x, y: w.end.y + d.y },
      });
    }
    for (const m of selectedMeasurements) {
      const d = deltas.get(m.id);
      if (!d) continue;
      updateMeasurement(m.id, {
        start: { x: m.start.x + d.x, y: m.start.y + d.y },
        end: { x: m.end.x + d.x, y: m.end.y + d.y },
      });
    }
  }

  function applyInnerDimension() {
    if (selectedWalls.length !== 2) return;
    const [wallA, wallB] = selectedWalls;
    const { start, end, startAnchor, endAnchor } = computeInnerDimension(wallA, wallB);
    pushHistory();
    const id = addMeasurement({ start, end, startAnchor, endAnchor });
    setSelection([id]);
  }

  function applyThickness(cm: number) {
    pushHistory();
    for (const w of selectedWalls) updateWall(w.id, { thickness: cm / 100 });
    setLastWallThickness(cm / 100);
  }

  function applyHeight(cm: number) {
    pushHistory();
    for (const w of selectedWalls) updateWall(w.id, { height: cm / 100 });
  }

  return (
    <div className="pointer-events-auto border-studio-line bg-studio-paper/90 text-studio-ink-soft absolute right-4 top-4 z-10 flex w-56 flex-col gap-3 rounded-xl border px-4 py-3.5 text-xs shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_20px_36px_-18px_rgba(43,36,28,0.4)] backdrop-blur-xl">
      {alignableCount >= 2 && (
        <div className="border-studio-line flex flex-col gap-2 border-b pb-3">
          <div className="text-studio-ink-soft text-[10.5px] font-semibold uppercase tracking-wider">
            Align ({alignableCount})
          </div>
          <div className="grid grid-cols-6 gap-1">
            {ALIGN_OPTIONS.map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                title={label}
                onClick={() => applyAlign(mode)}
                className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark hover:bg-studio-clay/10 flex items-center justify-center rounded-md border p-1.5 transition-all duration-150"
              >
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedWalls.length === 2 && (
        <div className="border-studio-line flex flex-col gap-2 border-b pb-3">
          <button
            type="button"
            onClick={applyInnerDimension}
            className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark hover:bg-studio-clay/10 flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-all duration-150"
          >
            <Ruler size={13} />
            Inner dimension
          </button>
        </div>
      )}

      {selectedWalls.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className="text-studio-ink-soft text-[10.5px] font-semibold uppercase tracking-wider">
            {selectedWalls.length > 1 ? `Walls (${selectedWalls.length})` : "Wall"}
          </div>
          <NumberField
            label="Thickness"
            valueCm={thicknessCm}
            min={MIN_THICKNESS_CM}
            max={MAX_THICKNESS_CM}
            onCommit={applyThickness}
          />
          <div className="flex flex-wrap gap-1">
            {THICKNESS_PRESETS_CM.map((cm) => (
              <button
                key={cm}
                type="button"
                onClick={() => applyThickness(cm)}
                title={`${cm} cm`}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-all duration-150 ${
                  thicknessCm === cm
                    ? "border-studio-clay/40 bg-studio-clay/15 text-studio-clay-dark"
                    : "border-studio-line text-studio-ink-faint hover:border-studio-line-strong hover:text-studio-ink"
                }`}
              >
                {cm}
              </button>
            ))}
          </div>
          <NumberField
            label="Ceiling height"
            valueCm={heightCm}
            min={MIN_HEIGHT_CM}
            max={MAX_HEIGHT_CM}
            onCommit={applyHeight}
          />
        </div>
      )}

      {selectedFurniture.length > 0 && (
        <div className="border-studio-line flex flex-col gap-2.5 border-t pt-3 first:border-t-0 first:pt-0">
          <div className="text-studio-ink-soft text-[10.5px] font-semibold uppercase tracking-wider">
            {selectedFurniture.length > 1 ? `Furniture (${selectedFurniture.length})` : selectedFurniture[0].label}
          </div>
          <NumberField
            label="Width"
            valueCm={furnitureWidthCm}
            min={MIN_FURNITURE_SIZE_CM}
            max={MAX_FURNITURE_WIDTH_CM}
            onCommit={applyFurnitureWidth}
          />
          <NumberField
            label="Depth"
            valueCm={furnitureDepthCm}
            min={MIN_FURNITURE_SIZE_CM}
            max={MAX_FURNITURE_WIDTH_CM}
            onCommit={applyFurnitureDepth}
          />
          <NumberField
            label={selectedAllCeilingHung ? "Length" : "Height"}
            valueCm={furnitureHeightCm}
            min={MIN_FURNITURE_SIZE_CM}
            max={MAX_FURNITURE_HEIGHT_CM}
            onCommit={applyFurnitureHeight}
          />
          {selectedAllCeilingHung ? (
            <p className="text-studio-ink-faint text-[10.5px] leading-snug">Hangs from the ceiling automatically — adjust Length above to change how far down it reaches.</p>
          ) : (
            <NumberField
              label="Elevation"
              valueCm={furnitureElevationCm}
              min={0}
              max={MAX_FURNITURE_HEIGHT_CM}
              onCommit={applyFurnitureElevation}
            />
          )}
          <div className="flex items-center gap-2">
            <span className="text-studio-ink-soft flex-1">Color</span>
            <input
              type="color"
              value={furnitureColor}
              onChange={(e) => applyFurnitureColor(e.target.value)}
              className="border-studio-line h-7 w-9 cursor-pointer rounded-md border bg-transparent p-0.5"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FURNITURE_COLOR_PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                title={hex}
                onClick={() => applyFurnitureColor(hex)}
                style={{ backgroundColor: hex }}
                className={`h-5 w-5 rounded-full border transition-transform duration-150 hover:scale-110 ${
                  furnitureColor.toLowerCase() === hex
                    ? "border-studio-clay ring-studio-clay/40 ring-2"
                    : "border-studio-line"
                }`}
              />
            ))}
          </div>
          <NumberField label="Rotation" valueCm={rotationDeg} min={0} max={359} unit="°" onCommit={applyRotationDeg} />
          <div className="flex items-center gap-2">
            <span className="text-studio-ink-soft flex-1">Quick rotate</span>
            <button
              type="button"
              title="Rotate 90° left"
              onClick={() => nudgeRotation(-90)}
              className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark rounded-md border p-1.5 transition-all duration-150"
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              title="Rotate 90° right"
              onClick={() => nudgeRotation(90)}
              className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark rounded-md border p-1.5 transition-all duration-150"
            >
              <RotateCw size={14} />
            </button>
          </div>
        </div>
      )}

      {selectedOpenings.length > 0 && (
        <div className="border-studio-line flex flex-col gap-2.5 border-t pt-3 first:border-t-0 first:pt-0">
          <div className="text-studio-ink-soft text-[10.5px] font-semibold uppercase tracking-wider">
            {selectedOpenings.length > 1
              ? `Openings (${selectedOpenings.length})`
              : selectedOpenings[0].type === "door"
                ? "Door"
                : "Window"}
          </div>
          <NumberField
            label="Width"
            valueCm={Math.round(selectedOpenings[0].width * 100)}
            min={MIN_OPENING_WIDTH_CM}
            max={MAX_OPENING_WIDTH_CM}
            onCommit={(cm) => {
              pushHistory();
              const widthM = cm / 100;
              for (const o of selectedOpenings) {
                const wall = walls.find((w) => w.id === o.wallId);
                if (!wall) continue;
                const fit = fitOpeningOnWall(wall, o.offset, widthM, openings, o.id);
                updateOpening(o.id, { width: widthM, offset: fit.offset });
              }
            }}
          />
          {selectedOpenings.some((o) => o.type === "door") && (
            <div className="flex items-center gap-2">
              <span className="text-studio-ink-soft flex-1">Orientation</span>
              <button
                type="button"
                title="Flip hinge side"
                onClick={() => {
                  pushHistory();
                  for (const o of selectedOpenings) {
                    if (o.type === "door") updateOpening(o.id, { hingeAtEnd: !o.hingeAtEnd });
                  }
                }}
                className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark rounded-md border p-1.5 transition-all duration-150"
              >
                <RefreshCw size={14} />
              </button>
              <button
                type="button"
                title="Flip swing side"
                onClick={() => {
                  pushHistory();
                  for (const o of selectedOpenings) {
                    if (o.type === "door") updateOpening(o.id, { swingFlipped: !o.swingFlipped });
                  }
                }}
                className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark rounded-md border p-1.5 transition-all duration-150"
              >
                <FlipHorizontal size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {selectedRoom && (
        <div className="border-studio-line flex flex-col gap-2.5 border-t pt-3 first:border-t-0 first:pt-0">
          <div className="text-studio-ink-soft text-[10.5px] font-semibold uppercase tracking-wider">
            Floor ({selectedRoom.area.toFixed(1)} m²)
          </div>
          {reusableFloorTextures.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-studio-ink-faint text-[10px] font-medium">Reuse from another room</div>
              <div className="flex flex-wrap gap-1.5">
                {reusableFloorTextures.map((rf) => (
                  <button
                    key={rf.key}
                    type="button"
                    onClick={() => selectedRoomKey && setRoomFloor(selectedRoomKey, rf.textureDataUrl, rf.tileSizeM)}
                    title="Use this pattern"
                    className="border-studio-line hover:border-studio-clay h-9 w-9 shrink-0 rounded-md border bg-cover bg-center transition-colors"
                    style={{ backgroundImage: `url(${rf.textureDataUrl})` }}
                  />
                ))}
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleFloorFile(file);
            }}
          />
          {selectedRoomFloor ? (
            <>
              <div className="flex items-center gap-2">
                <div
                  className="border-studio-line h-12 w-12 shrink-0 rounded-md border bg-cover bg-center"
                  style={{ backgroundImage: `url(${selectedRoomFloor.textureDataUrl})` }}
                />
                <div className="flex flex-1 flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark hover:bg-studio-clay/10 flex items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150"
                  >
                    <Upload size={12} />
                    Change pattern
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRoomFloor(selectedRoom.key)}
                    className="border-studio-line text-studio-ink-soft hover:border-studio-brick/50 hover:text-studio-brick flex items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150"
                  >
                    <Trash2 size={12} />
                    Remove
                  </button>
                </div>
              </div>
              <NumberField
                label="Tile size"
                valueCm={Math.round(selectedRoomFloor.tileSizeM * 100)}
                min={MIN_FLOOR_TILE_CM}
                max={MAX_FLOOR_TILE_CM}
                onCommit={applyFloorTileSize}
              />
            </>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="border-studio-line text-studio-ink-soft hover:border-studio-clay/50 hover:text-studio-clay-dark hover:bg-studio-clay/10 flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-all duration-150"
            >
              <Upload size={13} />
              Upload floor pattern
            </button>
          )}
        </div>
      )}
    </div>
  );
}
