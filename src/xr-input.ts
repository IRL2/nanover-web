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
import { ColocationManager } from './xr/colocation';
import { SqueezeManipulation } from './xr/manipulation';
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
  readonly colocation: ColocationManager;
  readonly manipulation: SqueezeManipulation;

  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;

  private readonly panelRot: Object3D;
  private readonly interactionManager: InteractionManager;

  private readonly pointers: XRPointer[] = [];
  private readonly controllerTips = new Map<Group<WebXRSpaceEventMap>, Object3D>();

  private activeSession: XRSession | null = null;

  private recenter: () => void = () => {};

  private readonly hoverButtonPos = new Vector3();
  private readonly hoverControllerPos = new Vector3();
  private readonly calibratedInverse = new Matrix4();
  private readonly componentMatrix = new Matrix4();
  private readonly tempPosA = new Vector3();
  private readonly tempQuat = new Quaternion();
  private readonly tempScale = new Vector3();
  private readonly avatarFacingCorrection = new Quaternion(0, 1, 0, 0);

  constructor(options: XRInputOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.panelRot = options.panelRot;
    this.interactionManager = options.interactionManager;

    this.colocation = new ColocationManager({
      renderer: options.renderer,
      scene: options.scene,
      calibratedSpace: options.calibratedSpace,
      getColocationMode: options.getColocationMode,
    });
    this.manipulation = new SqueezeManipulation(options.objects);

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
    this.colocation.calibratedSpace.updateWorldMatrix(true, false);
    this.calibratedInverse.copy(this.colocation.calibratedSpace.matrixWorld).invert();

    const xrCamera = this.renderer.xr.getCamera();
    xrCamera.updateWorldMatrix(true, false);
    this.addAvatarComponent(components, 'headset', xrCamera);

    for (let i = 0; i < 2; i += 1) {
      const controller = this.controllers[i];
      if (controller && controller.visible) {
        controller.updateWorldMatrix(true, false);
        this.addAvatarComponent(components, i === 0 ? 'hand.left' : 'hand.right', controller);
      }
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

    this.manipulation.update();
    this.updateRayPointers(panelRoot);
    this.interactionManager.updateActive();
    this.colocation.updateAnchorPose();
  }

  private setupControllers() {
    const modelFactory = new XRControllerModelFactory();

    for (let i = 0; i < 2; i += 1) {
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.add(modelFactory.createControllerModel(grip));
      this.scene.add(grip);

      const controller = this.renderer.xr.getController(i);
      this.controllers.push(controller);
      this.scene.add(controller);

      const hand = this.renderer.xr.getHand(i);
      hand.add(new OculusHandModel(hand));
      this.hands.push(hand);
      this.scene.add(hand);

      this.addClicker(controller);
      this.addClicker(hand);

      controller.addEventListener('squeezestart', () => this.manipulation.startGrip(controller));
      controller.addEventListener('squeezeend', () => this.manipulation.endGrip(controller));

      this.setupRayPointer(controller, i);
    }
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

  private onSessionStart = () => {
    this.activeSession = this.renderer.xr.getSession();
    if (this.activeSession) {
      this.colocation.onSessionStart(this.activeSession);
    }
    resetPanelPlacement();
    window.setTimeout(() => this.recenter(), 500);
  };

  private onSessionEnd = () => {
    if (this.activeSession) {
      this.colocation.onSessionEnd(this.activeSession);
    }
    this.activeSession = null;
    this.manipulation.reset();
  };

  private addAvatarComponent(components: AvatarComponentsState, name: string, source: Object3D) {
    this.componentMatrix.multiplyMatrices(this.calibratedInverse, source.matrixWorld);
    this.componentMatrix.decompose(this.tempPosA, this.tempQuat, this.tempScale);
    this.tempQuat.multiply(this.avatarFacingCorrection).normalize();

    components.push({
      name,
      position: [this.tempPosA.x, this.tempPosA.y, this.tempPosA.z],
      rotation: [this.tempQuat.x, this.tempQuat.y, this.tempQuat.z, this.tempQuat.w],
    });
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
