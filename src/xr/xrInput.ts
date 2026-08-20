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
import { forceScale, setForceScale } from '../state';
import { OculusHandModel } from 'three/addons/webxr/OculusHandModel.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { InteractionManager } from '../tools/interaction-manager';
import { AvatarComponentsState } from '../core/avatar-state';
import { CursorState } from '../core/primitives';
import { ColocationManager } from './colocation';
import { SqueezeManipulation } from './manipulation';
import {
  endPanelGrab,
  getGrabHandle,
  isPanelBeingGrabbed,
  resetPanelPlacement,
  startPanelGrab,
  UIKitButton,
  uikitButtons,
} from '../ui/xrUI';

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

  private scaleTick = 0;
  private scaleTime = 0;
  private lastUpdateTime = 0;

  private readonly hoverButtonPos = new Vector3();
  private readonly hoverControllerPos = new Vector3();
  private readonly calibratedInverse = new Matrix4();
  private readonly componentMatrix = new Matrix4();
  private readonly tempPosA = new Vector3();
  private readonly tempPosB = new Vector3();
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

  getRightController(): Group<WebXRSpaceEventMap> | undefined {
    return this.controllers.find((controller) => controller.userData.handedness === 'right');
  }

  private setHeldButton(group: Group<WebXRSpaceEventMap>, button: string, held: boolean) {
    const heldButtons = group.userData.heldButtons as Set<string> | undefined;
    if (!heldButtons) {
      return;
    }
    if (held) {
      heldButtons.add(button);
    } else {
      heldButtons.delete(button);
    }
  }

  private updateHandPinch(hand: Group<WebXRSpaceEventMap>) {
    const joints = (hand as unknown as { joints?: Record<string, Object3D | undefined> }).joints;
    if (!joints) {
      return;
    }

    const thumbTip = joints['thumb-tip'];
    const indexTip = joints['index-finger-tip'];
    if (!thumbTip || !indexTip) {
      return;
    }

    thumbTip.getWorldPosition(this.tempPosA);
    indexTip.getWorldPosition(this.tempPosB);
    const pinching = this.tempPosA.distanceTo(this.tempPosB) < 0.02;

    const heldButtons = hand.userData.heldButtons as Set<string> | undefined;
    if (!heldButtons) {
      return;
    }

    const wasPinching = heldButtons.has('pinch');
    if (pinching && !wasPinching) {
      heldButtons.add('pinch');
      heldButtons.add('primary');
      heldButtons.add('trigger');
    } else if (!pinching && wasPinching) {
      heldButtons.delete('pinch');
      heldButtons.delete('primary');
      heldButtons.delete('trigger');
    }
  }

  collectCursors(): CursorState[] {
    const cursors: CursorState[] = [];
    if (!this.renderer.xr.isPresenting) {
      return cursors;
    }

    const session = this.renderer.xr.getSession();

    this.colocation.calibratedSpace.updateWorldMatrix(true, false);
    this.calibratedInverse.copy(this.colocation.calibratedSpace.matrixWorld).invert();

    for (let i = 0; i < this.controllers.length; i += 1) {
      const controller = this.controllers[i];
      const hand = this.hands[i];

      const handedness = controller.userData.handedness ?? hand?.userData.handedness;
      if (handedness !== 'left' && handedness !== 'right') {
        continue;
      }

      const buttons = new Set<string>();
      const controllerButtons = controller.userData.heldButtons as Set<string> | undefined;
      if (controllerButtons) {
        for (const button of controllerButtons) {
          buttons.add(button);
        }
      }

      if (hand) {
        this.updateHandPinch(hand);
        const handButtons = hand.userData.heldButtons as Set<string> | undefined;
        if (handButtons) {
          for (const button of handButtons) {
            if (button !== 'pinch') {
              buttons.add(button);
            }
          }
        }
      }

      controller.updateWorldMatrix(true, false);
      this.componentMatrix.multiplyMatrices(this.calibratedInverse, controller.matrixWorld);
      this.componentMatrix.decompose(this.tempPosA, this.tempQuat, this.tempScale);

      cursors.push({
        handedness,
        position: [this.tempPosA.x, this.tempPosA.y, this.tempPosA.z],
        rotation: [this.tempQuat.x, this.tempQuat.y, this.tempQuat.z, this.tempQuat.w],
        heldbuttons: [...buttons],
        joystick: this.readJoystick(session, handedness),
      });
    }

    return cursors;
  }

  private readJoystick(session: XRSession | null, handedness: 'left' | 'right'): [number, number] {
    if (!session) {
      return [0, 0];
    }

    for (const source of session.inputSources) {
      if (source.handedness !== handedness || !source.gamepad) {
        continue;
      }

      const axes = source.gamepad.axes;
      if (axes.length > 3) {
        return [axes[2], axes[3]];
      }
      if (axes.length > 1) {
        return [axes[0], axes[1]];
      }
    }

    return [0, 0];
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
    this.interactionManager.updateHoverHighlight();
    this.updateForceScaleFromThumbstick();
    this.colocation.updateAnchorPose();
  }

  private updateForceScaleFromThumbstick() {
    const now = performance.now() / 1000;
    const dt = this.lastUpdateTime > 0 ? Math.min(0.067, now - this.lastUpdateTime) : 0;
    this.lastUpdateTime = now;

    const x = this.getRightThumbstickX();
    const increase = x > 0.5;
    const decrease = x < -0.5;
    const isScaling = increase || decrease;

    this.scaleTime = isScaling ? this.scaleTime + dt : 0;
    this.scaleTick = isScaling ? this.scaleTick + dt : 0;

    if (this.scaleTick > 0.1) {
      const sign = increase ? 1 : -1;
      const acceleration = Math.pow(2, Math.floor(this.scaleTime));
      const change = sign * acceleration;
      const newScale = Math.round(Math.min(10000, Math.max(1, forceScale + change)));
      setForceScale(newScale);
      this.scaleTick -= 0.1;
    }
  }

  private getRightThumbstickX(): number {
    const session = this.renderer.xr.getSession();
    if (!session) return 0;
    for (const source of session.inputSources) {
      if (source.handedness === 'right' && source.gamepad) {
        const axes = source.gamepad.axes;
        // WebXR standard gamepad mapping: axes[2] = thumbstick X, axes[0] = touchpad X
        if (axes.length > 2) return axes[2];
        if (axes.length > 0) return axes[0];
      }
    }
    return 0;
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

      controller.addEventListener('connected', (event) => {
        controller.userData.handedness = event.data.handedness;
        controller.userData.heldButtons = new Set<string>();
      });
      controller.addEventListener('disconnected', () => {
        controller.userData.handedness = undefined;
        controller.userData.heldButtons = undefined;
      });

      controller.addEventListener('selectstart', () => this.setHeldButton(controller, 'primary', true));
      controller.addEventListener('selectend', () => this.setHeldButton(controller, 'primary', false));
      controller.addEventListener('selectstart', () => this.setHeldButton(controller, 'trigger', true));
      controller.addEventListener('selectend', () => this.setHeldButton(controller, 'trigger', false));

      const hand = this.renderer.xr.getHand(i);
      hand.add(new OculusHandModel(hand));
      this.hands.push(hand);
      this.scene.add(hand);

      hand.addEventListener('connected', (event) => {
        hand.userData.handedness = event.data.handedness;
        hand.userData.heldButtons = new Set<string>();
      });
      hand.addEventListener('disconnected', () => {
        hand.userData.handedness = undefined;
        hand.userData.heldButtons = undefined;
      });
      hand.addEventListener('selectstart', () => this.setHeldButton(hand, 'primary', true));
      hand.addEventListener('selectend', () => this.setHeldButton(hand, 'primary', false));

      this.addClicker(controller);
      this.addClicker(hand);

      controller.addEventListener('squeezestart', () => {
        this.manipulation.startGrip(controller);
        this.setHeldButton(controller, 'grip', true);
        this.setHeldButton(controller, 'secondary', true);
      });
      controller.addEventListener('squeezeend', () => {
        this.manipulation.endGrip(controller);
        this.setHeldButton(controller, 'grip', false);
        this.setHeldButton(controller, 'secondary', false);
      });

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
