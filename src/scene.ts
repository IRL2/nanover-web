import GUI, { Controller } from 'lil-gui'
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
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
import Button from './scrap/button'
import { CommandRequestData } from './nanover/workers/websocket-worker'

import { GDrivePicker } from './helpers/gdrive-picker';

import { Container, reversePainterSortStable, Text as UIText } from '@pmndrs/uikit';
import { Slider } from '@pmndrs/uikit-default';
import { createRayPointer, Pointer } from '@pmndrs/pointer-events';

import jsQR from 'jsqr';

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
let panel: Object3D;
let panelRot: Object3D;
let sliderHandle: Button;
let range: number;
let recenter = () => {};

let buttons: Button[] = [];

// UIKit root container
let controlPanel: Container | undefined;
let uikitButtons: { container: Container, onClick: () => void, originalColor: number }[] = [];
let playButtonText: UIText | undefined;
let showPanelInDesktop = false;
let uikitSlider: Slider | undefined;

let xrPointers: { pointer: Pointer, controller: Group, rayLine: Mesh }[] = [];
function ui_hover(group: Group<WebXRSpaceEventMap>) {
  const p = new Vector3();
  const c = new Vector3();
  group.userData ??= {};
  group.userData.hovered?.exit();
  group.userData.hovered = undefined;
  group.userData.hoveredUIKit = undefined;

  group.getWorldPosition(c);

  for (const button of buttons) {
    button.face.getWorldPosition(p);
    const d = p.distanceTo(c);
    const close = d < .075;

    if (close) group.userData.hovered = button;
  }

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

const avatars = new InstancedMesh(new BoxGeometry(), new MeshLambertMaterial(), 64);
avatars.boundingSphere = new Sphere(new Vector3(), 100);
avatars.count = 0;
const interactions = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial({ color: "green" }), 64);
interactions.boundingSphere = new Sphere(new Vector3(), 100);
interactions.count = 0;

const frameClock = new Clock();

const pairs: { traj: TestTrajectory, renderer: NaiveRenderer }[] = [];

// Initialize UIKit
function initUIKit() {
  //  root container control panel
  controlPanel = new Container({
    sizeX: 0.9,
    sizeY: 0.35,
    flexDirection: "column",
    backgroundColor: 0x1a1a1a,
    padding: 2,
    gap: 5,
    borderRadius: 2,
  });

  controlPanel.position.set(0, 0, 0);
  panelRot.add(controlPanel);

  // button container (horizontal row)
  const buttonRow = new Container({
    flexDirection: "row",
    gap: 3,
    justifyContent: "center",
    alignItems: "center",
  });

  // custom button container
  function createUIButton(label: string, color: number, onClick: () => void) {
    const btn = new Container({
      width: 20,
      height: 10,
      backgroundColor: color,
      borderRadius: 2,
      justifyContent: "center",
      alignItems: "center",
      cursor: "pointer",
      pointerEvents: "auto",
    });

    const btnText = new UIText({
      fontSize: 3,
      color: 0xffffff,
      anchorX: "center",
      anchorY: "middle",
    });
    
    btnText.setProperties({ text: label } as any);

    btn.add(btnText);
    
    // pointer event listeners for raycasting
    btn.addEventListener('click', onClick);
    btn.addEventListener('pointerenter', () => {
      btn.setProperties({ backgroundColor: color + 0x303030 });
    });
    btn.addEventListener('pointerleave', () => {
      btn.setProperties({ backgroundColor: color });
    });
    
    uikitButtons.push({ container: btn, onClick, originalColor: color });

    return btn;
  }

  const prevBtn = createUIButton("<", 0x444444, () => frameSeek.setValue(frameSeek.getValue()-1));
  const playBtn = createUIButton("PLAY", 0x2196F3, () => {
    framePlay.setValue(!framePlay.getValue());

    if (playButtonText) {
      playButtonText.setProperties({ text: framePlay.getValue() ? "PAUSE" : "PLAY" } as any);
    }
  });
  const nextBtn = createUIButton(">", 0x444444, () => frameSeek.setValue(frameSeek.getValue()+1));
  const resetBtn = createUIButton("RESET", 0x666666, () => frameSeek.setValue(0));
  const centerBtn = createUIButton("CENTER", 0x666666, () => recenter());
  
  playButtonText = playBtn.children[0] as UIText;

  buttonRow.add(prevBtn, playBtn, nextBtn, resetBtn, centerBtn);

  // UIKit default Slider component
  uikitSlider = new Slider();
  uikitSlider.setProperties({
    width: "100%",
    value: 0,
    min: 0,
    max: 1,
    step: 1,
    pointerEvents: "auto",
    onValueChange: (value: number) => {
      console.log("Slider value changed:", value, "frameSeek:", frameSeek);
      if (frameSeek) {
        framePlay.setValue(false); // stop playback when user drags
        frameSeek.setValue(Math.round(value));
      }
    },
  } as any);

// Make thumb smaller (default is 20x20)
if (uikitSlider.thumb) {
  uikitSlider.thumb.setProperties({
    borderColor: 0x888888,
    height: 12,
    width: 12,
    transformTranslateX: -6,
    transformTranslateY: -4,
  } as any);
}

if (uikitSlider.track) {
  uikitSlider.track.setProperties({
    height: 4,
  } as any);
}

  controlPanel.add(buttonRow, uikitSlider);
}

init()

function init() {
  // ===== 🖼️ CANVAS, RENDERER, & SCENE =====
  {
    canvas = document.querySelector(`canvas#${CANVAS_ID}`)!
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
    }

    function exit_xr() {

    }

    function onSelect(event: XRInputSourceEvent) {
      let frame = event.frame;

      // skip calib
      return;
      // if (session.enabledFeatures?.includes("anchors")) return;

      const clickPose = event.frame.getPose(
        event.inputSource.targetRaySpace,
        renderer.xr.getReferenceSpace()!,
      )!;

      const support = renderer.xr.getSession()?.enabledFeatures?.includes("anchors");

      const next = new Mesh(
        new CylinderGeometry(),
        new MeshBasicMaterial({ color: support ? "green" : "red" }),
      );
      next.position.copy(clickPose.transform.position);
      next.position.y = 0.05;
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
          next.position.y = 0.05;
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
    avatars.geometry = (data.children[0] as any).geometry;
    avatars.geometry.rotateX(-Math.PI * .5);
  });

  // ===== 📦 OBJECTS =====
  {
    scene.add(calibratedSpace);
    calibratedSpace.add(avatars);
    objects = new Object3D();
    calibratedSpace.add(objects);
    live = new NaiveRenderer();
    objects.add(live);
    objects.add(interactions);
  }

  panelRot = new Object3D();
  panel = new Object3D();
  panelRot.add(panel);
  scene.add(panelRot);

  function make_button(label: string, onclick = () => {}) {
    const button = new Button(label);
    button.onclick = onclick;
    button.scale.multiplyScalar(.05);
    return button;
  }

  const playButton = make_button("PLAY", () => framePlay.setValue(!framePlay.getValue()));
  const resetButton = make_button("RESET", () => frameSeek.setValue(0));
  const centerButton = make_button("CENTER", () => recenter());
  const prevButton = make_button("<", () => frameSeek.setValue(frameSeek.getValue()-1));
  const nextButton = make_button(">", () => frameSeek.setValue(frameSeek.getValue()+1));

  buttons.push(playButton, prevButton, centerButton, nextButton, resetButton);
  const gap = 0.125;
  range = (buttons.length-1) * gap;
  
  let offset = -range * .5;

  for (const button of buttons) {
    panel.add(button);
    button.position.x = offset;
    offset += gap;
  }

  sliderHandle = new Button("");
  sliderHandle.scale.multiplyScalar(.04);

  const sliderTrack = new Mesh(
    new CapsuleGeometry(.02, range + gap).rotateZ(Math.PI * .5),
    new MeshBasicMaterial({ color: 0x333333 }),
  );
  sliderTrack.position.set(0, 0, -.1);
  panel.add(sliderTrack);
  sliderTrack.add(sliderHandle);

  buttons.push(playButton, resetButton, sliderHandle);

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
      });

      //button release
      controller.addEventListener('selectend' as any, () => {
        pointer.up({ timeStamp: performance.now(), button: 0 });
      });

      xrPointers.push({ pointer, controller, rayLine: rayMesh });
    }

    setupRayPointer(controller1);
    setupRayPointer(controller2);
  }

  // ===== 📈 STATS & CLOCK =====
  {
    stats = new Stats()
    document.body.appendChild(stats.dom)

    document.body.appendChild(XRButton.createButton(renderer, { optionalFeatures: ["anchors", "hand-tracking"] }));
  }

  // ===== UIKit Setup =====
  initUIKit();

  // ==== 🐞 DEBUG GUI ====
  {
    const websocketWorker = new Worker(new URL("nanover/workers/websocket-worker.ts", import.meta.url), { type: "module" });
    const websocketChannel = new MessageChannel();

    gui = new GUI({ title: '🐞 Debug GUI', width: 300 })
    
    const uikitFolder = gui.addFolder("UIKit Debug");
    uikitFolder.add({ showInDesktop: showPanelInDesktop }, "showInDesktop").name("Show Panel in Desktop").onChange((value: boolean) => {
      showPanelInDesktop = value;
    });
    uikitFolder.open();

    function connect(host: string) {
      websocketWorker.postMessage({ port: websocketChannel.port2, host }, { transfer: [websocketChannel.port2] });
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
      }

      if (frame?.box) {
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

        // objects.position.set(0, 1, 0);
        // const test = new Vector3();
        // boxMesh.getWorldPosition(test);
        // objects.position.sub(scale.multiplyScalar(objects.scale.x));
        // objects.position.sub(test).y += 1;
      }

      if (frame?.state) {
        avatars.count = 0;
        avatars.instanceMatrix.needsUpdate = true;
        if (avatars.instanceColor) avatars.instanceColor.needsUpdate = true;
        interactions.count = 0;
        interactions.instanceMatrix.needsUpdate = true;

        for (const text of texts) {
          text.dispose();
          text.removeFromParent();
        }
        texts.clear();

        if (frame.state.scene) {
          t.fromArray(frame.state.scene, 0);
          r.fromArray(frame.state.scene, 3);
          s.fromArray(frame.state.scene, 7);
          s.x *= -1;

          objects.position.copy(t);
          objects.rotation.setFromQuaternion(r);
          objects.scale.copy(s);

          cameraControls.target.copy(objects.position);
          cameraControls.target.addScaledVector(objects.scale, -.5);
          cameraControls.update();
        }

        for (const [key, value] of Object.entries(frame?.state)) {
          if (key.startsWith("interaction.") && frame.positions) {
            t.fromArray(frame.positions, (value as any).particles[0] * 3);
            r.identity();
            s.set(.1, .1, .1);
            m.compose(t, r, s);
            interactions.setMatrixAt(interactions.count, m);
            interactions.count += 1;
          }

          if (key.startsWith("avatar.")) {
            c2.fromArray((value as any).color);
            for (const component of (value as any).components) {
              // const id = `${key}.${component.name}`;
              t.fromArray(component.position);
              r.fromArray(component.rotation);
              s.set(.05, .05, .05);
              m.compose(t, r, s);
              avatars.setMatrixAt(avatars.count, m);
              avatars.setColorAt(avatars.count, c2);
              avatars.count += 1;

              const myText = new Text();
              scene.add(myText);

              // Set properties to configure:
              myText.text = (value as any).name;
              myText.fontSize = 0.05;
              myText.position.copy(t).y += 0.1;
              myText.color = "#" + c2.getHexString();
              myText.anchorX = "center";
              myText.anchorY = "bottom";
              myText.lookAt(camera.position);

              // Update the rendering:
              myText.sync()
              texts.add(myText);
            }
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

    function loadTrajectories(paths: string[]) {
      for (const { renderer } of pairs) {
        renderer.removeFromParent();
      }
      pairs.length = 0;

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

    const discoveryFolder = gui.addFolder("Discovery");
    discoveryFolder.add({ refresh }, "refresh").name("Refresh");
    let servers = discoveryFolder.addFolder("Servers");

    const trajectoryFolder = gui.addFolder("Trajectories");
    for (const { name, paths } of trajpaths) {
      trajectoryFolder.add({ load: () => loadTrajectories(paths) }, "load").name(name);
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
    const qrFolder = gui.addFolder("QR Code Scanner");
    const qrState = {
      enabled: false,
      lastResult: "No QR detected yet",
    };

    let qrVideo: HTMLVideoElement | null = null;
    let qrCanvas: HTMLCanvasElement | null = null;
    let qrContext: CanvasRenderingContext2D | null = null;
    let qrOverlay: HTMLDivElement | null = null;
    let qrStream: MediaStream | null = null;
    let isScanningQR = false;
    let detectedUrl = "";

    const resultController = qrFolder.add(qrState, "lastResult").name("Result").listen();
    
    const loadScannedFile = async () => {
      if (!detectedUrl) return;
      console.log("Processing scanned URL:", detectedUrl);
      
      try {
        loadButtonController.name("Downloading...");
        
        // github url parcer to avoid cors issues
        let fetchUrl = detectedUrl;
        const githubRegex = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/;
        const match = detectedUrl.match(githubRegex);
        
        if (match) {
          fetchUrl = `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`;
          console.log("Converted GitHub URL to:", fetchUrl);
        }
        
        let arrayBuffer: ArrayBuffer | null = null;

        try {
          const response = await fetch(fetchUrl);
          if (!response.ok) throw new Error("Status: " + response.status);
          arrayBuffer = await response.arrayBuffer();
        } catch (err) {
          console.warn("Direct fetch failed", err);
          
        }
        
        if (!arrayBuffer) throw new Error("Empty response");

        const filename = detectedUrl.split('/').pop()?.split('?')[0] || "scanned_file.traj";
        
        // clear existing trajectories
        for (const { renderer } of pairs) {
          renderer.removeFromParent();
        }
        pairs.length = 0;
        
        // send to loader worker
        trajLoaderChannel.port1.postMessage({
          arrayBuffer: arrayBuffer,
          filename: filename
        }, [arrayBuffer]);
        
        loadButtonController.name("Loaded!");
        setTimeout(() => loadButtonController.name("Load Scanned URL"), 2000);
        
        
        qrState.enabled = false;
        enableController.updateDisplay();
        stopQRScanner();
        
      } catch (err) {
        console.error("Failed to load file from QR:", err);
        loadButtonController.name("Failed (See Console)");
        setTimeout(() => loadButtonController.name("Load Scanned URL"), 3000);
      }
    };

    const loadButtonController = qrFolder.add({ load: loadScannedFile }, "load").name("Load Scanned URL").disable();
    const enableController = qrFolder.add(qrState, "enabled").name("Enable Scanner").onChange((enabled: boolean) => {
      if (enabled) {
        startQRScanner();
      } else {
        stopQRScanner();
      }
    });

    function drawQRLine(begin: {x: number, y: number}, end: {x: number, y: number}, color: string) {
      if (!qrContext) return;
      qrContext.beginPath();
      qrContext.moveTo(begin.x, begin.y);
      qrContext.lineTo(end.x, end.y);
      qrContext.lineWidth = 4;
      qrContext.strokeStyle = color;
      qrContext.stroke();
    }

    async function startQRScanner() {
      // simple overlay setup
      if (!qrOverlay) {
        qrOverlay = document.createElement("div");
        qrOverlay.style.position = "fixed";
        qrOverlay.style.bottom = "20px";
        qrOverlay.style.right = "20px";
        qrOverlay.style.width = "320px";
        qrOverlay.style.height = "240px";
        qrOverlay.style.backgroundColor = "black";
        qrOverlay.style.border = "2px solid white";
        qrOverlay.style.zIndex = "1000";
        qrOverlay.style.borderRadius = "8px";
        qrOverlay.style.overflow = "hidden";
        document.body.appendChild(qrOverlay);
      } else {
        qrOverlay.style.display = "block";
      }

      if (!qrVideo) {
        qrVideo = document.createElement("video");
        qrVideo.style.width = "100%";
        qrVideo.style.height = "100%";
        qrVideo.style.objectFit = "cover";
        qrOverlay.appendChild(qrVideo);
      }

      if (!qrCanvas) {
        qrCanvas = document.createElement("canvas");
        qrCanvas.style.position = "absolute";
        qrCanvas.style.top = "0";
        qrCanvas.style.left = "0";
        qrCanvas.style.width = "100%";
        qrCanvas.style.height = "100%";
        qrOverlay.appendChild(qrCanvas);
        qrContext = qrCanvas.getContext("2d");
      }

      try {
        qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (qrVideo) {
          qrVideo.srcObject = qrStream;
          qrVideo.setAttribute("playsinline", "true");
          qrVideo.play();
          isScanningQR = true;
          requestAnimationFrame(qrTick);
        }
      } catch (err) {
        console.error("Error accessing camera for QR scan:", err);
        qrState.enabled = false;
        qrState.lastResult = "Camera Error";
        enableController.updateDisplay();
      }
    }

    function qrTick() {
      if (!isScanningQR || !qrVideo || !qrCanvas || !qrContext) return;

      if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
        qrCanvas.height = qrVideo.videoHeight;
        qrCanvas.width = qrVideo.videoWidth;
        
        qrContext.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);
        
        const imageData = qrContext.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
        
      
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });

        if (code) {
        
          drawQRLine(code.location.topLeftCorner, code.location.topRightCorner, "#FF3B58");
          drawQRLine(code.location.topRightCorner, code.location.bottomRightCorner, "#FF3B58");
          drawQRLine(code.location.bottomRightCorner, code.location.bottomLeftCorner, "#FF3B58");
          drawQRLine(code.location.bottomLeftCorner, code.location.topLeftCorner, "#FF3B58");

          
          if (qrState.lastResult !== code.data) {
             qrState.lastResult = code.data;
             
             
             if (code.data.startsWith("http://") || code.data.startsWith("https://")) {
                detectedUrl = code.data;
                loadButtonController.enable();
             } else {
                detectedUrl = "";
                loadButtonController.disable();
             }
          }
        }
      }

      requestAnimationFrame(qrTick);
    }

    function stopQRScanner() {
      isScanningQR = false;
      if (qrStream) {
        qrStream.getTracks().forEach(track => track.stop());
        qrStream = null;
      }
      if (qrOverlay) {
        qrOverlay.style.display = "none";
      }
      loadButtonController.disable();
    }

    loadTrajectories(trajpaths[2].paths);
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

  const u = frameSeek.getValue() / max;
  sliderHandle.position.set(range * (u - .5), 0, 0);

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

  // Update UIKit control panel
  if (controlPanel) {
    controlPanel.update(dt * 1000);
    
    if (uikitSlider && max > 1) {
      uikitSlider.setProperties({ 
        max: max - 1,
        value: frameSeek.getValue() 
      } as any);
    }
  }

  if (!renderer.xr.isPresenting && resizeRendererToDisplaySize(renderer)) {
    const canvas = renderer.domElement
    camera.aspect = canvas.clientWidth / canvas.clientHeight
    camera.updateProjectionMatrix()
  }

  cameraControls.update()
  
  renderer.render(scene, camera)
  stats.end()

  panel.visible = false;
  if (controlPanel) {
    controlPanel.visible = renderer.xr.isPresenting || showPanelInDesktop;
  }

  // panel positioning
  if (renderer.xr.isPresenting) {
    const camera = renderer.xr.getCamera();
    panelRot.position.copy(camera.position);
    panelRot.position.y -= 0.6;

    const forward = new Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    panelRot.position.addScaledVector(forward, 0.8); 
    
    panelRot.lookAt(camera.position);
    if (controlPanel) {
      controlPanel.rotation.x = Math.PI * 0.15;
    }

    ui_hover(renderer.xr.getController(0));
    ui_hover(renderer.xr.getController(1));
    ui_hover(renderer.xr.getHand(0));
    ui_hover(renderer.xr.getHand(1));

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
  } else {
    for (const { rayLine } of xrPointers) {
      rayLine.visible = false;
    }
    
    if (showPanelInDesktop && controlPanel) {
    // Position panel in front of desktop camera for debugging
    panelRot.position.copy(camera.position);
    const forward = new Vector3();
    camera.getWorldDirection(forward);
    panelRot.position.addScaledVector(forward, 2);
    panelRot.lookAt(camera.position);
    if (controlPanel) {
      controlPanel.rotation.x = 0;
    }
  }

  if (renderer.xr.isPresenting && calibAnchor) {
    const frame = renderer.xr.getFrame();
    const pose = frame.getPose(calibAnchor.anchorSpace, renderer.xr.getReferenceSpace()!)!;
    
    calibratedSpace.position.copy(pose.transform.position);
    calibratedSpace.rotation.setFromQuaternion(new Quaternion().copy(pose.transform.orientation));
    calibratedSpace.scale.x = -1;
  }
}
}