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
const FURNITURE_ROTATE_HANDLE_GAP_M = 0.35;
const FURNITURE_ROTATE_HANDLE_HIT_PX = 18;

/** World (ground-plane) position of the little rotate-handle floating in front of a selected furniture item — same idea as Canvas2D's handle, just in world units instead of screen pixels since there's no fixed "zoom" here. */
function furnitureRotateHandleGroundPos(item: FurnitureItem): Point {
  const localForward = -item.depth / 2 - FURNITURE_ROTATE_HANDLE_GAP_M;
  const cos = Math.cos(item.rotation);
  const sin = Math.sin(item.rotation);
  return { x: item.position.x - localForward * sin, y: item.position.y + localForward * cos };
}

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

/**
 * Round dining table ringed with chairs — the chair count scales with the
 * table's own circumference (~1 chair per 0.75m), so the same component
 * covers a 2-seat bistro table, a 4-seat round table, and a 6-seat one.
 */
export function RoundDiningTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const radius = width / 2;
  const topThickness = 0.045;
  const legThickness = 0.08;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const chairCount = Math.max(2, Math.round((2 * Math.PI * radius) / 0.75));
  const chairOrbit = radius + CHAIR_GAP + CHAIR_SEAT_SIZE / 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius, topThickness, 32]} />
        <meshStandardMaterial color={topColor} roughness={0.5} />
      </mesh>
      <mesh position={[0, (height - topThickness) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[legThickness, legThickness * 1.3, height - topThickness, 16]} />
        <meshStandardMaterial color={topColor} roughness={0.6} />
      </mesh>
      {Array.from({ length: chairCount }, (_, i) => {
        const theta = (i / chairCount) * Math.PI * 2;
        return (
          <Chair
            key={i}
            position={[Math.sin(theta) * chairOrbit, 0, Math.cos(theta) * chairOrbit]}
            rotationY={theta + Math.PI}
          />
        );
      })}
    </group>
  );
}

/** Slim console table: a narrow slab top on tapered A-frame legs, no chairs — meant to sit against a wall. */
export function ConsoleTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.04;
  const legThickness = 0.04;
  const legInset = legThickness / 2 + 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, topThickness, depth]} radius={0.015} smoothness={2} position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh
            key={`${sx}-${sz}`}
            position={[sx * (width / 2 - legInset), (height - topThickness) / 2, sz * (depth / 2 - legInset)]}
            rotation={[0, 0, sx * 0.06]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[legThickness, height - topThickness, legThickness]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
      <mesh position={[0, height * 0.32, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.85, 0.02, depth * 0.85]} />
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </mesh>
    </group>
  );
}

/** Writing desk: a slab top with a shallow drawer front and tapered peg legs — no chair, just the desk itself. */
export function WritingDesk({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.035;
  const drawerH = height * 0.16;
  const legThickness = 0.045;
  const legInset = legThickness / 2 + 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, topThickness, depth]} radius={0.01} smoothness={2} position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.32, drawerH, depth * 0.85]}
        radius={0.01}
        smoothness={2}
        position={[width * 0.28, height - topThickness - drawerH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={topColor} roughness={0.5} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh
            key={`${sx}-${sz}`}
            position={[sx * (width / 2 - legInset), (height - topThickness) / 2, sz * (depth / 2 - legInset)]}
            castShadow
            receiveShadow
          >
            <cylinderGeometry args={[legThickness / 2, legThickness / 2.6, height - topThickness, 10]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Nesting tables: two round-top side tables of different heights, the smaller tucked partly under the larger. */
export function NestingTables({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const bigR = Math.min(width, depth) / 2;
  const smallR = bigR * 0.72;
  const smallH = height * 0.68;
  const topT = 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[-width * 0.12, height - topT / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[bigR, bigR, topT, 24]} />
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </mesh>
      <mesh position={[-width * 0.12, (height - topT) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.025, 0.03, height - topT, 12]} />
        <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
      </mesh>
      <mesh position={[width * 0.22, smallH - topT / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[smallR, smallR, topT, 24]} />
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </mesh>
      <mesh position={[width * 0.22, (smallH - topT) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.02, 0.025, smallH - topT, 12]} />
        <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Glass coffee table: a transparent tabletop on a slim black metal frame. */
export function GlassCoffeeTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : "#2a2a2a";
  const topThickness = 0.02;
  const legInset = 0.05;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, topThickness, depth]} />
        <meshStandardMaterial color={color} roughness={0.05} transparent opacity={0.35} />
      </mesh>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - legInset), (height - topThickness) / 2, sz * (depth / 2 - legInset)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.018, 0.018, height - topThickness, 10]} />
            <meshStandardMaterial color={frameColor} roughness={0.3} metalness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Plain rectangular wood coffee table: a slab top on four block legs. */
export function RectCoffeeTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.04;
  const legThickness = 0.06;
  const legInset = legThickness / 2 + 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, topThickness, depth]} radius={0.01} smoothness={2} position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={topColor} roughness={0.5} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh
            key={`${sx}-${sz}`}
            position={[sx * (width / 2 - legInset), (height - topThickness) / 2, sz * (depth / 2 - legInset)]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[legThickness, height - topThickness, legThickness]} />
            <meshStandardMaterial color={topColor} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Pub/bar-height table: a small round top on a single tall pedestal, tall enough to stand or use with bar stools — no attached chairs. */
export function PubTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const radius = width / 2;
  const topThickness = 0.04;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius, topThickness, 28]} />
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </mesh>
      <mesh position={[0, (height - topThickness) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.03, 0.05, height - topThickness, 16]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius * 0.6, radius * 0.6, 0.03, 20]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
    </group>
  );
}

/** Trestle table: a slab top resting on two A-frame (trestle) end supports instead of four separate legs. */
export function TrestleTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.05;
  const trestleX = width / 2 - 0.15;
  const legThickness = 0.06;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, topThickness, depth]} radius={0.015} smoothness={2} position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={topColor} roughness={0.5} />
      </RoundedBox>
      {[-1, 1].map((sx) => (
        <group key={sx} position={[sx * trestleX, 0, 0]}>
          {[-1, 1].map((sz) => (
            <mesh
              key={sz}
              position={[0, (height - topThickness) / 2, sz * (depth / 2 - 0.1)]}
              rotation={[0, 0, sz * sx * 0.18]}
              castShadow
              receiveShadow
            >
              <boxGeometry args={[legThickness, height - topThickness, legThickness]} />
              <meshStandardMaterial color={topColor} roughness={0.6} />
            </mesh>
          ))}
          <mesh position={[0, (height - topThickness) * 0.4, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
            <cylinderGeometry args={[0.025, 0.025, depth * 0.7, 10]} />
            <meshStandardMaterial color={topColor} roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Vanity/dressing table: a slim table with a tall attached mirror panel at the back. */
export function VanityDesk({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.035;
  const mirrorH = height * 0.75;
  const legThickness = 0.035;
  const legInset = legThickness / 2 + 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, topThickness, depth]} radius={0.01} smoothness={2} position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={topColor} roughness={0.4} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh
            key={`${sx}-${sz}`}
            position={[sx * (width / 2 - legInset), (height - topThickness) / 2, sz * (depth / 2 - legInset)]}
            castShadow
            receiveShadow
          >
            <cylinderGeometry args={[legThickness / 2, legThickness / 2.6, height - topThickness, 10]} />
            <meshStandardMaterial color={topColor} roughness={0.6} />
          </mesh>
        )),
      )}
      <mesh position={[0, height + mirrorH / 2, -depth / 2 + 0.01]} castShadow>
        <planeGeometry args={[width * 0.6, mirrorH]} />
        <meshStandardMaterial color="#dfeaee" roughness={0.05} metalness={0.6} />
      </mesh>
      <mesh position={[0, height + mirrorH / 2, -depth / 2]} castShadow>
        <boxGeometry args={[width * 0.64, mirrorH * 1.03, 0.015]} />
        <meshStandardMaterial color={topColor} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Drafting table: a tilted rectangular top on an easel-style frame, fixed at a comfortable drawing angle. */
export function DraftingTable({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const topColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.03;
  const tilt = 0.35;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <group rotation={[tilt, 0, 0]} position={[0, height - depth * Math.sin(tilt) * 0.5, depth * 0.1]}>
        <RoundedBox args={[width, topThickness, depth]} radius={0.01} smoothness={2}>
          <meshStandardMaterial color={topColor} roughness={0.45} />
        </RoundedBox>
      </group>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh
            key={`${sx}-${sz}`}
            position={[sx * (width / 2 - 0.06), height * 0.42, sz * (depth / 2 - 0.1)]}
            rotation={[0, 0, sx * 0.12]}
            castShadow
            receiveShadow
          >
            <boxGeometry args={[0.05, height * 0.84, 0.05]} />
            <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
          </mesh>
        )),
      )}
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

/** Straight upholstered sofa: a bench-seat cushion, back cushion, boxy arms, and short peg legs — the loveseat catalog entry reuses this same component at a narrower width. */
export function StraightSofa({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const armW = 0.18;
  const legH = 0.12;
  const seatH = height * 0.4;
  const backH = height - seatH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width - armW * 2, seatH, depth]} radius={0.05} smoothness={3} position={[0, legH + seatH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width - armW * 2, backH, 0.18]}
        radius={0.05}
        smoothness={3}
        position={[0, legH + seatH + backH / 2 - 0.03, depth / 2 - 0.09]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      {[-1, 1].map((side) => (
        <RoundedBox
          key={side}
          args={[armW, height - legH, depth]}
          radius={0.04}
          smoothness={3}
          position={[side * (width / 2 - armW / 2), legH + (height - legH) / 2, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={bodyColor} roughness={0.9} />
        </RoundedBox>
      ))}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.1), legH / 2, sz * (depth / 2 - 0.1)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.02, 0.025, legH, 8]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Simple wooden dining chair — a standalone catalog version of the chair used around dining tables, for extra seating anywhere in the room. */
export function WoodDiningChair({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const seatH = height * 0.5;
  const backH = height - seatH;
  const legT = 0.04;
  const legInset = legT / 2 + 0.02;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, seatH, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </mesh>
      <mesh position={[0, seatH + backH / 2, -depth / 2 + 0.02]} castShadow receiveShadow>
        <boxGeometry args={[width, backH, 0.04]} />
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </mesh>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - legInset), seatH / 2, sz * (depth / 2 - legInset)]} castShadow receiveShadow>
            <boxGeometry args={[legT, seatH, legT]} />
            <meshStandardMaterial color={frameColor} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Chaise lounge: an elongated low seat with one raised end acting as a backrest/headrest. */
export function ChaiseLounge({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = 0.12;
  const seatH = height * 0.5;
  const raisedH = height - legH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, seatH, depth]} radius={0.06} smoothness={3} position={[0, legH + seatH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.28, raisedH, depth]}
        radius={0.06}
        smoothness={3}
        position={[-width / 2 + width * 0.14, legH + raisedH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      {[-1, 1].map((sz) => (
        <mesh key={sz} position={[width / 2 - 0.08, legH / 2, sz * (depth / 2 - 0.08)]} castShadow receiveShadow>
          <cylinderGeometry args={[0.02, 0.025, legH, 8]} />
          <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Bar stool: tall round seat on a slim pedestal with a footrest ring. */
export function BarStool({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const seatColor = selected ? WALL_COLOR_SELECTED : color;
  const seatR = width / 2;
  const seatT = 0.05;
  const poleR = 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - seatT / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[seatR, seatR, seatT, 20]} />
        <meshStandardMaterial color={seatColor} roughness={0.85} />
      </mesh>
      <mesh position={[0, (height - seatT) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[poleR, poleR, height - seatT, 12]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, height * 0.35, 0]} castShadow>
        <torusGeometry args={[seatR * 0.75, 0.012, 8, 20]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.01, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[seatR * 0.7, seatR * 0.7, 0.02, 20]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
    </group>
  );
}

/** Rectangular tufted ottoman/bench: a padded top on four short peg legs. */
export function OttomanBench({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const padColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = height * 0.22;
  const padH = height - legH;
  const legInset = 0.06;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox
        args={[width, padH, depth]}
        radius={Math.min(width, depth, padH) * 0.25}
        smoothness={3}
        position={[0, legH + padH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={padColor} roughness={0.95} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - legInset), legH / 2, sz * (depth / 2 - legInset)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.02, 0.025, legH, 8]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Wingback chair: a tall back with angled side "wings", a boxy seat cushion, and short turned legs. */
export function WingbackChair({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = height * 0.16;
  const seatH = height * 0.32;
  const backH = height - legH - seatH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, seatH, depth]} radius={0.05} smoothness={3} position={[0, legH + seatH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width, backH, 0.16]}
        radius={0.05}
        smoothness={3}
        position={[0, legH + seatH + backH / 2 - 0.02, depth / 2 - 0.08]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      {[-1, 1].map((side) => (
        <RoundedBox
          key={side}
          args={[width * 0.16, backH * 0.85, depth * 0.5]}
          radius={0.04}
          smoothness={3}
          position={[side * (width / 2 - width * 0.08), legH + seatH + backH * 0.85 / 2, 0]}
          rotation={[0, side * -0.35, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color={bodyColor} roughness={0.9} />
        </RoundedBox>
      ))}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.08), legH / 2, sz * (depth / 2 - 0.08)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.02, 0.025, legH, 8]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Recliner chair: a chunky upholstered chair with a footrest block extended in front. */
export function ReclinerChair({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = 0.1;
  const seatH = height * 0.42;
  const backH = height - legH - seatH;
  const footrestD = depth * 0.4;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, seatH, depth]} radius={0.06} smoothness={3} position={[0, legH + seatH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width, backH, 0.2]}
        radius={0.06}
        smoothness={3}
        position={[0, legH + seatH + backH / 2 - 0.03, depth / 2 - 0.1]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.8, legH + 0.08, footrestD]}
        radius={0.04}
        smoothness={3}
        position={[0, (legH + 0.08) / 2, -depth / 2 - footrestD / 2]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
    </group>
  );
}

/** Chesterfield sofa: a tufted-look boxy body with tall rolled arms that rise above the back cushion. */
export function ChesterfieldSofa({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const armW = 0.2;
  const legH = 0.1;
  const seatH = height * 0.38;
  const backH = height - seatH - legH * 0.4;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width - armW * 2, seatH, depth]} radius={0.04} smoothness={3} position={[0, legH + seatH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </RoundedBox>
      <RoundedBox
        args={[width - armW * 2, backH * 0.8, 0.18]}
        radius={0.04}
        smoothness={3}
        position={[0, legH + seatH + (backH * 0.8) / 2 - 0.02, depth / 2 - 0.09]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </RoundedBox>
      {[-0.28, 0, 0.28].map((fx) =>
        [0.35, 0.65].map((fy) => (
          <mesh
            key={`${fx}-${fy}`}
            position={[fx * (width - armW * 2), legH + seatH + backH * 0.8 * fy, depth / 2 - 0.002]}
            castShadow
          >
            <sphereGeometry args={[0.012, 8, 8]} />
            <meshStandardMaterial color={bodyColor} roughness={0.3} />
          </mesh>
        )),
      )}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (width / 2 - armW / 2), legH + backH / 2, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
          <cylinderGeometry args={[armW / 2, armW / 2, depth, 16]} />
          <meshStandardMaterial color={bodyColor} roughness={0.6} />
        </mesh>
      ))}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.12), legH / 2, sz * (depth / 2 - 0.12)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.025, 0.03, legH, 8]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** L-shaped sectional sofa: a straight run plus a perpendicular chaise-return segment sharing one corner. */
export function SectionalSofa({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = 0.1;
  const seatH = height * 0.4;
  const backH = height - seatH - legH;
  const returnDepth = depth * 1.6;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, seatH, depth]} radius={0.05} smoothness={3} position={[0, legH + seatH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width, backH, 0.18]}
        radius={0.05}
        smoothness={3}
        position={[0, legH + seatH + backH / 2 - 0.02, depth / 2 - 0.09]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[depth, seatH, returnDepth]}
        radius={0.05}
        smoothness={3}
        position={[-width / 2 + depth / 2, legH + seatH / 2, depth / 2 + returnDepth / 2]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={bodyColor} roughness={0.9} />
      </RoundedBox>
    </group>
  );
}

/** Bean bag chair: a squashed, lumpy sphere sitting low to the floor. */
export function BeanBagChair({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const bagColor = selected ? WALL_COLOR_SELECTED : color;
  const radius = width / 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} scale={[1, height / width, 1]} castShadow receiveShadow>
        <sphereGeometry args={[radius, 20, 16]} />
        <meshStandardMaterial color={bagColor} roughness={1} />
      </mesh>
    </group>
  );
}

/** Rocking chair: a wood-frame chair seat and back on a pair of curved rocker rails. */
export function RockingChairModel({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const rockerH = 0.12;
  const seatH = height * 0.42;
  const backH = height - rockerH - seatH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, rockerH, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.85, 0.04, depth * 0.85]} />
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </mesh>
      <mesh position={[0, rockerH + seatH, -depth / 2 + 0.03]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.85, backH, 0.04]} />
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (width / 2 - 0.03), rockerH / 2, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
          <torusGeometry args={[depth * 0.6, 0.018, 8, 20, Math.PI]} />
          <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
        </mesh>
      ))}
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

/** Bunk bed: two stacked frame+mattress decks joined by a side ladder. */
export function BunkBed({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const deckH = 0.14;
  const mattressH = 0.12;
  const lowerY = 0;
  const upperY = height * 0.58;
  const postThickness = 0.06;
  const ladderX = width / 2 - postThickness / 2;

  const deck = (y: number, key: string) => (
    <group key={key}>
      <RoundedBox args={[width, deckH, depth]} radius={0.02} smoothness={2} position={[0, y + deckH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </RoundedBox>
      <RoundedBox args={[width * 0.94, mattressH, depth * 0.94]} radius={0.03} smoothness={2} position={[0, y + deckH + mattressH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f5f1e6" roughness={0.9} />
      </RoundedBox>
    </group>
  );

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {deck(lowerY, "lower")}
      {deck(upperY, "upper")}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - postThickness / 2), height / 2, sz * (depth / 2 - postThickness / 2)]} castShadow receiveShadow>
            <boxGeometry args={[postThickness, height, postThickness]} />
            <meshStandardMaterial color={frameColor} roughness={0.6} />
          </mesh>
        )),
      )}
      {Array.from({ length: 4 }, (_, i) => (
        <mesh key={i} position={[ladderX, 0.15 + i * (upperY / 4), depth / 2 + 0.02]} castShadow>
          <boxGeometry args={[0.22, 0.03, 0.03]} />
          <meshStandardMaterial color={frameColor} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Sleigh bed: a frame with curved, scrolled head- and footboards (approximated with tilted rounded slabs). */
export function SleighBed({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const frameH = height * 0.35;
  const mattressH = height * 0.35;
  const boardH = height;
  const headThickness = 0.08;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, frameH, depth]} radius={0.03} smoothness={2} position={[0, frameH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={frameColor} roughness={0.5} />
      </RoundedBox>
      <RoundedBox args={[width * 0.96, mattressH, depth * 0.96]} radius={0.05} smoothness={3} position={[0, frameH + mattressH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f5f1e6" roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width + 0.04, boardH, headThickness]}
        radius={headThickness * 0.35}
        smoothness={3}
        position={[0, boardH / 2, -depth / 2 - headThickness / 2]}
        rotation={[-0.12, 0, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={frameColor} roughness={0.5} />
      </RoundedBox>
      <RoundedBox
        args={[width + 0.04, boardH * 0.6, headThickness]}
        radius={headThickness * 0.35}
        smoothness={3}
        position={[0, (boardH * 0.6) / 2, depth / 2 + headThickness / 2]}
        rotation={[0.12, 0, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={frameColor} roughness={0.5} />
      </RoundedBox>
    </group>
  );
}

/** Four-poster canopy bed: a low frame + mattress under a top rail frame held up by four corner posts. */
export function CanopyBed({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const frameH = height * 0.3;
  const mattressH = height * 0.3;
  const postH = height * 2.2;
  const postThickness = 0.06;
  const railThickness = 0.04;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, frameH, depth]} radius={0.03} smoothness={2} position={[0, frameH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </RoundedBox>
      <RoundedBox args={[width * 0.96, mattressH, depth * 0.96]} radius={0.05} smoothness={3} position={[0, frameH + mattressH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f5f1e6" roughness={0.9} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - postThickness / 2), postH / 2, sz * (depth / 2 - postThickness / 2)]} castShadow receiveShadow>
            <boxGeometry args={[postThickness, postH, postThickness]} />
            <meshStandardMaterial color={frameColor} roughness={0.6} />
          </mesh>
        )),
      )}
      {[-1, 1].map((sz) => (
        <mesh key={`x${sz}`} position={[0, postH, sz * (depth / 2 - postThickness / 2)]} castShadow>
          <boxGeometry args={[width, railThickness, railThickness]} />
          <meshStandardMaterial color={frameColor} roughness={0.6} />
        </mesh>
      ))}
      {[-1, 1].map((sx) => (
        <mesh key={`z${sx}`} position={[sx * (width / 2 - postThickness / 2), postH, 0]} castShadow>
          <boxGeometry args={[railThickness, railThickness, depth]} />
          <meshStandardMaterial color={frameColor} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Murphy (wall) bed shown folded away: a tall flat cabinet front standing in for the closed position. */
export function MurphyBedCabinet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.6} />
      </RoundedBox>
      <mesh position={[0, height * 0.5, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[width * 0.9, 0.008, 0.008]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * width * 0.4, height * 0.5, depth / 2 + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, height * 0.14, 8]} />
          <meshStandardMaterial color="#c9a86a" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Daybed frame: a low single mattress flanked by a back cushion and two arm bolsters, so it reads as a sofa by day. */
export function DaybedFrame({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const frameH = height * 0.4;
  const mattressH = height * 0.3;
  const bolsterH = height - frameH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, frameH, depth]} radius={0.03} smoothness={2} position={[0, frameH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={frameColor} roughness={0.6} />
      </RoundedBox>
      <RoundedBox args={[width * 0.94, mattressH, depth * 0.9]} radius={0.04} smoothness={3} position={[0, frameH + mattressH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f5f1e6" roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[width, bolsterH, 0.14]}
        radius={0.04}
        smoothness={3}
        position={[0, frameH + bolsterH / 2, -depth / 2 + 0.07]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={frameColor} roughness={0.85} />
      </RoundedBox>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (width / 2 - 0.09), frameH + height * 0.18, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
          <cylinderGeometry args={[height * 0.15, height * 0.15, depth * 0.85, 16]} />
          <meshStandardMaterial color={frameColor} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** Baby crib: a mattress platform enclosed by slatted side rails on four short posts. */
export function Crib({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const mattressH = 0.08;
  const railH = height - mattressH;
  const postThickness = 0.04;
  const slatCount = 8;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width * 0.94, mattressH, depth * 0.94]} radius={0.02} smoothness={2} position={[0, railH + mattressH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#f5f1e6" roughness={0.9} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - postThickness / 2), railH / 2, sz * (depth / 2 - postThickness / 2)]} castShadow receiveShadow>
            <boxGeometry args={[postThickness, railH, postThickness]} />
            <meshStandardMaterial color={frameColor} roughness={0.5} />
          </mesh>
        )),
      )}
      {Array.from({ length: slatCount }, (_, i) => (
        <mesh
          key={`fs${i}`}
          position={[-width / 2 + (width / slatCount) * (i + 0.5), railH / 2, depth / 2 - postThickness / 2]}
          castShadow
        >
          <boxGeometry args={[0.015, railH * 0.92, 0.015]} />
          <meshStandardMaterial color={frameColor} roughness={0.5} />
        </mesh>
      ))}
      {Array.from({ length: slatCount }, (_, i) => (
        <mesh
          key={`bs${i}`}
          position={[-width / 2 + (width / slatCount) * (i + 0.5), railH / 2, -depth / 2 + postThickness / 2]}
          castShadow
        >
          <boxGeometry args={[0.015, railH * 0.92, 0.015]} />
          <meshStandardMaterial color={frameColor} roughness={0.5} />
        </mesh>
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

/** Chest of drawers / nightstand: a cabinet body with a stack of drawer-front seams and knobs — the drawer count scales with height, so this covers both a tall dresser and a small nightstand. */
export function ChestOfDrawers({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const drawerCount = height > 1.1 ? 5 : height > 0.6 ? 4 : 2;
  const drawerH = height / drawerCount;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </RoundedBox>
      {Array.from({ length: drawerCount - 1 }, (_, i) => (
        <mesh key={i} position={[0, (i + 1) * drawerH, depth / 2 + 0.002]} castShadow>
          <boxGeometry args={[width * 0.92, 0.006, 0.006]} />
          <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
        </mesh>
      ))}
      {Array.from({ length: drawerCount }, (_, i) => (
        <mesh key={`h${i}`} position={[0, i * drawerH + drawerH / 2, depth / 2 + 0.02]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, width * 0.18, 8]} />
          <meshStandardMaterial color="#c9a86a" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Low sideboard/credenza: a wide, low cabinet with a sliding-door seam and slim raised legs — the "media console" catalog entry reuses the exact same shape. */
export function Sideboard({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = 0.1;
  const bodyH = height - legH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, bodyH, depth]} radius={0.02} smoothness={2} position={[0, legH + bodyH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </RoundedBox>
      {[-1, 0, 1].map((sx) => (
        <mesh key={sx} position={[sx * (width / 3), legH + bodyH / 2, depth / 2 + 0.002]} castShadow>
          <boxGeometry args={[0.006, bodyH * 0.85, 0.006]} />
          <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
        </mesh>
      ))}
      {[-2, -1, 1, 2].map((slot) => (
        <mesh key={slot} position={[slot * (width / 6), legH + bodyH * 0.55, depth / 2 + 0.02]} castShadow>
          <cylinderGeometry args={[0.007, 0.007, bodyH * 0.14, 8]} />
          <meshStandardMaterial color="#c9a86a" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.08), legH / 2, sz * (depth / 2 - 0.08)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.015, 0.015, legH, 8]} />
            <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Leaning ladder shelf: an angled frame with a few shallow shelves — the bathroom "towel ladder" and living-room "blanket ladder" catalog entries both reuse this shape as-is. */
export function LadderShelf({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const tilt = 0.22;
  const shelfCount = 4;
  const railThickness = 0.035;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <group rotation={[tilt, 0, 0]} position={[0, 0, -depth * 0.15]}>
        {[-1, 1].map((sx) => (
          <mesh key={sx} position={[sx * (width / 2 - railThickness / 2), height / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[railThickness, height, railThickness]} />
            <meshStandardMaterial color={frameColor} roughness={0.65} />
          </mesh>
        ))}
        {Array.from({ length: shelfCount }, (_, i) => (
          <mesh key={i} position={[0, height * 0.18 + i * (height * 0.72) / (shelfCount - 1), depth * 0.1]} castShadow receiveShadow>
            <boxGeometry args={[width - railThickness, 0.025, depth * 0.55]} />
            <meshStandardMaterial color={frameColor} roughness={0.65} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Entryway storage bench: a box body with a padded cushion top, a lift-lid seam, and short peg feet. */
export function StorageBench({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const legH = 0.08;
  const cushionH = height * 0.18;
  const bodyH = height - legH - cushionH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, bodyH, depth]} radius={0.02} smoothness={2} position={[0, legH + bodyH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </RoundedBox>
      <RoundedBox
        args={[width * 0.98, cushionH, depth * 0.98]}
        radius={cushionH * 0.4}
        smoothness={3}
        position={[0, legH + bodyH + cushionH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#e9e2d0" roughness={0.95} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.08), legH / 2, sz * (depth / 2 - 0.08)]} castShadow receiveShadow>
            <cylinderGeometry args={[0.02, 0.025, legH, 8]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Blanket/trunk chest: a low wide box with a domed lid (a half-cylinder) and two side handles. */
export function TrunkChest({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const lidR = Math.min(depth, height * 0.6) / 2;
  const bodyH = height - lidR;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, bodyH, depth]} radius={0.02} smoothness={2} position={[0, bodyH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </RoundedBox>
      <mesh position={[0, bodyH, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
        <cylinderGeometry args={[lidR, lidR, width, 20, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * width * 0.32, bodyH * 0.6, depth / 2 + 0.01]} castShadow>
          <torusGeometry args={[0.035, 0.008, 6, 12]} />
          <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

/** Glass-door display cabinet: a cabinet body whose front face is a semi-transparent glass panel, with a couple of items shown on a mid shelf. */
export function DisplayCabinet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * (width / 2 - 0.02), height / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.04, height, depth]} />
          <meshStandardMaterial color={bodyColor} roughness={0.7} />
        </mesh>
      ))}
      <mesh position={[0, height - 0.02, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, 0.04, depth]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      <mesh position={[0, height / 2, depth / 2 - 0.01]}>
        <boxGeometry args={[width * 0.9, height * 0.9, 0.01]} />
        <meshStandardMaterial color="#cfe0e6" roughness={0.1} transparent opacity={0.35} />
      </mesh>
      <mesh position={[0, height * 0.5, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.9, 0.02, depth * 0.8]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      <mesh position={[-width * 0.15, height * 0.58, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.08, 0.16, 0.08]} />
        <meshStandardMaterial color="#a15c3e" roughness={0.8} />
      </mesh>
      <mesh position={[width * 0.15, height * 0.56, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.05, 0.05, 0.12, 12]} />
        <meshStandardMaterial color="#c9a86a" roughness={0.5} metalness={0.3} />
      </mesh>
    </group>
  );
}

/** Corner shelf unit: an L-shaped stack of triangular shelves fitting into a room corner. */
export function CornerShelfUnit({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const shelfColor = selected ? WALL_COLOR_SELECTED : color;
  const shelfCount = 4;
  const gap = height / shelfCount;
  const postThickness = 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[-width / 2 + postThickness / 2, height / 2, -depth / 2 + postThickness / 2]} castShadow receiveShadow>
        <boxGeometry args={[postThickness, height, postThickness]} />
        <meshStandardMaterial color={shelfColor} roughness={0.65} />
      </mesh>
      {Array.from({ length: shelfCount }, (_, i) => (
        <mesh key={i} position={[-width / 4, i * gap + 0.02, -depth / 4]} rotation={[0, 0, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[Math.min(width, depth) / 2, Math.min(width, depth) / 2, 0.025, 4, 1, false, Math.PI / 4, Math.PI / 2]} />
          <meshStandardMaterial color={shelfColor} roughness={0.65} />
        </mesh>
      ))}
    </group>
  );
}

/** Cubby storage organizer: an open grid of square compartments, à la Kallax-style shelving. */
export function CubbyOrganizer({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const cols = 3;
  const rows = 3;
  const cellW = width / cols;
  const cellH = height / rows;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color={frameColor} roughness={0.7} />
      </mesh>
      {Array.from({ length: cols - 1 }, (_, i) => (
        <mesh key={`c${i}`} position={[-width / 2 + cellW * (i + 1), height / 2, 0]} castShadow>
          <boxGeometry args={[0.01, height, depth + 0.01]} />
          <meshStandardMaterial color="#1c1c1c" roughness={0.6} />
        </mesh>
      ))}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <mesh key={`r${i}`} position={[0, cellH * (i + 1), 0]} castShadow>
          <boxGeometry args={[width, 0.01, depth + 0.01]} />
          <meshStandardMaterial color="#1c1c1c" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** China hutch: a glass-front display cabinet on top of a solid, closed-door base cabinet. */
export function Hutch({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const baseH = height * 0.4;
  const upperH = height - baseH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, baseH, depth]} radius={0.02} smoothness={2} position={[0, baseH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </RoundedBox>
      <mesh position={[0, baseH / 2, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[0.006, baseH * 0.9, 0.006]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * width * 0.16, baseH * 0.55, depth / 2 + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, baseH * 0.16, 8]} />
          <meshStandardMaterial color="#c9a86a" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
      <RoundedBox args={[width * 0.92, upperH, depth * 0.7]} radius={0.02} smoothness={2} position={[0, baseH + upperH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.65} />
      </RoundedBox>
      <mesh position={[0, baseH + upperH / 2, depth * 0.35 - 0.01]}>
        <planeGeometry args={[width * 0.8, upperH * 0.85]} />
        <meshStandardMaterial color="#cfe0e6" roughness={0.1} transparent opacity={0.3} />
      </mesh>
    </group>
  );
}

/** Entryway coat rack: a slim pole with a ring of angled peg hooks near the top, on a small weighted base. */
export function CoatRack({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const hookY = height * 0.82;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.42, width * 0.5, 0.03, 20]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.02, 0.02, height, 12]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.5} />
      </mesh>
      {Array.from({ length: 6 }, (_, i) => {
        const theta = (i / 6) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(theta) * 0.05, hookY, Math.sin(theta) * 0.05]}
            rotation={[Math.cos(theta) * 0.6, 0, Math.sin(theta) * 0.6]}
            castShadow
          >
            <cylinderGeometry args={[0.012, 0.012, 0.12, 8]} />
            <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.5} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Umbrella stand: a small tapered cylindrical vessel by the entryway. */
export function UmbrellaStand({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const standColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.4, width * 0.3, height, 20]} />
        <meshStandardMaterial color={standColor} roughness={0.6} />
      </mesh>
      <mesh position={[0, height * 0.96, 0]} castShadow>
        <torusGeometry args={[width * 0.39, 0.012, 8, 20]} />
        <meshStandardMaterial color={standColor} roughness={0.4} metalness={0.3} />
      </mesh>
      {[0, 1, 2].map((i) => {
        const theta = (i / 3) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(theta) * width * 0.16, height * 0.7, Math.sin(theta) * width * 0.16]} rotation={[Math.sin(theta) * 0.15, 0, Math.cos(theta) * 0.15]} castShadow>
            <cylinderGeometry args={[0.008, 0.008, height * 0.55, 8]} />
            <meshStandardMaterial color="#3a3a3a" roughness={0.5} metalness={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Woven storage basket: an open-topped, gently tapered basket for blankets or toys. */
export function WeaveBasket({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const basketColor = selected ? WALL_COLOR_SELECTED : color;
  const radius = width / 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius * 0.82, height, 24]} />
        <meshStandardMaterial color={basketColor} roughness={1} />
      </mesh>
      <mesh position={[0, height * 0.95, 0]} castShadow>
        <torusGeometry args={[radius * 0.98, 0.015, 8, 24]} />
        <meshStandardMaterial color={basketColor} roughness={1} />
      </mesh>
    </group>
  );
}

/** Kitchen island: a cabinet base under a slightly overhanging countertop, with a shallow inset standing in for a sink basin. */
export function KitchenIsland({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const cabinetColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.04;
  const cabinetHeight = height - topThickness;
  const frontZ = depth / 2 + 0.002;
  // left third: a stack of drawer fronts; right two-thirds: a pair of cabinet doors — the mix of a real island's storage
  const drawerZoneW = width * 0.32;
  const doorZoneW = width - drawerZoneW;
  const drawerZoneX = -width / 2 + drawerZoneW / 2;
  const doorZoneX = drawerZoneW - width / 2 + doorZoneW / 2;
  const drawerCount = 3;
  const drawerH = cabinetHeight / drawerCount;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetHeight, depth]} radius={0.02} smoothness={2} position={[0, cabinetHeight / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.6} />
      </RoundedBox>
      {Array.from({ length: drawerCount - 1 }, (_, i) => (
        <mesh key={i} position={[drawerZoneX, (i + 1) * drawerH, frontZ]} castShadow>
          <boxGeometry args={[drawerZoneW * 0.92, 0.006, 0.006]} />
          <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
        </mesh>
      ))}
      {Array.from({ length: drawerCount }, (_, i) => (
        <mesh key={`h${i}`} position={[drawerZoneX, i * drawerH + drawerH / 2, frontZ + 0.015]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, drawerZoneW * 0.35, 8]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
      <mesh position={[doorZoneX, cabinetHeight / 2, frontZ]} castShadow>
        <boxGeometry args={[0.006, cabinetHeight * 0.92, 0.006]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[doorZoneX + (side * doorZoneW) / 4, cabinetHeight * 0.55, frontZ + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, cabinetHeight * 0.16, 8]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
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

/** Range/oven: a tall cabinet body with an oven door seam low down and four burner discs set into the top. */
export function KitchenRange({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.02;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.4} metalness={0.3} />
      </RoundedBox>
      <mesh position={[0, height - topThickness / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width - 0.02, topThickness, depth - 0.02]} />
        <meshStandardMaterial color="#1c1c1c" roughness={0.3} />
      </mesh>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * width * 0.22, height - topThickness - 0.005, sz * depth * 0.2]} castShadow>
            <cylinderGeometry args={[width * 0.1, width * 0.1, 0.01, 20]} />
            <meshStandardMaterial color="#0d0d0d" roughness={0.5} />
          </mesh>
        )),
      )}
      <mesh position={[0, height * 0.35, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[width * 0.8, height * 0.55, 0.01]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={[0, height * 0.62, depth / 2 + 0.02]} castShadow>
        <boxGeometry args={[width * 0.5, 0.02, 0.03]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
      </mesh>
    </group>
  );
}

/** Dishwasher: a plain cabinet-height panel with a slim control strip near the top and a recessed handle. */
export function Dishwasher({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.015} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.4} metalness={0.35} />
      </RoundedBox>
      <mesh position={[0, height * 0.94, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[width * 0.9, 0.03, 0.006]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} />
      </mesh>
      <mesh position={[0, height * 0.86, depth / 2 + 0.015]} castShadow>
        <boxGeometry args={[width * 0.85, 0.02, 0.02]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
      </mesh>
    </group>
  );
}

/** Bar cart: a slim two-tier wheeled cart with a thin frame and a wire glass-holder ring on top. */
export function BarCart({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const shelfThickness = 0.02;
  const topY = height - 0.08;
  const midY = height * 0.5;
  const legR = 0.015;
  const wheelR = 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {[topY, midY].map((y, i) => (
        <mesh key={i} position={[0, y, 0]} castShadow receiveShadow>
          <boxGeometry args={[width, shelfThickness, depth]} />
          <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.5} />
        </mesh>
      ))}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.03), (height - wheelR) / 2, sz * (depth / 2 - 0.03)]} castShadow receiveShadow>
            <cylinderGeometry args={[legR, legR, height - wheelR, 8]} />
            <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.5} />
          </mesh>
        )),
      )}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`w${sx}-${sz}`} position={[sx * (width / 2 - 0.03), wheelR, sz * (depth / 2 - 0.03)]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[wheelR, wheelR, 0.015, 12]} />
            <meshStandardMaterial color="#2a2a2a" roughness={0.6} />
          </mesh>
        )),
      )}
      <mesh position={[0, topY + 0.03, 0]} castShadow>
        <torusGeometry args={[Math.min(width, depth) * 0.35, 0.008, 6, 20]} />
        <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.5} />
      </mesh>
    </group>
  );
}

/** Sink base cabinet: a cabinet body with a farmhouse apron-front panel and a recessed basin cut into the countertop. */
export function FarmhouseSinkCabinet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const cabinetColor = selected ? WALL_COLOR_SELECTED : color;
  const topThickness = 0.04;
  const cabinetHeight = height - topThickness;
  const basinDepth = 0.12;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetHeight, depth]} radius={0.02} smoothness={2} position={[0, cabinetHeight / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.6} />
      </RoundedBox>
      <mesh position={[0, cabinetHeight * 0.55, depth / 2 + 0.005]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.7, cabinetHeight * 0.7, 0.02]} />
        <meshStandardMaterial color="#f5f5f5" roughness={0.35} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={`h${side}`} position={[side * width * 0.42, cabinetHeight * 0.5, depth / 2 + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, cabinetHeight * 0.14, 8]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
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
      <mesh position={[0, cabinetHeight + topThickness - basinDepth / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.55, basinDepth, depth * 0.55]} />
        <meshStandardMaterial color="#dcdcdc" roughness={0.3} />
      </mesh>
      <mesh position={[0, cabinetHeight + topThickness + 0.12, -depth * 0.3]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.24, 10]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

/** Microwave cart: a small cabinet on casters with a microwave-oven box sitting on top. */
export function MicrowaveCart({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const cabinetColor = selected ? WALL_COLOR_SELECTED : color;
  const cabinetH = height * 0.65;
  const microwaveH = height - cabinetH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetH, depth]} radius={0.02} smoothness={2} position={[0, cabinetH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.6} />
      </RoundedBox>
      <mesh position={[0, cabinetH * 0.55, depth / 2 + 0.02]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, cabinetH * 0.18, 8]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
      </mesh>
      <mesh position={[0, cabinetH + microwaveH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.85, microwaveH, depth * 0.85]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.35} metalness={0.3} />
      </mesh>
      <mesh position={[0, cabinetH + microwaveH / 2, depth * 0.42]} castShadow>
        <boxGeometry args={[width * 0.5, microwaveH * 0.6, 0.01]} />
        <meshStandardMaterial color="#111214" roughness={0.15} />
      </mesh>
    </group>
  );
}

/** Double oven tower: a tall cabinet column with two stacked oven doors, each with a small window and handle bar. */
export function DoubleOvenTower({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.4} metalness={0.3} />
      </RoundedBox>
      {[0.35, 0.68].map((frac, i) => (
        <group key={i}>
          <mesh position={[0, height * frac, depth / 2 + 0.002]} castShadow>
            <boxGeometry args={[width * 0.75, height * 0.18, 0.01]} />
            <meshStandardMaterial color="#1c1c1c" roughness={0.25} />
          </mesh>
          <mesh position={[0, height * frac + height * 0.12, depth / 2 + 0.02]} castShadow>
            <boxGeometry args={[width * 0.6, 0.02, 0.03]} />
            <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
          </mesh>
        </group>
      ))}
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
      <mesh position={[0, height * 0.97, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width * 0.8, depth * 0.62]} />
        <meshStandardMaterial color="#dce8ea" roughness={0.15} />
      </mesh>
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
  const frontZ = depth / 2 + 0.002;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetH, depth]} radius={0.02} smoothness={2} position={[0, cabinetH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.65} />
      </RoundedBox>
      <mesh position={[0, cabinetH / 2, frontZ]} castShadow>
        <boxGeometry args={[0.006, cabinetH * 0.92, 0.006]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * width * 0.16, cabinetH * 0.55, frontZ + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, cabinetH * 0.16, 8]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
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
      {[-1, 1].map((side) => (
        <mesh key={`k${side}`} position={[side * 0.05, cabinetH + basinH + 0.03, -depth * 0.3]} castShadow>
          <cylinderGeometry args={[0.012, 0.012, 0.02, 10]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/** Toilet: a tank box behind a rounded bowl-and-base shell. */
export function Toilet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const shellColor = selected ? WALL_COLOR_SELECTED : color;
  const tankH = height * 0.5;
  const tankDepth = depth * 0.28;
  const bowlH = height - tankH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox
        args={[width * 0.85, tankH, tankDepth]}
        radius={0.02}
        smoothness={2}
        position={[0, height - tankH / 2, -depth / 2 + tankDepth / 2]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={shellColor} roughness={0.2} />
      </RoundedBox>
      <RoundedBox
        args={[width, bowlH, depth]}
        radius={Math.min(width, bowlH, depth) * 0.4}
        smoothness={4}
        position={[0, bowlH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={shellColor} roughness={0.2} />
      </RoundedBox>
      <mesh position={[0, bowlH * 0.85, depth * 0.05]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.32, width * 0.34, bowlH * 0.15, 20]} />
        <meshStandardMaterial color="#f5f5f5" roughness={0.15} />
      </mesh>
      <mesh position={[0, height + 0.003, -depth / 2 + tankDepth / 2]} castShadow>
        <cylinderGeometry args={[0.018, 0.018, 0.006, 16]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
      </mesh>
    </group>
  );
}

/** Small bidet — a shorter, tankless cousin of the toilet bowl shell. */
export function Bidet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const shellColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox
        args={[width, height, depth]}
        radius={Math.min(width, height, depth) * 0.4}
        smoothness={4}
        position={[0, height / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={shellColor} roughness={0.2} />
      </RoundedBox>
      <mesh position={[0, height * 0.88, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.34, width * 0.36, height * 0.15, 20]} />
        <meshStandardMaterial color="#f5f5f5" roughness={0.15} />
      </mesh>
      <mesh position={[0, height * 0.95, -depth * 0.25]} castShadow>
        <cylinderGeometry args={[0.01, 0.01, 0.08, 8]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

/** Shower enclosure: a shallow tiled base tray inside semi-transparent glass panels on two sides. */
export function ShowerEnclosure({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const trayColor = selected ? WALL_COLOR_SELECTED : color;
  const trayH = 0.05;
  const glassH = height * 0.75;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, trayH, depth]} radius={0.02} smoothness={2} position={[0, trayH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={trayColor} roughness={0.5} />
      </RoundedBox>
      <mesh position={[-width / 2 + 0.01, trayH + glassH / 2, 0]} receiveShadow>
        <boxGeometry args={[0.015, glassH, depth]} />
        <meshStandardMaterial color="#cfe6ea" roughness={0.05} transparent opacity={0.25} />
      </mesh>
      <mesh position={[0, trayH + glassH / 2, -depth / 2 + 0.01]} receiveShadow>
        <boxGeometry args={[width, glassH, 0.015]} />
        <meshStandardMaterial color="#cfe6ea" roughness={0.05} transparent opacity={0.25} />
      </mesh>
      <mesh position={[0, trayH + glassH * 0.98, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.15, 10]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
      <mesh position={[0, trayH + glassH * 0.92, -depth / 2 + 0.08]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.01, 0.01, 0.16, 8]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
      <mesh position={[0, trayH + glassH * 0.92, -depth / 2 + 0.16]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 0.012, 20]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.25} metalness={0.7} />
      </mesh>
      <mesh position={[width * 0.3, trayH + glassH * 0.55, -depth / 2 + 0.01]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 0.015, 16]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

/** Pedestal sink: a basin bowl on a slim single column pedestal, rather than a full vanity cabinet. */
export function PedestalSink({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const basinColor = selected ? WALL_COLOR_SELECTED : color;
  const basinH = height * 0.22;
  const pedestalH = height - basinH;
  const pedestalR = Math.min(width, depth) * 0.16;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox
        args={[width, basinH, depth]}
        radius={Math.min(width, basinH, depth) * 0.4}
        smoothness={3}
        position={[0, pedestalH + basinH / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color={basinColor} roughness={0.2} />
      </RoundedBox>
      <mesh position={[0, pedestalH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[pedestalR, pedestalR * 1.3, pedestalH, 20]} />
        <meshStandardMaterial color={basinColor} roughness={0.2} />
      </mesh>
      <mesh position={[0, pedestalH + basinH + 0.08, -depth * 0.28]} castShadow>
        <cylinderGeometry args={[0.012, 0.012, 0.16, 10]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * 0.06, pedestalH + basinH + 0.02, -depth * 0.28]} castShadow>
          <cylinderGeometry args={[0.012, 0.012, 0.02, 10]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/** Double vanity: a wide cabinet with two inset basins side by side, sharing one countertop. */
export function DoubleVanitySink({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const cabinetColor = selected ? WALL_COLOR_SELECTED : color;
  const basinH = height * 0.12;
  const cabinetH = height - basinH;
  const basinW = width * 0.36;
  const basinOffset = width * 0.24;
  const frontZ = depth / 2 + 0.002;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, cabinetH, depth]} radius={0.02} smoothness={2} position={[0, cabinetH / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={cabinetColor} roughness={0.65} />
      </RoundedBox>
      {[-1, 0, 1].map((sx) => (
        <mesh key={sx} position={[sx * (width / 3), cabinetH / 2, frontZ]} castShadow>
          <boxGeometry args={[0.006, cabinetH * 0.92, 0.006]} />
          <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`d${side}`} position={[side * basinOffset, cabinetH * 0.55, frontZ + 0.02]} castShadow>
          <cylinderGeometry args={[0.008, 0.008, cabinetH * 0.16, 8]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
      <RoundedBox args={[width, basinH * 0.4, depth]} radius={0.01} smoothness={2} position={[0, cabinetH + basinH * 0.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#e8e4da" roughness={0.3} />
      </RoundedBox>
      {[-1, 1].map((side) => (
        <RoundedBox
          key={side}
          args={[basinW, basinH, depth * 0.85]}
          radius={Math.min(basinW, basinH, depth * 0.85) * 0.4}
          smoothness={3}
          position={[side * basinOffset, cabinetH + basinH * 0.4 + basinH / 2, 0]}
          castShadow
          receiveShadow
        >
          <meshStandardMaterial color="#f5f5f5" roughness={0.2} />
        </RoundedBox>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`f${side}`} position={[side * basinOffset, cabinetH + basinH + 0.1, -depth * 0.3]} castShadow>
          <cylinderGeometry args={[0.01, 0.01, 0.18, 10]} />
          <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/** Wall-hung mirror cabinet: a thin box with a reflective front face and a slim frame edge. */
export function MirrorCabinet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.01} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.2} />
      </RoundedBox>
      <mesh position={[0, height / 2, depth / 2 - 0.005]}>
        <planeGeometry args={[width * 0.92, height * 0.92]} />
        <meshStandardMaterial color="#dfeaee" roughness={0.05} metalness={0.6} />
      </mesh>
    </group>
  );
}

/** Built-in alcove bathtub: a simple rectangular tub shell (less rounded than the freestanding tub) meant to sit against a wall. */
export function AlcoveBathtub({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const shellColor = selected ? WALL_COLOR_SELECTED : color;
  const wallThickness = 0.05;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={shellColor} roughness={0.2} />
      </RoundedBox>
      <mesh position={[0, height - wallThickness / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width - wallThickness * 2, wallThickness, depth - wallThickness * 2]} />
        <meshStandardMaterial color="#dcdcdc" roughness={0.25} />
      </mesh>
      <mesh position={[0, height * 0.9, -depth / 2 + 0.06]} castShadow>
        <cylinderGeometry args={[0.014, 0.014, 0.1, 10]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  );
}

/** Wall-style towel warmer rack: a slim ladder of rounded chrome rungs on two side rails, floor-standing. */
export function TowelWarmerRack({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const railColor = selected ? WALL_COLOR_SELECTED : color;
  const rungCount = 6;
  const railThickness = 0.02;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * (width / 2 - railThickness / 2), height / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[railThickness / 2, railThickness / 2, height, 10]} />
          <meshStandardMaterial color={railColor} roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
      {Array.from({ length: rungCount }, (_, i) => (
        <mesh
          key={i}
          position={[0, height * 0.15 + i * (height * 0.7) / (rungCount - 1), 0]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[railThickness / 2, railThickness / 2, width, 10]} />
          <meshStandardMaterial color={railColor} roughness={0.3} metalness={0.6} />
        </mesh>
      ))}
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

/** Arc floor lamp: a weighted marble-look disc base, a curved arm sweeping up and over, and a small dome shade at the end. */
export function ArcLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const armRadius = height * 0.55;
  const arcSpan = Math.PI * 0.62;
  const segments = 16;

  const points = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments;
    const theta = -Math.PI / 2 + t * arcSpan;
    return [Math.cos(theta) * armRadius, height * 0.18 + Math.sin(theta) * armRadius + armRadius, 0] as [number, number, number];
  });
  const tip = points[points.length - 1];

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.025, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.32, width * 0.4, 0.05, 24]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.3} metalness={0.4} />
      </mesh>
      {points.slice(0, -1).map((p, i) => {
        const next = points[i + 1];
        const mid: [number, number, number] = [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2, 0];
        const segLen = Math.hypot(next[0] - p[0], next[1] - p[1]);
        const angle = Math.atan2(next[1] - p[1], next[0] - p[0]);
        return (
          <mesh key={i} position={mid} rotation={[0, 0, angle - Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.012, 0.012, segLen, 8]} />
            <meshStandardMaterial color="#2a2a2a" roughness={0.3} metalness={0.5} />
          </mesh>
        );
      })}
      <mesh position={tip} rotation={[Math.PI, 0, 0]} castShadow>
        <cylinderGeometry args={[width * 0.22, width * 0.12, 0.14, 16, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.7} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Torchiere uplight: a tall slim pole ending in an open bowl shade that throws light upward. */
export function TorchiereLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const bowlH = height * 0.14;
  const poleH = height - bowlH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.35, width * 0.42, 0.03, 20]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.02, 0.025, poleH, 12]} />
        <meshStandardMaterial color="#3a3a3a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH + bowlH / 2, 0]} rotation={[Math.PI, 0, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.4, width * 0.12, bowlH, 20, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.5} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Tripod floor lamp: three splayed wooden legs meeting a pole and a wide drum shade. */
export function TripodLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const shadeH = height * 0.32;
  const poleH = height - shadeH;
  const legSpread = width * 0.42;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {[0, 1, 2].map((i) => {
        const theta = (i / 3) * Math.PI * 2;
        return (
          <mesh
            key={i}
            position={[Math.cos(theta) * legSpread * 0.5, poleH * 0.42, Math.sin(theta) * legSpread * 0.5]}
            rotation={[Math.cos(theta) * 0.35, 0, Math.sin(theta) * 0.35]}
            castShadow
            receiveShadow
          >
            <cylinderGeometry args={[0.014, 0.018, poleH * 0.85, 8]} />
            <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
          </mesh>
        );
      })}
      <mesh position={[0, poleH * 0.55, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.015, 0.015, poleH * 0.9, 10]} />
        <meshStandardMaterial color={WOOD_LEG_COLOR} roughness={0.6} />
      </mesh>
      <mesh position={[0, poleH + shadeH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.42, width * 0.48, shadeH, 20, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Small desk lamp: a weighted base, a bent two-segment arm, and a tilted cone shade. */
export function DeskLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const lowerH = height * 0.45;
  const upperLen = height * 0.4;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.01, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.4, width * 0.4, 0.02, 16]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, lowerH / 2, 0]} rotation={[0, 0, 0.25]} castShadow receiveShadow>
        <cylinderGeometry args={[0.012, 0.012, lowerH, 8]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[width * 0.12, lowerH + upperLen * 0.3, 0]} rotation={[0, 0, -0.6]} castShadow receiveShadow>
        <cylinderGeometry args={[0.01, 0.01, upperLen, 8]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[width * 0.32, lowerH + upperLen * 0.55, 0]} rotation={[0, 0, Math.PI * 0.62]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.18, width * 0.07, height * 0.16, 16, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Decorative floor lantern: a slim metal cage frame around a candle-like glowing column. */
export function FloorLantern({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const postCount = 4;
  const postR = width * 0.42;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {Array.from({ length: postCount }, (_, i) => {
        const theta = (i / postCount) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(theta) * postR, height / 2, Math.sin(theta) * postR]} castShadow receiveShadow>
            <cylinderGeometry args={[0.01, 0.01, height, 6]} />
            <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.6} />
          </mesh>
        );
      })}
      {[0.05, height - 0.08].map((y, i) => (
        <mesh key={i} position={[0, y, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[postR, postR, 0.03, 16]} />
          <meshStandardMaterial color={frameColor} roughness={0.4} metalness={0.6} />
        </mesh>
      ))}
      <mesh position={[0, height / 2, 0]} castShadow>
        <cylinderGeometry args={[postR * 0.55, postR * 0.55, height * 0.75, 16]} />
        <meshStandardMaterial color="#f5e6b8" roughness={0.5} emissive="#f5e6b8" emissiveIntensity={0.35} transparent opacity={0.55} />
      </mesh>
    </group>
  );
}

/** Globe floor lamp: a slim pole topped with a frosted spherical glass shade. */
export function GlobeFloorLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const globeR = width * 0.42;
  const poleH = height - globeR * 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.3, width * 0.36, 0.03, 20]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.016, 0.016, poleH, 10]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH + globeR, 0]} castShadow>
        <sphereGeometry args={[globeR, 20, 16]} />
        <meshStandardMaterial color={shadeColor} roughness={0.4} emissive={shadeColor} emissiveIntensity={0.25} transparent opacity={0.75} />
      </mesh>
    </group>
  );
}

/** Industrial-style floor lamp: a raw pipe-look pole ending in a small exposed bulb, no shade. */
export function IndustrialLampPole({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const bulbR = width * 0.28;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.3, width * 0.36, 0.03, 6]} />
        <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.6} />
      </mesh>
      <mesh position={[0, (height - bulbR) / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.018, 0.018, height - bulbR, 10]} />
        <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.6} />
      </mesh>
      <mesh position={[0, height - bulbR, 0]} castShadow>
        <sphereGeometry args={[bulbR, 16, 12]} />
        <meshStandardMaterial color="#fff3d0" emissive="#ffedb0" emissiveIntensity={0.6} roughness={0.3} />
      </mesh>
    </group>
  );
}

/** Pharmacy floor lamp: a thin pole with a small hinged angled reading shade near the top. */
export function PharmacyLamp({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const shadeColor = selected ? WALL_COLOR_SELECTED : color;
  const armLen = width * 0.9;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.3, width * 0.36, 0.03, 20]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, height * 0.46, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.016, 0.016, height * 0.9, 10]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[armLen / 2, height * 0.9, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
        <cylinderGeometry args={[0.012, 0.012, armLen, 8]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[armLen, height * 0.82, 0]} rotation={[Math.PI, 0, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.3, width * 0.12, 0.12, 16, 1, true]} />
        <meshStandardMaterial color={shadeColor} roughness={0.6} side={THREE.DoubleSide} />
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

/** Leaning full-length floor mirror: a thin frame around a reflective panel, tilted back slightly against an implied wall. */
export function FloorMirror({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const frameThickness = 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <group rotation={[0.06, 0, 0]} position={[0, 0, -0.02]}>
        <RoundedBox args={[width, height, frameThickness]} radius={0.01} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={frameColor} roughness={0.5} metalness={0.2} />
        </RoundedBox>
        <mesh position={[0, height / 2, frameThickness / 2 + 0.002]}>
          <planeGeometry args={[width * 0.86, height * 0.92]} />
          <meshStandardMaterial color="#dfeaee" roughness={0.05} metalness={0.6} />
        </mesh>
      </group>
    </group>
  );
}

/** Tall floor vase with a small cluster of thin dried branches. */
export function FloorVase({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const vaseColor = selected ? WALL_COLOR_SELECTED : color;
  const vaseH = height * 0.45;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, vaseH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.28, width * 0.4, vaseH, 20]} />
        <meshStandardMaterial color={vaseColor} roughness={0.4} />
      </mesh>
      {[0, 1, 2, 3].map((i) => {
        const angle = (i / 4) * Math.PI * 2;
        const branchH = height - vaseH - i * 0.1;
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * 0.02, vaseH + branchH / 2, Math.sin(angle) * 0.02]}
            rotation={[Math.sin(angle) * 0.15, 0, Math.cos(angle) * 0.15]}
            castShadow
          >
            <cylinderGeometry args={[0.006, 0.01, branchH, 6]} />
            <meshStandardMaterial color="#7a5738" roughness={0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Leaning framed art print: a flat frame propped against the wall at a slight angle, canvas-style. */
export function LeaningArt({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const thickness = 0.03;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <group rotation={[0.1, 0, 0]} position={[0, height / 2 - 0.01, -0.03]}>
        <RoundedBox args={[width, height, thickness]} radius={0.005} smoothness={2} castShadow receiveShadow>
          <meshStandardMaterial color="#2a2a2a" roughness={0.6} />
        </RoundedBox>
        <mesh position={[0, 0, thickness / 2 + 0.002]}>
          <planeGeometry args={[width * 0.9, height * 0.9]} />
          <meshStandardMaterial color={frameColor} roughness={0.85} />
        </mesh>
      </group>
    </group>
  );
}

/** Abstract decorative sculpture on a small plinth — a stack of two low-poly forms for a gallery-like accent. */
export function DecorSculpture({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const sculptureColor = selected ? WALL_COLOR_SELECTED : color;
  const plinthH = height * 0.35;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, plinthH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.32, width * 0.36, plinthH, 20]} />
        <meshStandardMaterial color="#e8e4da" roughness={0.5} />
      </mesh>
      <mesh position={[0, plinthH + (height - plinthH) * 0.35, 0]} rotation={[0.4, 0.6, 0]} castShadow receiveShadow>
        <torusKnotGeometry args={[width * 0.18, width * 0.06, 64, 8]} />
        <meshStandardMaterial color={sculptureColor} roughness={0.35} metalness={0.3} />
      </mesh>
    </group>
  );
}

/** Folding room divider screen: three hinged panels set at slight angles to each other. */
export function RoomDivider({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const panelColor = selected ? WALL_COLOR_SELECTED : color;
  const panelW = width / 3;
  const panelThickness = 0.02;
  const foldAngle = 0.45;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {[-1, 0, 1].map((i) => {
        const theta = i * foldAngle;
        const x = i * panelW * Math.cos(foldAngle);
        const z = Math.abs(i) * panelW * Math.sin(foldAngle);
        return (
          <mesh key={i} position={[x, height / 2, z]} rotation={[0, theta, 0]} castShadow receiveShadow>
            <boxGeometry args={[panelW * 0.96, height, panelThickness]} />
            <meshStandardMaterial color={panelColor} roughness={0.7} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * Round area rug: two stacked horizontal discs (base + a lighter inset
 * "border"), the circular counterpart of AreaRug — kept as its own
 * component since a circle needs circleGeometry, not planeGeometry.
 */
export function RoundRug({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, color } = item;
  const rugColor = selected ? WALL_COLOR_SELECTED : color;
  const radius = width / 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[radius, 40]} />
        <meshStandardMaterial color={rugColor} roughness={1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.007, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[radius * 0.8, 40]} />
        <meshStandardMaterial color="#f2ece0" roughness={1} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Grandfather clock: a tall wood case with a round dial face inset near the top. */
export function GrandfatherClock({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const caseColor = selected ? WALL_COLOR_SELECTED : color;
  const dialY = height * 0.85;
  const dialR = width * 0.32;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.02} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={caseColor} roughness={0.55} />
      </RoundedBox>
      <mesh position={[0, dialY, depth / 2 + 0.003]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[dialR, dialR, 0.01, 24]} />
        <meshStandardMaterial color="#f2ece0" roughness={0.4} />
      </mesh>
      <mesh position={[0, dialY, depth / 2 + 0.009]} rotation={[0, 0, 0.9]} castShadow>
        <boxGeometry args={[0.006, dialR * 1.1, 0.004]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} />
      </mesh>
      <mesh position={[0, dialY, depth / 2 + 0.009]} rotation={[0, 0, -0.5]} castShadow>
        <boxGeometry args={[0.006, dialR * 0.7, 0.004]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} />
      </mesh>
      <mesh position={[0, height * 0.4, depth / 2 + 0.002]} castShadow>
        <boxGeometry args={[width * 0.06, height * 0.42, 0.008]} />
        <meshStandardMaterial color="#c9a86a" roughness={0.3} metalness={0.5} />
      </mesh>
      <mesh position={[0, height * 0.24, depth / 2 + 0.011]} castShadow>
        <cylinderGeometry args={[width * 0.09, width * 0.09, 0.01, 20]} />
        <meshStandardMaterial color="#c9a86a" roughness={0.25} metalness={0.6} />
      </mesh>
    </group>
  );
}

/** Cluster of pillar candles of varying heights on a small tray. */
export function CandlePillarSet({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const waxColor = selected ? WALL_COLOR_SELECTED : color;
  const trayR = width / 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.008, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[trayR, trayR, 0.015, 24]} />
        <meshStandardMaterial color="#c9c9c9" roughness={0.4} metalness={0.4} />
      </mesh>
      {[0.4, 0.65, 1].map((frac, i) => {
        const h = height * frac;
        const r = width * 0.16;
        const x = (i - 1) * width * 0.24;
        return (
          <mesh key={i} position={[x, h / 2 + 0.015, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[r, r, h, 16]} />
            <meshStandardMaterial color={waxColor} roughness={0.7} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Coffee-table-style decor stack: a book pile topped with a small object, styled to sit on the floor as a standalone accent. */
export function StylingStack({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const bookColor = selected ? WALL_COLOR_SELECTED : color;
  const bookColors = [bookColor, "#5f7a54", "#8f8064"];
  const bookH = height * 0.6;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      {bookColors.map((c, i) => {
        const h = bookH / bookColors.length;
        const shrink = 1 - i * 0.08;
        return (
          <mesh key={i} position={[0, h * i + h / 2, 0]} rotation={[0, i * 0.3, 0]} castShadow receiveShadow>
            <boxGeometry args={[width * shrink, h * 0.9, width * 0.75 * shrink]} />
            <meshStandardMaterial color={c} roughness={0.85} />
          </mesh>
        );
      })}
      <mesh position={[0, bookH + (height - bookH) / 2, 0]} rotation={[0.3, 0.5, 0]} castShadow receiveShadow>
        <icosahedronGeometry args={[width * 0.22, 0]} />
        <meshStandardMaterial color="#c9a86a" roughness={0.4} metalness={0.3} flatShading />
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

/** Minimalist TV on a slim floor pole stand (no console cabinet underneath). */
export function TvPoleStand({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height } = item;
  const screenColor = selected ? WALL_COLOR_SELECTED : "#111214";
  const screenThickness = 0.04;
  const poleH = height * 0.55;
  const screenH = height - poleH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.015, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.22, width * 0.26, 0.03, 20]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, poleH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.025, 0.025, poleH, 12]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, poleH + screenH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, screenH, screenThickness]} />
        <meshStandardMaterial color={screenColor} roughness={0.15} metalness={0.2} />
      </mesh>
    </group>
  );
}

/** Slim soundbar sitting on two small feet, with a row of subtle speaker-grille dots. */
export function Soundbar({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={height * 0.4} smoothness={3} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.5} />
      </RoundedBox>
      {Array.from({ length: 7 }, (_, i) => (
        <mesh
          key={i}
          position={[-width * 0.36 + (i * width * 0.72) / 6, height / 2, depth / 2 + 0.005]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
        >
          <cylinderGeometry args={[height * 0.18, height * 0.18, 0.006, 12]} />
          <meshStandardMaterial color="#0d0d0d" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Desktop computer setup: a slim desk, a monitor panel, and a keyboard deck — one compact catalog piece instead of separate desk/monitor items. */
export function DesktopSetup({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const deskColor = selected ? WALL_COLOR_SELECTED : color;
  const deskH = height * 0.45;
  const monitorH = height - deskH;
  const legThickness = 0.035;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, 0.03, depth]} radius={0.01} smoothness={2} position={[0, deskH, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={deskColor} roughness={0.4} />
      </RoundedBox>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * (width / 2 - 0.05), deskH / 2, sz * (depth / 2 - 0.05)]} castShadow receiveShadow>
            <boxGeometry args={[legThickness, deskH, legThickness]} />
            <meshStandardMaterial color="#2a2a2a" roughness={0.5} metalness={0.4} />
          </mesh>
        )),
      )}
      <mesh position={[0, deskH + monitorH * 0.55, -depth * 0.25]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.55, monitorH * 0.7, 0.02]} />
        <meshStandardMaterial color="#111214" roughness={0.15} metalness={0.2} />
      </mesh>
      <mesh position={[0, deskH + 0.01, depth * 0.15]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.4, 0.015, depth * 0.18]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Small cylindrical smart speaker with a soft fabric-look body. */
export function SmartSpeaker({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width / 2, width / 2, height, 24]} />
        <meshStandardMaterial color={bodyColor} roughness={0.95} />
      </mesh>
      <mesh position={[0, height + 0.002, 0]} castShadow>
        <cylinderGeometry args={[width * 0.46, width * 0.46, 0.006, 24]} />
        <meshStandardMaterial color="#dcdcdc" roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Robot vacuum on its charging dock: a low flat disc parked against a small upright dock unit. */
export function RobotVacuumDock({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const dockColor = selected ? WALL_COLOR_SELECTED : color;
  const robotR = Math.min(width, depth) * 0.28;
  const robotH = height * 0.3;
  const dockH = height;
  const dockW = width * 0.4;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[dockW, dockH, depth * 0.5]} radius={0.02} smoothness={2} position={[0, dockH / 2, -depth * 0.2]} castShadow receiveShadow>
        <meshStandardMaterial color={dockColor} roughness={0.5} />
      </RoundedBox>
      <mesh position={[0, robotH / 2, depth * 0.15]} castShadow receiveShadow>
        <cylinderGeometry args={[robotR, robotR, robotH, 24]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} />
      </mesh>
    </group>
  );
}

/** Small WiFi router: a slim box with a pair of antenna sticks and a row of status-light dots. */
export function WifiRouter({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const antennaH = height * 1.4;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.015} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.4} />
      </RoundedBox>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * width * 0.3, height + antennaH / 2, 0]} rotation={[0, 0, sx * 0.15]} castShadow>
          <cylinderGeometry args={[0.006, 0.006, antennaH, 6]} />
          <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
        </mesh>
      ))}
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          position={[-width * 0.3 + i * width * 0.3, height * 0.7, depth / 2 + 0.003]}
          rotation={[Math.PI / 2, 0, 0]}
          castShadow
        >
          <cylinderGeometry args={[0.006, 0.006, 0.004, 8]} />
          <meshStandardMaterial color="#5cd66c" emissive="#5cd66c" emissiveIntensity={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Projector screen: a slim rolled housing above a flat pull-down screen panel, on two side supports. */
export function ProjectorScreen({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const frameColor = selected ? WALL_COLOR_SELECTED : color;
  const housingH = 0.08;
  const screenH = height - housingH;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height - housingH / 2, 0]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
        <cylinderGeometry args={[housingH / 2, housingH / 2, width, 16]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, height - housingH - screenH / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[width, screenH, 0.01]} />
        <meshStandardMaterial color="#f5f5f0" roughness={0.9} />
      </mesh>
      <mesh position={[0, height - housingH - screenH / 2, 0.006]}>
        <boxGeometry args={[width - 0.03, screenH - 0.03, 0.004]} />
        <meshStandardMaterial color={frameColor} roughness={0.9} transparent opacity={0.15} />
      </mesh>
    </group>
  );
}

/** Slim cylindrical air purifier tower with a top vent grille. */
export function AirPurifier({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, height / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width / 2, width / 2, height, 24]} />
        <meshStandardMaterial color={bodyColor} roughness={0.5} />
      </mesh>
      <mesh position={[0, height + 0.003, 0]} castShadow>
        <cylinderGeometry args={[width * 0.42, width * 0.42, 0.006, 24]} />
        <meshStandardMaterial color="#0d0d0d" roughness={0.6} />
      </mesh>
      <mesh position={[0, height * 0.4, width * 0.51]} castShadow>
        <planeGeometry args={[width * 0.02, height * 0.5]} />
        <meshStandardMaterial color="#0d0d0d" roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Gaming console stand: a low slim shelf unit holding a console box and a controller resting on top. */
export function GamingConsoleStand({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, depth, height, color } = item;
  const shelfColor = selected ? WALL_COLOR_SELECTED : color;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <RoundedBox args={[width, height, depth]} radius={0.015} smoothness={2} position={[0, height / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={shelfColor} roughness={0.6} />
      </RoundedBox>
      <mesh position={[-width * 0.2, height + 0.02, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.35, 0.04, depth * 0.7]} />
        <meshStandardMaterial color="#1c1c1c" roughness={0.3} metalness={0.3} />
      </mesh>
      <mesh position={[width * 0.22, height + 0.015, 0]} castShadow receiveShadow>
        <boxGeometry args={[width * 0.22, 0.03, depth * 0.4]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Small security camera on a weighted tripod-style floor stand. */
export function SecurityCameraStand({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const poleH = height * 0.85;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.01, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.35, width * 0.4, 0.02, 16]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.012, 0.012, poleH, 8]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, poleH, width * 0.06]} rotation={[0.3, 0, 0]} castShadow>
        <cylinderGeometry args={[width * 0.14, width * 0.14, height - poleH, 12]} />
        <meshStandardMaterial color={bodyColor} roughness={0.3} metalness={0.4} />
      </mesh>
    </group>
  );
}

/** Pedestal standing fan: a weighted round base, a slim pole, and a fan-head disc with a subtle grille pattern. */
export function StandingFan({ item, selected }: { item: FurnitureItem; selected: boolean }) {
  const { width, height, color } = item;
  const bodyColor = selected ? WALL_COLOR_SELECTED : color;
  const headR = width / 2;
  const poleH = height - headR * 2;

  return (
    <group position={[item.position.x, 0, item.position.y]} rotation={[0, -item.rotation, 0]} userData={{ furnitureId: item.id }}>
      <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[width * 0.32, width * 0.4, 0.04, 20]} />
        <meshStandardMaterial color={bodyColor} roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, poleH / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.018, 0.018, poleH, 10]} />
        <meshStandardMaterial color={bodyColor} roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, poleH + headR, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[headR, headR, 0.06, 24]} />
        <meshStandardMaterial color="#e8e4da" roughness={0.5} />
      </mesh>
      <mesh position={[0, poleH + headR, 0.032]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[headR * 0.85, 0.008, 8, 24]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.4} metalness={0.5} />
      </mesh>
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

    // seating
    case "straight-sofa-linen":
    case "loveseat-sage":
      return StraightSofa;
    case "wood-dining-chair":
      return WoodDiningChair;
    case "chaise-lounge":
      return ChaiseLounge;
    case "bar-stool":
      return BarStool;
    case "ottoman-bench":
      return OttomanBench;

    // tables
    case "dining-table-round-4":
    case "dining-table-round-6":
    case "bistro-table":
      return RoundDiningTable;
    case "console-table":
      return ConsoleTable;
    case "writing-desk":
      return WritingDesk;
    case "side-table-wood":
      return RoundStoneTable;
    case "nesting-tables":
      return NestingTables;

    // beds
    case "bunk-bed":
      return BunkBed;
    case "sleigh-bed":
      return SleighBed;

    // storage
    case "dresser-6drawer":
    case "nightstand":
      return ChestOfDrawers;
    case "sideboard":
    case "media-console":
      return Sideboard;
    case "ladder-shelf":
    case "towel-ladder":
    case "blanket-ladder":
      return LadderShelf;
    case "storage-bench":
      return StorageBench;
    case "trunk-chest":
      return TrunkChest;
    case "display-cabinet":
      return DisplayCabinet;

    // kitchen
    case "kitchen-range":
      return KitchenRange;
    case "dishwasher":
      return Dishwasher;
    case "bar-cart":
      return BarCart;
    case "farmhouse-sink-cabinet":
      return FarmhouseSinkCabinet;
    case "wine-fridge":
      return FridgeModern;
    case "kitchen-cart":
    case "kitchen-cabinet-run":
      return KitchenIsland;
    case "pantry-cabinet":
    case "linen-tower":
      return ModernWardrobe;

    // bathroom
    case "toilet":
      return Toilet;
    case "bidet":
      return Bidet;
    case "shower-enclosure":
      return ShowerEnclosure;
    case "pedestal-sink":
      return PedestalSink;
    case "double-vanity-sink":
      return DoubleVanitySink;
    case "mirror-cabinet":
      return MirrorCabinet;

    // lighting
    case "arc-lamp":
      return ArcLamp;
    case "torchiere-lamp":
    case "torchiere-lamp-black":
      return TorchiereLamp;
    case "tripod-lamp":
      return TripodLamp;
    case "desk-lamp":
      return DeskLamp;
    case "floor-lantern":
      return FloorLantern;
    case "floor-lamp-brass":
      return FloorLamp;
    case "table-lamp-ceramic":
      return TableLamp;

    // decor
    case "floor-mirror":
      return FloorMirror;
    case "floor-vase-branches":
      return FloorVase;
    case "leaning-wall-art":
      return LeaningArt;
    case "decor-sculpture":
      return DecorSculpture;
    case "room-divider-screen":
      return RoomDivider;
    case "round-area-rug":
      return RoundRug;
    case "potted-plant-large":
      return PottedPlant;

    // electronics
    case "tv-pole-stand":
      return TvPoleStand;
    case "soundbar":
      return Soundbar;
    case "desktop-setup":
      return DesktopSetup;
    case "smart-speaker":
      return SmartSpeaker;
    case "robot-vacuum-dock":
      return RobotVacuumDock;
    case "wifi-router":
      return WifiRouter;
    case "projector-screen":
      return ProjectorScreen;
    case "air-purifier":
      return AirPurifier;

    // seating (batch 2)
    case "wingback-chair":
      return WingbackChair;
    case "recliner-chair":
      return ReclinerChair;
    case "chesterfield-sofa":
      return ChesterfieldSofa;
    case "sectional-sofa":
      return SectionalSofa;
    case "bean-bag-chair":
      return BeanBagChair;
    case "rocking-chair":
      return RockingChairModel;
    case "accent-chair-velvet":
      return BoucleArmchair;
    case "swivel-egg-chair":
      return RattanChair;
    case "counter-stool":
      return BarStool;
    case "bench-seat-oak":
      return WoodDiningChair;

    // tables (batch 2)
    case "coffee-table-glass":
      return GlassCoffeeTable;
    case "coffee-table-rect-wood":
      return RectCoffeeTable;
    case "pub-table":
      return PubTable;
    case "trestle-table":
      return TrestleTable;
    case "vanity-desk":
      return VanityDesk;
    case "drafting-table":
      return DraftingTable;
    case "accent-table-marble":
      return RoundStoneTable;
    case "folding-table":
      return ConsoleTable;

    // beds (batch 2)
    case "canopy-bed":
      return CanopyBed;
    case "murphy-bed-closed":
      return MurphyBedCabinet;
    case "daybed-frame":
      return DaybedFrame;
    case "crib":
      return Crib;

    // storage (batch 2)
    case "filing-cabinet":
      return ChestOfDrawers;
    case "armoire":
    case "spice-rack-cabinet":
      return ModernWardrobe;
    case "shoe-cabinet":
      return ModernWardrobe;
    case "corner-shelf-unit":
      return CornerShelfUnit;
    case "floating-shelf-tower":
      return LadderShelf;
    case "cubby-organizer":
      return CubbyOrganizer;
    case "china-hutch":
    case "kitchen-hutch":
      return Hutch;
    case "coat-rack":
      return CoatRack;
    case "umbrella-stand":
      return UmbrellaStand;
    case "blanket-basket":
      return WeaveBasket;

    // kitchen (batch 2)
    case "microwave-cart":
      return MicrowaveCart;
    case "double-oven-tower":
      return DoubleOvenTower;
    case "breakfast-bar-island":
    case "kitchen-peninsula":
    case "butcher-block-cart":
      return KitchenIsland;
    case "coffee-station-cart":
      return BarCart;
    case "compost-bin-cabinet":
      return Dishwasher;
    case "undercounter-freezer":
      return FridgeModern;

    // bathroom (batch 2)
    case "corner-shower":
    case "walk-in-shower":
      return ShowerEnclosure;
    case "alcove-bathtub":
      return AlcoveBathtub;
    case "towel-warmer-rack":
      return TowelWarmerRack;
    case "bathroom-stool":
      return BarStool;
    case "bath-shelf-unit":
      return Bookshelf;
    case "corner-pedestal-sink":
      return PedestalSink;
    case "wall-hung-toilet":
      return Bidet;
    case "vanity-sink-marble":
      return VanitySink;
    case "bathtub-matte-black":
      return FreestandingBathtub;

    // lighting (batch 2)
    case "globe-floor-lamp":
      return GlobeFloorLamp;
    case "industrial-floor-lamp":
      return IndustrialLampPole;
    case "pharmacy-floor-lamp":
      return PharmacyLamp;
    case "reading-lamp-adjustable":
    case "task-lamp-clip":
      return DeskLamp;
    case "floor-lamp-linen-drum":
    case "floor-lamp-black-modern":
      return FloorLamp;
    case "torchiere-lamp-brass":
      return TorchiereLamp;
    case "lantern-set-small":
      return FloorLantern;
    case "tripod-lamp-black":
      return TripodLamp;

    // decor (batch 2)
    case "grandfather-clock":
      return GrandfatherClock;
    case "candle-pillar-set":
      return CandlePillarSet;
    case "styling-stack":
      return StylingStack;
    case "wall-tapestry":
    case "abstract-wall-art-large":
    case "woven-wall-hanging":
      return LeaningArt;
    case "floor-vase-large-ceramic":
      return FloorVase;
    case "decor-sculpture-marble":
      return DecorSculpture;
    case "runner-rug":
      return AreaRug;
    case "jute-round-rug":
      return RoundRug;

    // electronics (batch 2)
    case "gaming-console-stand":
      return GamingConsoleStand;
    case "security-camera-stand":
      return SecurityCameraStand;
    case "standing-fan":
      return StandingFan;
    case "tv-large-stand":
      return TvOnStand;
    case "bluetooth-speaker-small":
      return SmartSpeaker;
    case "speaker-pair-floor":
      return TowerSpeaker;
    case "av-shelf-unit":
      return Sideboard;
    case "smart-display-stand":
      return DesktopSetup;
    case "air-purifier-large":
      return AirPurifier;
    case "wifi-mesh-node":
      return WifiRouter;

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

  // the inverse of toNDC — projects a 3D world point onto the canvas in client
  // pixel coordinates, so the rotate handle's hit-test can work as a simple
  // screen-space distance check (like Canvas2D's), regardless of camera angle
  const projectToScreen = useCallback(
    (worldX: number, worldY: number, worldZ: number) => {
      const v = new THREE.Vector3(worldX, worldY, worldZ).project(camera);
      const rect = domElement.getBoundingClientRect();
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    },
    [camera, domElement],
  );

  useEffect(() => {
    let downPos: { x: number; y: number } | null = null;
    let moveFurnitureId: string | null = null;
    let moveOrigin: { x: number; y: number } | null = null;
    let moveSnapshot: { id: string; position: { x: number; y: number }; settled: { x: number; y: number } }[] = [];
    let moveObstacles: FurnitureObstacle[] = [];
    let dragStarted = false;
    let lastCursorRaycastMs = 0;
    let rotateFurnitureId: string | null = null;
    let rotateStartRotation = 0;
    let rotatePointerStartAngle = 0;
    let rotateArmed = false;

    const onPointerDown = (e: PointerEvent) => {
      if (readOnlyRef.current) return;
      if (e.button !== 0) return;
      downPos = { x: e.clientX, y: e.clientY };
      dragStarted = false;
      moveFurnitureId = null;
      rotateFurnitureId = null;
      rotateArmed = false;

      if (activeToolRef.current === "select" && selectedIdsRef.current.length === 1) {
        const sole = furnitureRef.current.find((f) => f.id === selectedIdsRef.current[0]);
        if (sole) {
          const handleGround = furnitureRotateHandleGroundPos(sole);
          const handleScreen = projectToScreen(handleGround.x, sole.height + 0.12, handleGround.y);
          if (Math.hypot(e.clientX - handleScreen.x, e.clientY - handleScreen.y) <= FURNITURE_ROTATE_HANDLE_HIT_PX) {
            rotateFurnitureId = sole.id;
            rotateStartRotation = sole.rotation;
            const floorAtDown = raycastFloor(e.clientX, e.clientY);
            rotatePointerStartAngle = floorAtDown
              ? Math.atan2(floorAtDown.y - sole.position.y, floorAtDown.x - sole.position.x)
              : 0;
            return;
          }
        }
      }

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

      if (downPos && rotateFurnitureId) {
        const movedForRotate = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
        if (movedForRotate >= CLICK_TOLERANCE_PX) {
          if (!rotateArmed) {
            rotateArmed = true;
            if (controlsRef.current) controlsRef.current.enabled = false;
            domElement.style.cursor = "grabbing";
            pushHistory();
          }
          const item = furnitureRef.current.find((f) => f.id === rotateFurnitureId);
          const floorPoint = raycastFloor(e.clientX, e.clientY);
          if (item && floorPoint) {
            const pointerAngle = Math.atan2(floorPoint.y - item.position.y, floorPoint.x - item.position.x);
            let rotation = rotateStartRotation + (pointerAngle - rotatePointerStartAngle);
            // soft-snap to 15° increments (always when close, or forced with Shift) — same feel as the 2D rotate handle
            const stepRad = (15 * Math.PI) / 180;
            const snapped = Math.round(rotation / stepRad) * stepRad;
            const diffDeg = (Math.abs(rotation - snapped) * 180) / Math.PI;
            if (e.shiftKey || diffDeg <= 3) rotation = snapped;
            const size = furnitureCollisionSize(item);
            const settled = resolveFurniturePlacement(
              item.position,
              size.width,
              size.depth,
              rotation,
              wallsRef.current,
              openingsRef.current,
              furnitureObstacles(furnitureRef.current, [item.id]),
            );
            updateFurniture(item.id, { rotation, position: settled });
          }
        }
        return;
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
      const wasRotating = rotateFurnitureId !== null;
      downPos = null;
      moveFurnitureId = null;
      moveOrigin = null;
      moveSnapshot = [];
      dragStarted = false;
      rotateFurnitureId = null;
      rotateArmed = false;

      // a click (even a tiny one) that landed on the rotate handle shouldn't fall through
      // to the empty-space "deselect" logic below — it was aimed at the handle, not the floor
      if (wasRotating) return;

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
    projectToScreen,
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

/**
 * Semi-transparent ghost of the item armed for placement, following the
 * cursor across the floor, plus — when exactly one furniture item is
 * selected — a small floating handle in front of it that can be dragged to
 * free-rotate the item, the same gesture Canvas2D offers in the top-down view.
 */
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
  const furniture = useDesignStore((s) => s.furniture);
  const selectedIds = useDesignStore((s) => s.selectedIds);

  const soleSelected = !readOnly && selectedIds.length === 1 ? furniture.find((f) => f.id === selectedIds[0]) : undefined;
  const handleGround = soleSelected ? furnitureRotateHandleGroundPos(soleSelected) : null;

  return (
    <>
      {pendingFurniture && previewPoint && (
        <mesh position={[previewPoint.x, pendingFurniture.height / 2, previewPoint.y]}>
          <boxGeometry args={[pendingFurniture.width, pendingFurniture.height, pendingFurniture.depth]} />
          <meshStandardMaterial color={pendingFurniture.color} transparent opacity={0.45} depthWrite={false} />
        </mesh>
      )}
      {soleSelected && handleGround && (
        <mesh position={[handleGround.x, soleSelected.height + 0.12, handleGround.y]} renderOrder={1}>
          <sphereGeometry args={[0.06, 16, 16]} />
          <meshBasicMaterial color={WALL_COLOR_SELECTED} depthTest={false} />
        </mesh>
      )}
    </>
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
