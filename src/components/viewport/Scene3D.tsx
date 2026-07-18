import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Grid, RoundedBox, PointerLockControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl, PointerLockControls as PointerLockControlsImpl } from "three-stdlib";
import { useDesignStore } from "../../store/useDesignStore";
import { useIsMobileViewport } from "../../lib/useIsMobileViewport";
import { MobileWalkthroughControls } from "./MobileWalkthroughControls";
import type { Wall, Opening, FurnitureItem, RoomFloor, Point, CeilingLight, TimeOfDay } from "../../types";
import {
  buildWallGeometry,
  buildCornerPatchGeometry,
  computeCornerPatches,
  wallTransform,
  wallsBoundingBox,
} from "../../lib/wallGeometry";
import {
  computeRooms,
  computeRoomFloorPolygons,
  computeDoorThresholdPatches,
  type DetectedRoom,
  type DoorThresholdPatch,
} from "../../lib/roomDetection";
import {
  resolveFurniturePlacement,
  sweepFurniturePlacement,
  furnitureCollisionSize,
  type FurnitureObstacle,
} from "../../lib/furnitureCollision";

const FURNITURE_BREAKTHROUGH_DISTANCE_M = 0.45;
const CURSOR_RAYCAST_THROTTLE_MS = 80;

function furnitureObstacles(items: FurnitureItem[], excludeIds: string[]): FurnitureObstacle[] {
  return items
    .filter((f) => !excludeIds.includes(f.id))
    .map((f) => {
      const size = furnitureCollisionSize(f);
      return { id: f.id, position: f.position, width: size.width, depth: size.depth, rotation: f.rotation };
    });
}

const WALL_COLOR = "#efe7d6";
const WALL_COLOR_SELECTED = "#ab5a38";

function WallGroup({
  wall,
  openings,
  selected,
  daylight,
}: {
  wall: Wall;
  openings: Opening[];
  selected: boolean;
  daylight: boolean;
}) {
  const geometry = useMemo(() => buildWallGeometry(wall, openings), [wall, openings]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const { position, rotationY } = useMemo(
    () => wallTransform(wall),
    [wall.start.x, wall.start.y, wall.end.x, wall.end.y],
  );
  const wallColor = selected ? WALL_COLOR_SELECTED : WALL_COLOR;
  const windows = openings.filter((o) => o.type === "window");

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshStandardMaterial color={wallColor} roughness={0.9} />
      </mesh>
      {windows.map((w) => (
        <group key={w.id}>
          <mesh position={[w.offset, w.sillHeight + w.height / 2, 0]}>
            <planeGeometry args={[w.width, w.height]} />
            <meshStandardMaterial
              color="#5a8aa8"
              transparent
              opacity={0.28}
              roughness={0.1}
              metalness={0.1}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* daylight glow from this window specifically — the single "sun"
              only ever lights whichever wall happens to face its one fixed
              azimuth; every other window would otherwise stay dark even
              though a real room is lit by the sky through *all* its windows,
              not just the one the sun is directly hitting. Point (not spot)
              so it doesn't need aiming at whichever room is on which side;
              no castShadow — this is meant to read as soft fill glowing in
              from outside, not another hard-edged beam, and a shadow map
              per window would add up fast on a multi-window floor plan.
              Only at daytime — there's no sky to glow in once it's night. */}
          {daylight && (
            <pointLight
              position={[w.offset, w.sillHeight + w.height / 2, 0]}
              intensity={10}
              distance={5.5}
              decay={2}
              color="#f2ecdb"
            />
          )}
        </group>
      ))}
    </group>
  );
}

function CornerPatchMesh({ patch, height, selected }: { patch: ReturnType<typeof computeCornerPatches>[number]; height: number; selected: boolean }) {
  const geometry = useMemo(() => buildCornerPatchGeometry(patch, height), [patch, height]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color={selected ? WALL_COLOR_SELECTED : WALL_COLOR} roughness={0.9} />
    </mesh>
  );
}

/**
 * A ceiling-mounted light fixture — just a plain bulb on a short stem for
 * now (real fixture models come later). The bulb mesh always renders (it's
 * a physical object, on or off); the actual illuminating pointLight only
 * exists while `on` is true. No castShadow on the light — this is meant to
 * be added freely, room by room, and a shadow map per fixture would add up
 * fast on a floor plan with many of them.
 */
function CeilingLightFixture({ position, ceilingHeight, on }: { position: Point; ceilingHeight: number; on: boolean }) {
  const mountY = Math.max(0.3, Math.min(ceilingHeight, 2.6) - 0.08);
  const bulbY = mountY - 0.12;

  return (
    <group position={[position.x, 0, position.y]}>
      <mesh position={[0, mountY - 0.03, 0]} castShadow>
        <cylinderGeometry args={[0.015, 0.015, 0.08, 8]} />
        <meshStandardMaterial color="#4a4a4a" roughness={0.6} />
      </mesh>
      <mesh position={[0, bulbY, 0]}>
        <sphereGeometry args={[0.07, 16, 12]} />
        <meshStandardMaterial
          color={on ? "#fff2c4" : "#d8d0bd"}
          roughness={0.4}
          emissive={on ? "#ffdf94" : "#000000"}
          emissiveIntensity={on ? 1.2 : 0}
        />
      </mesh>
      {on && <pointLight position={[0, bulbY, 0]} intensity={14} distance={7} decay={2} color="#ffdca8" />}
    </group>
  );
}

/** A room's uploaded floor pattern, tiled at real-world scale and clipped to its detected polygon. */
function polygonToShape(polygon: Point[]): THREE.Shape {
  const [first, ...rest] = polygon;
  const shape = new THREE.Shape();
  shape.moveTo(first.x, -first.y);
  for (const p of rest) shape.lineTo(p.x, -p.y);
  shape.closePath();
  return shape;
}

/**
 * A room's own polygon follows its walls' inner faces, door or no door —
 * it never reaches into a wall's thickness. That leaves the doorway's own
 * threshold strip uncovered, so each bordering room's door-threshold patch
 * (see roomDetection.ts) is extruded as an extra disjoint shape in the same
 * geometry — ExtrudeGeometry accepts an array of shapes — so the floor/
 * ceiling actually flows through the doorway instead of showing a gap.
 */
function roomShapes(room: DetectedRoom, patches: DoorThresholdPatch[]): THREE.Shape[] {
  return [polygonToShape(room.polygon), ...patches.map((p) => polygonToShape(p.polygon))];
}

function RoomFloorMesh({
  room,
  patches,
  tileSizeM,
  textureDataUrl,
}: {
  room: DetectedRoom;
  patches: DoorThresholdPatch[];
  tileSizeM: number;
  textureDataUrl: string;
}) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(textureDataUrl, (tex) => {
      if (cancelled) {
        tex.dispose();
        return;
      }
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      setTexture(tex);
    });
    return () => {
      cancelled = true;
    };
  }, [textureDataUrl]);

  useEffect(() => () => texture?.dispose(), [texture]);

  const geometry = useMemo(() => {
    const geo = new THREE.ExtrudeGeometry(roomShapes(room, patches), { depth: 0.01, bevelEnabled: false });

    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) / tileSizeM;
      uv[i * 2 + 1] = -pos.getY(i) / tileSizeM;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));

    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [room, patches, tileSizeM]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  if (!texture) return null;

  return (
    <mesh geometry={geometry} position={[0, 0.012, 0]} receiveShadow>
      <meshStandardMaterial map={texture} roughness={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** The four corners of a wall's own rectangular footprint, expanded slightly so it overlaps each bordering room's polygon instead of butting a hairline seam against it. */
function wallFootprintPolygon(wall: Wall, insetM: number): Point[] {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy) || 0.0001;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const half = wall.thickness / 2 + insetM;
  return [
    { x: wall.start.x + nx * half, y: wall.start.y + ny * half },
    { x: wall.end.x + nx * half, y: wall.end.y + ny * half },
    { x: wall.end.x - nx * half, y: wall.end.y - ny * half },
    { x: wall.start.x - nx * half, y: wall.start.y - ny * half },
  ];
}

const CEILING_OVERLAP_M = 0.05;

/**
 * One continuous ceiling slab over the whole building, built by combining
 * every room's own (already-correct, per-room) dilated polygon with a
 * rectangle for every wall — one ExtrudeGeometry from that whole array of
 * shapes, all rendered as a single flat plane, so adjoining pieces read as
 * one seamless surface instead of a separate patch per room. Tracing a
 * single contour around the combined room+wall footprint directly turned
 * out to be fragile on real, more complex layouts (it could pick the wrong
 * loop and cover only part of the building); this sidesteps that by only
 * ever tracing the same per-room shapes that are already proven correct.
 *
 * A real apartment always has a roof, whether or not the "Show ceiling"
 * toggle is drawing it — so this mounts (and casts a shadow) any time there
 * are walls, regardless of that toggle. `visible` only switches its own
 * material between opaque and fully transparent; castShadow keeps blocking
 * the sun from directly above either way, so light only ever reaches a room
 * through an actual door/window opening in a wall, i.e. from the side, the
 * way it would through a real roof. (A transparent/opacity-0 mesh still
 * casts a full shadow in Three.js — the shadow depth pass doesn't sample
 * diffuse opacity unless the material opts into alpha-tested shadows.)
 */
function CeilingMesh({ rooms, walls, height, visible }: { rooms: DetectedRoom[]; walls: Wall[]; height: number; visible: boolean }) {
  const geometry = useMemo(() => {
    const shapes = [
      ...rooms.map((r) => polygonToShape(r.polygon)),
      ...walls.map((w) => polygonToShape(wallFootprintPolygon(w, CEILING_OVERLAP_M))),
    ];
    const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.01, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [rooms, walls]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    // no receiveShadow: a thin flat slab that both casts and receives its
    // own shadow self-shadow-acnes badly (this is what was showing up as a
    // patchy purple/off-color tint on its underside) — nothing is ever above
    // the ceiling to cast a shadow onto it anyway, so there's nothing to lose
    <mesh geometry={geometry} position={[0, height, 0]} castShadow>
      <meshStandardMaterial
        color={WALL_COLOR}
        roughness={0.95}
        side={THREE.DoubleSide}
        transparent={!visible}
        opacity={visible ? 1 : 0}
        depthWrite={visible}
      />
    </mesh>
  );
}

/** A simple extruded box per furniture item — enough silhouette to judge scale/placement without modeling every item. */
export function FurnitureMesh({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, item.height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[item.width, item.height, item.depth]} />
        <meshStandardMaterial color={selected ? WALL_COLOR_SELECTED : item.color} roughness={0.75} />
      </mesh>
    </group>
  );
}

const CHAIR_SEAT_SIZE = 0.42;
const CHAIR_SEAT_HEIGHT = 0.45;
const CHAIR_SEAT_THICKNESS = 0.04;
const CHAIR_BACK_HEIGHT = 0.42;
const CHAIR_LEG_THICKNESS = 0.035;
const CHAIR_FRAME_COLOR = "#4a3b2c";
const CHAIR_SEAT_COLOR = "#8a6a4a";
const CHAIR_GAP = 0.06; // clearance between a chair's front edge and the table edge

/** A simple 4-legged chair — seat, backrest and legs — facing local +Z. */
function Chair({ position, rotationY }: { position: [number, number, number]; rotationY: number }) {
  const legInset = CHAIR_SEAT_SIZE / 2 - CHAIR_LEG_THICKNESS / 2 - 0.02;
  const legOffsets: [number, number][] = [
    [-legInset, -legInset],
    [legInset, -legInset],
    [legInset, legInset],
    [-legInset, legInset],
  ];
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, CHAIR_SEAT_HEIGHT, 0]} castShadow receiveShadow>
        <boxGeometry args={[CHAIR_SEAT_SIZE, CHAIR_SEAT_THICKNESS, CHAIR_SEAT_SIZE]} />
        <meshStandardMaterial color={CHAIR_SEAT_COLOR} roughness={0.7} />
      </mesh>
      <mesh position={[0, CHAIR_SEAT_HEIGHT + CHAIR_BACK_HEIGHT / 2, -CHAIR_SEAT_SIZE / 2 + 0.025]} castShadow receiveShadow>
        <boxGeometry args={[CHAIR_SEAT_SIZE, CHAIR_BACK_HEIGHT, 0.05]} />
        <meshStandardMaterial color={CHAIR_FRAME_COLOR} roughness={0.7} />
      </mesh>
      {legOffsets.map(([x, z], i) => (
        <mesh key={i} position={[x, CHAIR_SEAT_HEIGHT / 2, z]} castShadow receiveShadow>
          <boxGeometry args={[CHAIR_LEG_THICKNESS, CHAIR_SEAT_HEIGHT, CHAIR_LEG_THICKNESS]} />
          <meshStandardMaterial color={CHAIR_FRAME_COLOR} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * A dining table modeled as an actual tabletop + legs, ringed with chairs
 * on both long sides and both ends — the seat count scales with the table's
 * own width (~1 chair per 0.75m) so this works for the 6- and 10-seat
 * catalog entries alike, not just one hardcoded layout.
 */
export function DiningTableWithChairs({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topThickness = 0.045;
  const legThickness = 0.08;
  const topColor = selected ? WALL_COLOR_SELECTED : color;

  const legInsetX = Math.min(0.15, width / 8);
  const legZ = depth / 2 - legThickness / 2 - 0.02;
  const legPairCount = width > 2.2 ? 3 : 2;
  const legXs =
    legPairCount === 2
      ? [-(width / 2 - legInsetX), width / 2 - legInsetX]
      : [-(width / 2 - legInsetX), 0, width / 2 - legInsetX];

  const sideChairCount = Math.max(1, Math.round(width / 0.75));
  const chairHalf = CHAIR_SEAT_SIZE / 2;
  const chairXs = Array.from({ length: sideChairCount }, (_, i) => -width / 2 + (width / sideChairCount) * (i + 0.5));
  const chairZOffset = depth / 2 + CHAIR_GAP + chairHalf;
  const endChairXOffset = width / 2 + CHAIR_GAP + chairHalf;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, topThickness, depth]} />
        <meshStandardMaterial color={topColor} roughness={0.5} />
      </mesh>
      {legXs.map((x) =>
        [-1, 1].map((side) => (
          <mesh key={`${x}-${side}`} position={[x, (height - topThickness) / 2, side * legZ]} castShadow receiveShadow>
            <boxGeometry args={[legThickness, height - topThickness, legThickness]} />
            <meshStandardMaterial color={topColor} roughness={0.6} />
          </mesh>
        )),
      )}

      {chairXs.map((x) => (
        <Chair key={`f${x}`} position={[x, 0, chairZOffset]} rotationY={Math.PI} />
      ))}
      {chairXs.map((x) => (
        <Chair key={`b${x}`} position={[x, 0, -chairZOffset]} rotationY={0} />
      ))}
      <Chair position={[endChairXOffset, 0, 0]} rotationY={-Math.PI / 2} />
      <Chair position={[-endChairXOffset, 0, 0]} rotationY={Math.PI / 2} />
    </group>
  );
}

const WOOD_LEG_COLOR = "#7a5738";

/** A single puffy, deeply-rounded shell (seat+arms+back as one bouclé-upholstered form) on thin peg legs. */
export function BoucleArmchair({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const seatColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = height * 0.28;
  const bodyH = height - legH;
  const legInset = 0.08;
  const legOffsets: [number, number][] = [
    [width / 2 - legInset, depth / 2 - legInset],
    [-(width / 2 - legInset), depth / 2 - legInset],
    [width / 2 - legInset, -(depth / 2 - legInset)],
    [-(width / 2 - legInset), -(depth / 2 - legInset)],
  ];

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox
        args={[width, bodyH, depth]}
        radius={Math.min(width, depth, bodyH) * 0.32}
        smoothness={4}
        position={[0, legH + bodyH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={seatColor} roughness={0.95} />
      </RoundedBox>
      {legOffsets.map(([x, z], i) => (
        <mesh key={i} position={[x, legH / 2, z]} castShadow receiveShadow>
          <cylinderGeometry args={[0.02, 0.025, legH, 10]} />
          <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** A kidney/crescent sofa approximated as a faceted arc of rounded cushion segments — how many real curved sofas are modularly built anyway. */
export function CurvedSofa({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const segments = 5;
  const arcRad = (100 * Math.PI) / 180;
  const radius = width / (2 * Math.sin(arcRad / 2));
  const segAngle = arcRad / segments;
  const segChord = 2 * radius * Math.sin(segAngle / 2) + 0.02;
  const legH = 0.1;
  const seatH = height * 0.45;
  const backH = height - seatH;
  const backThickness = 0.16;
  const zOffset = -((radius + radius * Math.cos(arcRad / 2)) / 2);

  const segs = Array.from({ length: segments }, (_, i) => {
    const theta = -arcRad / 2 + segAngle * (i + 0.5);
    return { x: radius * Math.sin(theta), z: radius * Math.cos(theta) + zOffset, rotY: theta };
  });

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {segs.map((s, i) => (
        <group key={i} position={[s.x, 0, s.z]} rotation={[0, s.rotY, 0]}>
          <RoundedBox
            args={[segChord, seatH, depth]}
            radius={0.06}
            smoothness={3}
            position={[0, legH + seatH / 2, 0]}
            castShadow
            receiveShadow
          >
            <meshStandardMaterial color={bodyColor} roughness={0.95} />
          </RoundedBox>
          <RoundedBox
            args={[segChord, backH, backThickness]}
            radius={0.06}
            smoothness={3}
            position={[0, legH + seatH + backH / 2 - 0.05, depth / 2 - backThickness / 2]}
            castShadow
            receiveShadow
          >
            <meshStandardMaterial color={bodyColor} roughness={0.95} />
          </RoundedBox>
          {[-1, 1].map((side) => (
            <mesh key={side} position={[side * (segChord / 2 - 0.08), legH / 2, depth / 2 - 0.1]} castShadow receiveShadow>
              <cylinderGeometry args={[0.018, 0.022, legH, 8]} />
              <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** Round travertine coffee table: a wide slab top on a drum pedestal. */
export function RoundStoneTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const radius = width / 2;
  const topThickness = 0.05;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const baseRadius = radius * 0.45;
  const baseHeight = height - topThickness;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius, topThickness, 40]} />
        <meshStandardMaterial color={topColor} roughness={0.35} />
      </mesh>
      <mesh position={[0, baseHeight / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[baseRadius * 0.85, baseRadius, baseHeight, 32]} />
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </mesh>
    </group>
  );
}

/** Rattan basket/egg-chair shell — a tilted partial sphere with a woven rim ring, on a pedestal leg. */
export function RattanChair({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, color } = item;
  const shellColor = selected ? WALL_COLOR_SELECTED : color;
  const seatH = 0.4;
  const shellRadius = Math.max(width, depth) / 2;
  const shellY = seatH + shellRadius * 0.55;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh
        position={[0, shellY, -depth * 0.05]}
        rotation={[0.25, 0, 0]}
        scale={[width / (2 * shellRadius), 1, depth / (2 * shellRadius)]}
        castShadow
        receiveShadow
      >
        <sphereGeometry args={[shellRadius, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.72]} />
        <meshStandardMaterial color={shellColor} roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, seatH + shellRadius * 0.98, -depth * 0.05]} rotation={[Math.PI / 2 + 0.25, 0, 0]} castShadow>
        <torusGeometry args={[shellRadius * 0.98, 0.02, 8, 32]} />
        <meshStandardMaterial color={shellColor} roughness={1} />
      </mesh>
      <mesh position={[0, seatH * 0.9, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[shellRadius * 0.7, shellRadius * 0.7, 0.08, 24]} />
        <meshStandardMaterial color="#e8ddc8" roughness={0.9} />
      </mesh>
      <mesh position={[0, seatH * 0.45, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.03, 0.05, seatH * 0.9, 12]} />
        <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[shellRadius * 0.4, shellRadius * 0.4, 0.04, 24]} />
        <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Squat woven pouf with a subtly bulging profile and a braided trim ring near the top. */
export function WovenPouf({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const poufColor = selected ? WALL_COLOR_SELECTED : color;
  const radius = width / 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius * 0.92, height, 28]} />
        <meshStandardMaterial color={poufColor} roughness={1} />
      </mesh>
      <mesh position={[0, height * 0.92, 0]} castShadow>
        <torusGeometry args={[radius * 0.98, 0.018, 8, 28]} />
        <meshStandardMaterial color={poufColor} roughness={1} />
      </mesh>
    </group>
  );
}

/** Bed frame + mattress with a draped duvet and 1-2 pillows (single vs. double width) at the head. */
export function BedWithLinens({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const frameH = height * 0.55;
  const mattressH = height * 0.45;
  const mattressY = frameH;
  const duvetH = 0.08;
  const duvetLength = depth * 0.72;
  const duvetZ = depth / 2 - duvetLength / 2;
  const pillowCount = width >= 1.3 ? 2 : 1;
  const pillowW = pillowCount === 2 ? width * 0.42 : width * 0.7;
  const pillowD = 0.35;
  const pillowH = 0.12;
  const pillowZ = -depth / 2 + pillowD / 2 + 0.04;
  const pillowXs = pillowCount === 2 ? [-width * 0.24, width * 0.24] : [0];

  return (
    <group
      position={[item.position.x, 0, item.position.y]}
      rotation={[0, -item.rotation, 0]}
      userData={{ furnitureId: item.id }}
    >
      <RoundedBox
        args={[width, frameH, depth]}
        radius={0.03}
        smoothness={2}
        position={[0, frameH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.96, mattressH, depth * 0.96]}
        radius={0.05}
        smoothness={3}
        position={[0, mattressY + mattressH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#f5f1e6" roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.92, duvetH, duvetLength]}
        radius={0.03}
        smoothness={3}
        position={[0, mattressY + mattressH + duvetH / 2 - 0.02, duvetZ]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#e9e2d0" roughness={1} />
      </RoundedBox>
      {pillowXs.map((x, i) => (
        <RoundedBox
          key={i}
          args={[pillowW, pillowH, pillowD]}
          radius={0.05}
          smoothness={3}
          position={[x, mattressY + mattressH + pillowH / 2, pillowZ]}
          rotation={[0, (i - (pillowCount - 1) / 2) * 0.05, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color="#fbfaf5" roughness={1} />
        </RoundedBox>
      ))}
    </group>
  );
}

/** Freestanding double-door wardrobe: a plain cabinet body plus a center seam and a pair of handles standing in for the doors. */
export function ModernWardrobe({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const handleY = height * 0.55;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </RoundedBox>
      <mesh position={[0, height / 2, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[0.006, height * 0.92, 0.006]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * width * 0.14, handleY, depth / 2 + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, height * 0.16, 8]} />
          <meshStandardMaterial color="#c9a86a" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** An open shelving unit: a frame of side panels and horizontal boards, with a scatter of book-like blocks for scale/life. */
export function Bookshelf({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const shelfCount = 4;
  const boardThickness = 0.03;
  const gap = (height - boardThickness) / shelfCount;
  const bookColors = ["#a15c3e", "#5f7a54", "#8f8064", "#6b4c3a", "#c9a86a"];

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (width / 2 - boardThickness / 2), height / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[boardThickness, height, depth]} />
          <meshStandardMaterial color={frameColor} roughness={0.75} />
        </mesh>
      ))}
      {Array.from({ length: shelfCount + 1 }, (_, i) => (
        <mesh key={i} position={[0, i * gap + boardThickness / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[width, boardThickness, depth]} />
          <meshStandardMaterial color={frameColor} roughness={0.75} />
        </mesh>
      ))}
      {Array.from({ length: shelfCount }, (_, shelfIdx) => {
        const bookCount = 3 + (shelfIdx % 2);
        const y = shelfIdx * gap + boardThickness;
        const bookH = gap * 0.55;
        const spacing = (width * 0.7) / bookCount;
        return Array.from({ length: bookCount }, (_, bookIdx) => (
          <mesh
            key={`${shelfIdx}-${bookIdx}`}
            position={[-width * 0.35 + spacing * bookIdx + spacing / 2, y + bookH / 2, depth * 0.15]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[0.03, bookH, depth * 0.55]} />
            <meshStandardMaterial color={bookColors[(shelfIdx + bookIdx) % bookColors.length]} roughness={0.9} />
          </mesh>
        ));
      })}
    </group>
  );
}

/** Kitchen island: a cabinet base under a slightly overhanging countertop, with a shallow inset standing in for a sink basin. */
export function KitchenIsland({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const cabinetColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.04;
  const cabinetHeight = height - topThickness;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetHeight, depth]} radius={0.02} smoothness={2} position={[0, cabinetHeight / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.6} />
      </RoundedBox>
      <RoundedBox
        args={[width + 0.04, topThickness, depth + 0.04]}
        radius={0.01}
        smoothness={2}
        position={[0, cabinetHeight + topThickness / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#e8e4da" roughness={0.3} />
      </RoundedBox>
      <mesh position={[0, cabinetHeight + topThickness - 0.005, 0]} castShadow>
        <boxGeometry args={[width * 0.3, 0.02, depth * 0.4]} />
        <meshStandardMaterial color="#9aa0a6" roughness={0.4} metalness={0.4} />
      </mesh>
    </group>
  );
}

/** Tall fridge-freezer: a rounded body, a horizontal seam splitting fridge from freezer drawer, and two handle bars. */
export function FridgeModern({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const doorSplitY = height * 0.62;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.03} smoothness={3} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.35} metalness={0.4} />
      </RoundedBox>
      <mesh position={[0, doorSplitY, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[width * 0.94, 0.01, 0.01]} />
        <meshStandardMaterial color="#8a8a8a" roughness={0.4} />
      </mesh>
      <mesh position={[width * 0.32, height * 0.8, depth / 2 + 0.02]} castShadow>
        <boxGeometry args={[0.02, height * 0.28, 0.03]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
      </mesh>
      <mesh position={[width * 0.32, doorSplitY * 0.5, depth / 2 + 0.02]} castShadow>
        <boxGeometry args={[0.02, height * 0.16, 0.03]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
      </mesh>
    </group>
  );
}

/** Freestanding oval-ish tub, approximated as a heavily rounded box shell with a small faucet stub. */
export function FreestandingBathtub({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const shellColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox
        args={[width, height, depth]}
        radius={Math.min(width, depth, height) * 0.45}
        smoothness={4}
        position={[0, height / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={shellColor} roughness={0.25} />
      </RoundedBox>
      <mesh position={[0, height * 0.94, 0]} castShadow>
        <cylinderGeometry args={[0.015, 0.015, 0.12, 10]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

/** Bathroom vanity: a cabinet with a shallow basin on top and a stub faucet. */
export function VanitySink({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const cabinetColor = selected ? WALL_COLOR_SELECTED : color;
  const basinH = height * 0.12;
  const cabinetH = height - basinH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetH, depth]} radius={0.02} smoothness={2} position={[0, cabinetH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.65} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.9, basinH, depth * 0.85]}
        radius={Math.min(width * 0.9, basinH, depth * 0.85) * 0.4}
        smoothness={3}
        position={[0, cabinetH + basinH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#f5f5f5" roughness={0.2} />
      </RoundedBox>
      <mesh position={[0, cabinetH + basinH + 0.1, -depth * 0.3]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.2, 10]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

/** Floor lamp: disc base, thin pole, open-ended conical shade. */
export function FloorLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const baseR = width * 0.4;
  const poleR = 0.02;
  const shadeH = height * 0.28;
  const poleH = height - shadeH - 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[baseR, baseR * 1.1, 0.03, 20]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH / 2 + 0.03, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[poleR, poleR, poleH, 10]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH + shadeH / 2 + 0.03, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.28, width * 0.4, shadeH, 20, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Table lamp: small weighted base, thin stem, open-ended drum shade. */
export function TableLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const baseH = height * 0.12;
  const shadeH = height * 0.45;
  const stemH = height - baseH - shadeH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, baseH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.32, width * 0.36, baseH, 16]} />
        <meshStandardMaterial color="#8a7458" roughness={0.5} />
      </mesh>
      <mesh position={[0, baseH + stemH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.015, 0.015, stemH, 8]} />
        <meshStandardMaterial color="#8a7458" roughness={0.5} />
      </mesh>
      <mesh position={[0, baseH + stemH + shadeH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.22, width * 0.32, shadeH, 16, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Potted plant: a terracotta pot under a small cluster of low-poly foliage blobs. */
export function PottedPlant({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height } = item;
  const potColor = selected ? WALL_COLOR_SELECTED : "#b5651d";
  const potH = height * 0.28;
  const foliageColor = "#4f6b3a";

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, potH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.45, width * 0.35, potH, 16]} />
        <meshStandardMaterial color={potColor} roughness={0.8} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          position={[(i - 1) * width * 0.15, potH + (height - potH) * (0.4 + i * 0.18), (i % 2) * width * 0.1]}
          castShadow
          receiveShadow
        >
          <icosahedronGeometry args={[width * (0.32 - i * 0.03), 1]} />
          <meshStandardMaterial color={foliageColor} roughness={0.9} flatShading />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Flat area rug: two stacked horizontal planes (base + a lighter inset
 * "border"), not RoundedBox — a box that's only ~1cm thick has no room for
 * a corner radius rounded on that axis (RoundedBox's corner arcs live in its
 * own width×height face, and here that face *is* the thin axis), so a radius
 * anywhere near a usable rug-corner size produced degenerate geometry.
 */
export function AreaRug({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, color } = item;
  const rugColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color={rugColor} roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.007, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[width * 0.82, depth * 0.78]} />
        <meshStandardMaterial color="#f2ece0" roughness={1} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** TV on a low media console: console body plus a thin flat-screen panel and a small center stand nub. */
export function TvOnStand({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const consoleColor = selected ? WALL_COLOR_SELECTED : color;
  const consoleH = height * 0.35;
  const screenH = height - consoleH;
  const screenThickness = 0.04;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, consoleH, depth]} radius={0.02} smoothness={2} position={[0, consoleH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={consoleColor} roughness={0.6} />
      </RoundedBox>
      <mesh position={[0, consoleH + screenH / 2, -depth / 2 + screenThickness / 2 + 0.02]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.92, screenH * 0.85, screenThickness]} />
        <meshStandardMaterial color="#111214" roughness={0.15} metalness={0.2} />
      </mesh>
      <mesh position={[0, consoleH + 0.02, -depth / 2 + screenThickness / 2 + 0.02]} castShadow>
        <boxGeometry args={[0.05, 0.04, screenThickness]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} />
      </mesh>
    </group>
  );
}

/** Tower speaker: a tall rounded cabinet with two driver discs inset in the front face. */
export function TowerSpeaker({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.03} smoothness={3} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </RoundedBox>
      {[0.72, 0.42].map((frac, i) => (
        <mesh key={i} position={[0, height * frac, depth / 2 + 0.005]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[width * (i === 0 ? 0.32 : 0.4), width * (i === 0 ? 0.32 : 0.4), 0.01, 20]} />
          <meshStandardMaterial color="#0d0d0d" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

export type FurnitureModelComponent = (props: { item: FurnitureItem; selected: boolean }) => ReactElement;

/**
 * Which component actually renders a given furniture item — the single
 * source of truth for "does this item have a dedicated model, or does it
 * fall back to a plain box." Shared with the sidebar's Furniture catalog
 * (see FurnitureThumbnailFactory.tsx) so its 3D preview thumbnails use
 * exactly the same model the 3D view itself would place, and so a new
 * dedicated model only ever needs to be wired up in one place.
 */
export function resolveFurnitureComponent(item: Pick<FurnitureItem, "libraryId" | "category" | "height">): FurnitureModelComponent | null {
  switch (item.libraryId) {
    case "armchair-boucle":
      return BoucleArmchair;
    case "sofa-curved-sage":
      return CurvedSofa;
    case "coffee-table-travertine":
      return RoundStoneTable;
    case "rattan-chair":
      return RattanChair;
    case "woven-pouf":
      return WovenPouf;
    case "wardrobe-modern":
      return ModernWardrobe;
    case "bookshelf":
      return Bookshelf;
    case "kitchen-island":
      return KitchenIsland;
    case "fridge-modern":
      return FridgeModern;
    case "bathtub-freestanding":
      return FreestandingBathtub;
    case "vanity-sink":
      return VanitySink;
    case "floor-lamp":
      return FloorLamp;
    case "table-lamp":
      return TableLamp;
    case "potted-plant":
      return PottedPlant;
    case "area-rug":
      return AreaRug;
    case "tv-stand":
      return TvOnStand;
    case "tower-speaker":
      return TowerSpeaker;
    default:
      if (item.category === "table" && item.height >= 0.6) return DiningTableWithChairs;
      if (item.category === "bed") return BedWithLinens;
      return null;
  }
}

const FLY_SPEED = 3.2; // meters/second
const FLY_KEYS: Record<string, "forward" | "backward" | "left" | "right" | "up" | "down"> = {
  w: "forward",
  arrowup: "forward",
  s: "backward",
  arrowdown: "backward",
  a: "left",
  arrowleft: "left",
  d: "right",
  arrowright: "right",
  " ": "up",
  shift: "down",
};

/** WASD/arrow-key walkthrough: translates the camera (and its orbit target together, so dragging to look around still feels natural) across the floor plane, plus Space/Shift to rise or crouch. */
function useFlyControls(camera: THREE.Camera, controlsRef: RefObject<OrbitControlsImpl | null>) {
  const moveRef = useRef({ forward: false, backward: false, left: false, right: false, up: false, down: false });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const move = FLY_KEYS[e.key.toLowerCase()];
      if (!move) return;
      e.preventDefault();
      moveRef.current[move] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const move = FLY_KEYS[e.key.toLowerCase()];
      if (!move) return;
      moveRef.current[move] = false;
    };
    // if a key's release happens while the window/tab isn't focused (alt-tab, a native
    // dialog stealing focus), the keyup event never fires — without this, that key stays
    // "held" and the camera drifts forever until the same key is pressed again
    const clearMove = () => {
      const m = moveRef.current;
      m.forward = m.backward = m.left = m.right = m.up = m.down = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearMove);
    document.addEventListener("visibilitychange", clearMove);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearMove);
      document.removeEventListener("visibilitychange", clearMove);
    };
  }, []);

  useFrame((_, delta) => {
    const m = moveRef.current;
    if (!m.forward && !m.backward && !m.left && !m.right && !m.up && !m.down) return;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    const step = FLY_SPEED * delta;
    const delta3 = new THREE.Vector3();
    if (m.forward) delta3.addScaledVector(forward, step);
    if (m.backward) delta3.addScaledVector(forward, -step);
    if (m.right) delta3.addScaledVector(right, step);
    if (m.left) delta3.addScaledVector(right, -step);
    if (m.up) delta3.y += step;
    if (m.down) delta3.y -= step;

    camera.position.add(delta3);
    if (controlsRef.current) {
      controlsRef.current.target.add(delta3);
      controlsRef.current.update();
    }
  });
}

/**
 * Trackpad two-finger drag reaches the browser as `wheel` events, not touch
 * events — OrbitControls' `touches` config never sees it, so its only wheel
 * behavior (zoom) is all a trackpad drag could ever do. Handling wheel
 * ourselves — plain scroll pans, Ctrl/Cmd+scroll (or a pinch, which browsers
 * report as ctrlKey+wheel) zooms — mirrors the 2D editor and makes trackpad
 * panning actually work.
 */
function useWheelNavigation(
  camera: THREE.Camera,
  controlsRef: RefObject<OrbitControlsImpl | null>,
  domElement: HTMLElement,
) {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const controls = controlsRef.current;
      if (!controls) return;
      e.preventDefault();

      const distance = camera.position.distanceTo(controls.target);

      if (e.ctrlKey || e.metaKey) {
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        const minDist = controls.minDistance ?? 0.3;
        const maxDist = controls.maxDistance ?? 60;
        const newDistance = THREE.MathUtils.clamp(distance + e.deltaY * 0.01 * distance, minDist, maxDist);
        camera.position.copy(controls.target).addScaledVector(dir, -newDistance);
      } else {
        const perspective = camera as THREE.PerspectiveCamera;
        const fovRad = ((perspective.fov ?? 50) * Math.PI) / 180;
        const panScale = (2 * distance * Math.tan(fovRad / 2)) / domElement.clientHeight;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        const panOffset = new THREE.Vector3()
          .addScaledVector(right, -e.deltaX * panScale)
          .addScaledVector(up, e.deltaY * panScale);
        camera.position.add(panOffset);
        controls.target.add(panOffset);
      }
      controls.update();
    };

    domElement.addEventListener("wheel", onWheel, { passive: false });
    return () => domElement.removeEventListener("wheel", onWheel);
  }, [camera, controlsRef, domElement]);
}

const CLICK_TOLERANCE_PX = 5;

/** Walks up from a raycast hit to find which furniture item (if any) owns it. */
function findFurnitureId(object: THREE.Object3D | null): string | null {
  let obj = object;
  while (obj) {
    if (obj.userData?.furnitureId) return obj.userData.furnitureId as string;
    obj = obj.parent;
  }
  return null;
}

/**
 * Everything that lets furniture be manipulated directly in 3D, mirroring
 * the 2D canvas: the "furniture" tool places a new item on click, and the
 * "select" tool clicks an existing item to select it, drags it across the
 * floor plane, and Delete/Backspace removes the selection. A real camera
 * orbit-drag never gets mistaken for either, since both keep their own
 * press/release distance check before doing anything.
 */
function useFurnitureInteraction(
  camera: THREE.Camera,
  domElement: HTMLElement,
  scene: THREE.Scene,
  controlsRef: RefObject<OrbitControlsImpl | null>,
  readOnly = false,
) {
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  const activeTool = useDesignStore((s) => s.activeTool);
  const pendingFurniture = useDesignStore((s) => s.pendingFurniture);
  const selectedIds = useDesignStore((s) => s.selectedIds);
  const furniture = useDesignStore((s) => s.furniture);
  const walls = useDesignStore((s) => s.walls);
  const openings = useDesignStore((s) => s.openings);
  const addFurniture = useDesignStore((s) => s.addFurniture);
  const updateFurniture = useDesignStore((s) => s.updateFurniture);
  const removeElements = useDesignStore((s) => s.removeElements);
  const setSelection = useDesignStore((s) => s.setSelection);
  const toggleSelection = useDesignStore((s) => s.toggleSelection);
  const pushHistory = useDesignStore((s) => s.pushHistory);

  const activeToolRef = useRef(activeTool);
  const pendingRef = useRef(pendingFurniture);
  const selectedIdsRef = useRef(selectedIds);
  const furnitureRef = useRef(furniture);
  const wallsRef = useRef(walls);
  const openingsRef = useRef(openings);
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);
  useEffect(() => {
    pendingRef.current = pendingFurniture;
  }, [pendingFurniture]);
  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);
  useEffect(() => {
    furnitureRef.current = furniture;
  }, [furniture]);
  useEffect(() => {
    wallsRef.current = walls;
  }, [walls]);
  useEffect(() => {
    openingsRef.current = openings;
  }, [openings]);

  const [previewPoint, setPreviewPoint] = useState<{ x: number; y: number } | null>(null);
  const previewPointRef = useRef(previewPoint);
  useEffect(() => {
    previewPointRef.current = previewPoint;
  }, [previewPoint]);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const floorPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);

  const toNDC = useCallback(
    (clientX: number, clientY: number) => {
      const rect = domElement.getBoundingClientRect();
      return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    },
    [domElement],
  );

  const raycastFloor = useCallback(
    (clientX: number, clientY: number) => {
      raycaster.setFromCamera(toNDC(clientX, clientY), camera);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(floorPlane, hit) ? { x: hit.x, y: hit.z } : null;
    },
    [camera, raycaster, floorPlane, toNDC],
  );

  const raycastFurniture = useCallback(
    (clientX: number, clientY: number) => {
      raycaster.setFromCamera(toNDC(clientX, clientY), camera);
      const hits = raycaster.intersectObjects(scene.children, true);
      return hits.length > 0 ? findFurnitureId(hits[0].object) : null;
    },
    [camera, raycaster, scene, toNDC],
  );

  useEffect(() => {
    let downPos: { x: number; y: number } | null = null;
    let moveFurnitureId: string | null = null;
    let moveOrigin: { x: number; y: number } | null = null;
    let moveSnapshot: { id: string; position: { x: number; y: number }; settled: { x: number; y: number } }[] = [];
    let moveObstacles: FurnitureObstacle[] = [];
    let dragStarted = false;
    let lastCursorRaycastMs = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (readOnlyRef.current) return;
      if (e.button !== 0) return;
      downPos = { x: e.clientX, y: e.clientY };
      dragStarted = false;
      moveFurnitureId = null;

      if (activeToolRef.current === "select") {
        const hitId = raycastFurniture(e.clientX, e.clientY);
        if (hitId) {
          moveFurnitureId = hitId;
          moveOrigin = raycastFloor(e.clientX, e.clientY);
        }
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (readOnlyRef.current) return;
      if (activeToolRef.current === "furniture" && pendingRef.current) {
        setPreviewPoint(raycastFloor(e.clientX, e.clientY));
        domElement.style.cursor = "copy";
      } else if (activeToolRef.current === "select") {
        if (previewPointRef.current) setPreviewPoint(null);
        // a recursive raycast against the whole scene graph on every single
        // pointermove (up to 100+/sec on a high-poll-rate mouse) is overkill
        // just to pick a CSS cursor — throttling it is imperceptible to a user
        // hovering for a "can I grab this" affordance, but cuts the cost a lot
        const now = performance.now();
        if (now - lastCursorRaycastMs >= CURSOR_RAYCAST_THROTTLE_MS) {
          lastCursorRaycastMs = now;
          domElement.style.cursor = raycastFurniture(e.clientX, e.clientY) ? "grab" : "";
        }
      } else {
        if (previewPointRef.current) setPreviewPoint(null);
        domElement.style.cursor = "";
      }

      if (!downPos || !moveFurnitureId || !moveOrigin) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      if (moved < CLICK_TOLERANCE_PX) return;

      if (!dragStarted) {
        dragStarted = true;
        if (controlsRef.current) controlsRef.current.enabled = false;
        domElement.style.cursor = "grabbing";
        if (!selectedIdsRef.current.includes(moveFurnitureId)) {
          setSelection([moveFurnitureId]);
          selectedIdsRef.current = [moveFurnitureId];
        }
        pushHistory();
        moveSnapshot = furnitureRef.current
          .filter((f) => selectedIdsRef.current.includes(f.id))
          .map((f) => ({ id: f.id, position: f.position, settled: f.position }));
        // the non-dragged furniture doesn't move during this gesture, so this only
        // needs computing once at drag start instead of on every pointermove tick
        moveObstacles = furnitureObstacles(
          furnitureRef.current,
          moveSnapshot.map((s) => s.id),
        );
      }

      const current = raycastFloor(e.clientX, e.clientY);
      if (!current) return;
      const delta = { x: current.x - moveOrigin.x, y: current.y - moveOrigin.y };
      const obstacles = moveObstacles;
      for (const snap of moveSnapshot) {
        const item = furnitureRef.current.find((f) => f.id === snap.id);
        if (!item) continue;
        const desired = { x: snap.position.x + delta.x, y: snap.position.y + delta.y };
        const size = furnitureCollisionSize(item);
        const settled = sweepFurniturePlacement(
          snap.settled,
          desired,
          size.width,
          size.depth,
          item.rotation,
          wallsRef.current,
          openingsRef.current,
          obstacles,
          FURNITURE_BREAKTHROUGH_DISTANCE_M,
        );
        snap.settled = settled;
        updateFurniture(snap.id, { position: settled });
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (controlsRef.current) controlsRef.current.enabled = true;
      if (readOnlyRef.current) return;
      const wasDown = downPos;
      const clickedFurnitureId = moveFurnitureId;
      const wasDragging = dragStarted;
      downPos = null;
      moveFurnitureId = null;
      moveOrigin = null;
      moveSnapshot = [];
      dragStarted = false;

      if (e.button !== 0 || !wasDown) return;
      const moved = Math.hypot(e.clientX - wasDown.x, e.clientY - wasDown.y);
      if (moved > CLICK_TOLERANCE_PX || wasDragging) return;

      if (activeToolRef.current === "furniture" && pendingRef.current) {
        const point = raycastFloor(e.clientX, e.clientY);
        if (!point) return;
        const pending = pendingRef.current;
        const size = furnitureCollisionSize(pending);
        const settled = resolveFurniturePlacement(
          point,
          size.width,
          size.depth,
          0,
          wallsRef.current,
          openingsRef.current,
          furnitureObstacles(furnitureRef.current, []),
        );
        pushHistory();
        const id = addFurniture({ ...pending, position: settled, rotation: 0 });
        setSelection([id]);
        return;
      }

      if (activeToolRef.current === "select") {
        if (clickedFurnitureId) {
          if (e.shiftKey) toggleSelection(clickedFurnitureId);
          else setSelection([clickedFurnitureId]);
        } else if (!e.shiftKey) {
          setSelection([]);
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (readOnlyRef.current) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIdsRef.current.length > 0) {
        e.preventDefault();
        pushHistory();
        removeElements(selectedIdsRef.current);
      }
    };

    domElement.addEventListener("pointerdown", onPointerDown);
    domElement.addEventListener("pointermove", onPointerMove);
    domElement.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      domElement.style.cursor = "";
    };
  }, [
    domElement,
    raycastFloor,
    raycastFurniture,
    addFurniture,
    updateFurniture,
    removeElements,
    setSelection,
    toggleSelection,
    pushHistory,
    controlsRef,
  ]);

  return previewPoint;
}

/** Semi-transparent ghost of the item armed for placement, following the cursor across the floor. */
function FurnitureInteractionLayer({
  controlsRef,
  readOnly,
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
  readOnly: boolean;
}) {
  const { camera, gl, scene } = useThree();
  const previewPoint = useFurnitureInteraction(camera, gl.domElement, scene, controlsRef, readOnly);
  const pendingFurniture = useDesignStore((s) => s.pendingFurniture);

  if (!pendingFurniture || !previewPoint) return null;

  return (
    <mesh position={[previewPoint.x, pendingFurniture.height / 2, previewPoint.y]}>
      <boxGeometry args={[pendingFurniture.width, pendingFurniture.height, pendingFurniture.depth]} />
      <meshStandardMaterial color={pendingFurniture.color} transparent opacity={0.45} depthWrite={false} />
    </mesh>
  );
}

const ORBIT_FLOOR_CLEARANCE_M = 0.05;

/**
 * Right-drag panning, WASD/Space/Shift flying, and free orbiting (default
 * maxPolarAngle covers the full sphere) can all put the camera below y=0 —
 * from there you're looking at the underside of the floor/walls, which
 * reads as broken. Keeps the camera above the floor every frame, shifting
 * the orbit target by the same amount so the view doesn't jump when it
 * gets clamped.
 *
 * No explicit render-priority argument here: passing one to useFrame tells
 * R3F this callback takes over rendering (calling gl.render() itself),
 * switching the whole canvas out of its default auto-render loop — since
 * nothing here does that, the canvas would simply stop updating. Default
 * priority runs every registered callback in mount order within the same
 * frame, which is more than good enough for a clamp that just needs to
 * catch up within a frame or two, not react to itself same-frame.
 */
function useOrbitFloorClamp(camera: THREE.Camera, controlsRef: RefObject<OrbitControlsImpl | null>) {
  useFrame(() => {
    if (camera.position.y >= ORBIT_FLOOR_CLEARANCE_M) return;
    const dy = ORBIT_FLOOR_CLEARANCE_M - camera.position.y;
    camera.position.y = ORBIT_FLOOR_CLEARANCE_M;
    if (controlsRef.current) {
      controlsRef.current.target.y += dy;
      controlsRef.current.update();
    }
  });
}

function CameraRig({ walls, controlsRef }: { walls: Wall[]; controlsRef: RefObject<OrbitControlsImpl | null> }) {
  const { camera, gl } = useThree();
  useFlyControls(camera, controlsRef);
  useWheelNavigation(camera, controlsRef, gl.domElement);
  useOrbitFloorClamp(camera, controlsRef);

  useEffect(() => {
    const bbox = wallsBoundingBox(walls);
    if (!bbox) {
      camera.position.set(6, 6, 6);
      controlsRef.current?.target.set(0, 1, 0);
      controlsRef.current?.update();
      return;
    }

    const centerX = (bbox.minX + bbox.maxX) / 2;
    const centerZ = (bbox.minY + bbox.maxY) / 2;
    const size = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 2);
    const dist = size * 1.1 + 4;

    camera.position.set(centerX + dist * 0.6, dist * 0.6, centerZ + dist * 0.6);
    controlsRef.current?.target.set(centerX, 1, centerZ);
    controlsRef.current?.update();
    // run once when this view mounts (i.e. each time the user switches into 3D)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={0.3}
      maxDistance={60}
      // keep rotation itself from ever swinging under the floor, on top of
      // the per-frame clamp (which also catches panning/flying below y=0)
      maxPolarAngle={Math.PI * 0.495}
      // wheel-based zoom is handled entirely by useWheelNavigation (so plain
      // trackpad/wheel scroll can pan instead) — leaving this on would make
      // OrbitControls' own internal wheel listener zoom on every scroll too
      enableZoom={false}
      mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
      touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
    />
  );
}

/** Everything visible in the scene — lights, floor, grid, walls, room floors, furniture — shared between the orbit ("3D") view and the first-person walkthrough. */
function SceneObjects({
  walls,
  openings,
  furniture,
  selectedIds,
  roomFloors,
  showCeiling,
  ceilingLights,
  timeOfDay,
  lightsOn,
}: {
  walls: Wall[];
  openings: Opening[];
  furniture: FurnitureItem[];
  selectedIds: string[];
  roomFloors: RoomFloor[];
  showCeiling: boolean;
  ceilingLights: CeilingLight[];
  timeOfDay: TimeOfDay;
  lightsOn: boolean;
}) {
  const isNight = timeOfDay === "night";
  const cornerPatches = useMemo(() => computeCornerPatches(walls), [walls]);
  const rooms = useMemo(() => computeRooms(walls), [walls]);
  // dilated slightly so floor/ceiling geometry closes hairline gaps at wall
  // corners/junctions that the detection grid's resolution can leave uncovered
  const roomFloorPolygons = useMemo(() => computeRoomFloorPolygons(walls, rooms), [walls, rooms]);
  const doorPatches = useMemo(() => computeDoorThresholdPatches(rooms, walls, openings), [rooms, walls, openings]);
  const ceilingHeight = useMemo(() => Math.max(0, ...walls.map((w) => w.height)), [walls]);

  return (
    <>
      <color attach="background" args={[isNight ? "#0c1220" : "#f3efe4"]} />
      {/* High summer-noon sun as the one real daytime light source — no
          per-room "ceiling fixture" fill anymore, so a room only actually
          gets bright near a door/window opening the sun can reach through
          (walls cast real shadows via castShadow/receiveShadow), instead of
          every room being uniformly lit regardless of whether it has a
          window at all. Windows are holes in a *vertical* wall, though, not
          skylights — a truly overhead sun's rays barely drift sideways on
          their way down to the floor, so they'd graze the wall just outside
          the window and never actually reach the interior. ~23° off zenith
          is about as steep as real summer-noon sun gets at temperate
          latitudes, and it's enough that a ray entering at sill height has
          drifted a visible distance across the floor by the time it lands.

          At night this same light just becomes dim moonlight instead of
          disappearing — same angle (so shadow direction stays consistent),
          far lower intensity and a cool tint. With the sun that dim and the
          per-window daylight glow switched off (see WallGroup's `daylight`
          prop), a room only gets genuinely bright at night from its own
          ceiling lights, if any are placed and switched on.

          Shadows use VSM (shadows="variance" on the Canvas below), not PCF —
          this Three.js version silently downgrades the old "soft" PCF mode
          to hard-edged shadows (see WebGLShadowMap's own deprecation
          warning for PCFSoftShadowMap), which is why they came out razor-
          sharp before. VSM's blur (radius/blurSamples) is also much more
          forgiving about the bias/normalBias tuning that was causing the
          light-leak gaps at wall corners, so both are near-zero now instead
          of the harder push PCF needed.

          A hemisphere light (sky tint from above, warm floor-bounce tint
          from below) stands in for the outdoor bounce light a real room
          gets that this renderer has no actual global illumination for —
          it's what keeps shadowed areas a soft dim rather than inky black,
          which is what made the sun's shadows read as so much harsher than
          the old point-lit look even though the sun itself isn't that much
          stronger. Also much dimmer/cooler at night, same reasoning. */}
      <hemisphereLight args={isNight ? ["#1b2438", "#0d0f14", 0.15] : ["#dce8f5", "#e7ddc4", 0.55]} />
      <directionalLight
        position={[8, 22, 5]}
        intensity={isNight ? 0.12 : 1.7}
        color={isNight ? "#9fb3d9" : "#fff6e0"}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-radius={4}
        shadow-blurSamples={16}
        shadow-bias={-0.00005}
        shadow-normalBias={0.006}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-camera-near={1}
        shadow-camera-far={80}
      />

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[100, 100]} />
        <meshStandardMaterial color="#e7ddc4" />
      </mesh>

      {/* not infiniteGrid: that mode scales the grid's own vertices by
          ~(1 + fadeDistance) in its vertex shader to fake an endless plane,
          which wrecks depth-buffer precision near the origin — walls,
          furniture and room floors were all failing depth tests against it
          incorrectly. A large-but-finite grid avoids that entirely. */}
      <Grid
        position={[0, 0.01, 0]}
        args={[100, 100]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#d8caa6"
        sectionSize={1}
        sectionThickness={1}
        sectionColor="#c2b285"
        fadeDistance={30}
        fadeStrength={1}
      />

      {walls.map((wall) => (
        <WallGroup
          key={wall.id}
          wall={wall}
          openings={openings.filter((o) => o.wallId === wall.id)}
          selected={selectedIds.includes(wall.id)}
          daylight={!isNight}
        />
      ))}

      {ceilingLights.map((light) => (
        <CeilingLightFixture key={light.id} position={light.position} ceilingHeight={ceilingHeight} on={lightsOn} />
      ))}

      {cornerPatches.map((patch) => {
        const height = Math.max(...patch.wallIds.map((id) => walls.find((w) => w.id === id)?.height ?? 0));
        const selected = patch.wallIds.some((id) => selectedIds.includes(id));
        return <CornerPatchMesh key={patch.key} patch={patch} height={height} selected={selected} />;
      })}

      {rooms.map((room) => {
        const floor = roomFloors.find((rf) => rf.key === room.key);
        if (!floor) return null;
        const floorRoom = roomFloorPolygons.find((r) => r.key === room.key) ?? room;
        const patches = doorPatches.filter((p) => p.roomKey === room.key);
        return (
          <RoomFloorMesh
            key={room.key}
            room={floorRoom}
            patches={patches}
            tileSizeM={floor.tileSizeM}
            textureDataUrl={floor.textureDataUrl}
          />
        );
      })}

      {ceilingHeight > 0 && (
        <CeilingMesh rooms={roomFloorPolygons} walls={walls} height={ceilingHeight} visible={showCeiling} />
      )}

      {furniture.map((item) => {
        const selected = selectedIds.includes(item.id);
        const Model = resolveFurnitureComponent(item) ?? FurnitureMesh;
        return <Model key={item.id} item={item} selected={selected} />;
      })}
    </>
  );
}

export function Scene3D({ readOnly = false }: { readOnly?: boolean } = {}) {
  const walls = useDesignStore((s) => s.walls);
  const openings = useDesignStore((s) => s.openings);
  const furniture = useDesignStore((s) => s.furniture);
  const selectedIds = useDesignStore((s) => s.selectedIds);
  const activeTool = useDesignStore((s) => s.activeTool);
  const pendingFurniture = useDesignStore((s) => s.pendingFurniture);
  const setActiveTool = useDesignStore((s) => s.setActiveTool);
  const setPendingFurniture = useDesignStore((s) => s.setPendingFurniture);
  const roomFloors = useDesignStore((s) => s.roomFloors);
  const showCeiling = useDesignStore((s) => s.showCeiling);
  const ceilingLights = useDesignStore((s) => s.ceilingLights);
  const timeOfDay = useDesignStore((s) => s.timeOfDay);
  const lightsOn = useDesignStore((s) => s.lightsOn);
  const controlsRef = useRef<OrbitControlsImpl>(null);

  useEffect(() => {
    if (activeTool !== "furniture") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") {
        setActiveTool("select");
        setPendingFurniture(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTool, setActiveTool, setPendingFurniture]);

  return (
    <div className="bg-studio-bg relative h-full w-full">
      <Canvas shadows="variance" camera={{ position: [6, 6, 6], fov: 50, near: 0.1, far: 200 }} dpr={[1, 2]}>
        <SceneObjects
          walls={walls}
          openings={openings}
          furniture={furniture}
          selectedIds={selectedIds}
          roomFloors={roomFloors}
          showCeiling={showCeiling}
          ceilingLights={ceilingLights}
          timeOfDay={timeOfDay}
          lightsOn={lightsOn}
        />
        <FurnitureInteractionLayer controlsRef={controlsRef} readOnly={readOnly} />
        <CameraRig walls={walls} controlsRef={controlsRef} />
      </Canvas>

      {walls.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-studio-ink-faint text-sm font-medium">
            Draw a floor plan in the 2D editor to see the 3D model
          </p>
        </div>
      )}

      {walls.length > 0 && activeTool === "furniture" && pendingFurniture && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Click the floor to place "{pendingFurniture.label}" · Esc clears the library selection
        </div>
      )}

      {walls.length > 0 && !(activeTool === "furniture" && pendingFurniture) && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-xl border-studio-line bg-studio-paper/90 text-studio-ink-soft border px-4 py-2 text-[11px] shadow-[0_12px_24px_-14px_rgba(43,36,28,0.35)] backdrop-blur-xl">
          Left button: orbit · Right button / wheel / two fingers: pan · Ctrl+wheel: zoom · WASD/arrows: move · Space/Shift:
          up/down
        </div>
      )}
    </div>
  );
}

const WALK_EYE_HEIGHT_M = 1.65;
const WALK_SPEED_MS = 2.2;
const WALK_SPRINT_SPEED_MS = 4.6;
const WALK_PLAYER_SIZE_M = 0.4;

/** WASD ground movement for the walkthrough camera — horizontal only (fixed eye height), collides with walls the same way furniture does. Also accepts an analog {x, y} joystick input (x: strafe, y: forward), so a touch joystick drives the exact same movement path as the keyboard instead of a separate parallel implementation. */
function useWalkthroughMovement(
  camera: THREE.Camera,
  walls: Wall[],
  openings: Opening[],
  furniture: FurnitureItem[],
  eyeHeight: number,
  enabled: boolean,
  analogInputRef?: RefObject<{ x: number; y: number }>,
) {
  const moveRef = useRef({ forward: false, backward: false, left: false, right: false, sprint: false });
  const wallsRef = useRef(walls);
  const openingsRef = useRef(openings);
  const obstaclesRef = useRef<FurnitureObstacle[]>([]);
  useEffect(() => {
    wallsRef.current = walls;
  }, [walls]);
  useEffect(() => {
    openingsRef.current = openings;
  }, [openings]);
  useEffect(() => {
    obstaclesRef.current = furnitureObstacles(furniture, []);
  }, [furniture]);

  useEffect(() => {
    const keyMap: Record<string, keyof typeof moveRef.current> = {
      w: "forward",
      arrowup: "forward",
      s: "backward",
      arrowdown: "backward",
      a: "left",
      arrowleft: "left",
      d: "right",
      arrowright: "right",
      shift: "sprint",
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const key = keyMap[e.key.toLowerCase()];
      if (key) moveRef.current[key] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = keyMap[e.key.toLowerCase()];
      if (key) moveRef.current[key] = false;
    };
    // a keyup while the window/tab is unfocused never fires, so without this a held
    // movement key (e.g. alt-tabbing away mid-walk) stays "down" and the player keeps
    // walking on return until that same key is pressed and released again
    const clearMove = () => {
      const m = moveRef.current;
      m.forward = m.backward = m.left = m.right = m.sprint = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearMove);
    document.addEventListener("visibilitychange", clearMove);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearMove);
      document.removeEventListener("visibilitychange", clearMove);
    };
  }, []);

  useFrame((_, delta) => {
    camera.position.y = eyeHeight;
    if (!enabled) return;
    const m = moveRef.current;
    const analog = analogInputRef?.current ?? { x: 0, y: 0 };
    if (!m.forward && !m.backward && !m.left && !m.right && analog.x === 0 && analog.y === 0) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

    const speed = (m.sprint ? WALK_SPRINT_SPEED_MS : WALK_SPEED_MS) * delta;
    const step = new THREE.Vector3();
    if (m.forward) step.addScaledVector(forward, speed);
    if (m.backward) step.addScaledVector(forward, -speed);
    if (m.right) step.addScaledVector(right, speed);
    if (m.left) step.addScaledVector(right, -speed);
    // joystick axes are already normalized to [-1, 1] by how far the stick is
    // pushed, so they scale the same per-frame speed rather than always being full-speed
    if (analog.y !== 0) step.addScaledVector(forward, analog.y * speed);
    if (analog.x !== 0) step.addScaledVector(right, analog.x * speed);

    const from = { x: camera.position.x, y: camera.position.z };
    const desired = { x: from.x + step.x, y: from.y + step.z };
    const settled = sweepFurniturePlacement(
      from,
      desired,
      WALK_PLAYER_SIZE_M,
      WALK_PLAYER_SIZE_M,
      0,
      wallsRef.current,
      openingsRef.current,
      obstaclesRef.current,
    );
    camera.position.x = settled.x;
    camera.position.z = settled.y;
  });
}

/** First-person FPS-style walkthrough: click (or, on a touchscreen, an on-screen joystick + drag-to-look) to walk around. */
export function WalkthroughScene() {
  const walls = useDesignStore((s) => s.walls);
  const openings = useDesignStore((s) => s.openings);
  const furniture = useDesignStore((s) => s.furniture);
  const selectedIds = useDesignStore((s) => s.selectedIds);
  const roomFloors = useDesignStore((s) => s.roomFloors);
  const ceilingLights = useDesignStore((s) => s.ceilingLights);
  const timeOfDay = useDesignStore((s) => s.timeOfDay);
  const lightsOn = useDesignStore((s) => s.lightsOn);
  const walkthroughStart = useDesignStore((s) => s.walkthroughStart);
  const isMobile = useIsMobileViewport();
  const [locked, setLocked] = useState(false);
  const controlsRef = useRef<PointerLockControlsImpl>(null);
  // written by MobileWalkthroughControls' touch handlers, read every frame by
  // useWalkthroughMovement/useTouchLook — refs, not state, so a finger
  // dragging 60 times a second doesn't trigger a React re-render each time
  const moveInputRef = useRef({ x: 0, y: 0 });
  const lookDeltaRef = useRef({ x: 0, y: 0 });

  // mobile has no pointer to lock — it's just "on" the moment there's
  // something to walk around in, no click-to-enter gate needed
  useEffect(() => {
    if (isMobile && walls.length > 0) setLocked(true);
  }, [isMobile, walls.length]);

  const spawn = useMemo(() => {
    // an explicit start (set with the "Walk start" tool in the 2D editor)
    // always wins over the auto-guessed one
    if (walkthroughStart) return walkthroughStart;
    const rooms = computeRooms(walls);
    if (rooms.length > 0) {
      const biggest = rooms.reduce((a, b) => (a.area > b.area ? a : b));
      return { ...biggest.centroid, heading: 0 };
    }
    const bbox = wallsBoundingBox(walls);
    return bbox
      ? { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2, heading: 0 }
      : { x: 0, y: 0, heading: 0 };
  }, [walls, walkthroughStart]);

  return (
    <div className="bg-studio-bg relative h-full w-full">
      <Canvas
        shadows="variance"
        // A camera at rotation.y = 0 looks toward Three's -Z, not +X — so
        // heading 0 (facing world +x) needs an extra -90° on top of the
        // heading-to-Y-axis mapping furniture rotation uses elsewhere in this
        // file (rotation={[0, -item.rotation, 0]}), or the spawn ends up
        // looking 90° off (confirmed: it was pointing 90° left of the set direction).
        camera={{
          position: [spawn.x, WALK_EYE_HEIGHT_M, spawn.y],
          rotation: [0, -spawn.heading - Math.PI / 2, 0],
          fov: 70,
          near: 0.05,
          far: 200,
        }}
        dpr={[1, 2]}
      >
        <SceneObjects
          walls={walls}
          openings={openings}
          furniture={furniture}
          selectedIds={selectedIds}
          roomFloors={roomFloors}
          // always on here, regardless of the "Show ceiling" toggle (which
          // only applies to the orbit view) — standing inside a room with no
          // ceiling above you looks broken in first person, unlike orbiting
          // from outside where hiding it to see inside is often what you want
          showCeiling
          ceilingLights={ceilingLights}
          timeOfDay={timeOfDay}
          lightsOn={lightsOn}
        />
        {!isMobile && (
          <PointerLockControls ref={controlsRef} onLock={() => setLocked(true)} onUnlock={() => setLocked(false)} />
        )}
        <WalkthroughRig
          walls={walls}
          openings={openings}
          furniture={furniture}
          locked={locked}
          moveInputRef={moveInputRef}
          lookDeltaRef={lookDeltaRef}
          touchLookEnabled={isMobile && locked}
        />
      </Canvas>

      {isMobile && locked && <MobileWalkthroughControls moveInputRef={moveInputRef} lookDeltaRef={lookDeltaRef} />}

      {walls.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-studio-ink-faint text-sm font-medium">
            Draw a floor plan in the 2D editor to start the walkthrough
          </p>
        </div>
      )}

      {!isMobile && walls.length > 0 && !locked && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/10">
          <button
            type="button"
            onClick={() => controlsRef.current?.lock()}
            className="border-studio-line bg-studio-paper text-studio-ink flex flex-col items-center gap-2 rounded-2xl border px-8 py-6 text-sm font-medium shadow-[0_20px_50px_-20px_rgba(43,36,28,0.5)]"
          >
            <span className="text-base font-semibold">Click to enter the walkthrough</span>
            <span className="text-studio-ink-soft text-xs">WASD / arrows: walk · Shift: run · mouse: look around · Esc: release cursor</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Touch-drag look-around, standing in for PointerLockControls on mobile —
 * there's no mouse to lock, so this reads accumulated screen-pixel deltas a
 * DOM touch handler outside the canvas writes into `lookDeltaRef` (already
 * scaled to radians there) and applies them the same way PointerLockControls
 * itself does internally: read the camera's current orientation as a YXZ
 * Euler, subtract yaw/pitch, clamp pitch short of straight up/down so it
 * can't flip over, write it back as a quaternion. Consumes (zeroes) the ref
 * every frame so a finger held still applies no further rotation.
 */
function useTouchLook(camera: THREE.Camera, lookDeltaRef: RefObject<{ x: number; y: number }>, enabled: boolean) {
  const eulerRef = useRef(new THREE.Euler(0, 0, 0, "YXZ"));
  useFrame(() => {
    if (!enabled) return;
    const delta = lookDeltaRef.current;
    if (delta.x === 0 && delta.y === 0) return;
    const euler = eulerRef.current;
    euler.setFromQuaternion(camera.quaternion);
    euler.y -= delta.x;
    euler.x -= delta.y;
    const maxPitch = Math.PI / 2 - 0.01;
    euler.x = Math.max(-maxPitch, Math.min(maxPitch, euler.x));
    camera.quaternion.setFromEuler(euler);
    delta.x = 0;
    delta.y = 0;
  });
}

function WalkthroughRig({
  walls,
  openings,
  furniture,
  locked,
  moveInputRef,
  lookDeltaRef,
  touchLookEnabled,
}: {
  walls: Wall[];
  openings: Opening[];
  furniture: FurnitureItem[];
  locked: boolean;
  moveInputRef: RefObject<{ x: number; y: number }>;
  lookDeltaRef: RefObject<{ x: number; y: number }>;
  touchLookEnabled: boolean;
}) {
  const { camera } = useThree();
  useWalkthroughMovement(camera, walls, openings, furniture, WALK_EYE_HEIGHT_M, locked, moveInputRef);
  useTouchLook(camera, lookDeltaRef, touchLookEnabled);
  return null;
}
