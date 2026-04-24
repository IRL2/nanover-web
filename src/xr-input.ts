import { createRayPointer, Pointer } from '@pmndrs/pointer-events';
import {
  BufferAttribute,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  WebXRSpaceEventMap,
} from 'three';
import { OculusHandModel } from 'three/addons/webxr/OculusHandModel.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { InteractionManager } from './interaction-manager';
import { AvatarComponentsState } from './avatar-state';
import {
  endPanelGrab,
  getGrabHandle,
  isPanelBeingGrabbed,
  resetPanelPlacement,
  startPanelGrab,
  UIKitButton,
  uikitButtons,
} from './ui/xrUI';

type XRPointer = {
  pointer: Pointer;
  rayLine: Mesh;
  tipMarker: Mesh;
};

interface XRInputOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  objects: Object3D;
  panelRot: Object3D;
  calibratedSpace: Object3D;
  interactionManager: InteractionManager;
  getColocationMode: () => boolean;
}

export class XRInputManager {
  readonly controllers: Group<WebXRSpaceEventMap>[] = [];
  readonly hands: Group<WebXRSpaceEventMap>[] = [];

  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;

  private readonly objects: Object3D;
  private readonly panelRot: Object3D;
  private readonly calibratedSpace: Object3D;
  private readonly interactionManager: InteractionManager;
  private readonly getColocationMode: () => boolean;

  private readonly pointers: XRPointer[] = [];
  private readonly controllerTips = new Map<Group<WebXRSpaceEventMap>, Object3D>();
  private readonly grippingControllers: Group<WebXRSpaceEventMap>[] = [];
  private grabMode: 'none' | 'single' | 'dual' = 'none';
  private readonly singleGrabPrevMatrix = new Matrix4();
  private readonly dualGrabState = {
    prevDistance: 0,
    prevCenter: new Vector3(),
    prevAxis: new Vector3(),
  };

  private readonly calibPoints: Mesh[] = [];
  private calibAnchor: XRAnchor | undefined;
  private activeSession: XRSession | null = null;

  private recenter: () => void = () => {};

  private readonly hoverButtonPos = new Vector3();
  private readonly hoverControllerPos = new Vector3();
  private readonly tempPosA = new Vector3();
  private readonly tempPosB = new Vector3();
  private readonly tempAxis = new Vector3();
  private readonly tempCenter = new Vector3();
  private readonly tempScale = new Vector3();
  private readonly tempQuat = new Quaternion();
  private readonly tempMatrix = new Matrix4();
  private readonly tempMatrixA = new Matrix4();
  private readonly tempMatrixB = new Matrix4();
  private readonly tempMatrixC = new Matrix4();
  private readonly parentInverse = new Matrix4();
  private readonly calibratedInverse = new Matrix4();
  private readonly componentMatrix = new Matrix4();

  constructor(options: XRInputOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.objects = options.objects;
    this.panelRot = options.panelRot;
    this.calibratedSpace = options.calibratedSpace;
    this.interactionManager = options.interactionManager;
    this.getColocationMode = options.getColocationMode;

    this.setupControllers();
    this.renderer.xr.addEventListener('sessionstart', this.onSessionStart);
    this.renderer.xr.addEventListener('sessionend', this.onSessionEnd);
  }

  setRecenter(handler: () => void) {
    this.recenter = handler;
  }

  collectAvatarComponents(): AvatarComponentsState {
    if (!this.renderer.xr.isPresenting) {
      return [];
    }

    const components: AvatarComponentsState = [];
    this.calibratedSpace.updateWorldMatrix(true, false);
    this.calibratedInverse.copy(this.calibratedSpace.matrixWorld).invert();

    const xrCamera = this.renderer.xr.getCamera();
    xrCamera.updateWorldMatrix(true, false);
    this.addAvatarComponent(components, 'headset', xrCamera);

    const leftController = this.controllers[0];
    if (leftController.visible) {
      leftController.updateWorldMatrix(true, false);
      this.addAvatarComponent(components, 'hand.left', leftController);
    }

    const rightController = this.controllers[1];
    if (rightController.visible) {
      rightController.updateWorldMatrix(true, false);
      this.addAvatarComponent(components, 'hand.right', rightController);
    }

    return components;
  }

  update(panelRoot: Object3D | undefined) {
    if (!this.renderer.xr.isPresenting) {
      for (const { rayLine, tipMarker } of this.pointers) {
        rayLine.visible = false;
        tipMarker.visible = false;
      }
      return;
    }

    for (const { tipMarker } of this.pointers) {
      tipMarker.visible = true;
    }

    for (const controller of this.controllers) {
      this.updateUIButtonHover(controller);
    }
    for (const hand of this.hands) {
      this.updateUIButtonHover(hand);
    }

    this.updateSqueezeManipulation();
    this.updateRayPointers(panelRoot);
    this.interactionManager.updateActive();
    this.updateAnchorPose();
  }

  private setupControllers() {
    const modelFactory = new XRControllerModelFactory();

    const grip1 = this.renderer.xr.getControllerGrip(0);
    grip1.add(modelFactory.createControllerModel(grip1));
    this.scene.add(grip1);

    const grip2 = this.renderer.xr.getControllerGrip(1);
    grip2.add(modelFactory.createControllerModel(grip2));
    this.scene.add(grip2);

    const controller1 = this.renderer.xr.getController(0);
    const controller2 = this.renderer.xr.getController(1);
    this.controllers.push(controller1, controller2);
    this.scene.add(controller1, controller2);

    const hand1 = this.renderer.xr.getHand(0);
    hand1.add(new OculusHandModel(hand1));
    const hand2 = this.renderer.xr.getHand(1);
    hand2.add(new OculusHandModel(hand2));
    this.hands.push(hand1, hand2);
    this.scene.add(hand1, hand2);

    this.addClicker(controller1);
    this.addClicker(controller2);
    this.addClicker(hand1);
    this.addClicker(hand2);

    controller1.addEventListener('squeezestart', () => this.onSqueezeStart(controller1));
    controller1.addEventListener('squeezeend', () => this.onSqueezeEnd(controller1));
    controller2.addEventListener('squeezestart', () => this.onSqueezeStart(controller2));
    controller2.addEventListener('squeezeend', () => this.onSqueezeEnd(controller2));

    this.setupRayPointer(controller1, 0);
    this.setupRayPointer(controller2, 1);
  }

  private addClicker(group: Group<WebXRSpaceEventMap>) {
    group.userData.hoveredUIKit = undefined;
    group.addEventListener('select', () => {
      const hovered = group.userData.hoveredUIKit as UIKitButton | undefined;
      hovered?.onClick();
    });
  }

  private setupRayPointer(controller: Group<WebXRSpaceEventMap>, handIndex: number) {
    const side = handIndex === 0 ? -0.02 : 0.02;

    const tip = new Object3D();
    tip.position.set(side, 0, -0.08);
    controller.add(tip);
    this.controllerTips.set(controller, tip);
    this.interactionManager.registerControllerTip(controller, tip);

    const tipMarker = new Mesh(
      new SphereGeometry(0.008, 12, 12),
      new MeshBasicMaterial({
        color: 0x00ff66,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    tipMarker.renderOrder = 1000;
    tipMarker.frustumCulled = false;
    tip.add(tipMarker);

    const rayOrigin = new Object3D();
    rayOrigin.position.set(side, 0, -0.05);
    controller.add(rayOrigin);

    const rayLength = 1.0;
    const rayGeometry = new CylinderGeometry(0.003, 0.003, rayLength, 8);
    rayGeometry.rotateX(Math.PI / 2);
    rayGeometry.translate(0, 0, -rayLength / 2);

    const alphaCount = rayGeometry.attributes.position.count;
    const alphaValues = new Float32Array(alphaCount);
    const rayPositions = rayGeometry.attributes.position.array;
    for (let i = 0; i < alphaCount; i += 1) {
      const z = rayPositions[(i * 3) + 2];
      alphaValues[i] = 1 - (Math.abs(z) / rayLength);
    }
    rayGeometry.setAttribute('alpha', new BufferAttribute(alphaValues, 1));

    const rayMaterial = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      uniforms: {
        color: { value: new Color(0xffffff) },
        opacity: { value: 0.9 },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(color, opacity * vAlpha);
        }
      `,
    });

    const rayMesh = new Mesh(rayGeometry, rayMaterial);
    rayMesh.renderOrder = 999;
    rayMesh.frustumCulled = false;
    rayMesh.visible = false;
    rayOrigin.add(rayMesh);

    const pointer = createRayPointer(
      () => this.camera,
      { current: rayOrigin },
      { pressing: false },
      { minDistance: 0 },
      'xr-ray',
    );

    controller.addEventListener('selectstart', () => {
      pointer.down({ timeStamp: performance.now(), button: 0 });

      const intersection = pointer.getIntersection();
      const handle = getGrabHandle();
      if (handle && intersection && this.isDescendantOf(intersection.object, handle)) {
        startPanelGrab(controller, this.panelRot);
        return;
      }

      this.interactionManager.start(controller);
    });

    controller.addEventListener('selectend', () => {
      pointer.up({ timeStamp: performance.now(), button: 0 });
      if (isPanelBeingGrabbed()) {
        endPanelGrab();
      }
      this.interactionManager.end(controller);
    });

    this.pointers.push({ pointer, rayLine: rayMesh, tipMarker });
  }

  private updateUIButtonHover(group: Group<WebXRSpaceEventMap>) {
    group.userData.hoveredUIKit = undefined;
    group.getWorldPosition(this.hoverControllerPos);

    for (const button of uikitButtons) {
      button.container.getWorldPosition(this.hoverButtonPos);
      if (this.hoverButtonPos.distanceTo(this.hoverControllerPos) < 0.1) {
        group.userData.hoveredUIKit = button;
      }
    }
  }

  private updateSqueezeManipulation() {
    const gripCount = this.grippingControllers.length;
    if (gripCount === 0) {
      this.grabMode = 'none';
      return;
    }

    if (gripCount === 1) {
      this.updateSingleGrab(this.grippingControllers[0]);
      return;
    }

    this.updateDualGrab(this.grippingControllers[0], this.grippingControllers[1]);
  }

  private updateSingleGrab(controller: Group<WebXRSpaceEventMap>) {
    controller.updateWorldMatrix(true, false);

    if (this.grabMode !== 'single') {
      this.grabMode = 'single';
      this.singleGrabPrevMatrix.copy(controller.matrixWorld);
      return;
    }

    this.tempMatrix.copy(this.singleGrabPrevMatrix).invert();
    this.tempMatrixA.multiplyMatrices(controller.matrixWorld, this.tempMatrix);
    this.applyWorldDeltaToObjects(this.tempMatrixA);
    this.singleGrabPrevMatrix.copy(controller.matrixWorld);
  }

  private updateDualGrab(c1: Group<WebXRSpaceEventMap>, c2: Group<WebXRSpaceEventMap>) {
    c1.getWorldPosition(this.tempPosA);
    c2.getWorldPosition(this.tempPosB);

    const distance = this.tempPosA.distanceTo(this.tempPosB);
    if (distance < 1e-4) {
      this.dualGrabState.prevDistance = distance;
      this.grabMode = 'dual';
      return;
    }

    this.tempCenter.copy(this.tempPosA).lerp(this.tempPosB, 0.5);
    this.tempAxis.copy(this.tempPosB).sub(this.tempPosA).normalize();

    if (this.grabMode !== 'dual' || this.dualGrabState.prevDistance < 1e-4) {
      this.grabMode = 'dual';
      this.dualGrabState.prevDistance = distance;
      this.dualGrabState.prevCenter.copy(this.tempCenter);
      this.dualGrabState.prevAxis.copy(this.tempAxis);
      return;
    }

    let ratio = distance / this.dualGrabState.prevDistance;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      ratio = 1;
    }
    ratio = Math.min(5, Math.max(0.2, ratio));

    this.tempQuat.setFromUnitVectors(this.dualGrabState.prevAxis, this.tempAxis).normalize();
    this.tempScale.set(ratio, ratio, ratio);

    this.tempMatrixA.makeTranslation(this.tempCenter.x, this.tempCenter.y, this.tempCenter.z);
    this.tempMatrixB.makeRotationFromQuaternion(this.tempQuat);
    this.tempMatrixC.makeScale(this.tempScale.x, this.tempScale.y, this.tempScale.z);
    this.tempMatrix.makeTranslation(
      -this.dualGrabState.prevCenter.x,
      -this.dualGrabState.prevCenter.y,
      -this.dualGrabState.prevCenter.z,
    );

    this.tempMatrixA.multiply(this.tempMatrixB).multiply(this.tempMatrixC).multiply(this.tempMatrix);
    this.applyWorldDeltaToObjects(this.tempMatrixA);

    this.dualGrabState.prevDistance = distance;
    this.dualGrabState.prevCenter.copy(this.tempCenter);
    this.dualGrabState.prevAxis.copy(this.tempAxis);
  }

  private applyWorldDeltaToObjects(worldDelta: Matrix4) {
    this.objects.updateWorldMatrix(true, false);
    this.tempMatrixA.copy(worldDelta).multiply(this.objects.matrixWorld);

    const parent = this.objects.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      this.parentInverse.copy(parent.matrixWorld).invert();
      this.tempMatrixB.multiplyMatrices(this.parentInverse, this.tempMatrixA);
    } else {
      this.tempMatrixB.copy(this.tempMatrixA);
    }

    this.tempMatrixB.decompose(this.objects.position, this.objects.quaternion, this.objects.scale);
  }

  private updateRayPointers(panelRoot: Object3D | undefined) {
    for (const { pointer, rayLine } of this.pointers) {
      pointer.move(this.scene, { timeStamp: performance.now() });
      const intersection = pointer.getIntersection();
      const hitsPanel = Boolean(panelRoot && intersection && this.isDescendantOf(intersection.object, panelRoot));

      if (hitsPanel && intersection) {
        rayLine.visible = true;
        rayLine.scale.z = Math.min(intersection.distance, 2);
        continue;
      }

      rayLine.visible = false;
      rayLine.scale.z = 0.15;
    }
  }

  private updateAnchorPose() {
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

  private onSqueezeStart(controller: Group<WebXRSpaceEventMap>) {
    if (this.grippingControllers.includes(controller)) {
      return;
    }
    this.grippingControllers.push(controller);
    this.grabMode = 'none';
    this.dualGrabState.prevDistance = 0;
  }

  private onSqueezeEnd(controller: Group<WebXRSpaceEventMap>) {
    const index = this.grippingControllers.indexOf(controller);
    if (index >= 0) {
      this.grippingControllers.splice(index, 1);
    }
    this.grabMode = 'none';
    this.dualGrabState.prevDistance = 0;
  }

  private onSessionStart = () => {
    this.activeSession = this.renderer.xr.getSession();
    if (this.activeSession) {
      this.activeSession.addEventListener('select', this.onSessionSelect);
    }
    resetPanelPlacement();
    window.setTimeout(() => this.recenter(), 500);
  };

  private onSessionEnd = () => {
    if (this.activeSession) {
      this.activeSession.removeEventListener('select', this.onSessionSelect);
    }
    this.activeSession = null;
    this.grippingControllers.length = 0;
    this.grabMode = 'none';
    this.dualGrabState.prevDistance = 0;
  };

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
      clickPose.transform.position.y,
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

  private addAvatarComponent(components: AvatarComponentsState, name: string, source: Object3D) {
    this.componentMatrix.multiplyMatrices(this.calibratedInverse, source.matrixWorld);
    this.componentMatrix.decompose(this.tempPosA, this.tempQuat, this.tempScale);

    components.push({
      name,
      position: [this.tempPosA.x, this.tempPosA.y, this.tempPosA.z],
      rotation: [this.tempQuat.x, this.tempQuat.y, this.tempQuat.z, this.tempQuat.w],
    });
  }

  private makeCalibrationMarker(color: string): Mesh {
    const marker = new Mesh(
      new CylinderGeometry(),
      new MeshBasicMaterial({ color }),
    );
    marker.scale.set(0.05, 0.1, 0.05);
    return marker;
  }

  private isDescendantOf(child: Object3D, parent: Object3D): boolean {
    let cursor: Object3D | null = child;
    while (cursor) {
      if (cursor === parent) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  }
}
