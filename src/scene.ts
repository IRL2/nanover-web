import GUI, { Controller } from 'lil-gui'
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
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

function ui_hover(group: Group<WebXRSpaceEventMap>) {
  const p = new Vector3();
  const c = new Vector3();
  group.userData ??= {};
  group.userData.hovered?.exit();
  group.userData.hovered = undefined;

  group.getWorldPosition(c);

  for (const button of buttons) {
    button.face.getWorldPosition(p);
    const d = p.distanceTo(c);
    const close = d < .075;

    if (close) group.userData.hovered = button;
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
        console.log("SELECT", grip.userData.name, grip.userData.hovered);
        grip.userData.hovered?.onclick();
      });
    }

    const controllerModelFactory = new XRControllerModelFactory();
    const controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    const controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);
    
    const hand1 = renderer.xr.getHand(0);
    hand1.add(new OculusHandModel(hand1));
    scene.add(hand1);
    
    const hand2 = renderer.xr.getHand(1);
    hand2.add(new OculusHandModel(hand2));
    scene.add(hand2);

    add_clicker(renderer.xr.getController(0), "left controller");
    add_clicker(renderer.xr.getController(1), "right controller");

    add_clicker(hand1, "left hand");
    add_clicker(hand2, "right hand");
  }

  // ===== 📈 STATS & CLOCK =====
  {
    stats = new Stats()
    document.body.appendChild(stats.dom)

    document.body.appendChild(XRButton.createButton(renderer, { optionalFeatures: ["anchors", "hand-tracking"] }));
  }

  // ==== 🐞 DEBUG GUI ====
  {
    const websocketWorker = new Worker(new URL("nanover/workers/websocket-worker.ts", import.meta.url), { type: "module" });
    const framesChannel = new MessageChannel();

    gui = new GUI({ title: '🐞 Debug GUI', width: 300 })

    function connect(host: string) {
      websocketWorker.postMessage({ port: framesChannel.port2, host }, { transfer: [framesChannel.port2] });
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

    framesChannel.port1.addEventListener("message", (event) => {
      const { frame } = event.data as import("./nanover/workers/websocket-worker").SendMessageData;

      if (frame.topology) {
        const atomCount = frame.topology.elements.length;
        const colors = new Float32Array(atomCount * 3);
        for (let j = 0; j < atomCount; ++j) {
          make_color({ topology: frame.topology }, j);
          c.toArray(colors, j * 3);
        }

        live.setData(
          new Array(atomCount * 3),
          colors,
          frame.topology.bonds,
        );
      }

      if (frame.positions) {
        live.setPositions(frame.positions);
      }

      if (frame.box) {
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

      if (frame.state) {
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

        for (const [key, value] of Object.entries(frame.state)) {
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
    framesChannel.port1.start();

    const refresh = () => {
      const test = fetch("https://irl-discovery.onrender.com/list").then((r) => r.json());
      servers.destroy();
      servers = discoveryFolder.addFolder("Servers");

      test.then((list) => {
        if (list.length > 0) {
          console.log(list);
          for (const [ , data ] of list) {
            servers.add({ click: () => connect(data.endpoint) }, "click").name(data.name);
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

    loadTrajectories(trajpaths[2].paths);

    // persist GUI state in local storage on changes
    gui.onFinishChange(() => {
      const guiState = gui.save()
      localStorage.setItem('guiState', JSON.stringify(guiState))
    })

    // load GUI state if available in local storage
    const guiState = localStorage.getItem('guiState')
    if (guiState) gui.load(JSON.parse(guiState))

    // reset GUI state button
    const resetGui = () => {
      localStorage.removeItem('guiState')
      gui.reset()
    }
    gui.add({ resetGui }, 'resetGui').name('RESET')
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

  if (resizeRendererToDisplaySize(renderer)) {
    const canvas = renderer.domElement
    camera.aspect = canvas.clientWidth / canvas.clientHeight
    camera.updateProjectionMatrix()
  }

  cameraControls.update()
  
  renderer.render(scene, camera)
  stats.end()

  panel.visible = renderer.xr.isPresenting;

  if (renderer.xr.isPresenting) {
    const camera = renderer.xr.getCamera();
    panelRot.position.copy(camera.position).y -= .35;

    const forward = new Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.multiplyScalar(-1);
    panelRot.lookAt(forward.clone().add(panelRot.position));
    panel.rotation.x = Math.PI * .25;
    panelRot.position.addScaledVector(forward, -.35);

    ui_hover(renderer.xr.getController(0));
    ui_hover(renderer.xr.getController(1));
    ui_hover(renderer.xr.getHand(0));
    ui_hover(renderer.xr.getHand(1));
  }

  if (renderer.xr.isPresenting && calibAnchor) {
    const frame = renderer.xr.getFrame();
    const pose = frame.getPose(calibAnchor.anchorSpace, renderer.xr.getReferenceSpace()!)!;
    
    calibratedSpace.position.copy(pose.transform.position);
    calibratedSpace.rotation.setFromQuaternion(new Quaternion().copy(pose.transform.orientation));
    calibratedSpace.scale.x = -1;
  }
}
