import { STARTER_PALETTE, type Character } from '../character/model';
import {
  loadImage,
  makeTileset,
  uid,
  type AssetRect,
  type Doc,
  type Layer,
  type MapObject,
  type Tileset,
} from '../core/doc';
import { EMPTY } from '../core/tiles';
import type { AssetFolder, AssetRef } from '../ui/packs';

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Rebuilds a placed object, filling anything missing with a neutral value.
 * A file edited by hand or written by an older build should load with its
 * objects untransformed rather than fail to load at all.
 */
function readObject(raw: Partial<MapObject>): MapObject {
  const rect = raw.rect ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('obj'),
    tilesetId: typeof raw.tilesetId === 'string' ? raw.tilesetId : '',
    rect: {
      x: finite(rect.x, 0),
      y: finite(rect.y, 0),
      w: Math.max(1, finite(rect.w, 1)),
      h: Math.max(1, finite(rect.h, 1)),
    },
    x: finite(raw.x, 0),
    y: finite(raw.y, 0),
    scale: Math.max(0.01, finite(raw.scale, 1)),
    rotation: ((Math.round(finite(raw.rotation, 0)) % 4) + 4) % 4,
    flipX: raw.flipX === true,
    flipY: raw.flipY === true,
    hueShift: finite(raw.hueShift, 0),
    saturation: finite(raw.saturation, 1),
    brightness: finite(raw.brightness, 1),
    ...(finite(raw.contrast, 1) !== 1 ? { contrast: finite(raw.contrast, 1) } : {}),
    ...(finite(raw.clarity, 0) !== 0 ? { clarity: finite(raw.clarity, 0) } : {}),
    ...(raw.blocks ? { blocks: true } : {}),
    ...(raw.door && Number.isFinite(raw.door.x) && Number.isFinite(raw.door.y)
      ? { door: { x: raw.door.x, y: raw.door.y } }
      : {}),
    ...(raw.locked ? { locked: true } : {}),
    ...(typeof raw.groupId === 'string' && raw.groupId ? { groupId: raw.groupId } : {}),
  };
}

/**
 * On-disk project format. Layer buffers are base64 so a project round-trips
 * through plain JSON, which keeps a saved file openable on any device and
 * small enough to sit in IndexedDB without extra encoding.
 */

/** 2 added image layers and characters. Version 1 files still load. */
export const PROJECT_VERSION = 2;

interface SerializedLayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
}

interface SerializedTileLayer extends SerializedLayerBase {
  /** Absent in version 1 files, which only had tile layers. */
  kind?: 'tiles';
  collider: boolean;
  data: string;
}

interface SerializedImageLayer extends SerializedLayerBase {
  kind: 'image';
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SerializedObjectLayer extends SerializedLayerBase {
  kind: 'objects';
  /** Already plain data, so objects are stored as they are. */
  objects: MapObject[];
}

type SerializedLayer = SerializedTileLayer | SerializedImageLayer | SerializedObjectLayer;

interface SerializedTileset {
  id: string;
  name: string;
  src: string;
  tileW: number;
  tileH: number;
  margin: number;
  spacing: number;
  /** Present for editor-generated sheets, whose slot count is not derivable. */
  generated?: boolean;
  count?: number;
  /**
   * How the sheet is cut into assets. Detection is slow on a large sheet and
   * the user may have adjusted it, so the result is saved rather than redone.
   */
  splitMode?: 'grid' | 'objects';
  assets?: AssetRect[];
  assetsVersion?: number;
  assetsEdited?: boolean;
  propsOnly?: boolean;
  groundAssets?: number[];
  groundBlocks?: AssetRect[];
  pathStride?: number;
}

interface SerializedCharacter {
  id: string;
  name: string;
  tilesW: number;
  tilesH: number;
  w: number;
  h: number;
  frameCount: number;
  frameMs: number;
  palette: string[];
  /** Base64 RGBA buffers, direction-major like `Character.frames`. */
  frames: string[];
  /** Picture traced over, absent when there is none. */
  reference?: { src: string; opacity: number; visible: boolean };
}

export interface SerializedProject {
  /** From before the app was called Habitat; files saved since then still carry it. */
  format: 'pixel-fusion-project';
  version: number;
  name: string;
  width: number;
  height: number;
  tileSize: number;
  background: string;
  activeLayer: number;
  tilesets: SerializedTileset[];
  layers: SerializedLayer[];
  /** Absent in version 1 files. */
  characters?: SerializedCharacter[];
  /** Id of the character Play should walk. Absent in older files. */
  lastPlayedCharacter?: string;
  /** Canvas size, in tiles, the last time a character was drawn on. */
  lastCharacterSize?: { tilesW: number; tilesH: number };
  /** The square the character stands on in the map, when it has been placed. */
  characterAt?: { x: number; y: number };
  pins?: AssetRef[];
  folders?: AssetFolder[];
  removedSheets?: string[];
  pinnedPacks?: string[];
}

function toBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked so a large map does not blow the argument limit of fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function serializeProject(
  doc: Doc,
  characters: Character[] = [],
  lastPlayedId?: string | null,
  lastCharacterSize?: { tilesW: number; tilesH: number } | null,
  characterAt?: { x: number; y: number } | null,
): SerializedProject {
  return {
    ...(lastPlayedId ? { lastPlayedCharacter: lastPlayedId } : {}),
    ...(lastCharacterSize ? { lastCharacterSize: { ...lastCharacterSize } } : {}),
    ...(characterAt ? { characterAt: { x: characterAt.x, y: characterAt.y } } : {}),
    characters: characters.map((c) => ({
      id: c.id,
      name: c.name,
      tilesW: c.tilesW,
      tilesH: c.tilesH,
      w: c.w,
      h: c.h,
      frameCount: c.frameCount,
      frameMs: c.frameMs,
      palette: [...c.palette],
      frames: c.frames.map((f) => toBase64(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength))),
      ...(c.reference
        ? { reference: { src: c.reference.src, opacity: c.reference.opacity, visible: c.reference.visible } }
        : {}),
    })),
    format: 'pixel-fusion-project',
    version: PROJECT_VERSION,
    name: doc.name,
    ...(doc.pins.length ? { pins: doc.pins.map((pin) => ({ tilesetId: pin.tilesetId, rect: { ...pin.rect } })) } : {}),
    ...(doc.folders.length
      ? {
          folders: doc.folders.map((folder) => ({
            id: folder.id,
            name: folder.name,
            assets: folder.assets.map((asset) => ({ tilesetId: asset.tilesetId, rect: { ...asset.rect } })),
          })),
        }
      : {}),
    ...(doc.removedSheets.length ? { removedSheets: [...doc.removedSheets] } : {}),
    ...(doc.pinnedPacks.length ? { pinnedPacks: [...doc.pinnedPacks] } : {}),
    width: doc.width,
    height: doc.height,
    tileSize: doc.tileSize,
    background: doc.background,
    activeLayer: doc.activeLayer,
    tilesets: doc.tilesets.map((t) => ({
      id: t.id,
      name: t.name,
      src: t.src,
      tileW: t.tileW,
      tileH: t.tileH,
      margin: t.margin,
      spacing: t.spacing,
      ...(t.generated ? { generated: true, count: t.count } : {}),
      ...(t.splitMode ? { splitMode: t.splitMode } : {}),
      ...(t.assets ? { assets: t.assets.map((a) => ({ ...a })) } : {}),
      ...(t.assetsVersion ? { assetsVersion: t.assetsVersion } : {}),
      ...(t.assetsEdited ? { assetsEdited: true } : {}),
      ...(t.propsOnly ? { propsOnly: true } : {}),
      ...(t.groundAssets?.length ? { groundAssets: [...t.groundAssets] } : {}),
      ...(t.groundBlocks?.length ? { groundBlocks: t.groundBlocks.map((b) => ({ ...b })) } : {}),
      ...(t.pathStride ? { pathStride: t.pathStride } : {}),
    })),
    layers: doc.layers.map((l): SerializedLayer => {
      const base = {
        id: l.id,
        name: l.name,
        visible: l.visible,
        locked: l.locked,
        opacity: l.opacity,
      };
      if (l.kind === 'image') {
        return { ...base, kind: 'image', src: l.src, x: l.x, y: l.y, w: l.w, h: l.h };
      }
      if (l.kind === 'objects') {
        return { ...base, kind: 'objects', objects: l.objects.map((o) => ({ ...o, rect: { ...o.rect } })) };
      }
      return { ...base, kind: 'tiles', collider: l.collider, data: toBase64(l.data.buffer) };
    }),
  };
}

export function isProjectFile(value: unknown): value is SerializedProject {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as SerializedProject).format === 'pixel-fusion-project' &&
    Array.isArray((value as SerializedProject).layers)
  );
}

/** Rebuilds the characters saved alongside a map. */
export function deserializeCharacters(data: SerializedProject): Character[] {
  if (!data.characters) return [];
  return data.characters.map((c) => {
    const expected = c.w * c.h * 4;
    const frames = c.frames.map((encoded) => {
      const decoded = new Uint8ClampedArray(fromBase64(encoded));
      if (decoded.length === expected) return { id: uid('frame'), data: decoded };
      // Tolerate a frame whose size disagrees with the header rather than
      // losing the whole character.
      const fixed = new Uint8ClampedArray(expected);
      fixed.set(decoded.subarray(0, Math.min(decoded.length, expected)));
      return { id: uid('frame'), data: fixed };
    });
    return {
      id: c.id || uid('char'),
      name: c.name,
      tilesW: c.tilesW,
      tilesH: c.tilesH,
      w: c.w,
      h: c.h,
      frameCount: c.frameCount,
      frameMs: c.frameMs ?? 140,
      palette: c.palette?.length ? [...c.palette] : [...STARTER_PALETTE],
      frames,
      ...(c.reference && typeof c.reference.src === 'string'
        ? {
            reference: {
              src: c.reference.src,
              opacity: finite(c.reference.opacity, 0.5),
              visible: c.reference.visible !== false,
            },
          }
        : {}),
    };
  });
}

export async function deserializeProject(data: SerializedProject): Promise<Doc> {
  const expected = data.width * data.height;

  const tilesets: Tileset[] = [];
  for (const t of data.tilesets) {
    try {
      const tileset = await makeTileset(t.src, t.name, t.tileW, t.tileH, t.margin, t.spacing);
      // Keep the saved id so nothing else in the project has to be remapped.
      tileset.id = t.id;
      if (t.generated) {
        // The image has spare slots past the last real tile; trust the saved
        // count, or the next edit would land after a run of blanks.
        tileset.generated = true;
        tileset.count = Math.min(tileset.count, t.count ?? tileset.count);
      }
      if (t.splitMode) tileset.splitMode = t.splitMode;
      if (Array.isArray(t.assets)) tileset.assets = t.assets.map((a) => ({ ...a }));
      if (t.assetsVersion) tileset.assetsVersion = t.assetsVersion;
      if (t.assetsEdited) tileset.assetsEdited = true;
      if (t.propsOnly) tileset.propsOnly = true;
      if (Array.isArray(t.groundAssets)) tileset.groundAssets = [...t.groundAssets];
      if (Array.isArray(t.groundBlocks)) tileset.groundBlocks = t.groundBlocks.map((b) => ({ ...b }));
      if (t.pathStride) tileset.pathStride = t.pathStride;
      tilesets.push(tileset);
    } catch {
      // A tileset that fails to decode would otherwise shift every later
      // tileset index and silently corrupt the map, so insert a placeholder.
      // How it was split is kept with it, so a picture that loads again
      // later comes back whole rather than needing to be worked out afresh.
      tilesets.push({
        id: t.id,
        name: `${t.name} (missing)`,
        src: t.src,
        tileW: t.tileW,
        tileH: t.tileH,
        margin: t.margin,
        spacing: t.spacing,
        image: null,
        imgW: 0,
        imgH: 0,
        cols: 0,
        rows: 0,
        count: 0,
        ...(t.splitMode ? { splitMode: t.splitMode } : {}),
        ...(Array.isArray(t.assets) ? { assets: t.assets.map((a) => ({ ...a })) } : {}),
        ...(t.assetsVersion ? { assetsVersion: t.assetsVersion } : {}),
        ...(t.assetsEdited ? { assetsEdited: true } : {}),
        ...(t.propsOnly ? { propsOnly: true } : {}),
        ...(Array.isArray(t.groundAssets) ? { groundAssets: [...t.groundAssets] } : {}),
        ...(Array.isArray(t.groundBlocks) ? { groundBlocks: t.groundBlocks.map((b) => ({ ...b })) } : {}),
        ...(t.pathStride ? { pathStride: t.pathStride } : {}),
      });
    }
  }

  const layers: Layer[] = [];
  for (const l of data.layers) {
    const base = {
      id: l.id || uid('layer'),
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity ?? 1,
    };

    if (l.kind === 'objects') {
      layers.push({ ...base, kind: 'objects', objects: (l.objects ?? []).map(readObject) });
      continue;
    }

    if (l.kind === 'image') {
      // A reference image that cannot be decoded still keeps its slot and
      // placement, so the layer stack and the project file stay consistent.
      let image: HTMLImageElement | null = null;
      try {
        image = await loadImage(l.src);
      } catch {
        image = null;
      }
      layers.push({
        ...base,
        kind: 'image',
        src: l.src,
        image,
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
        naturalW: image?.naturalWidth ?? l.w,
        naturalH: image?.naturalHeight ?? l.h,
      });
      continue;
    }

    const decoded = new Int32Array(fromBase64(l.data));
    let cells = decoded;
    // Guard against a file whose dimensions disagree with its buffers.
    if (decoded.length !== expected) {
      cells = new Int32Array(expected);
      cells.fill(EMPTY);
      cells.set(decoded.subarray(0, Math.min(decoded.length, expected)));
    }
    layers.push({ ...base, kind: 'tiles', collider: l.collider ?? false, data: cells });
  }

  return {
    name: data.name,
    width: data.width,
    height: data.height,
    tileSize: data.tileSize,
    background: data.background ?? '#1b1d24',
    tilesets,
    pins: data.pins ?? [],
    folders: data.folders ?? [],
    removedSheets: stringList(data.removedSheets),
    pinnedPacks: stringList(data.pinnedPacks),
    layers,
    activeLayer: Math.min(Math.max(0, data.activeLayer ?? 0), Math.max(0, layers.length - 1)),
  };
}
