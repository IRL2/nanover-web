import { Color, Object3D, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import NaiveRenderer from './nanover/NaiveRenderer';
import { TestTrajectory } from './nanover/types';
import { SendMessageData } from './nanover/workers/traj-loader-worker';

export interface TrajectoryPreset {
  name: string;
  paths: string[];
}

export const DEFAULT_TRAJECTORIES: TrajectoryPreset[] = [
  {
    name: 'Ludo GluHUTs',
    paths: [
      'ludo-gluhut-0.msgpack',
      'ludo-gluhut-1.msgpack',
      'ludo-gluhut-2.msgpack',
      'ludo-gluhut-3.msgpack',
      'ludo-gluhut-4.msgpack',
      'ludo-gluhut-5.msgpack',
      'ludo-gluhut-6.msgpack',
    ],
  },
  { name: '17-Alanine', paths: ['bucky-test.msgpack'] },
  { name: 'Nanotube', paths: ['webtraj.msgpack'] },
];

type TrajectoryPair = {
  traj: TestTrajectory;
  renderer: NaiveRenderer;
};

const elementColors = new Map<number, Color>([
  [1, new Color('white')],
  [6, new Color('black')],
  [7, new Color('blue')],
  [8, new Color('red')],
]);

const colorScratch = new Color();

function makeColor(elements: Uint8Array, index: number): Color {
  colorScratch.setHSL((index / elements.length) + (Math.random() * 0.1), 0.25, 0.5);
  const mapped = elementColors.get(elements[index]);
  if (mapped) {
    colorScratch.lerp(mapped, 0.65);
  }
  return colorScratch;
}

export function buildAtomColors(elements: Uint8Array): Float32Array {
  const colors = new Float32Array(elements.length * 3);
  for (let i = 0; i < elements.length; i += 1) {
    makeColor(elements, i).toArray(colors, i * 3);
  }
  return colors;
}

interface TrajectoryLoaderOptions {
  objects: Object3D;
  updateTrajectoryName: (name: string) => void;
}

export class TrajectoryLoader {
  private readonly objects: Object3D;
  private readonly updateTrajectoryName: (name: string) => void;
  private readonly trajLoaderChannel = new MessageChannel();
  private readonly pairs: TrajectoryPair[] = [];
  private readonly sum = new Vector3();
  private readonly atomPosition = new Vector3();

  constructor(options: TrajectoryLoaderOptions) {
    this.objects = options.objects;
    this.updateTrajectoryName = options.updateTrajectoryName;

    const worker = new Worker(new URL('nanover/workers/traj-loader-worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.postMessage({ port: this.trajLoaderChannel.port2 }, { transfer: [this.trajLoaderChannel.port2] });

    this.trajLoaderChannel.port1.addEventListener('message', this.onTrajectoryLoaded);
    this.trajLoaderChannel.port1.start();
  }

  private onTrajectoryLoaded = (event: MessageEvent<SendMessageData>) => {
    const { traj } = event.data;
    const renderer = new NaiveRenderer();
    this.objects.add(renderer);
    this.pairs.push({ traj, renderer });

    const atomCount = traj.positions[0].length / 3;
    const colors = new Float32Array(traj.positions[0].length);
    for (let i = 0; i < atomCount; i += 1) {
      makeColor(traj.topology.elements, i).toArray(colors, i * 3);
    }

    renderer.setData(
      traj.positions[0],
      colors,
      traj.topology.bonds,
    );
  };

  clear() {
    for (const { renderer } of this.pairs) {
      renderer.removeFromParent();
    }
    this.pairs.length = 0;
  }

  hideAll() {
    for (const { renderer } of this.pairs) {
      renderer.visible = false;
    }
  }

  showAll() {
    for (const { renderer } of this.pairs) {
      renderer.visible = true;
    }
  }

  hasTrajectories(): boolean {
    return this.pairs.length > 0;
  }

  getMaxFrameCount(): number {
    return Math.max(1, ...this.pairs.map(({ traj }) => traj.positions.length));
  }

  loadPaths(paths: string[], displayName?: string) {
    this.clear();
    this.showAll();
    this.updateTrajectoryName(displayName ?? paths.join(', '));

    for (const path of paths) {
      const url = new URL(`./data/${path}`, window.location.href).toString();
      this.trajLoaderChannel.port1.postMessage({ path: url });
    }
  }

  enqueueArrayBuffer(arrayBuffer: ArrayBuffer, filename: string) {
    this.trajLoaderChannel.port1.postMessage({ arrayBuffer, filename }, [arrayBuffer]);
  }

  async loadFromUrl(url: string) {
    this.updateTrajectoryName('Loading...');

    const githubRegex = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/;
    const match = url.match(githubRegex);
    const fetchUrl = match
      ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}`
      : url;

    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch trajectory: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const filename = url.split('/').pop()?.split('?')[0] ?? 'url_trajectory.msgpack';

    this.clear();
    this.updateTrajectoryName(filename);
    this.enqueueArrayBuffer(arrayBuffer, filename);
  }

  applyFrame(index: number, cameraControls: OrbitControls) {
    this.sum.set(0, 0, 0);
    let atomCountSum = 0;

    for (const { traj, renderer } of this.pairs) {
      const positions = traj.positions[Math.min(index, traj.positions.length - 1)];
      renderer.setPositions(positions);

      const atomCount = positions.length / 3;
      atomCountSum += atomCount;
      for (let i = 0; i < atomCount; i += 1) {
        this.atomPosition.fromArray(positions, i * 3);
        this.sum.add(this.atomPosition);
      }
    }

    if (atomCountSum === 0) {
      return;
    }

    this.sum.divideScalar(atomCountSum);
    this.sum.multiply(this.objects.scale);

    cameraControls.target.copy(this.sum);
    cameraControls.update();
  }
}
