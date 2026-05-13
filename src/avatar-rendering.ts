import { Text } from 'troika-three-text';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Sphere,
  Vector3,
} from 'three';
import { LiveAvatarState } from './live-frame-state';

interface AvatarRenderingOptions {
  parent: Object3D;
  camera: PerspectiveCamera;
}

export class AvatarRendering {
  readonly headsets: InstancedMesh;
  readonly hands: InstancedMesh;

  private readonly parent: Object3D;
  private readonly camera: PerspectiveCamera;

  private readonly labels = new Set<Text>();

  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scale = new Vector3();
  private readonly color = new Color();

  constructor(options: AvatarRenderingOptions) {
    this.parent = options.parent;
    this.camera = options.camera;

    this.headsets = new InstancedMesh(new BoxGeometry(), new MeshLambertMaterial(), 64);
    this.headsets.boundingSphere = new Sphere(new Vector3(), 100);
    this.headsets.count = 0;

    this.hands = new InstancedMesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshLambertMaterial(), 128);
    this.hands.boundingSphere = new Sphere(new Vector3(), 100);
    this.hands.count = 0;

    this.parent.add(this.headsets);
    this.parent.add(this.hands);
  }

  setHeadsetGeometry(geometry: BufferGeometry) {
    this.headsets.geometry = geometry;
  }

  clear() {
    this.headsets.count = 0;
    this.hands.count = 0;
    this.headsets.instanceMatrix.needsUpdate = true;
    this.hands.instanceMatrix.needsUpdate = true;
    if (this.headsets.instanceColor) {
      this.headsets.instanceColor.needsUpdate = true;
    }
    if (this.hands.instanceColor) {
      this.hands.instanceColor.needsUpdate = true;
    }

    for (const label of this.labels) {
      label.dispose();
      label.removeFromParent();
    }
    this.labels.clear();
  }

  render(avatars: LiveAvatarState[]) {
    this.clear();

    for (const avatar of avatars) {
      this.color.fromArray(avatar.color);
      for (const component of avatar.components) {
        this.position.fromArray(component.position);
        this.rotation.fromArray(component.rotation);

        if (component.name === 'headset') {
          this.scale.set(0.05, 0.05, 0.05);
          this.matrix.compose(this.position, this.rotation, this.scale);
          this.headsets.setMatrixAt(this.headsets.count, this.matrix);
          this.headsets.setColorAt(this.headsets.count, this.color);
          this.headsets.count += 1;

          const label = new Text();
          label.text = avatar.name;
          label.fontSize = 0.05;
          label.position.copy(this.position).y += 0.1;
          label.color = `#${this.color.getHexString()}`;
          label.anchorX = 'center';
          label.anchorY = 'bottom';
          label.lookAt(this.camera.position);
          label.sync();
          this.parent.add(label);
          this.labels.add(label);
          continue;
        }

        if (component.name === 'hand.left' || component.name === 'hand.right') {
          this.scale.set(1, 1, 1);
          this.matrix.compose(this.position, this.rotation, this.scale);
          this.hands.setMatrixAt(this.hands.count, this.matrix);
          this.hands.setColorAt(this.hands.count, this.color);
          this.hands.count += 1;
        }
      }
    }

    this.headsets.instanceMatrix.needsUpdate = true;
    this.hands.instanceMatrix.needsUpdate = true;
    if (this.headsets.instanceColor) {
      this.headsets.instanceColor.needsUpdate = true;
    }
    if (this.hands.instanceColor) {
      this.hands.instanceColor.needsUpdate = true;
    }
  }
}
