import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Scene,
  Sphere,
  Vector3,
  WebXRSpaceEventMap,
} from 'three';
import { forceType, forceScale, selectionTarget } from './state/ui-state';
import { LiveInteractionState } from './live-frame-state';
import { simulationToWorld, updateSceneMatrixWorld } from './scene-transform';
import { NaiveRenderer } from './nanover/NaiveRenderer';

export interface InteractionUpdate {
  position: [number, number, number];
  particles: number[];
  interaction_type?: string;
  scale?: number;
  mass_weighted?: boolean;
}

type InteractionSender = (interactionId: string, interaction: InteractionUpdate | null) => void;

interface ActiveInteraction {
  id: string;
  particles: number[];
  line: Mesh;
}

interface InteractionManagerOptions {
  scene: Scene;
  objects: Object3D;
}

export const MAX_INTERACTION_DISTANCE = 0.3;

export class InteractionManager {
  readonly remoteInteractions: InstancedMesh;

  private readonly objects: Object3D;
  private readonly interactionLines = new Group();
  private readonly remoteInteractionLines = new Group();
  private readonly activeInteractions = new Map<Group<WebXRSpaceEventMap>, ActiveInteraction>();
  private readonly controllerTips = new Map<Group<WebXRSpaceEventMap>, Object3D>();
  private readonly remoteLines: Mesh[] = [];

  private readonly lineGeometry = new CylinderGeometry(0.005, 0.005, 1, 8);
  private readonly lineMaterial = new MeshBasicMaterial({
    color: 0xffff00,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
  });

  private readonly simPos = new Vector3();
  private readonly worldPos = new Vector3();
  private readonly atomPos = new Vector3();
  private readonly inverseObjects = new Matrix4();
  private readonly matrix = new Matrix4();
  private readonly rotation = new Quaternion();
  private readonly remoteScale = new Vector3(0.08, 0.08, 0.08);
  private readonly remoteSimPos = new Vector3();
  private readonly sceneMatrix = new Matrix4();

  private currentPositions: Float32Array | null = null;
  private particleResidues: Int32Array | null = null;
  private interactionIdCounter = 0;
  private sendInteraction: InteractionSender = () => {};

  // --- highlight state ---
  private highlightRenderer: NaiveRenderer | null = null;
  private hoverParticles: Set<number> = new Set();
  private activeHighlightParticles: Set<number> = new Set();

  constructor(options: InteractionManagerOptions) {
    this.objects = options.objects;

    this.remoteInteractions = new InstancedMesh(
      new BoxGeometry(),
      new MeshBasicMaterial({ color: 'green' }),
      64,
    );
    this.remoteInteractions.boundingSphere = new Sphere(new Vector3(), 100);
    this.remoteInteractions.count = 0;
    this.objects.add(this.remoteInteractions);

    this.lineGeometry.rotateX(Math.PI / 2);
    this.lineGeometry.translate(0, 0, 0.5);
    options.scene.add(this.interactionLines);
    options.scene.add(this.remoteInteractionLines);
  }

  setInteractionSender(sender: InteractionSender) {
    this.sendInteraction = sender;
  }

  setCurrentPositions(positions: Float32Array | null) {
    this.currentPositions = positions;
    if (!positions) {
      this.hoverParticles = new Set();
    }
  }

  setParticleResidues(residues: Int32Array | null) {
    this.particleResidues = residues;
  }

  registerControllerTip(controller: Group<WebXRSpaceEventMap>, tip: Object3D) {
    this.controllerTips.set(controller, tip);
  }

  setHighlightRenderer(renderer: NaiveRenderer | null) {
    if (this.highlightRenderer && renderer !== this.highlightRenderer) {
      this.highlightRenderer.clearHighlight();
    }
    this.highlightRenderer = renderer;
  }

  start(controller: Group<WebXRSpaceEventMap>) {
    if (this.activeInteractions.has(controller) || !this.currentPositions) {
      return;
    }

    const tip = this.controllerTips.get(controller);
    if (!tip) {
      return;
    }

    tip.getWorldPosition(this.worldPos);
    const closest = this.findClosestAtoms(this.worldPos, 1);
    if (closest.length === 0) {
      return;
    }

    const particle = closest[0];
    if (!this.getAtomWorldPosition(particle, this.atomPos)) {
      return;
    }

    if (this.worldPos.distanceTo(this.atomPos) > MAX_INTERACTION_DISTANCE) {
      return;
    }

    let particles: number[];
    if (selectionTarget === 'residue' && this.particleResidues) {
      const residueId = this.particleResidues[particle];
      if (residueId !== undefined) {
        particles = [];
        for (let i = 0; i < this.particleResidues.length; i += 1) {
          if (this.particleResidues[i] === residueId) {
            particles.push(i);
          }
        }
      } else {
        particles = closest;
      }
    } else {
      particles = closest;
    }

    const interactionId = this.generateInteractionId();
    const line = new Mesh(this.lineGeometry, this.lineMaterial);
    line.renderOrder = 999;
    this.interactionLines.add(line);

    this.activeInteractions.set(controller, {
      id: interactionId,
      particles,
      line,
    });

    this.rebuildActiveHighlightParticles();
    this.applyHighlight();

    this.toSimulationPosition(this.worldPos, this.simPos);
    this.sendInteraction(interactionId, {
      position: [this.simPos.x, this.simPos.y, this.simPos.z],
      particles,
      interaction_type: forceType,
      scale: forceScale,
    });
  }

  update(controller: Group<WebXRSpaceEventMap>) {
    const active = this.activeInteractions.get(controller);
    if (!active) {
      return;
    }

    const tip = this.controllerTips.get(controller);
    if (!tip) {
      return;
    }

    tip.getWorldPosition(this.worldPos);

    this.toSimulationPosition(this.worldPos, this.simPos);
    this.sendInteraction(active.id, {
      position: [this.simPos.x, this.simPos.y, this.simPos.z],
      particles: active.particles,
      interaction_type: forceType,
      scale: forceScale,
    });

    const atomIndex = active.particles[0];
    if (!this.getAtomWorldPosition(atomIndex, this.atomPos)) {
      return;
    }

    active.line.position.copy(this.worldPos);
    active.line.lookAt(this.atomPos);
    active.line.scale.set(1, 1, this.worldPos.distanceTo(this.atomPos));
  }

  updateActive() {
    for (const controller of this.activeInteractions.keys()) {
      this.update(controller);
    }
  }

  end(controller: Group<WebXRSpaceEventMap>) {
    const active = this.activeInteractions.get(controller);
    if (!active) {
      return;
    }

    this.sendInteraction(active.id, null);
    active.line.removeFromParent();
    this.activeInteractions.delete(controller);

    this.rebuildActiveHighlightParticles();
    this.applyHighlight();
  }

  updateHoverHighlight() {
    if (!this.highlightRenderer) return;

    const newHoverParticles = new Set<number>();

    if (this.currentPositions && this.controllerTips.size > 0) {
      this.objects.updateMatrixWorld(false);

      for (const [controller, tip] of this.controllerTips.entries()) {
        if (this.activeInteractions.has(controller)) {
          continue;
        }

        tip.getWorldPosition(this.worldPos);
        this.toSimulationPosition(this.worldPos, this.simPos);

        let closestIdx = -1;
        let closestDistSq = Infinity;
        const atomCount = this.currentPositions.length / 3;
        for (let i = 0; i < atomCount; i++) {
          this.atomPos.fromArray(this.currentPositions, i * 3);
          const d2 = this.simPos.distanceToSquared(this.atomPos);
          if (d2 < closestDistSq) {
            closestDistSq = d2;
            closestIdx = i;
          }
        }

        if (closestIdx >= 0 && this.getAtomWorldPosition(closestIdx, this.atomPos)) {
          if (this.worldPos.distanceTo(this.atomPos) <= MAX_INTERACTION_DISTANCE) {
            if (selectionTarget === 'residue' && this.particleResidues) {
              const residueId = this.particleResidues[closestIdx];
              if (residueId !== undefined) {
                for (let i = 0; i < this.particleResidues.length; i++) {
                  if (this.particleResidues[i] === residueId) {
                    newHoverParticles.add(i);
                  }
                }
              } else {
                newHoverParticles.add(closestIdx);
              }
            } else {
              newHoverParticles.add(closestIdx);
            }
          }
        }
      }
    }

    this.hoverParticles = newHoverParticles;
    this.highlightRenderer.setHighlight(this.hoverParticles, this.activeHighlightParticles);
    this.highlightRenderer.updateHighlightPulse();
  }

  renderRemoteInteractions(interactions: LiveInteractionState[], framePositions = this.currentPositions ?? undefined) {
    this.remoteInteractions.count = 0;
    let renderedLineCount = 0;

    this.sceneMatrix.copy(updateSceneMatrixWorld(this.objects));

    for (const interaction of interactions) {
      if (interaction.position) {
        this.remoteSimPos.fromArray(interaction.position);
        simulationToWorld(this.sceneMatrix, this.remoteSimPos, this.worldPos);
      } else {
        const atomIndex = interaction.particles[0];
        if (!framePositions) {
          continue;
        }

        const from = atomIndex * 3;
        if (from + 2 >= framePositions.length) {
          continue;
        }

        this.remoteSimPos.fromArray(framePositions, from);
        simulationToWorld(this.sceneMatrix, this.remoteSimPos, this.worldPos);
      }

      this.rotation.identity();
      this.matrix.compose(this.worldPos, this.rotation, this.remoteScale);
      this.remoteInteractions.setMatrixAt(this.remoteInteractions.count, this.matrix);
      this.remoteInteractions.count += 1;

      if (!framePositions) {
        continue;
      }

      const atomIndex = interaction.particles[0];
      const from = atomIndex * 3;
      if (from + 2 >= framePositions.length) {
        continue;
      }

      this.remoteSimPos.fromArray(framePositions, from);
      simulationToWorld(this.sceneMatrix, this.remoteSimPos, this.atomPos);

      const remoteLine = this.getRemoteLine(renderedLineCount);
      renderedLineCount += 1;
      remoteLine.visible = true;
      remoteLine.position.copy(this.worldPos);
      remoteLine.lookAt(this.atomPos);
      remoteLine.scale.set(1, 1, this.worldPos.distanceTo(this.atomPos));
    }

    for (let i = renderedLineCount; i < this.remoteLines.length; i += 1) {
      this.remoteLines[i].visible = false;
    }

    this.remoteInteractions.instanceMatrix.needsUpdate = true;
  }

  private getRemoteLine(index: number): Mesh {
    if (index < this.remoteLines.length) {
      return this.remoteLines[index];
    }

    const line = new Mesh(this.lineGeometry, this.lineMaterial);
    line.renderOrder = 998;
    this.remoteInteractionLines.add(line);
    this.remoteLines.push(line);
    return line;
  }

  private generateInteractionId(): string {
    const id = `web-${Date.now()}-${this.interactionIdCounter}`;
    this.interactionIdCounter += 1;
    return id;
  }

  private toSimulationPosition(world: Vector3, target: Vector3) {
    this.inverseObjects.copy(this.objects.matrixWorld).invert();
    target.copy(world).applyMatrix4(this.inverseObjects);
  }

  private getAtomWorldPosition(atomIndex: number, target: Vector3): boolean {
    if (!this.currentPositions) {
      return false;
    }

    const from = atomIndex * 3;
    if (from + 2 >= this.currentPositions.length) {
      return false;
    }

    target.fromArray(this.currentPositions, from).applyMatrix4(this.objects.matrixWorld);
    return true;
  }

  private findClosestAtoms(worldPos: Vector3, count: number): number[] {
    if (!this.currentPositions || this.currentPositions.length === 0) {
      return [];
    }

    this.toSimulationPosition(worldPos, this.simPos);

    const atomCount = this.currentPositions.length / 3;
    const distances: { index: number; distance: number }[] = [];
    for (let i = 0; i < atomCount; i += 1) {
      this.atomPos.fromArray(this.currentPositions, i * 3);
      distances.push({
        index: i,
        distance: this.simPos.distanceTo(this.atomPos),
      });
    }

    distances.sort((a, b) => a.distance - b.distance);
    return distances.slice(0, count).map((entry) => entry.index);
  }

  private rebuildActiveHighlightParticles() {
    this.activeHighlightParticles.clear();
    for (const active of this.activeInteractions.values()) {
      for (const p of active.particles) {
        this.activeHighlightParticles.add(p);
      }
    }
  }

  private applyHighlight() {
    this.highlightRenderer?.setHighlight(this.hoverParticles, this.activeHighlightParticles);
  }
}
