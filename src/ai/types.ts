import type { Rect } from './image';

export type AssetKind = 'object' | 'tile' | 'frame';

export const CATEGORIES = [
  'tree',
  'bush',
  'plant',
  'flower',
  'rock',
  'furniture',
  'building',
  'decoration',
  'path',
  'terrain',
  'wall',
  'water',
  'character',
  'item',
  'effect',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Where a proposal came from, so a reviewer knows what to trust. */
export type ProposalSource = 'model' | 'reinspection' | 'pixels' | 'manual';

/** One thing the vision model says is on the sheet, before its pixels are pinned down. */
export interface Proposal {
  id: string;
  name: string;
  category: Category;
  kind: AssetKind;
  /** Approximate box in sheet pixels. */
  bbox: Rect;
  /** Numbered marks (component ids) the model says belong to this asset. */
  marks: number[];
  confidence: number;
  animation?: { group: string; frame: number };
  source: ProposalSource;
  /** Region the proposal was made in, -1 when not from a region pass. */
  region: number;
  /** Set when this proposal stood alone at a region edge or was merged from several regions. */
  regions?: number[];
}

/** A block of repeating ground the model says should be cut into separate cells. */
export interface TerrainProposal {
  name: string;
  category: Category;
  bbox: Rect;
  cell: number;
  confidence: number;
  region: number;
}

export type FlagCode =
  | 'touching-split'
  | 'box-mismatch'
  | 'beyond-box'
  | 'duplicate'
  | 'unidentified'
  | 'possible-split'
  | 'animation-size'
  | 'animation-gap'
  | 'transparency'
  | 'terrain-overlap'
  | 'low-confidence'
  | 'no-model'
  | 'confirmed'
  | 'corrected';

export interface Flag {
  code: FlagCode;
  message: string;
  severity: 'info' | 'warn' | 'error';
}

export interface ExtractedAsset {
  id: string;
  name: string;
  category: Category;
  kind: AssetKind;
  /** Tight box of the asset's own pixels on the original sheet. */
  rect: Rect;
  /** Sheet pixel indices that belong to this asset and no other. */
  pixels: Int32Array;
  /** Where the asset stands, in its own pixels: bottom centre for objects, top left for tiles. */
  anchor: { x: number; y: number };
  /** Final confidence after verification, 0 to 1. */
  confidence: number;
  /** The model's own confidence (or the second inspection's), before verification penalties. */
  modelConfidence: number;
  needsReview: boolean;
  flags: Flag[];
  animation?: { group: string; frame: number };
  /** The model's own box, kept to judge how well pixels and model agree. */
  modelBox?: Rect;
  source: ProposalSource;
}

export interface ExtractionStats {
  regions: number;
  modelCalls: number;
  proposals: number;
  terrainBlocks: number;
  reinspected: number;
  corrected: number;
  dropped: number;
  unassignedPixels: number;
}

export interface ExtractionResult {
  sheetName: string;
  width: number;
  height: number;
  cell: number | null;
  background: 'alpha' | 'colour' | 'none';
  assets: ExtractedAsset[];
  stats: ExtractionStats;
  /** Human-readable account of every stage, shown in the dialog and saved with the export. */
  log: string[];
  /** Provider and model that did the looking, or null in pixel-only mode. */
  model: string | null;
}

export const REVIEW_THRESHOLD = 0.6;
