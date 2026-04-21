import {
  BoxGeometry,
  DoubleSide,
  EdgesGeometry,
  Matrix3,
  Object3D,
  Quaternion,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import NaiveRenderer from './nanover/NaiveRenderer';
import { AvatarRendering } from './avatar-rendering';
import { InteractionManager, InteractionUpdate } from './interaction-manager';
import { normalizeLivePayload } from './live-frame-state';
import {
  CommandRequestData,
  CommandResponseData,
  SendMessageData as WorkerSendMessageData,
} from './nanover/workers/websocket-worker';
import { buildAtomColors } from './trajectory-loader';

interface NetworkClientOptions {
  objects: Object3D;
  cameraControls: OrbitControls;
  liveRenderer: NaiveRenderer;
  avatarRendering: AvatarRendering;
  interactionManager: InteractionManager;
}

type SharedStateUpdate = {
  updates?: Record<string, unknown>;
  removals?: string[];
};

const BOX_EDGE_WIDTH_PX = 3;

export class NetworkClient {
  private readonly objects: Object3D;
  private readonly cameraControls: OrbitControls;
  private readonly liveRenderer: NaiveRenderer;
  private readonly avatarRendering: AvatarRendering;
  private readonly interactionManager: InteractionManager;
  private readonly worker: Worker;
  private readonly channel = new MessageChannel();

  private readonly boxEdgesGeometry = new LineSegmentsGeometry();
  private readonly boxEdgesMaterial = new LineMaterial({
    color: 'orange',
    transparent: true,
    opacity: 0.9,
    linewidth: BOX_EDGE_WIDTH_PX,
    resolution: new Vector2(1, 1),
    side: DoubleSide,
  });
  private readonly boxEdges = new LineSegments2(this.boxEdgesGeometry, this.boxEdgesMaterial);
  private readonly sharedState: Record<string, unknown> = {};
  private readonly pendingCommands = new Map<number, (value: unknown) => void>();
  private nextCommandId = 1;
  
  private readonly scenePosition = new Vector3();
  private readonly sceneRotation = new Quaternion();
  private readonly sceneScale = new Vector3();

  private readonly boxMatrix = new Matrix3();
  private readonly boxAxisX = new Vector3();
  private readonly boxAxisY = new Vector3();
  private readonly boxAxisZ = new Vector3();
  private readonly boxSize = new Vector3();
  private readonly boxHalfSize = new Vector3();
  private readonly boxResolution = new Vector2();

  constructor(options: NetworkClientOptions) {
    this.objects = options.objects;
    this.cameraControls = options.cameraControls;
    this.liveRenderer = options.liveRenderer;
    this.avatarRendering = options.avatarRendering;
    this.interactionManager = options.interactionManager;

    this.boxEdges.visible = false;
    this.boxEdges.frustumCulled = false;
    this.boxEdges.onBeforeRender = (renderer) => {
      const webglRenderer = renderer as WebGLRenderer;
      webglRenderer.getDrawingBufferSize(this.boxResolution);
      this.boxEdgesMaterial.resolution.copy(this.boxResolution);
    };
    this.updateBoxEdgeResolution();
    window.addEventListener('resize', this.updateBoxEdgeResolution);
    this.objects.add(this.boxEdges);

    this.worker = new Worker(new URL('nanover/workers/websocket-worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ port: this.channel.port2 }, { transfer: [this.channel.port2] });
    this.channel.port1.addEventListener('message', this.onWorkerMessage);
    this.channel.port1.start();
  }

  connect(host: string) {
    this.worker.postMessage({ host });
  }

  sendInteractionUpdate(interactionId: string, interaction: InteractionUpdate | null) {
    const state: SharedStateUpdate = interaction === null
      ? { removals: [`interaction.${interactionId}`] }
      : {
          updates: {
            [`interaction.${interactionId}`]: {
              position: interaction.position,
              particles: interaction.particles,
              interaction_type: interaction.interaction_type ?? 'spring',
              scale: interaction.scale ?? 100,
              mass_weighted: interaction.mass_weighted ?? true,
            },
          },
        };

    this.channel.port1.postMessage({ state });
  }

  runCommand(name: string, args?: object): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      const request: CommandRequestData = {
        id: this.nextCommandId,
        name,
      };

      if (args) {
        request.arguments = args;
      }

      this.nextCommandId += 1;
      this.pendingCommands.set(request.id, resolve);
      this.channel.port1.postMessage({ command: { request } });
    });
  }

  private onWorkerMessage = (event: MessageEvent<WorkerSendMessageData>) => {
    const message = event.data;
    const normalized = normalizeLivePayload(message, this.sharedState);

    this.resolveCommands(message.command ?? []);

    if (normalized.elements && normalized.bonds) {
      const colors = buildAtomColors(normalized.elements);
      this.liveRenderer.setData(
        new Array(normalized.elements.length * 3),
        colors,
        normalized.bonds,
      );
    }

    if (normalized.positions) {
      this.liveRenderer.setPositions(normalized.positions);
      this.interactionManager.setCurrentPositions(normalized.positions);
    }

    if (normalized.box) {
      this.updateBoxGeometry(normalized.box);
    }

    if (!normalized.hasStateUpdate) {
      return;
    }

    if (!normalized.state) {
      return;
    }

    this.applySceneState(normalized.state.scene);
    this.avatarRendering.render(normalized.state.avatars);
    this.interactionManager.renderRemoteInteractions(normalized.state.interactions, normalized.positions);
  };

  private resolveCommands(commands: CommandResponseData[]) {
    for (const response of commands) {
      const resolve = this.pendingCommands.get(response.request.id);
      if (!resolve) {
        continue;
      }

      this.pendingCommands.delete(response.request.id);
      resolve(response.response);
    }
  }

  private applySceneState(scene: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  } | undefined) {
    if (!scene) {
      return;
    }

    this.scenePosition.fromArray(scene.position);
    this.sceneRotation.fromArray(scene.rotation);
    this.sceneScale.fromArray(scene.scale);
    this.sceneScale.x *= -1;

    this.objects.position.copy(this.scenePosition);
    this.objects.rotation.setFromQuaternion(this.sceneRotation);
    this.objects.scale.copy(this.sceneScale);

    this.cameraControls.target.copy(this.objects.position);
    this.cameraControls.target.addScaledVector(this.objects.scale, -0.5);
    this.cameraControls.update();
  }

  private updateBoxGeometry(box: Float32Array) {
    if (box.length < 9) {
      return;
    }

    this.boxMatrix.set(
      box[0], box[1], box[2],
      box[3], box[4], box[5],
      box[6], box[7], box[8],
    );

    this.boxMatrix.extractBasis(this.boxAxisX, this.boxAxisY, this.boxAxisZ);
    this.boxSize.set(this.boxAxisX.length(), this.boxAxisY.length(), this.boxAxisZ.length());
    this.boxHalfSize.copy(this.boxSize).multiplyScalar(0.5);

    const boxGeometry = new BoxGeometry(this.boxSize.x, this.boxSize.y, this.boxSize.z);
    boxGeometry.translate(this.boxHalfSize.x, this.boxHalfSize.y, this.boxHalfSize.z);
    const edgesGeometry = new EdgesGeometry(boxGeometry);
    const edgePositions = edgesGeometry.attributes.position.array;
    this.boxEdgesGeometry.setPositions(
      edgePositions instanceof Float32Array
        ? edgePositions
        : Float32Array.from(edgePositions as ArrayLike<number>),
    );
    this.boxEdgesGeometry.computeBoundingSphere();
    edgesGeometry.dispose();
    boxGeometry.dispose();

    this.boxEdges.visible = true;
  }

  private updateBoxEdgeResolution = () => {
    this.boxEdgesMaterial.resolution.set(
      window.innerWidth * window.devicePixelRatio,
      window.innerHeight * window.devicePixelRatio,
    );
  };
}
