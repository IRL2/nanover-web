import { SendMessageData } from './nanover/workers/websocket-worker';

export interface LiveSceneTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface LiveAvatarComponent {
  name: string;
  position: [number, number, number];
  rotation: [number, number, number, number];
}

export interface LiveAvatarState {
  id: string;
  name: string;
  color: [number, number, number];
  components: LiveAvatarComponent[];
}

export interface LiveInteractionState {
  id: string;
  position?: [number, number, number];
  particles: number[];
}

export interface LiveFrameState {
  scene?: LiveSceneTransform;
  avatars: LiveAvatarState[];
  interactions: LiveInteractionState[];
  raw: Record<string, unknown>;
}

export interface NormalizedLivePayload {
  positions?: Float32Array;
  elements?: Uint8Array;
  bonds?: Uint32Array;
  box?: Float32Array;
  state?: LiveFrameState;
  hasStateUpdate: boolean;
}

type SharedStateDelta = {
  updates?: Record<string, unknown>;
  removals?: string[];
};

function asNumberArray(value: unknown, minLength: number): number[] | undefined {
  if (!Array.isArray(value) || value.length < minLength) {
    return undefined;
  }

  const parsed: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const next = value[i];
    if (typeof next !== 'number') {
      return undefined;
    }
    parsed.push(next);
  }
  return parsed;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseScene(rawScene: unknown): LiveSceneTransform | undefined {
  const scene = asNumberArray(rawScene, 10);
  if (!scene) {
    return undefined;
  }
  return {
    position: [scene[0], scene[1], scene[2]],
    rotation: [scene[3], scene[4], scene[5], scene[6]],
    scale: [scene[7], scene[8], scene[9]],
  };
}

function parseInteraction(id: string, value: unknown): LiveInteractionState | undefined {
  const state = asObject(value);
  if (!state) {
    return undefined;
  }

  const particlesRaw = state.particles;
  if (!Array.isArray(particlesRaw)) {
    return undefined;
  }

  const particles: number[] = [];
  for (let i = 0; i < particlesRaw.length; i += 1) {
    const particle = particlesRaw[i];
    if (typeof particle !== 'number') {
      return undefined;
    }
    particles.push(particle);
  }

  const positionRaw = asNumberArray(state.position, 3);

  return {
    id,
    position: positionRaw ? [positionRaw[0], positionRaw[1], positionRaw[2]] : undefined,
    particles,
  };
}

function parseAvatar(id: string, value: unknown): LiveAvatarState | undefined {
  const avatar = asObject(value);
  if (!avatar) {
    return undefined;
  }

  const colorArray = asNumberArray(avatar.color, 3);
  const componentsRaw = avatar.components;
  if (!colorArray || !Array.isArray(componentsRaw)) {
    return undefined;
  }

  const components: LiveAvatarComponent[] = [];
  for (let i = 0; i < componentsRaw.length; i += 1) {
    const component = asObject(componentsRaw[i]);
    if (!component) {
      continue;
    }

    if (typeof component.name !== 'string') {
      continue;
    }

    const position = asNumberArray(component.position, 3);
    const rotation = asNumberArray(component.rotation, 4);
    if (!position || !rotation) {
      continue;
    }

    components.push({
      name: component.name,
      position: [position[0], position[1], position[2]],
      rotation: [rotation[0], rotation[1], rotation[2], rotation[3]],
    });
  }

  return {
    id,
    name: typeof avatar.name === 'string' ? avatar.name : id,
    color: [colorArray[0], colorArray[1], colorArray[2]],
    components,
  };
}

function applyStateDelta(sharedState: Record<string, unknown>, delta: SharedStateDelta) {
  if (delta.updates) {
    for (const [key, value] of Object.entries(delta.updates)) {
      sharedState[key] = value;
    }
  }

  if (delta.removals) {
    for (const key of delta.removals) {
      delete sharedState[key];
    }
  }
}

function buildLiveFrameState(sharedState: Record<string, unknown>): LiveFrameState {
  let scene = parseScene(sharedState.scene);
  const avatars: LiveAvatarState[] = [];
  const interactions: LiveInteractionState[] = [];

  for (const [key, value] of Object.entries(sharedState)) {
    if (key === 'scene') {
      if (!scene) {
        scene = parseScene(value);
      }
      continue;
    }

    if (key.startsWith('avatar.')) {
      const avatar = parseAvatar(key.slice('avatar.'.length), value);
      if (avatar) {
        avatars.push(avatar);
      }
      continue;
    }

    if (key.startsWith('interaction.')) {
      const interaction = parseInteraction(key.slice('interaction.'.length), value);
      if (interaction) {
        interactions.push(interaction);
      }
    }
  }

  return {
    scene,
    avatars,
    interactions,
    raw: sharedState,
  };
}

export function normalizeLivePayload(
  message: SendMessageData,
  sharedState: Record<string, unknown>,
): NormalizedLivePayload {
  const frame = message.frame ?? {};
  const hasStateUpdate = Boolean(frame.state);

  let state: LiveFrameState | undefined;

  if (hasStateUpdate) {
    applyStateDelta(sharedState, frame.state as SharedStateDelta);
    state = buildLiveFrameState(sharedState);
  }

  return {
    positions: frame.positions,
    elements: frame.elements,
    bonds: frame.bonds,
    box: frame.box,
    state,
    hasStateUpdate,
  };
}
