import GUI from 'lil-gui'
import {
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  IcosahedronGeometry,
  LoadingManager,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
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
    // renderer.xr.addEventListener("sessionstart", enter_xr);
    // renderer.xr.addEventListener("sessionend", exit_xr);
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
    objects = new Object3D();
    scene.add(objects);
  }

  const trajLoaderChannel = new MessageChannel();
  {
    const trajLoaderWorker = new Worker(new URL("nanover/workers/traj-loader-worker.js", import.meta.url), { type: "module" });
    trajLoaderWorker.postMessage({ port: trajLoaderChannel.port2 }, { transfer: [trajLoaderChannel.port2] });

    const elementColors = new Map([
      [1, new Color("white")],
      [6, new Color("black")],
      [7, new Color("blue")],
      [8, new Color("red")],
    ]);

    const c = new Color();
    function make_color(traj: TestTrajectory, i: number) {
      c.setHSL((i / traj.topology.elements.length) + Math.random() * .1, .25, .5);
      c.lerp(elementColors.get(traj.topology.elements[i]) ?? c, .65);
      return c
    }

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

    document.body.appendChild(XRButton.createButton(renderer));
  }

  // ==== 🐞 DEBUG GUI ====
  {
    gui = new GUI({ title: '🐞 Debug GUI', width: 300 })

    const refresh = () => {
      const test = fetch("https://irl-discovery.onrender.com/list").then((r) => r.json());

      test.then((list) => {
        servers.destroy();
        servers = discoveryFolder.addFolder("Servers");

        if (list.length > 0) {
          servers.add({ click: () => { } }, "click").name("TEST");
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

    const discoveryFolder = gui.addFolder("Discovery");
    discoveryFolder.add({ refresh }, "refresh").name("Refresh");
    let servers = discoveryFolder.addFolder("Servers");

    const trajectoryFolder = gui.addFolder("Trajectories");
    for (const { name, paths } of trajpaths) {
      function load() {
        for (const { renderer } of pairs) {
          renderer.removeFromParent();
        }
        pairs.length = 0;

        for (let path of paths) {
          path = "/data/" + path;
          trajLoaderChannel.port1.postMessage({ path });
        }
      }

      trajectoryFolder.add({ load }, "load").name(name);
    }

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

    gui.close()
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

  objects.position.set(0, 1, 0).sub(sum);
  cameraControls.update();
}

function animate() {
  const max = Math.max(0, ...pairs.map(({ traj }) => traj.positions.length));
  const frame = Math.floor((performance.now() / 1000 * 30 * 3) % max);

  if (pairs.length > 0) {
    frame_positions_index(frame);
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
}
