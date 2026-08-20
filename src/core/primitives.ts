export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];
export type ColorTuple = [number, number, number, number];

export interface SceneShapeData {
  shape: string;
  position: Vec3Tuple;
  color: ColorTuple;
  size: number;
  parent: string;
}

export interface SceneLineData {
  positions: Vec3Tuple[];
  colors: ColorTuple[] | null;
  color: ColorTuple;
  size: number;
  sizes: number[] | null;
  parent: string;
  type: string;
}

export interface SceneLabelData {
  text: string;
  position: Vec3Tuple;
  color: ColorTuple;
  size: number;
  parent: string;
}

export interface SceneSpriteData {
  texture: string;
  position: Vec3Tuple;
  color: ColorTuple;
  size: number;
  parent: string;
}

export interface SceneTransformData {
  transform: number[];
  parent: string;
}

export interface CursorState {
  handedness: 'left' | 'right';
  position: Vec3Tuple;
  rotation: QuatTuple;
  heldbuttons: string[];
  joystick: [number, number];
}

export const SHAPE_PREFIX = 'object.shape.';
export const LINE_PREFIX = 'object.line.';
export const LABEL_PREFIX = 'object.label.';
export const SPRITE_PREFIX = 'object.sprite.';
export const TRANSFORM_PREFIX = 'transform.';
export const CURSOR_PREFIX = 'cursor.';

export const SIMULATION_PARENT = 'simulation';
export const ROOT_PARENTS = new Set(['', 'root', 'shared', 'calibrated']);

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function asVec3(value: unknown, fallback: Vec3Tuple = [0, 0, 0]): Vec3Tuple {
  if (!Array.isArray(value) || value.length < 3) {
    return [...fallback];
  }
  return [asNumber(value[0], fallback[0]), asNumber(value[1], fallback[1]), asNumber(value[2], fallback[2])];
}

export function asColor(value: unknown, fallback: ColorTuple = [1, 1, 1, 1]): ColorTuple {
  if (!Array.isArray(value) || value.length < 3) {
    return [...fallback];
  }
  return [
    asNumber(value[0], fallback[0]),
    asNumber(value[1], fallback[1]),
    asNumber(value[2], fallback[2]),
    asNumber(value.length > 3 ? value[3] : undefined, fallback[3]),
  ];
}

function asVec3Array(value: unknown): Vec3Tuple[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const points: Vec3Tuple[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) {
      return undefined;
    }
    points.push([asNumber(entry[0], 0), asNumber(entry[1], 0), asNumber(entry[2], 0)]);
  }
  return points;
}

function asColorArray(value: unknown): ColorTuple[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const colors: ColorTuple[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) {
      return undefined;
    }
    colors.push(asColor(entry));
  }
  return colors;
}

function asNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return undefined;
    }
    numbers.push(entry);
  }
  return numbers;
}

export function parseShape(value: unknown): SceneShapeData | undefined {
  const data = asObject(value);
  if (!data) {
    return undefined;
  }

  return {
    shape: asString(data.shape, 'sphere'),
    position: asVec3(data.position),
    color: asColor(data.color),
    size: asNumber(data.size, 0.1),
    parent: asString(data.parent, SIMULATION_PARENT),
  };
}

export function parseLine(value: unknown): SceneLineData | undefined {
  const data = asObject(value);
  if (!data) {
    return undefined;
  }

  const positions = asVec3Array(data.positions);
  if (!positions) {
    return undefined;
  }

  return {
    positions,
    colors: asColorArray(data.colors) ?? null,
    color: asColor(data.color),
    size: asNumber(data.size, 0.05),
    sizes: asNumberArray(data.sizes) ?? null,
    parent: asString(data.parent, SIMULATION_PARENT),
    type: asString(data.type, 'solid'),
  };
}

export function parseLabel(value: unknown): SceneLabelData | undefined {
  const data = asObject(value);
  if (!data) {
    return undefined;
  }

  return {
    text: asString(data.text, ''),
    position: asVec3(data.position),
    color: asColor(data.color),
    size: asNumber(data.size, 0.05),
    parent: asString(data.parent, SIMULATION_PARENT),
  };
}

export function parseSprite(value: unknown): SceneSpriteData | undefined {
  const data = asObject(value);
  if (!data) {
    return undefined;
  }

  const texture = data.texture;
  if (typeof texture !== 'string' || texture.length === 0) {
    return undefined;
  }

  return {
    texture,
    position: asVec3(data.position),
    color: asColor(data.color),
    size: asNumber(data.size, 1),
    parent: asString(data.parent, SIMULATION_PARENT),
  };
}

export function parseTransform(value: unknown): SceneTransformData | undefined {
  const data = asObject(value);
  if (!data) {
    return undefined;
  }

  const transform = asNumberArray(data.transform);
  if (!transform || transform.length < 3) {
    return undefined;
  }

  return {
    transform,
    parent: asString(data.parent, 'root'),
  };
}

export function applyStateTransform(
  transform: number[],
  position: { set(x: number, y: number, z: number): unknown },
  quaternion: { set(x: number, y: number, z: number, w: number): unknown },
  scale: { set(x: number, y: number, z: number): unknown },
) {
  position.set(
    asNumber(transform[0], 0),
    asNumber(transform[1], 0),
    asNumber(transform[2], 0),
  );
  quaternion.set(
    asNumber(transform[3], 0),
    asNumber(transform[4], 0),
    asNumber(transform[5], 0),
    asNumber(transform[6], 1),
  );
  scale.set(
    asNumber(transform[7], 1),
    asNumber(transform[8], 1),
    asNumber(transform[9], 1),
  );
}
