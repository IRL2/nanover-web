import {
  BoxGeometry,
  Color,
  DoubleSide,
  EdgesGeometry,
  Matrix3,
  Object3D,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import NaiveRenderer from '../visuals/NaiveRenderer';
import { AvatarRendering } from '../visuals/avatar-rendering';
import { InteractionManager, InteractionUpdate } from '../tools/interaction-manager';
import { LiveAvatarState, LiveInteractionState, normalizeLivePayload } from '../core/live-frame-state';
import { AvatarComponentsState } from '../core/avatar-state';
import { setForceType } from '../state';
import {
  CommandRegisterData,
  CommandRequestData,
  SendMessageData as WorkerSendMessageData,
  ServerCommandMessage,
} from './workers/websocket-worker';
import { buildAtomColors } from './trajectory-loader';
import {
  applyLiveSceneTransform,
  copySceneState,
  sceneStateChanged,
  SceneStateTuple,
  simulationToWorld,
  updateSceneMatrixWorld,
  writeSceneState,
} from '../core/scene-transform';

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

export type UserCommand = {
  name: string;
  label?: string;
  icon?: string;
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
  private readonly localAvatarId = this.createLocalAvatarId();
  private readonly localAvatarName = `WebXR`;
  private readonly localAvatarColor = this.createLocalAvatarColor();
  private readonly sceneCenter = new Vector3(0.5, 0.5, 0.5);
  private readonly sceneCenterWorld = new Vector3();
  private readonly currentSceneState: SceneStateTuple = [0, 0, 0, 0, 0, 0, 1, -1, 1, 1];
  private readonly lastSentSceneState: SceneStateTuple = [0, 0, 0, 0, 0, 0, 1, -1, 1, 1];
  private readonly localInteractionIds = new Set<string>();
  private remoteInteractions: LiveInteractionState[] = [];
  private hasPublishedAvatar = false;
  private hasSentSceneState = false;
  private nextCommandId = 1;
  private notificationHandler: ((message: string) => void) | null = null;
  private userCommandsHandler: ((commands: UserCommand[]) => void) | null = null;
  private userCommands: UserCommand[] = [];

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

    this.worker = new Worker(new URL('workers/websocket-worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ port: this.channel.port2 }, { transfer: [this.channel.port2] });
    this.channel.port1.addEventListener('message', this.onWorkerMessage);
    this.channel.port1.start();
  }

  connect(host: string) {
    this.hasSentSceneState = false;
    this.localInteractionIds.clear();
    this.setUserCommands([]);
    this.worker.postMessage({ host });
  }

  setNotificationHandler(handler: (message: string) => void) {
    this.notificationHandler = handler;
  }

  setUserCommandsHandler(handler: (commands: UserCommand[]) => void) {
    this.userCommandsHandler = handler;
    handler(this.userCommands);
  }

  private get notifyCommandName(): string {
    return `${this.localAvatarId}/notify`;
  }

  private registerNotifyCommand() {
    const register: CommandRegisterData = {
      name: this.notifyCommandName,
      arguments: { message: '' },
    };
    this.channel.port1.postMessage({ command: { register } });
  }

  sendInteractionUpdate(interactionId: string, interaction: InteractionUpdate | null) {
    if (interaction === null) {
      this.localInteractionIds.delete(interactionId);
    } else {
      this.localInteractionIds.add(interactionId);
    }

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

  updateLocalState(avatarComponents: AvatarComponentsState) {
    const updates: Record<string, unknown> = {};
    const removals: string[] = [];

    writeSceneState(this.objects, this.currentSceneState);
    const sceneChanged = !this.hasSentSceneState
      || sceneStateChanged(this.currentSceneState, this.lastSentSceneState);
    if (sceneChanged) {
      updates.scene = [...this.currentSceneState];
      copySceneState(this.currentSceneState, this.lastSentSceneState);
      this.hasSentSceneState = true;
    }

    if (avatarComponents.length > 0) {
      updates[`avatar.${this.localAvatarId}`] = {
        playerid: this.localAvatarId,
        name: this.localAvatarName,
        color: this.localAvatarColor,
        components: avatarComponents,
      };
      this.hasPublishedAvatar = true;
    } else if (this.hasPublishedAvatar) {
      removals.push(`avatar.${this.localAvatarId}`);
      this.hasPublishedAvatar = false;
    }

    if (Object.keys(updates).length === 0 && removals.length === 0) {
      return;
    }

    const state: SharedStateUpdate = {};
    if (Object.keys(updates).length > 0) {
      state.updates = updates;
    }
    if (removals.length > 0) {
      state.removals = removals;
    }

    this.channel.port1.postMessage({ state });
  }

  runCommand(name: string, args?: Record<string, unknown>): Promise<unknown> {
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

  setSharedState(updates: Record<string, unknown>, removals?: string[]) {
    const state: SharedStateUpdate = {};
    if (Object.keys(updates).length > 0) {
      state.updates = updates;
    }
    if (removals && removals.length > 0) {
      state.removals = removals;
    }
    if (!state.updates && !state.removals) {
      return;
    }

    this.channel.port1.postMessage({ state });
  }

  private onWorkerMessage = (event: MessageEvent<WorkerSendMessageData>) => {
    const message = event.data;

    if (message.event === 'open') {
      this.registerNotifyCommand();
      void this.runCommand('commands/list').then((result) => {
        this.setUserCommands(this.parseUserCommands(result));
      });
    } else if (message.event === 'close') {
      this.setUserCommands([]);
    }

    const normalized = normalizeLivePayload(message, this.sharedState);

    this.handleCommandMessages(message.command);

    if (normalized.elements && normalized.bonds) {
      const colors = buildAtomColors(normalized.elements);
      this.liveRenderer.setData(
        new Array(normalized.elements.length * 3),
        colors,
        normalized.bonds,
      );
    }

    if (normalized.residues) {
      this.interactionManager.setParticleResidues(normalized.residues);
    }

    if (normalized.positions) {
      this.liveRenderer.setPositions(normalized.positions);
      this.interactionManager.setCurrentPositions(normalized.positions);
    }

    if (normalized.box) {
      this.updateBoxGeometry(normalized.box);
    }

    if (normalized.hasStateUpdate && normalized.state) {
      const suggestedForceType = normalized.state.raw['suggested.interaction.type'];
      if (suggestedForceType === 'gaussian' || suggestedForceType === 'spring' || suggestedForceType === 'constant') {
        setForceType(suggestedForceType);
      }

      this.applySceneState(normalized.state.scene);
      const remoteAvatars: LiveAvatarState[] = [];
      for (const avatar of normalized.state.avatars) {
        if (avatar.id !== this.localAvatarId) {
          remoteAvatars.push(avatar);
        }
      }
      this.avatarRendering.render(remoteAvatars);
      const remoteInteractions: LiveInteractionState[] = [];
      for (const interaction of normalized.state.interactions) {
        if (!this.localInteractionIds.has(interaction.id)) {
          remoteInteractions.push(interaction);
        }
      }
      this.remoteInteractions = remoteInteractions;
    }

    if (normalized.positions || normalized.hasStateUpdate) {
      this.interactionManager.renderRemoteInteractions(this.remoteInteractions, normalized.positions);
    }
  };

  private handleCommandMessages(command: WorkerSendMessageData['command']) {
    if (!command) {
      return;
    }

    const messages: ServerCommandMessage[] = Array.isArray(command) ? command : [command];
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }

      const request = message.request;
      if (!request) {
        continue;
      }

      if ('response' in message || 'exception' in message) {
        const resolve = this.pendingCommands.get(request.id);
        if (!resolve) {
          continue;
        }

        this.pendingCommands.delete(request.id);
        resolve(message.response);
        continue;
      }

      this.handleIncomingCommandRequest(request);
    }
  }

  private handleIncomingCommandRequest(request: CommandRequestData) {
    if (request.name === this.notifyCommandName) {
      const message = request.arguments?.message;
      if (typeof message === 'string' && this.notificationHandler) {
        this.notificationHandler(message);
      }
    }

    this.channel.port1.postMessage({
      command: { request: { id: request.id, name: request.name }, response: {} },
    });
  }

  private setUserCommands(commands: UserCommand[]) {
    this.userCommands = commands;
    this.userCommandsHandler?.(commands);
  }

  private parseUserCommands(result: unknown): UserCommand[] {
    if (!result || typeof result !== 'object') {
      return [];
    }

    const commands = (result as { commands?: unknown }).commands;
    if (!Array.isArray(commands)) {
      return [];
    }

    const userCommands: UserCommand[] = [];
    for (const command of commands) {
      if (!command || typeof command !== 'object') {
        continue;
      }

      const { name, label, icon } = command as {
        name?: unknown;
        label?: unknown;
        icon?: unknown;
      };
      if (typeof name !== 'string' || !name.startsWith('user/')) {
        continue;
      }

      userCommands.push({
        name,
        label: typeof label === 'string' ? label : undefined,
        icon: typeof icon === 'string' ? icon : undefined,
      });
    }

    return userCommands;
  }

  private applySceneState(scene: {
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
  } | undefined) {
    if (!scene) {
      return;
    }

    applyLiveSceneTransform(this.objects, scene);
    writeSceneState(this.objects, this.lastSentSceneState);
    this.hasSentSceneState = true;

    simulationToWorld(updateSceneMatrixWorld(this.objects), this.sceneCenter, this.sceneCenterWorld);
    this.cameraControls.target.copy(this.sceneCenterWorld);
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

  private createLocalAvatarId(): string {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === 'function') {
      return `web-${randomUUID.call(globalThis.crypto)}`;
    }

    return `web-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  }

  private createLocalAvatarColor(): [number, number, number] {
    const color = new Color().setHSL(Math.random(), 0.75, 0.55);
    return [color.r, color.g, color.b];
  }

  private updateBoxEdgeResolution = () => {
    this.boxEdgesMaterial.resolution.set(
      window.innerWidth * window.devicePixelRatio,
      window.innerHeight * window.devicePixelRatio,
    );
  };
}
