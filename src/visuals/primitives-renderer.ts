import { Text } from 'troika-three-text';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Sphere,
  SphereGeometry,
  Texture,
  TextureLoader,
  Vector3,
} from 'three';
import {
  applyStateTransform,
  ColorTuple,
  CURSOR_PREFIX,
  LABEL_PREFIX,
  LINE_PREFIX,
  parseLabel,
  parseLine,
  parseShape,
  parseSprite,
  parseTransform,
  ROOT_PARENTS,
  SceneLabelData,
  SceneLineData,
  SceneShapeData,
  SceneSpriteData,
  SceneTransformData,
  SHAPE_PREFIX,
  SIMULATION_PARENT,
  SPRITE_PREFIX,
  TRANSFORM_PREFIX,
} from '../core/primitives';

interface PrimitivesRendererOptions {
  root: Object3D;
  simulation: Object3D;
  runCommand: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface ShapeEntry {
  mesh: Mesh;
  material: MeshLambertMaterial;
}

interface LineEntry {
  mesh: InstancedMesh;
  material: MeshBasicMaterial;
  capacity: number;
}

interface LabelEntry {
  text: Text;
}

interface SpriteEntry {
  mesh: Mesh;
  material: MeshBasicMaterial;
  textureKey: string;
  size: number;
}

const MAX_LINE_INSTANCES = 8192;

export class PrimitivesRenderer {
  private readonly root: Object3D;
  private readonly simulation: Object3D;
  private readonly runCommand: PrimitivesRendererOptions['runCommand'];

  private readonly transformNodes = new Map<string, Object3D>();
  private readonly shapes = new Map<string, ShapeEntry>();
  private readonly lines = new Map<string, LineEntry>();
  private readonly labels = new Map<string, LabelEntry>();
  private readonly sprites = new Map<string, SpriteEntry>();
  private readonly textures = new Map<string, Texture>();
  private readonly pendingTextures = new Set<string>();

  private readonly shapeGeometries = new Map<string, BufferGeometry>();
  private readonly lineGeometry = new CylinderGeometry(0.5, 0.5, 1, 8, 1);
  private readonly planeGeometry = new PlaneGeometry(1, 1);

  private readonly segmentForward = new Vector3(0, 0, 1);
  private readonly segmentStart = new Vector3();
  private readonly segmentEnd = new Vector3();
  private readonly segmentMid = new Vector3();
  private readonly segmentDir = new Vector3();
  private readonly segmentQuat = new Quaternion();
  private readonly segmentMatrix = new Matrix4();
  private readonly segmentScale = new Vector3();
  private readonly segmentColor = new Color();
  private readonly cameraWorldPos = new Vector3();

  constructor(options: PrimitivesRendererOptions) {
    this.root = options.root;
    this.simulation = options.simulation;
    this.runCommand = options.runCommand;
    this.lineGeometry.rotateX(Math.PI / 2);
  }

  applyStateDelta(
    updates: Record<string, unknown> | undefined,
    removals: string[] | undefined,
  ) {
    if (updates) {
      for (const [key, value] of Object.entries(updates)) {
        if (key.startsWith(TRANSFORM_PREFIX)) {
          this.updateTransform(key.slice(TRANSFORM_PREFIX.length), value);
        }
      }

      for (const [key, value] of Object.entries(updates)) {
        if (key.startsWith(SHAPE_PREFIX)) {
          const data = parseShape(value);
          if (data) {
            this.updateShape(key.slice(SHAPE_PREFIX.length), data);
          }
        } else if (key.startsWith(LINE_PREFIX)) {
          const data = parseLine(value);
          if (data) {
            this.updateLine(key.slice(LINE_PREFIX.length), data);
          }
        } else if (key.startsWith(LABEL_PREFIX)) {
          const data = parseLabel(value);
          if (data) {
            this.updateLabel(key.slice(LABEL_PREFIX.length), data);
          }
        } else if (key.startsWith(SPRITE_PREFIX)) {
          const data = parseSprite(value);
          if (data) {
            this.updateSprite(key.slice(SPRITE_PREFIX.length), data);
          }
        }
      }
    }

    if (removals) {
      for (const key of removals) {
        if (key.startsWith(SHAPE_PREFIX)) {
          this.removeShape(key.slice(SHAPE_PREFIX.length));
        } else if (key.startsWith(LINE_PREFIX)) {
          this.removeLine(key.slice(LINE_PREFIX.length));
        } else if (key.startsWith(LABEL_PREFIX)) {
          this.removeLabel(key.slice(LABEL_PREFIX.length));
        } else if (key.startsWith(SPRITE_PREFIX)) {
          this.removeSprite(key.slice(SPRITE_PREFIX.length));
        } else if (key.startsWith(TRANSFORM_PREFIX)) {
          this.removeTransform(key.slice(TRANSFORM_PREFIX.length));
        }
      }
    }
  }

  update(camera: PerspectiveCamera) {
    if (this.labels.size === 0) {
      return;
    }

    camera.getWorldPosition(this.cameraWorldPos);
    for (const { text } of this.labels.values()) {
      text.lookAt(this.cameraWorldPos);
    }
  }

  clear() {
    for (const key of [...this.shapes.keys()]) {
      this.removeShape(key);
    }
    for (const key of [...this.lines.keys()]) {
      this.removeLine(key);
    }
    for (const key of [...this.labels.keys()]) {
      this.removeLabel(key);
    }
    for (const key of [...this.sprites.keys()]) {
      this.removeSprite(key);
    }
    for (const key of [...this.transformNodes.keys()]) {
      this.removeTransform(key);
    }
  }

  private resolveParent(parent: string): Object3D {
    if (ROOT_PARENTS.has(parent)) {
      return this.root;
    }
    if (parent === SIMULATION_PARENT) {
      return this.simulation;
    }
    return this.getTransformNode(parent);
  }

  private getTransformNode(id: string): Object3D {
    let node = this.transformNodes.get(id);
    if (!node) {
      node = new Object3D();
      node.name = `transform.${id}`;
      this.transformNodes.set(id, node);
    }
    return node;
  }

  private reparent(node: Object3D, parent: Object3D) {
    if (node.parent !== parent) {
      parent.add(node);
    }
  }

  private updateTransform(key: string, value: unknown) {
    if (key === SIMULATION_PARENT) {
      return;
    }

    const data: SceneTransformData | undefined = parseTransform(value);
    if (!data) {
      return;
    }

    const node = this.getTransformNode(key);
    applyStateTransform(data.transform, node.position, node.quaternion, node.scale);
    this.reparent(node, this.resolveParent(data.parent));
  }

  private removeTransform(key: string) {
    if (key === SIMULATION_PARENT) {
      return;
    }

    const node = this.transformNodes.get(key);
    if (!node) {
      return;
    }

    node.removeFromParent();
  }

  private getShapeGeometry(shape: string): BufferGeometry {
    let geometry = this.shapeGeometries.get(shape);
    if (geometry) {
      return geometry;
    }

    switch (shape) {
      case 'cube':
      case 'box':
        geometry = new BoxGeometry(1, 1, 1);
        break;
      case 'cylinder':
        geometry = new CylinderGeometry(0.5, 0.5, 1, 16);
        break;
      case 'cone':
        geometry = new ConeGeometry(0.5, 1, 16);
        break;
      default:
        geometry = new SphereGeometry(0.5, 24, 16);
        break;
    }

    this.shapeGeometries.set(shape, geometry);
    return geometry;
  }

  private updateShape(key: string, data: SceneShapeData) {
    let entry = this.shapes.get(key);
    if (!entry) {
      const material = new MeshLambertMaterial({ transparent: true });
      const mesh = new Mesh(this.getShapeGeometry(data.shape), material);
      mesh.frustumCulled = false;
      entry = { mesh, material };
      this.shapes.set(key, entry);
    }

    if (entry.mesh.geometry !== this.getShapeGeometry(data.shape)) {
      entry.mesh.geometry = this.getShapeGeometry(data.shape);
    }

    entry.mesh.position.fromArray(data.position);
    entry.mesh.scale.setScalar(Math.max(1e-6, data.size));
    entry.material.color.setRGB(data.color[0], data.color[1], data.color[2]);
    entry.material.opacity = data.color[3];
    entry.material.wireframe = data.shape === 'wireframe';
    this.reparent(entry.mesh, this.resolveParent(data.parent));
  }

  private removeShape(key: string) {
    const entry = this.shapes.get(key);
    if (!entry) {
      return;
    }

    entry.mesh.removeFromParent();
    entry.material.dispose();
    this.shapes.delete(key);
  }

  private updateLine(key: string, data: SceneLineData) {
    const segmentCount = Math.max(0, data.positions.length - 1);

    let entry = this.lines.get(key);
    if (!entry || (segmentCount > entry.capacity && entry.capacity < MAX_LINE_INSTANCES)) {
      if (entry) {
        this.disposeLineEntry(entry);
      }

      const capacity = Math.min(MAX_LINE_INSTANCES, Math.max(4, segmentCount * 2));
      const material = new MeshBasicMaterial({ transparent: true });
      const mesh = new InstancedMesh(this.lineGeometry, material, capacity);
      mesh.boundingSphere = new Sphere(new Vector3(), 1e6);
      mesh.frustumCulled = false;
      entry = { mesh, material, capacity };
      this.lines.set(key, entry);
    }

    const { mesh, material } = entry;
    mesh.count = Math.min(segmentCount, entry.capacity);
    material.opacity = data.color[3];

    for (let i = 0; i < mesh.count; i += 1) {
      this.segmentStart.fromArray(data.positions[i]);
      this.segmentEnd.fromArray(data.positions[i + 1]);

      this.segmentDir.subVectors(this.segmentEnd, this.segmentStart);
      const length = this.segmentDir.length();

      this.segmentMid.addVectors(this.segmentStart, this.segmentEnd).multiplyScalar(0.5);

      if (length > 1e-8) {
        this.segmentDir.divideScalar(length);
        this.segmentQuat.setFromUnitVectors(this.segmentForward, this.segmentDir);
      } else {
        this.segmentQuat.identity();
      }

      const thickness = data.sizes?.[i] ?? data.size;
      this.segmentScale.set(thickness, thickness, Math.max(1e-6, length));
      this.segmentMatrix.compose(this.segmentMid, this.segmentQuat, this.segmentScale);
      mesh.setMatrixAt(i, this.segmentMatrix);

      const color = data.colors?.[i] ?? data.color;
      this.segmentColor.setRGB(color[0], color[1], color[2]);
      mesh.setColorAt(i, this.segmentColor);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }

    this.reparent(mesh, this.resolveParent(data.parent));
  }

  private removeLine(key: string) {
    const entry = this.lines.get(key);
    if (!entry) {
      return;
    }

    this.disposeLineEntry(entry);
    this.lines.delete(key);
  }

  private disposeLineEntry(entry: LineEntry) {
    entry.mesh.removeFromParent();
    entry.mesh.dispose();
    entry.material.dispose();
  }

  private updateLabel(key: string, data: SceneLabelData) {
    let entry = this.labels.get(key);
    if (!entry) {
      const text = new Text();
      text.anchorX = 'center';
      text.anchorY = 'middle';
      text.frustumCulled = false;
      entry = { text };
      this.labels.set(key, entry);
    }

    const { text } = entry;
    if (text.text !== data.text) {
      text.text = data.text;
    }
    text.fontSize = Math.max(1e-4, data.size * 4);
    text.color = this.segmentColor.setRGB(data.color[0], data.color[1], data.color[2]).getHex();
    text.fillOpacity = data.color[3];
    text.position.fromArray(data.position);
    text.sync();
    this.reparent(text, this.resolveParent(data.parent));
  }

  private removeLabel(key: string) {
    const entry = this.labels.get(key);
    if (!entry) {
      return;
    }

    entry.text.removeFromParent();
    entry.text.dispose();
    this.labels.delete(key);
  }

  private updateSprite(key: string, data: SceneSpriteData) {
    let entry = this.sprites.get(key);
    if (!entry) {
      const material = new MeshBasicMaterial({
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
      });
      const mesh = new Mesh(this.planeGeometry, material);
      mesh.frustumCulled = false;
      entry = { mesh, material, textureKey: '', size: 1 };
      this.sprites.set(key, entry);
    }

    if (entry.textureKey !== data.texture) {
      entry.textureKey = data.texture;
      const texture = this.getTexture(data.texture);
      entry.material.map = texture ?? null;
      entry.material.needsUpdate = true;
    }

    entry.size = Math.max(1e-6, data.size);
    entry.mesh.position.fromArray(data.position);
    this.applySpriteScale(entry);
    entry.material.color.setRGB(data.color[0], data.color[1], data.color[2]);
    entry.material.opacity = data.color[3];
    this.reparent(entry.mesh, this.resolveParent(data.parent));
  }

  private applySpriteScale(entry: SpriteEntry) {
    const image = entry.material.map?.image as { width?: number; height?: number } | undefined;
    const aspect = image?.width && image?.height ? image.width / image.height : 1;
    entry.mesh.scale.set(entry.size * aspect, entry.size, 1);
  }

  private removeSprite(key: string) {
    const entry = this.sprites.get(key);
    if (!entry) {
      return;
    }

    entry.mesh.removeFromParent();
    entry.material.dispose();
    this.sprites.delete(key);
  }

  private getTexture(textureKey: string): Texture | undefined {
    const cached = this.textures.get(textureKey);
    if (cached || this.pendingTextures.has(textureKey)) {
      return cached;
    }

    this.pendingTextures.add(textureKey);

    if (/^(https?:)?\/\//.test(textureKey) || textureKey.startsWith('/')) {
      new TextureLoader().load(textureKey, (texture) => {
        this.pendingTextures.delete(textureKey);
        this.textures.set(textureKey, texture);
        this.applyTexture(textureKey, texture);
      });
      return undefined;
    }

    void this.fetchResourceTexture(textureKey);
    return undefined;
  }

  private async fetchResourceTexture(textureKey: string) {
    try {
      const response = await this.runCommand('resources/fetch', { key: textureKey });
      const data = (response as { data?: unknown } | undefined)?.data;

      let bytes: Uint8Array | undefined;
      if (data instanceof Uint8Array) {
        bytes = data;
      } else if (Array.isArray(data)) {
        bytes = Uint8Array.from(data as number[]);
      }

      if (!bytes || bytes.length === 0) {
        this.pendingTextures.delete(textureKey);
        return;
      }

      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const url = URL.createObjectURL(new Blob([copy], { type: 'image/png' }));
      new TextureLoader().load(url, (texture) => {
        URL.revokeObjectURL(url);
        this.pendingTextures.delete(textureKey);
        this.textures.set(textureKey, texture);
        this.applyTexture(textureKey, texture);
      });
    } catch (error) {
      console.warn('Failed to fetch sprite texture', textureKey, error);
      this.pendingTextures.delete(textureKey);
    }
  }

  private applyTexture(textureKey: string, texture: Texture) {
    for (const entry of this.sprites.values()) {
      if (entry.textureKey === textureKey) {
        entry.material.map = texture;
        entry.material.needsUpdate = true;
        this.applySpriteScale(entry);
      }
    }
  }
}

export const PRIMITIVES_STATE_PREFIXES = [
  SHAPE_PREFIX,
  LINE_PREFIX,
  LABEL_PREFIX,
  SPRITE_PREFIX,
  TRANSFORM_PREFIX,
  CURSOR_PREFIX,
];

export type { ColorTuple };
