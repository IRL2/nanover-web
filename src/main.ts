import GUI, { Controller } from 'lil-gui';
import {
  AmbientLight,
  BackSide,
  Clock,
  Color,
  DirectionalLight,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Stats from 'stats.js';
import { XRButton } from 'three/examples/jsm/webxr/XRButton.js';
import { OBJLoader } from 'three/examples/jsm/Addons.js';
import { reversePainterSortStable } from '@pmndrs/uikit';
import { toggleFullScreen } from './helpers/fullscreen';
import { resizeRendererToDisplaySize } from './helpers/responsiveness';
import './style.css';
import NaiveRenderer from './visuals/NaiveRenderer';
import {
  controlPanel,
  getColocationMode,
  setUserCommands,
  showPanelInDesktop,
  setConnectedToServer,
  setShowPanelInDesktop,
  setupXRUI,
  updateXRUI,
} from './ui/xrUI';
import { setupWebUI, updateWebUI } from './ui/webUI';
import { setupNotificationUI, showNotification, updateNotificationUI } from './ui/xrNotification';
import { AvatarRendering } from './visuals/avatar-rendering';
import { InteractionManager } from './tools/interaction-manager';
import { NetworkClient } from './io/network-client';
import { DEFAULT_TRAJECTORIES, TrajectoryLoader } from './io/trajectory-loader';
import { XRInputManager } from './xr/xrInput';
import { PrimitivesRenderer } from './visuals/primitives-renderer';

const CANVAS_ID = 'scene';

function getURLParam(param: string): string | null {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(param);
}

class SceneApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();

  private readonly camera: PerspectiveCamera;
  private readonly cameraControls: OrbitControls;

  private readonly stats = new Stats();
  private readonly frameClock = new Clock();

  private readonly calibratedSpace = new Object3D();
  private readonly objects = new Object3D();
  private readonly panelRot = new Object3D();
  private readonly live = new NaiveRenderer();
  private readonly trajectoryNameElement: HTMLElement | null;
  private readonly avatarRendering: AvatarRendering;

  private readonly interactionManager: InteractionManager;
  private readonly trajectoryLoader: TrajectoryLoader;
  private readonly networkClient: NetworkClient;
  private readonly primitivesRenderer: PrimitivesRenderer;

  private readonly xrInput: XRInputManager;
  
  private readonly recenterPosition = new Vector3();
  private readonly recenterDirection = new Vector3();

  private frameSeek!: Controller;
  private framePlay!: Controller;
  private frameTimer = 0;

  constructor() {
    this.canvas = document.querySelector(`canvas#${CANVAS_ID}`)!;
    this.trajectoryNameElement = document.getElementById('trajectory-name');

    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.renderer.localClippingEnabled = true;
    this.renderer.setTransparentSort(reversePainterSortStable);

    const threeScene = this.scene;
    threeScene.add(this.calibratedSpace);
    this.calibratedSpace.add(this.objects);
    this.objects.add(this.live);
    threeScene.add(this.panelRot);

    this.camera = new PerspectiveCamera(75, this.canvas.clientWidth / this.canvas.clientHeight, 0.1, 1000);
    this.camera.position.set(2, 2, 5);

    this.camera.add(new DirectionalLight(new Color(), Math.PI));
    threeScene.add(new AmbientLight(new Color(), 0.25 * Math.PI));
    threeScene.add(this.camera);

    this.cameraControls = new OrbitControls(this.camera, this.canvas);
    this.cameraControls.target.set(0, 1, 0);
    this.cameraControls.enableDamping = true;
    this.cameraControls.autoRotate = false;
    this.cameraControls.update();

    const skybox = new Mesh(
      new IcosahedronGeometry(),
      new MeshBasicMaterial({ color: 0x505050, transparent: true, opacity: 0.995, side: BackSide }),
    );
    skybox.scale.set(5, 5, 5);
    skybox.position.set(0, 1, 0);
    skybox.visible = false;
    threeScene.add(skybox);

    this.avatarRendering = new AvatarRendering({
      parent: this.calibratedSpace,
      camera: this.camera,
    });

    this.interactionManager = new InteractionManager({
      scene: threeScene,
      objects: this.objects,
    });

    this.trajectoryLoader = new TrajectoryLoader({
      objects: this.objects,
      updateTrajectoryName: this.updateTrajectoryName,
    });

    this.primitivesRenderer = new PrimitivesRenderer({
      root: this.calibratedSpace,
      simulation: this.objects,
      runCommand: (name, args) => this.networkClient.runCommand(name, args),
    });

    this.networkClient = new NetworkClient({
      objects: this.objects,
      cameraControls: this.cameraControls,
      liveRenderer: this.live,
      avatarRendering: this.avatarRendering,
      interactionManager: this.interactionManager,
      primitivesRenderer: this.primitivesRenderer,
    });

    setupNotificationUI(threeScene);
    this.networkClient.setNotificationHandler(showNotification);
    this.networkClient.setUserCommandsHandler(setUserCommands);

    this.interactionManager.setInteractionSender((interactionId, interaction) => {
      this.networkClient.sendInteractionUpdate(interactionId, interaction);
    });

    this.interactionManager.setHighlightRenderer(this.live);

    this.xrInput = new XRInputManager({
      renderer: this.renderer,
      scene: threeScene,
      camera: this.camera,
      objects: this.objects,
      panelRot: this.panelRot,
      calibratedSpace: this.calibratedSpace,
      interactionManager: this.interactionManager,
      getColocationMode,
    });
    this.xrInput.setRecenter(this.recenter);

    setupXRUI(this.panelRot, {
      getFrameSeek: () => this.frameSeek,
      getFramePlay: () => this.framePlay,
      recenter: this.recenter,
      publishSharedState: (updates, removals) => this.networkClient.setSharedState(updates, removals),
      runCommand: (name, args) => this.networkClient.runCommand(name, args),
    });

    setupWebUI({
      getFrameSeek: () => this.frameSeek,
      getFramePlay: () => this.framePlay,
      updateTrajectoryName: this.updateTrajectoryName,
      connectToServer: (host: string) => {
        this.networkClient.connect(host);
        this.trajectoryLoader.hideAll();
        this.framePlay.setValue(false);
        setConnectedToServer(true);
      },
    });

    const showDebug = getURLParam('debug') !== null;
    if (showDebug) {
      document.body.appendChild(this.stats.dom);
    }

    document.body.appendChild(XRButton.createButton(this.renderer, { optionalFeatures: ['anchors'] }));

    this.setupDebugGui(showDebug);

    const loader = new OBJLoader();
    loader.load(new URL('./data/circlet.obj', window.location.href).toString(), (data) => {
      const source = data.children[0] as Mesh;
      source.geometry.rotateX(-Math.PI * 0.5);
      this.avatarRendering.setHeadsetGeometry(source.geometry);
    });

    window.addEventListener('dblclick', this.onDoubleClick);
    this.renderer.setAnimationLoop(this.animate);
  }

  private updateTrajectoryName = (name: string) => {
    if (!this.trajectoryNameElement) {
      return;
    }

    this.trajectoryNameElement.textContent = name || 'No trajectory loaded';
  };

  private recenter = () => {
    const xrCamera = this.renderer.xr.getCamera();
    xrCamera.getWorldPosition(this.recenterPosition);
    xrCamera.getWorldDirection(this.recenterDirection);
    this.objects.position
      .copy(this.recenterPosition)
      .addScaledVector(this.recenterDirection, 1)
      .sub(this.cameraControls.target);
  };

  private onDoubleClick = (event: MouseEvent) => {
    if (event.target === this.canvas) {
      toggleFullScreen(this.canvas);
    }
  };

  private setupDebugGui(showDebug: boolean): GUI {
    const gui = new GUI({ title: '🐞 Debug GUI', width: 300 });
    if (!showDebug) {
      gui.hide();
    }

    const uikitFolder = gui.addFolder('UIKit Debug');
    uikitFolder
      .add({ showInDesktop: showPanelInDesktop }, 'showInDesktop')
      .name('Show Panel in Desktop')
      .onChange((value: boolean) => {
        setShowPanelInDesktop(value);
      });
    uikitFolder.open();

    const connect = (host: string) => {
      this.networkClient.connect(host);
      this.trajectoryLoader.hideAll();
      this.framePlay.setValue(false);
      setConnectedToServer(true);
    };

    const connectFolder = gui.addFolder('Direct');
    connectFolder.add({ connect: () => connect('wss://nanover-server-js.onrender.com') }, 'connect').name('Connect');

    const discoveryFolder = gui.addFolder('Discovery');
    let serversFolder = discoveryFolder.addFolder('Servers');
    const refresh = () => {
      void fetch('https://irl-discovery.onrender.com/list')
        .then((response) => response.json() as Promise<Array<{ info: { name: string; wss: string } }>>)
        .then((list) => {
          serversFolder.destroy();
          serversFolder = discoveryFolder.addFolder('Servers');
          if (list.length === 0) {
            serversFolder.close();
            return;
          }

          for (const { info } of list) {
            serversFolder.add({ click: () => connect(info.wss) }, 'click').name(info.name);
          }
          serversFolder.open();
        });
    };
    discoveryFolder.add({ refresh }, 'refresh').name('Refresh');

    const trajectoryFolder = gui.addFolder('Trajectories');
    for (const trajectory of DEFAULT_TRAJECTORIES) {
      trajectoryFolder
        .add(
          {
            load: () => this.trajectoryLoader.loadPaths(trajectory.paths, trajectory.name),
          },
          'load',
        )
        .name(trajectory.name);
    }

    this.frameSeek = trajectoryFolder.add({ frame: 0 }, 'frame', 0, 1, 1).name('Frame');
    this.framePlay = trajectoryFolder.add({ play: true }, 'play').name('Play');
    this.frameSeek.$widget.onpointerdown = () => this.framePlay.setValue(false);

    const simulationsFolder = gui.addFolder('Simulations');
    const commandsFolder = gui.addFolder('Commands');
    commandsFolder.add({ reset: () => this.networkClient.runCommand('playback/reset') }, 'reset').name('Reset');
    commandsFolder.add(
      {
        list: async () => {
          const result = await this.networkClient.runCommand('playback/list') as { simulations?: string[] };
          const simulations = Array.isArray(result.simulations) ? result.simulations : [];

          for (let i = 0; i < simulations.length; i += 1) {
            simulationsFolder.add(
              { load: () => this.networkClient.runCommand('playback/load', { index: i }) },
              'load',
            ).name(simulations[i]);
          }
        },
      },
      'list',
    ).name('List Sims');

    const trajUrl = getURLParam('traj');
    if (trajUrl) {
      void this.trajectoryLoader.loadFromUrl(trajUrl).catch((error: unknown) => {
        console.error('Failed to load trajectory from URL', error);
        this.updateTrajectoryName('Failed to load');
      });
    } else {
      const defaultTrajectory = DEFAULT_TRAJECTORIES[2];
      this.trajectoryLoader.loadPaths(defaultTrajectory.paths, defaultTrajectory.name);
    }

    return gui;
  }

  private animate = () => {
    const dt = Math.min(1 / 15, this.frameClock.getDelta());
    const maxFrames = this.trajectoryLoader.getMaxFrameCount();
    this.frameSeek.max(maxFrames);

    if (this.framePlay.getValue()) {
      this.frameTimer += dt;
      if (this.frameTimer > (1 / 30)) {
        this.frameTimer -= (1 / 30);
        this.frameSeek.setValue((this.frameSeek.getValue() + 1) % maxFrames);
      }
    } else {
      this.frameTimer = 0;
    }

    if (this.trajectoryLoader.hasTrajectories()) {
      this.trajectoryLoader.applyFrame(this.frameSeek.getValue(), this.cameraControls);
    }

    this.stats.begin();

    const activeCamera = this.renderer.xr.isPresenting
      ? (this.renderer.xr.getCamera() as unknown as PerspectiveCamera)
      : this.camera;

    updateXRUI(
      dt,
      this.renderer.xr.isPresenting,
      activeCamera,
      this.panelRot,
      this.frameSeek.getValue(),
      maxFrames,
      this.xrInput.controllers,
    );

    updateWebUI(this.frameSeek.getValue(), maxFrames);

    updateNotificationUI(
      dt,
      this.renderer.xr.isPresenting,
      activeCamera,
      this.xrInput.getRightController(),
    );

    this.primitivesRenderer.update(activeCamera);

    if (!this.renderer.xr.isPresenting && resizeRendererToDisplaySize(this.renderer)) {
      this.camera.aspect = this.canvas.clientWidth / this.canvas.clientHeight;
      this.camera.updateProjectionMatrix();
    }

    this.cameraControls.update();
    this.xrInput.update(controlPanel);
    this.networkClient.updateLocalState(this.xrInput.collectAvatarComponents(), this.xrInput.collectCursors());
    this.renderer.render(this.scene, this.camera);
    this.stats.end();
  };
}

new SceneApp();
