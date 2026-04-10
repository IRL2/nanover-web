import GUI, { Controller } from 'lil-gui'
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  Clock,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  ShaderMaterial,
  Sphere,
  Vector3,
  WebGLRenderer,
  WebXRSpaceEventMap,
  WireframeGeometry,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'stats.js'
import { toggleFullScreen } from './helpers/fullscreen'
import { resizeRendererToDisplaySize } from './helpers/responsiveness'
import './style.css'
import NaiveRenderer from './nanover/NaiveRenderer'
import { TestTrajectory } from './nanover/types'
import { SendMessageData } from './nanover/workers/traj-loader-worker'
import { XRButton } from 'three/examples/jsm/webxr/XRButton.js'
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js'
import { OBJLoader } from 'three/examples/jsm/Addons.js'
import { OculusHandModel } from 'three/addons/webxr/OculusHandModel.js';

import { Text } from "troika-three-text";
import { CommandRequestData } from './nanover/workers/websocket-worker'

import { GDrivePicker } from './helpers/gdrive-picker';

import { reversePainterSortStable } from '@pmndrs/uikit';
import { createRayPointer, Pointer } from '@pmndrs/pointer-events';

import { setupXRUI, updateXRUI, uikitButtons, setShowPanelInDesktop, showPanelInDesktop, getGrabHandle, startPanelGrab, endPanelGrab, isPanelBeingGrabbed, resetPanelPlacement } from './ui/xrUI';
import { setupWebUI, updateWebUI } from './ui/webUI';
import { setupQRScanner } from './helpers/qrReader';

declare const gapi: any;

const CANVAS_ID = 'scene'

let canvas: HTMLElement
let renderer: WebGLRenderer
let scene: Scene
let camera: PerspectiveCamera
let cameraControls: OrbitControls
let stats: Stats
let gui: GUI
let objects: Object3D
let live: NaiveRenderer;
let frameSeek: Controller;
let framePlay: Controller;
let frameTimer = 0.0;
let panelRot: Object3D;
let recenter = () => {};
let trajectoryNameElement: HTMLElement | null;

function updateTrajectoryName(name: string) {
  if (trajectoryNameElement) {
    trajectoryNameElement.textContent = name || 'No trajectory loaded';
  }
}

let xrPointers: { pointer: Pointer, controller: Group, rayLine: Mesh }[] = [];

// grab/scale State
const grippingControllers: Group[] = [];
const grabState = {
  active: false,
  count: 0,
  prevDist: 0,
  prevCenter: new Vector3(),
};

// IMD interaction astate
interface IMDInteraction {
  id: string;
  controller: Group;
  particles: number[];
  active: boolean;
}

const activeInteractions = new Map<Group, IMDInteraction>();
let interactionIdCounter = 0;

function generateInteractionId(): string {
  return `web-${Date.now()}-${interactionIdCounter++}`;
}

let onInteractionStart: ((controller: Group) => void) | null = null;
let onInteractionUpdate: ((controller: Group) => void) | null = null;
let onInteractionEnd: ((controller: Group) => void) | null = null;

function getURLParam(param: string): string | null {
  const paramsString = window.location.search;
  const urlParams = new URLSearchParams(paramsString);
  return urlParams.get(param); 
}

function ui_hover(group: Group<WebXRSpaceEventMap>) {
  const p = new Vector3();
  const c = new Vector3();
  group.userData ??= {};
  group.userData.hovered?.exit();
  group.userData.hovered = undefined;
  group.userData.hoveredUIKit = undefined;

  group.getWorldPosition(c);

  for (const uiButton of uikitButtons) {
    uiButton.container.getWorldPosition(p);
    const d = p.distanceTo(c);
    const close = d < .1;

    if (close) {
      group.userData.hoveredUIKit = uiButton;
    }
  }

  group.userData.hovered?.enter();
}

const calibPoints: Mesh[] = [];
let calibAnchor: XRAnchor | undefined;

let calibratedSpace = new Object3D();


const avatarHeadsets = new InstancedMesh(new BoxGeometry(), new MeshLambertMaterial(), 64);
avatarHeadsets.boundingSphere = new Sphere(new Vector3(), 100);
avatarHeadsets.count = 0;

const avatarHands = new InstancedMesh(new BoxGeometry(0.08, 0.08, 0.08), new MeshLambertMaterial(), 128);
avatarHands.boundingSphere = new Sphere(new Vector3(), 100);
avatarHands.count = 0;

const interactions = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial({ color: "green" }), 64);
interactions.boundingSphere = new Sphere(new Vector3(), 100);
interactions.count = 0;

//interaction lines
const interactionLines = new Group();
const interactionLineMaterial = new MeshBasicMaterial({ 
  color: 0xFFFF00, 
  transparent: true, 
  opacity: 0.8,
  depthTest: false 
});

const frameClock = new Clock();

const pairs: { traj: TestTrajectory, renderer: NaiveRenderer }[] = [];

init()

function init() {
  // ===== 🖼️ CANVAS, RENDERER, & SCENE =====
  {
    canvas = document.querySelector(`canvas#${CANVAS_ID}`)!
    trajectoryNameElement = document.getElementById('trajectory-name')
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    scene = new Scene()

    renderer.setAnimationLoop(animate);

    renderer.xr.enabled = true;
    renderer.xr.addEventListener("sessionstart", enter_xr);
    renderer.xr.addEventListener("sessionend", exit_xr);

    // enable required settings for UIKit
    renderer.localClippingEnabled = true;
    renderer.setTransparentSort(reversePainterSortStable);

    function enter_xr() {
      const session = renderer.xr.getSession()!;
      console.log(session.enabledFeatures);
      session.addEventListener('select', onSelect);

      resetPanelPlacement();

      setTimeout(() => {
        recenter();
      }, 500);
    }

    function exit_xr() {

    }

    function onSelect(event: XRInputSourceEvent) {
      if (event.inputSource.handedness !== 'left') {
        return;
      }
      
      let frame = event.frame;

      const support = renderer.xr.getSession()?.enabledFeatures?.includes("anchors");

      const clickPose = event.frame.getPose(
        event.inputSource.targetRaySpace,
        renderer.xr.getReferenceSpace()!,
      )!;

      const next = new Mesh(
        new CylinderGeometry(),
        new MeshBasicMaterial({ color: support ? "green" : "red" }),
      );
      next.position.copy(clickPose.transform.position);
      // next.position.y = 0.05;
      next.scale.set(.05, .1, .05);
      scene.add(next);
      calibPoints.push(next);

      if (calibPoints.length > 2) {
        const prev = calibPoints.shift()!;
        prev.removeFromParent();
      }

      if (calibPoints.length == 2) {
        calibAnchor?.delete();
        calibAnchor = undefined;
        
        const a = calibPoints[0].position;
        const b = calibPoints[1].position;

        const up = new Vector3(0, 1, 0);
        const center = b.clone().lerp(a, .5);
        const normal = up.clone().cross(b.clone().sub(a)).normalize();

        const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(
          center,
          center.clone().add(normal),
          up,
        )).normalize();
        const calibPose = new XRRigidTransform(center, rotation);

        // Create a free-floating anchor.
        frame.createAnchor!(calibPose, renderer.xr.getReferenceSpace()!)!.then((anchor) => {
          calibAnchor = anchor;
          const next = new Mesh(
            new CylinderGeometry(),
            new MeshBasicMaterial({ color: "magenta" }),
          );
          // next.position.y = 0.05;
          next.scale.set(.05, .1, .05);
          calibratedSpace.add(next);
        }, (error) => {
          console.error("Could not create anchor: " + error);
        });
      }
    }
  }

  const loader = new OBJLoader();
  loader.load(new URL("./data/circlet.obj", window.location.href).toString(), (data) => {
    avatarHeadsets.geometry = (data.children[0] as any).geometry;
    avatarHeadsets.geometry.rotateX(-Math.PI * .5);
  });

  // ===== 📦 OBJECTS =====
  {
    scene.add(calibratedSpace);
    calibratedSpace.add(avatarHeadsets);
    calibratedSpace.add(avatarHands);
    objects = new Object3D();
    calibratedSpace.add(objects);
    live = new NaiveRenderer();
    objects.add(live);
    objects.add(interactions);
    scene.add(interactionLines);
  }

  // anchor for the UI Panel
  panelRot = new Object3D();
  scene.add(panelRot);

  const elementColors = new Map([
    [1, new Color("white")],
    [6, new Color("black")],
    [7, new Color("blue")],
    [8, new Color("red")],
  ]);

  const c = new Color();
  function make_color(traj: Pick<TestTrajectory, "topology">, i: number) {
    c.setHSL((i / traj.topology.elements.length) + Math.random() * .1, .25, .5);
    c.lerp(elementColors.get(traj.topology.elements[i]) ?? c, .65);
    return c
  }

  const trajLoaderChannel = new MessageChannel();
  {
    const trajLoaderWorker = new Worker(new URL("nanover/workers/traj-loader-worker.ts", import.meta.url), { type: "module" });
    trajLoaderWorker.postMessage({ port: trajLoaderChannel.port2 }, { transfer: [trajLoaderChannel.port2] });

    trajLoaderChannel.port1.addEventListener("message", (event) => {
      const { traj } = event.data as SendMessageData;
      const renderer = new NaiveRenderer();
      objects.add(renderer);

      pairs.push({ traj, renderer });

      const atomCount = traj.positions[0].length / 3;

      const colors = new Float32Array(traj.positions[0].length);
      for (let j = 0; j < atomCount; ++j) {
        make_color(traj, j).toArray(colors, j * 3);
        // c.setHSL(i / fileCount, .75, .5);
        // c.toArray(colors, j * 3);
      }

      renderer.setData(
        traj.positions[0],
        colors,
        traj.topology.bonds,
      );
    });
    trajLoaderChannel.port1.start();
  }

  // ===== 🎥 CAMERA =====
  {
    camera = new PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 1000)
    camera.position.set(2, 2, 5)
  }

  // ===== 💡 LIGHTS =====
  {
    camera.add(new DirectionalLight(new Color(), Math.PI));
    scene.add(new AmbientLight(new Color(), .25 * Math.PI));
    scene.add(camera);
  }


  // ===== 🕹️ CONTROLS =====
  {
    cameraControls = new OrbitControls(camera, canvas)
    cameraControls.target.set(0, 1, 0);
    cameraControls.enableDamping = true
    cameraControls.autoRotate = false
    cameraControls.update()

    // Full screen
    window.addEventListener('dblclick', (event) => {
      if (event.target === canvas) {
        toggleFullScreen(canvas)
      }
    })
  }

  {
    const skybox = new Mesh(
      new IcosahedronGeometry(),
      new MeshBasicMaterial({ color: 0x505050, transparent: true, opacity: .995, side: BackSide }),
    );
    skybox.scale.set(5, 5, 5);
    skybox.position.set(0, 1, 0);
    scene.add(skybox);
    skybox.visible = false;

    function add_clicker(grip: Group<WebXRSpaceEventMap>, name = "UNKNOWN") {
      grip.userData = { name };
      grip.addEventListener("select", () => {
        console.log("SELECT", grip.userData.name, grip.userData.hovered, grip.userData.hoveredUIKit);
        grip.userData.hovered?.onclick();
        grip.userData.hoveredUIKit?.onClick();
      });
    }

    const controllerModelFactory = new XRControllerModelFactory();
    const controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    const controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);

    const controller1 = renderer.xr.getController(0);
    const controller2 = renderer.xr.getController(1);
    scene.add(controller1);
    scene.add(controller2);
    
    const hand1 = renderer.xr.getHand(0);
    hand1.add(new OculusHandModel(hand1));
    scene.add(hand1);
    
    const hand2 = renderer.xr.getHand(1);
    hand2.add(new OculusHandModel(hand2));
    scene.add(hand2);

    add_clicker(controller1, "left controller");
    add_clicker(controller2, "right controller");

    add_clicker(hand1, "left hand");
    add_clicker(hand2, "right hand");

    // grab logic handlers
    function onSqueezeStart(event: any) {
      const controller = event.target;
      if (!grippingControllers.includes(controller)) {
        grippingControllers.push(controller);
        grabState.active = false;
      }
    }

    function onSqueezeEnd(event: any) {
      const controller = event.target;
      const index = grippingControllers.indexOf(controller);
      if (index >= 0) {
        grippingControllers.splice(index, 1);
        grabState.active = false;
      }
    }

    controller1.addEventListener('squeezestart', onSqueezeStart);
    controller1.addEventListener('squeezeend', onSqueezeEnd);
    controller2.addEventListener('squeezestart', onSqueezeStart);
    controller2.addEventListener('squeezeend', onSqueezeEnd);

    // ray pointers for controllers
    function setupRayPointer(controller: Group) {
      const spaceRef = { current: controller };

      // ray visual with transparency gradient using shader
      const rayLength = 1.0;
      const rayGeometry = new CylinderGeometry(0.003, 0.003, rayLength, 8);
      rayGeometry.rotateX(Math.PI / 2);
      rayGeometry.translate(0, 0, -rayLength / 2); // origin at controller
      
      // fade based on Z position
      const count = rayGeometry.attributes.position.count;
      const alphas = new Float32Array(count);
      const positions = rayGeometry.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const z = positions[i * 3 + 2];
        alphas[i] = 1 - Math.abs(z) / rayLength;
      }
      rayGeometry.setAttribute('alpha', new BufferAttribute(alphas, 1));
      
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
      controller.add(rayMesh);

      // create ray pointer
      const pointer = createRayPointer(
        () => camera,
        spaceRef,
        { pressing: false },
        { minDistance: 0 },
        'xr-ray'
      );

      // button press
      controller.addEventListener('selectstart' as any, () => {
        pointer.down({ timeStamp: performance.now(), button: 0 });
        
        const intersection = pointer.getIntersection();
        const handle = getGrabHandle();
        let uiInteraction = false;
        
        if (handle && intersection?.object) {
          let obj = intersection.object;
          while (obj) {
            if (obj === handle || (handle as any).interactionPanel === obj) {
              startPanelGrab(controller, panelRot);
              uiInteraction = true;
              break;
            }
            obj = obj.parent as any;
          }
        }
        
        if (!uiInteraction && onInteractionStart) {
          onInteractionStart(controller);
        }
      });

      //button release
      controller.addEventListener('selectend' as any, () => {
        pointer.up({ timeStamp: performance.now(), button: 0 });
        if (isPanelBeingGrabbed()) {
          endPanelGrab();
        }
        if (onInteractionEnd) {
          onInteractionEnd(controller);
        }
      });

      xrPointers.push({ pointer, controller, rayLine: rayMesh });
    }

    setupRayPointer(controller1);
    setupRayPointer(controller2);
  }

  // ===== 📈 STATS & CLOCK =====
  {
    const debugMode = getURLParam('debug') !== null;
    stats = new Stats()
    if (debugMode) {
      document.body.appendChild(stats.dom)
    }

    document.body.appendChild(XRButton.createButton(renderer, { optionalFeatures: ["anchors", "hand-tracking"] }));
  }

  // ===== UIKit Setup =====
  setupXRUI(panelRot, {
    getFrameSeek: () => frameSeek,
    getFramePlay: () => framePlay,
    recenter: () => recenter(),
  });

  // ===== Web UI (HTML panel) =====
  setupWebUI({
    getFrameSeek: () => frameSeek,
    getFramePlay: () => framePlay,
    updateTrajectoryName: (name: string) => updateTrajectoryName(name),
  });


  // ==== 🐞 DEBUG GUI ====
  {
    // check url for debug UI visibility
    const showDebug = getURLParam('debug') !== null || getURLParam('debug') === 'true';

    const websocketWorker = new Worker(new URL("nanover/workers/websocket-worker.ts", import.meta.url), { type: "module" });
    const websocketChannel = new MessageChannel();
    
    websocketWorker.postMessage({ port: websocketChannel.port2 }, { transfer: [websocketChannel.port2] });

    gui = new GUI({ title: '🐞 Debug GUI', width: 300 })
    
    if (!showDebug) {
      gui.hide();
    } 

    const uikitFolder = gui.addFolder("UIKit Debug");
    uikitFolder.add({ showInDesktop: showPanelInDesktop }, "showInDesktop").name("Show Panel in Desktop").onChange((value: boolean) => {
      setShowPanelInDesktop(value);
    });
    uikitFolder.open();

    function connect(host: string) {
      websocketWorker.postMessage({ host });
      
      // Hide trajectory playback - server provides live frames instead
      for (const { renderer } of pairs) {
        renderer.visible = false;
      }
      framePlay.setValue(false);
    }

    const boxMesh = new Mesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ color: "orange", side: BackSide, transparent: true, opacity: .5 }),
    )
    objects.add(boxMesh);
    boxMesh.visible = false;

    const boxWire = new LineSegments(new WireframeGeometry(boxMesh.geometry));
    boxMesh.add(boxWire);

    const t = new Vector3();
    const r = new Quaternion();
    const s = new Vector3();
    const m = new Matrix4();
    const c2 = new Color();

    const texts: Set<Text> = new Set();

    const sharedState: { [key: string]: any } = {};
    
    // current live frame positions 
    let currentPositions: Float32Array | null = null;

    // send state update
    function sendInteractionUpdate(interactionId: string, interaction: {
      positions: [number, number, number];
      particles: number[];
      type?: string;
      scale?: number;
      mass_weighted?: boolean;
    } | null) {
      const stateUpdate: { updates?: { [key: string]: any }, removals?: string[] } = {};
      
      if (interaction === null) {
        stateUpdate.removals = [`interaction.${interactionId}`];
      } else {

        stateUpdate.updates = {
          [`interaction.${interactionId}`]: {
            position: interaction.positions,
            particles: interaction.particles,
            interaction_type: interaction.type ?? "constant",
            scale: interaction.scale ?? 70,
            mass_weighted: interaction.mass_weighted ?? true,
          }
        };
      }
      
      console.log("Sending interaction update:", JSON.stringify(stateUpdate, null, 2));
      websocketChannel.port1.postMessage({ state: stateUpdate });
    }

    // Find the N closest atoms to a world position
    function findClosestAtoms(worldPos: Vector3, count: number = 1): number[] {
      if (!currentPositions || currentPositions.length === 0) return [];
      
      const atomCount = currentPositions.length / 3;
      const distances: { index: number; dist: number }[] = [];
      
      // Transform world position to simulation space
      const simPos = worldPos.clone();
      // Apply inverse of objects transform to get simulation coordinates
      const invMatrix = new Matrix4().copy(objects.matrixWorld).invert();
      simPos.applyMatrix4(invMatrix);
      
      const atomPos = new Vector3();
      for (let i = 0; i < atomCount; i++) {
        atomPos.fromArray(currentPositions, i * 3);
        const dist = simPos.distanceTo(atomPos);
        distances.push({ index: i, dist });
      }
      
      distances.sort((a, b) => a.dist - b.dist);
      return distances.slice(0, count).map(d => d.index);
    }

    // get world position of an atom
    function getAtomWorldPosition(atomIndex: number): Vector3 | null {
      if (!currentPositions || atomIndex * 3 + 2 >= currentPositions.length) return null;
      
      const pos = new Vector3().fromArray(currentPositions, atomIndex * 3);
      // transform to world space
      pos.applyMatrix4(objects.matrixWorld);
      return pos;
    }

    function startInteraction(controller: Group) {
      if (activeInteractions.has(controller)) return;
      
      const controllerPos = controller.getWorldPosition(new Vector3());
      const particles = findClosestAtoms(controllerPos, 1);
      
      if (particles.length === 0) return;
      
      const interactionId = generateInteractionId();
      const interaction: IMDInteraction = {
        id: interactionId,
        controller,
        particles,
        active: true,
      };
      
      activeInteractions.set(controller, interaction);
      

      const lineGeom = new CylinderGeometry(0.005, 0.005, 1, 8);
      lineGeom.rotateX(Math.PI / 2);
      lineGeom.translate(0, 0, 0.5);
      const line = new Mesh(lineGeom, interactionLineMaterial.clone());
      line.userData.interactionId = interactionId;
      line.renderOrder = 999;
      interactionLines.add(line);
      
      // send initial state
      const simPos = controllerPos.clone();
      const invMatrix = new Matrix4().copy(objects.matrixWorld).invert();
      simPos.applyMatrix4(invMatrix);
      
      sendInteractionUpdate(interactionId, {
        positions: [simPos.x, simPos.y, simPos.z],
        particles,
      });
    }

    // update active interaction
    function updateInteraction(controller: Group) {
      const interaction = activeInteractions.get(controller);
      if (!interaction || !interaction.active) return;
      
      const controllerPos = controller.getWorldPosition(new Vector3());
      
      // tansform to simulation space
      const simPos = controllerPos.clone();
      const invMatrix = new Matrix4().copy(objects.matrixWorld).invert();
      simPos.applyMatrix4(invMatrix);
      
      sendInteractionUpdate(interaction.id, {
        positions: [simPos.x, simPos.y, simPos.z],
        particles: interaction.particles,
      });
      
      // update  line
      const atomPos = getAtomWorldPosition(interaction.particles[0]);
      if (atomPos) {
        for (const child of interactionLines.children) {
          if (child.userData.interactionId === interaction.id) {
            const line = child as Mesh;
            line.position.copy(controllerPos);
            line.lookAt(atomPos);
            const distance = controllerPos.distanceTo(atomPos);
            line.scale.set(1, 1, distance);
          }
        }
      }
    }

    // end an interaction
    function endInteraction(controller: Group) {
      const interaction = activeInteractions.get(controller);
      if (!interaction) return;
      sendInteractionUpdate(interaction.id, null);

      const toRemove: Object3D[] = [];
      for (const child of interactionLines.children) {
        if (child.userData.interactionId === interaction.id) {
          toRemove.push(child);
        }
      }
      for (const child of toRemove) {
        interactionLines.remove(child);
        if ((child as Mesh).geometry) (child as Mesh).geometry.dispose();
        if ((child as Mesh).material) ((child as Mesh).material as MeshBasicMaterial).dispose();
      }
      
      activeInteractions.delete(controller);
    }

    onInteractionStart = startInteraction;
    onInteractionUpdate = updateInteraction;
    onInteractionEnd = endInteraction;

    websocketChannel.port1.addEventListener("message", (event) => {
      const { frame, command } = event.data as import("./nanover/workers/websocket-worker").SendMessageData;

      if (command) {
        for (const response of command) {
          const resolve = pendingCommands.get(response.request.id);

          if (resolve) {
            resolve(response.response);
          } else {
            console.log("RESPONSE TO UNKNOWN REQUEST", response);
          }
        }
      }

      if (frame?.elements && frame?.bonds) {
        const atomCount = frame.elements.length;
        const colors = new Float32Array(atomCount * 3);
        for (let j = 0; j < atomCount; ++j) {
          make_color({ topology: { elements: frame.elements, bonds: frame.bonds } }, j);
          c.toArray(colors, j * 3);
        }

        live.setData(
          new Array(atomCount * 3),
          colors,
          frame.bonds,
        );
      }

      if (frame?.positions) {
        live.setPositions(frame.positions);
        currentPositions = frame.positions;
      }

      if (frame?.box) {
        // console.log("Box data received:", frame.box);
        // @ts-ignore
        const m = new Matrix3(...frame.box);
        const x = new Vector3();
        const y = new Vector3();
        const z = new Vector3();
        m.extractBasis(x, y, z);

        const scale = new Vector3(x.length(), y.length(), z.length());
        boxMesh.geometry = new BoxGeometry(scale.x, scale.y, scale.z);
        scale.multiplyScalar(.5);
        boxMesh.geometry.translate(scale.x, scale.y, scale.z);
        boxMesh.visible = true;

        boxWire.geometry = new WireframeGeometry(boxMesh.geometry);
      } else {

        if (sharedState["system.box.vectors"]) {
          console.log("Box from state:", sharedState["system.box.vectors"]);
        }
      }

      if (frame?.state) {
        const stateData = frame.state as { updates?: { [key: string]: any }, removals?: string[] };
        
        if (stateData.updates) {
          for (const [key, value] of Object.entries(stateData.updates)) {
            sharedState[key] = value;
          }
        }

        if (stateData.removals) {
          for (const key of stateData.removals) {
            delete sharedState[key];
          }
        }

        // console.log("Shared state keys:", Object.keys(sharedState));

        avatarHeadsets.count = 0;
        avatarHeadsets.instanceMatrix.needsUpdate = true;
        if (avatarHeadsets.instanceColor) avatarHeadsets.instanceColor.needsUpdate = true;
        avatarHands.count = 0;
        avatarHands.instanceMatrix.needsUpdate = true;
        if (avatarHands.instanceColor) avatarHands.instanceColor.needsUpdate = true;
        interactions.count = 0;
        interactions.instanceMatrix.needsUpdate = true;

        for (const text of texts) {
          text.dispose();
          text.removeFromParent();
        }
        texts.clear();

        if (sharedState.scene) {
          console.log("Scene state:", sharedState.scene);
          t.fromArray(sharedState.scene, 0);
          r.fromArray(sharedState.scene, 3);
          s.fromArray(sharedState.scene, 7);
          s.x *= -1;

          objects.position.copy(t);
          objects.rotation.setFromQuaternion(r);
          objects.scale.copy(s);

          cameraControls.target.copy(objects.position);
          cameraControls.target.addScaledVector(objects.scale, -.5);
          cameraControls.update();
        }

        for (const [key, value] of Object.entries(sharedState)) {
          if (key.startsWith("interaction.") && frame.positions) {
            t.fromArray(frame.positions, (value as any).particles[0] * 3);
            r.identity();
            s.set(.1, .1, .1);
            m.compose(t, r, s);
            interactions.setMatrixAt(interactions.count, m);
            interactions.count += 1;
          }

          if (key.startsWith("avatar.")) {
            console.log("Avatar data:", key, value);
            c2.fromArray((value as any).color);
            for (const component of (value as any).components) {
              console.log("Avatar component:", component.name, component.position);
              t.fromArray(component.position);
              r.fromArray(component.rotation);
              
              if (component.name === "headset") {
                s.set(.05, .05, .05);
                m.compose(t, r, s);
                avatarHeadsets.setMatrixAt(avatarHeadsets.count, m);
                avatarHeadsets.setColorAt(avatarHeadsets.count, c2);
                avatarHeadsets.count += 1;

                const myText = new Text();
                calibratedSpace.add(myText);
                myText.text = (value as any).name;
                myText.fontSize = 0.05;
                myText.position.copy(t).y += 0.1;
                myText.color = "#" + c2.getHexString();
                myText.anchorX = "center";
                myText.anchorY = "bottom";
                myText.lookAt(camera.position);
                myText.sync();
                texts.add(myText);
              } else if (component.name === "hand.left" || component.name === "hand.right") {
                s.set(1, 1, 1); 
                m.compose(t, r, s);
                avatarHands.setMatrixAt(avatarHands.count, m);
                avatarHands.setColorAt(avatarHands.count, c2);
                avatarHands.count += 1;
              }
            }
            console.log("Avatar headsets:", avatarHeadsets.count, "hands:", avatarHands.count);
          }
        }
      }
    });
    websocketChannel.port1.start();

    const refresh = () => {
      const test = fetch("https://irl-discovery.onrender.com/list").then((r) => r.json());
      servers.destroy();
      servers = discoveryFolder.addFolder("Servers");

      test.then((list) => {
        if (list.length > 0) {
          console.log(list);
          for (const { info } of list) {
            servers.add({ click: () => connect(info.wss) }, "click").name(info.name);
          }
          servers.open();
        } else {
          servers.close();
        }
      });
    }

    const trajpaths = [
      { name: "Ludo GluHUTs", paths: ["ludo-gluhut-0.msgpack", "ludo-gluhut-1.msgpack", "ludo-gluhut-2.msgpack", "ludo-gluhut-3.msgpack", "ludo-gluhut-4.msgpack", "ludo-gluhut-5.msgpack", "ludo-gluhut-6.msgpack"] },
      { name: "17-Alanine", paths: ["bucky-test.msgpack"] },
      { name: "Nanotube", paths: ["webtraj.msgpack"] },
    ];

    function loadTrajectories(paths: string[], displayName?: string) {
      for (const { renderer } of pairs) {
        renderer.removeFromParent();
      }
      pairs.length = 0;

      updateTrajectoryName(displayName || paths.join(', '));

      for (let path of paths) {
        path = new URL("./data/" + path, window.location.href).toString();
        trajLoaderChannel.port1.postMessage({ path });
      }
    }

    recenter = function() {
      const p = renderer.xr.getCamera().getWorldPosition(new Vector3());
      const d = renderer.xr.getCamera().getWorldDirection(new Vector3());
      objects.position.copy(p).addScaledVector(d, 1).sub(cameraControls.target);
    }

    const directConnect = () => {
      connect("wss://nanover-server-js.onrender.com");
    }

    const connectFolder = gui.addFolder("Direct");
    
    connectFolder.add({ directConnect }, "directConnect").name("Connect");

    const discoveryFolder = gui.addFolder("Discovery");
    discoveryFolder.add({ refresh }, "refresh").name("Refresh");
    let servers = discoveryFolder.addFolder("Servers");

    const trajectoryFolder = gui.addFolder("Trajectories");
    for (const { name, paths } of trajpaths) {
      trajectoryFolder.add({ load: () => loadTrajectories(paths, name) }, "load").name(name);
    }

    frameSeek = trajectoryFolder.add({ frame: 0 }, "frame", 0, 1, 1).name("Frame");
    framePlay = trajectoryFolder.add({ play: true }, "play").name("Play");

    frameSeek.$widget.onpointerdown = () => framePlay.setValue(false);

    const pendingCommands = new Map<number, (value: any) => void>();
    let nextCommandId = 1;

    async function run_command(name: string, args: Object | undefined = undefined): Promise<any> {
      return new Promise<any>((resolve) => {
        const request: CommandRequestData = {
          id: nextCommandId,
          name,
        };

        if (args) {
          request.arguments = args;
        }

        nextCommandId += 1;

        pendingCommands.set(request.id, resolve);
        websocketChannel.port1.postMessage({ command: { request }});
      });
    }

    const simulationsFolder = gui.addFolder("Simulations");

    function reset() {
      run_command("playback/reset");
    }

    async function list() {
      const result = await run_command("playback/list");
      const sims = result.simulations;

      for (let i = 0; i < sims.length; ++i) {
        function load() {
          run_command("playback/load", { index: i });
        }

        simulationsFolder.add({ load }, "load").name(sims[i]);
      }
    }

    const commandsFolder = gui.addFolder("Commands");
    commandsFolder.add({ reset }, "reset").name("Reset");
    commandsFolder.add({ list }, "list").name("List Sims");

    //google drive picker
    const gdrivePicker = new GDrivePicker();
    const pickerFolder = gui.addFolder("Google Drive Picker");

    const pickerStates = {
      authorized: false,
      status: 'Initializing...',
      selectedFiles: 'No files selected',
    };

    const statusController = pickerFolder.add(pickerStates, 'status').name('Status').disable();
    const filesController = pickerFolder.add(pickerStates, 'selectedFiles').name('Selected Files').disable();

    const authorizeController = pickerFolder.add({ authorize: () => {
      gdrivePicker.authorize().then(() => {
        pickerStates.authorized = true;
        pickerStates.status = 'Authorized';
        statusController.updateDisplay();
        authorizeController.name('Open');
      }).catch((error: any) => {
        console.error('Authorization failed:', error);
        pickerStates.status = 'Authorization failed';
        statusController.updateDisplay();
      });
    } }, 'authorize').name('Authorize');

    gdrivePicker.onAuthReady((isReady) => {
      if (isReady) {
        pickerStates.status = 'Ready to authorize';
        statusController.updateDisplay();
      }
    });

    gdrivePicker.onFileSelected(async (files) => {
      console.log('Selected files:', files);
      const fileNames = files.map((f: any) => f.driveData.name).join(', ');
      pickerStates.selectedFiles = fileNames || 'No files';
      filesController.updateDisplay();
      updateTrajectoryName(fileNames);

      // clear existing trajectories

      for (const { renderer } of pairs) {
        renderer.removeFromParent();
      }
      pairs.length = 0;

      // download and load each selected file
      for (const file of files) {
        const fileId = file.driveData.id;

        try {
          // download file
          const response = await gapi.client.drive.files.get({
            fileId: fileId,
            alt: 'media'
          });

          // convert response to ArrayBuffer
          const blob = await fetch(`data:application/octet-stream;base64,${btoa(response.body)}`).then(r => r.blob());
          const arrayBuffer = await blob.arrayBuffer();

          // send to trajectory loader worker
          trajLoaderChannel.port1.postMessage({
            arrayBuffer: arrayBuffer,
            filename: file.driveData.name
          }, [arrayBuffer]);

        } catch (error) {
          console.error('Failed to load file from Google Drive:', error);
          pickerStates.status = 'Failed to load file';
          statusController.updateDisplay();
        }
      }
    });

    // qr scanner setup
    setupQRScanner(gui, (arrayBuffer, filename) => {
        // clear existing trajectories
        for (const { renderer } of pairs) {
            renderer.removeFromParent();
        }
        pairs.length = 0;
        updateTrajectoryName(filename);

        // send to loader worker
        trajLoaderChannel.port1.postMessage({
            arrayBuffer: arrayBuffer,
            filename: filename
        }, [arrayBuffer]);
    });

    // load trajectory from URL query parameter
    const trajUrl = getURLParam('traj');
    if (trajUrl) {
      loadTrajectoryFromUrl(trajUrl);
    } else {
      loadTrajectories(trajpaths[2].paths, trajpaths[2].name);
    }

    async function loadTrajectoryFromUrl(url: string) {
      try {
        updateTrajectoryName('Loading...');

        // convert github blob URLs to raw
        let fetchUrl = url;
        const githubRegex = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/;
        const match = url.match(githubRegex);
        if (match) {
          fetchUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
        }

        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error('Failed to fetch: ' + response.status);
        const arrayBuffer = await response.arrayBuffer();

        const filename = url.split('/').pop()?.split('?')[0] || 'url_trajectory.msgpack';

        // clear existing trajectories
        for (const { renderer } of pairs) {
          renderer.removeFromParent();
        }
        pairs.length = 0;
        updateTrajectoryName(filename);

        trajLoaderChannel.port1.postMessage({
          arrayBuffer: arrayBuffer,
          filename: filename
        }, [arrayBuffer]);

      } catch (err) {
        console.error('Failed to load trajectory from URL:', err);
        updateTrajectoryName('Failed to load');
      }
    }
  }
}

function frame_positions_index(index: number) {
  const sum = new Vector3();
  const pos = new Vector3();
  let count = 0;

  for (const { traj, renderer } of pairs) {
    const positions = traj.positions[Math.min(index, traj.positions.length - 1)];
    renderer.setPositions(positions);

    const atomCount = positions.length / 3;
    count += atomCount;

    for (let i = 0; i < atomCount; ++i) {
      pos.fromArray(positions, i * 3);
      sum.add(pos);
    }
  }

  // recenter
  sum.divideScalar(count);
  sum.multiply(objects.scale);

  cameraControls.target = sum;
  cameraControls.update();
}

function animate() {
  const dt = Math.min(1/15, frameClock.getDelta());

  const max = Math.max(1, ...pairs.map(({ traj }) => traj.positions.length));

  frameSeek.max(max);

  if (framePlay.getValue()) {
    frameTimer += dt;
    if (frameTimer > 1/30) {
      frameTimer -= 1/30;
      frameSeek.setValue((frameSeek.getValue() + 1) % max);
    }
  } else {
    frameTimer = 0;
  }

  if (pairs.length > 0) {
    frame_positions_index(frameSeek.getValue());
  }

  stats.begin()

updateXRUI(
    dt,
    renderer.xr.isPresenting,
    renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, 
    panelRot,
    frameSeek.getValue(),
    max
);

  updateWebUI(frameSeek.getValue(), max);

  if (!renderer.xr.isPresenting && resizeRendererToDisplaySize(renderer)) {
    const canvas = renderer.domElement
    camera.aspect = canvas.clientWidth / canvas.clientHeight
    camera.updateProjectionMatrix()
  }

  cameraControls.update()
  
  renderer.render(scene, camera)
  stats.end()

  // panel positioning
  if (renderer.xr.isPresenting) {
    ui_hover(renderer.xr.getController(0));
    ui_hover(renderer.xr.getController(1));
    ui_hover(renderer.xr.getHand(0));
    ui_hover(renderer.xr.getHand(1));

 if (grippingControllers.length >= 2) {
      const c1 = grippingControllers[0];
      const c2 = grippingControllers[1];
      const p1 = c1.getWorldPosition(new Vector3());
      const p2 = c2.getWorldPosition(new Vector3());
      
      const currDist = p1.distanceTo(p2);
      const currCenter = p1.clone().lerp(p2, 0.5);

      if (grabState.active) {
        // NewPos = Center + (OldPos - PrevCenter) * Ratio
        
        const ratio = currDist / grabState.prevDist;
        const delta = currCenter.clone().sub(grabState.prevCenter);
        objects.position.add(delta);

        const dir = objects.position.clone().sub(currCenter);
        objects.position.copy(currCenter).add(dir.multiplyScalar(ratio));
        objects.scale.multiplyScalar(ratio);

      } else {
        grabState.active = true;
      }

      grabState.prevDist = currDist;
      grabState.prevCenter.copy(currCenter);
      grabState.count = 2;

    } else {
      grabState.active = false;
    }

    // xr ray pointers update
    for (const { pointer, rayLine } of xrPointers) {
      pointer.move(scene, { timeStamp: performance.now() });
      
      const intersection = pointer.getIntersection();
      rayLine.visible = true;
      if (intersection?.object) {
        rayLine.scale.z = Math.min(intersection.distance, 2);
      } else {
        rayLine.scale.z = 0.15; 
      }
    }

    // update active molecule interactions
    for (const [controller] of activeInteractions) {
      if (onInteractionUpdate) {
        onInteractionUpdate(controller);
      }
    }

    if (calibAnchor) {
      const frame = renderer.xr.getFrame();
      const pose = frame.getPose(calibAnchor.anchorSpace, renderer.xr.getReferenceSpace()!)!;
      
      calibratedSpace.position.copy(pose.transform.position);
      calibratedSpace.rotation.setFromQuaternion(new Quaternion().copy(pose.transform.orientation));
      calibratedSpace.scale.x = -1;
    }
  } else {
    for (const { rayLine } of xrPointers) {
      rayLine.visible = false;
    }
  }
}