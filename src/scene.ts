import GUI, { Controller } from 'lil-gui'
import {
  AmbientLight,
  BackSide,
  BoxGeometry,
  Clock,
  Color,
  CylinderGeometry,
  DirectionalLight,
  IcosahedronGeometry,
  InstancedMesh,
  LineSegments,
  LoadingManager,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
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

const CANVAS_ID = 'scene'

let canvas: HTMLElement
let renderer: WebGLRenderer
let scene: Scene
let loadingManager: LoadingManager
let camera: PerspectiveCamera
let cameraControls: OrbitControls
let stats: Stats
let gui: GUI
let objects: Object3D
let live: NaiveRenderer;
let frameSeek: Controller;
let framePlay: Controller;
let frameTimer = 0.0;


const calibPoints: Mesh[] = [];
let calibAnchor: XRAnchor | undefined;

let calibratedSpace = new Object3D();

const avatars = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial({ color: "red" }), 64);
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

  // ===== 👨🏻‍💼 LOADING MANAGER =====
  {
    loadingManager = new LoadingManager()

    loadingManager.onStart = () => {
      console.log('loading started')
    }
    loadingManager.onProgress = (url, loaded, total) => {
      console.log('loading in progress:')
      console.log(`${url} -> ${loaded} / ${total}`)
    }
    loadingManager.onLoad = () => {
      console.log('loaded!')
    }
    loadingManager.onError = () => {
      console.log('❌ error while loading')
    }
  }

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

    const controllerModelFactory = new XRControllerModelFactory();
    const controllerGrip1 = renderer.xr.getControllerGrip(0);
    controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
    scene.add(controllerGrip1);

    const controllerGrip2 = renderer.xr.getControllerGrip(1);
    controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
    scene.add(controllerGrip2);
  }

  // ===== 📈 STATS & CLOCK =====
  {
    stats = new Stats()
    document.body.appendChild(stats.dom)

    document.body.appendChild(XRButton.createButton(renderer, { requiredFeatures: ["anchors"] }));
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
        interactions.count = 0;
        interactions.instanceMatrix.needsUpdate = true;

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
            for (const component of (value as any).components) {
              // const id = `${key}.${component.name}`;
              t.fromArray(component.position);
              r.fromArray(component.rotation);
              s.set(.05, .05, .05);
              m.compose(t, r, s);
              avatars.setMatrixAt(avatars.count, m);
              avatars.count += 1;
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
      { name: "Ludo GluHUTs", paths: ["ludo-gluhut-0.json", "ludo-gluhut-1.json", "ludo-gluhut-2.json", "ludo-gluhut-3.json", "ludo-gluhut-4.json", "ludo-gluhut-5.json", "ludo-gluhut-6.json"] },
      { name: "17-Alanine", paths: ["bucky-test.json"] },
      { name: "Nanotube", paths: ["webtraj.json"] },
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

    loadTrajectories(trajpaths[1].paths);

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

  // objects.position.set(0, 1, 0).sub(sum);
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

  if (resizeRendererToDisplaySize(renderer)) {
    const canvas = renderer.domElement
    camera.aspect = canvas.clientWidth / canvas.clientHeight
    camera.updateProjectionMatrix()
  }

  cameraControls.update()

  renderer.render(scene, camera)
  stats.end()

  if (renderer.xr.isPresenting && calibAnchor) {
    const frame = renderer.xr.getFrame();
    const pose = frame.getPose(calibAnchor.anchorSpace, renderer.xr.getReferenceSpace()!)!;
    
    calibratedSpace.position.copy(pose.transform.position);
    calibratedSpace.rotation.setFromQuaternion(new Quaternion().copy(pose.transform.orientation));
    calibratedSpace.scale.x = -1;
  }
}
