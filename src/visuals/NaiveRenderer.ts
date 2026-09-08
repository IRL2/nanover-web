"use strict";

import * as THREE from "three";

const DEFAULT_OPTIONS = {
  atomLimit: 20480,
  bondLimit: 20480,
}

const UP = new THREE.Vector3(0, 1, 0);

const matrix = new THREE.Matrix4();
const posA = new THREE.Vector3();
const posB = new THREE.Vector3();
const posU = new THREE.Vector3();

const rot = new THREE.Matrix4();

const t = new THREE.Vector3();
const r = new THREE.Quaternion();
const s = new THREE.Vector3(.035, .035, .035);

const colorA = new THREE.Color();
const colorB = new THREE.Color();

const hackScale = new THREE.Vector3(.035, .035, .035);

class NaiveRenderer extends THREE.Object3D {
  material: THREE.MeshStandardMaterial;
  atomsMesh: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial, THREE.InstancedMeshEventMap>;
  bondsMesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial, THREE.InstancedMeshEventMap>;
  private _bonds: ArrayLike<number>;

  private baseAtomColors: Float32Array | null = null;
  private baseBondColors: Float32Array | null = null;

  private visibleAtoms: Int32Array = new Int32Array(0);
  private atomToVisible: Int32Array = new Int32Array(0);
  private visibleCount = 0;

  private atomToBonds: Map<number, number[]> = new Map();

  private hoverAtoms: Set<number> = new Set();
  private activeAtoms: Set<number> = new Set();

  private prevAllHighlighted: Set<number> = new Set();
  private prevHighlightedBonds: Set<number> = new Set();
  private hadHighlights = false;

  private static readonly WHITE = new THREE.Color(1, 1, 1);

  constructor(options = DEFAULT_OPTIONS) {
    super();

    this.material = new THREE.MeshStandardMaterial();

    this.atomsMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 2),
      this.material,
      options.atomLimit,
    );
    this.atomsMesh.count = 0;
    this.atomsMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    this.add(this.atomsMesh);

    this.bondsMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).rotateX(Math.PI * .5),
      this.material,
      options.bondLimit,
    );
    this.bondsMesh.count = 0;
    this.bondsMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    this.add(this.bondsMesh);

    this._bonds = [];
  }

  setData(
    positions: ArrayLike<number>,
    colors: ArrayLike<number>,
    bonds: ArrayLike<number>,
    particleFilter: Set<number> | null = null,
  ) {
    const atomCount = positions.length / 3;

    if (particleFilter) {
      const visible: number[] = [];
      this.atomToVisible = new Int32Array(atomCount).fill(-1);
      for (let i = 0; i < atomCount; ++i) {
        if (particleFilter.has(i)) {
          this.atomToVisible[i] = visible.length;
          visible.push(i);
        }
      }
      this.visibleAtoms = Int32Array.from(visible);
    } else {
      this.visibleAtoms = new Int32Array(atomCount);
      this.atomToVisible = new Int32Array(atomCount);
      for (let i = 0; i < atomCount; ++i) {
        this.visibleAtoms[i] = i;
        this.atomToVisible[i] = i;
      }
    }

    this.visibleCount = this.visibleAtoms.length;
    this.atomsMesh.count = this.visibleCount;

    this.baseAtomColors = new Float32Array(this.visibleCount * 3);
    for (let slot = 0; slot < this.visibleCount; ++slot) {
      const atom = this.visibleAtoms[slot];
      colorA.fromArray(colors, atom * 3);
      this.atomsMesh.setColorAt(slot, colorA);
      this.baseAtomColors[slot * 3]     = colorA.r;
      this.baseAtomColors[slot * 3 + 1] = colorA.g;
      this.baseAtomColors[slot * 3 + 2] = colorA.b;
    }

    this.atomToBonds.clear();
    const keptBonds: number[] = [];
    const totalBonds = bonds.length / 2;
    for (let i = 0; i < totalBonds; ++i) {
      const ia = bonds[i * 2 + 0];
      const ib = bonds[i * 2 + 1];
      if (this.atomToVisible[ia] < 0 || this.atomToVisible[ib] < 0) {
        continue;
      }
      const bondSlot = keptBonds.length / 2;
      keptBonds.push(ia, ib);
      if (!this.atomToBonds.has(ia)) this.atomToBonds.set(ia, []);
      if (!this.atomToBonds.has(ib)) this.atomToBonds.set(ib, []);
      this.atomToBonds.get(ia)!.push(bondSlot);
      this.atomToBonds.get(ib)!.push(bondSlot);
    }

    this._bonds = keptBonds;
    const bondCount = keptBonds.length / 2;
    this.bondsMesh.count = bondCount;

    this.baseBondColors = new Float32Array(bondCount * 3);
    for (let i = 0; i < bondCount; ++i) {
      const ia = keptBonds[i * 2 + 0];
      const ib = keptBonds[i * 2 + 1];

      colorA.fromArray(colors, ia * 3);
      colorB.fromArray(colors, ib * 3);
      colorA.lerp(colorB, .5);
      this.bondsMesh.setColorAt(i, colorA);
      this.baseBondColors[i * 3]     = colorA.r;
      this.baseBondColors[i * 3 + 1] = colorA.g;
      this.baseBondColors[i * 3 + 2] = colorA.b;
    }

    this.hoverAtoms  = new Set();
    this.activeAtoms = new Set();
    this.prevAllHighlighted  = new Set();
    this.prevHighlightedBonds = new Set();
    this.hadHighlights = false;

    this.atomsMesh.instanceColor!.needsUpdate = true;
    this.bondsMesh.instanceColor!.needsUpdate = true;

    this.setPositions(positions);
  }

  setPositions(positions: ArrayLike<number>) {
    this.atomsMesh.count = this.visibleCount;

    // TODO: independent scales
    matrix.identity();
    matrix.scale(hackScale);

    for (let slot = 0; slot < this.visibleCount; ++slot) {
      const atom = this.visibleAtoms[slot];
      t.fromArray(positions, atom * 3);
      matrix.setPosition(t);
      this.atomsMesh.setMatrixAt(slot, matrix);
    }

    const bonds = this._bonds;
    const bondCount = bonds.length / 2;

    for (let i = 0; i < bondCount; ++i) {
      const [ia, ib] = [bonds[i * 2 + 0], bonds[i * 2 + 1]];
      posA.fromArray(positions, ia * 3);
      posB.fromArray(positions, ib * 3);

      const d = posU.copy(posA).sub(posB).length();
      rot.lookAt(posA, posB, UP);
      r.setFromRotationMatrix(rot);
      r.normalize();

      t.lerpVectors(posA, posB, .5);
      s.copy(hackScale).multiplyScalar(.5);
      s.z = d;

      matrix.compose(t, r, s);

      this.bondsMesh.setMatrixAt(i, matrix);
    }

    this.atomsMesh.instanceMatrix.needsUpdate = true;
    this.bondsMesh.instanceMatrix.needsUpdate = true;
  }

  setHighlight(hoverAtoms: Set<number>, activeAtoms: Set<number>) {
    this.hoverAtoms  = hoverAtoms;
    this.activeAtoms = activeAtoms;
  }

  clearHighlight() {
    this.setHighlight(new Set(), new Set());
  }

  updateHighlightPulse() {
    if (!this.baseAtomColors) return;

    const hasHighlights = this.hoverAtoms.size > 0 || this.activeAtoms.size > 0;
    if (!hasHighlights && !this.hadHighlights) return;

    const t = performance.now() / 1000;
    // (sin+1)/2 → smooth 0-to-1 oscillation
    const hoverBlend  = 0.20 + 0.20 * ((Math.sin(t * Math.PI * 1.0) + 1) / 2);
    const activeBlend = 0.40 + 0.30 * ((Math.sin(t * Math.PI * 2.0) + 1) / 2);

    const newAllHighlighted = new Set<number>([...this.hoverAtoms, ...this.activeAtoms]);

    // --- Atoms ---
    let atomsDirty = false;

    for (const idx of this.prevAllHighlighted) {
      if (!newAllHighlighted.has(idx)) {
        const slot = this.atomToVisible[idx];
        if (slot < 0) continue;
        colorA.fromArray(this.baseAtomColors, slot * 3);
        this.atomsMesh.setColorAt(slot, colorA);
        atomsDirty = true;
      }
    }

    for (const idx of this.activeAtoms) {
      const slot = this.atomToVisible[idx];
      if (slot < 0) continue;
      colorA.fromArray(this.baseAtomColors, slot * 3);
      colorA.lerp(NaiveRenderer.WHITE, activeBlend);
      this.atomsMesh.setColorAt(slot, colorA);
      atomsDirty = true;
    }

    for (const idx of this.hoverAtoms) {
      if (!this.activeAtoms.has(idx)) {
        const slot = this.atomToVisible[idx];
        if (slot < 0) continue;
        colorA.fromArray(this.baseAtomColors, slot * 3);
        colorA.lerp(NaiveRenderer.WHITE, hoverBlend);
        this.atomsMesh.setColorAt(slot, colorA);
        atomsDirty = true;
      }
    }

    if (atomsDirty) {
      this.atomsMesh.instanceColor!.needsUpdate = true;
    }

    // --- Bonds ---
    if (this.baseBondColors && this.bondsMesh.instanceColor) {
      const newHighlightedBonds = new Set<number>();
      for (const atomIdx of newAllHighlighted) {
        const bondIndices = this.atomToBonds.get(atomIdx);
        if (bondIndices) {
          for (const bi of bondIndices) newHighlightedBonds.add(bi);
        }
      }

      let bondsDirty = false;
      const bonds = this._bonds;

      for (const bi of this.prevHighlightedBonds) {
        if (!newHighlightedBonds.has(bi)) {
          colorA.fromArray(this.baseBondColors, bi * 3);
          this.bondsMesh.setColorAt(bi, colorA);
          bondsDirty = true;
        }
      }

      for (const bi of newHighlightedBonds) {
        const ia = bonds[bi * 2];
        const ib = bonds[bi * 2 + 1];
        colorA.fromArray(this.baseBondColors, bi * 3);
        if (this.activeAtoms.has(ia) || this.activeAtoms.has(ib)) {
          colorA.lerp(NaiveRenderer.WHITE, activeBlend);
        } else {
          colorA.lerp(NaiveRenderer.WHITE, hoverBlend);
        }
        this.bondsMesh.setColorAt(bi, colorA);
        bondsDirty = true;
      }

      if (bondsDirty) {
        this.bondsMesh.instanceColor.needsUpdate = true;
      }

      this.prevHighlightedBonds = newHighlightedBonds;
    }

    this.prevAllHighlighted = newAllHighlighted;
    this.hadHighlights = hasHighlights;
  }
}

export default NaiveRenderer;
export { NaiveRenderer };
