import {
  CylinderGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

interface ColocationOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  calibratedSpace: Object3D;
  getColocationMode: () => boolean;
}

export class ColocationManager {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  readonly calibratedSpace: Object3D;
  private readonly getColocationMode: () => boolean;

  private readonly calibPoints: Mesh[] = [];
  private calibAnchor: XRAnchor | undefined;

  constructor(options: ColocationOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.calibratedSpace = options.calibratedSpace;
    this.getColocationMode = options.getColocationMode;
  }

  get isCalibrated(): boolean {
    return this.calibAnchor !== undefined;
  }

  onSessionStart(session: XRSession) {
    session.addEventListener('select', this.onSessionSelect);
  }

  onSessionEnd(session: XRSession) {
    session.removeEventListener('select', this.onSessionSelect);
    this.calibAnchor?.delete();
    this.calibAnchor = undefined;
    for (const m of this.calibPoints) m.removeFromParent();
    this.calibPoints.length = 0;
  }

  updateAnchorPose() {
    if (!this.calibAnchor) {
      return;
    }

    const frame = this.renderer.xr.getFrame();
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!frame || !referenceSpace) {
      return;
    }

    const pose = frame.getPose(this.calibAnchor.anchorSpace, referenceSpace);
    if (!pose) {
      return;
    }

    this.calibratedSpace.position.set(
      pose.transform.position.x,
      pose.transform.position.y,
      pose.transform.position.z,
    );
    this.calibratedSpace.quaternion.set(
      pose.transform.orientation.x,
      pose.transform.orientation.y,
      pose.transform.orientation.z,
      pose.transform.orientation.w,
    );
    this.calibratedSpace.scale.x = -1;
  }

  private onSessionSelect = (event: XRInputSourceEvent) => {
    if (!this.getColocationMode()) {
      return;
    }

    if (event.inputSource.handedness !== 'left') {
      return;
    }

    const referenceSpace = this.renderer.xr.getReferenceSpace();
    const session = this.renderer.xr.getSession();
    if (!referenceSpace || !session) {
      return;
    }

    const clickPose = event.frame.getPose(event.inputSource.targetRaySpace, referenceSpace);
    if (!clickPose) {
      return;
    }

    const supportsAnchors = session.enabledFeatures?.includes('anchors') ?? false;
    const marker = this.makeCalibrationMarker(supportsAnchors ? 'green' : 'red');
    marker.position.set(
      clickPose.transform.position.x,
      0,
      clickPose.transform.position.z,
    );
    this.scene.add(marker);
    this.calibPoints.push(marker);

    if (this.calibPoints.length > 2) {
      const previous = this.calibPoints.shift();
      previous?.removeFromParent();
    }

    const createAnchor = event.frame.createAnchor;
    if (this.calibPoints.length !== 2 || !supportsAnchors || !createAnchor) {
      return;
    }

    this.calibAnchor?.delete();
    this.calibAnchor = undefined;

    const a = this.calibPoints[0].position;
    const b = this.calibPoints[1].position;
    const up = new Vector3(0, 1, 0);
    const center = b.clone().lerp(a, 0.5);
    const normal = up.clone().cross(b.clone().sub(a)).normalize();
    const rotation = new Quaternion()
      .setFromRotationMatrix(new Matrix4().lookAt(center, center.clone().add(normal), up))
      .normalize();

    const pose = new XRRigidTransform(
      { x: center.x, y: center.y, z: center.z },
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
    );

    const anchorPromise = event.frame.createAnchor!(pose, referenceSpace);
    if (!anchorPromise) {
      return;
    }

    anchorPromise.then((anchor) => {
      this.calibAnchor = anchor;
      this.calibratedSpace.add(this.makeCalibrationMarker('magenta'));
    }).catch((error) => {
      console.error(`Could not create anchor: ${String(error)}`);
    });
  };

  private makeCalibrationMarker(color: string): Mesh {
    const marker = new Mesh(
      new CylinderGeometry(),
      new MeshBasicMaterial({ color }),
    );
    marker.scale.set(0.05, 0.1, 0.05);
    return marker;
  }
}
