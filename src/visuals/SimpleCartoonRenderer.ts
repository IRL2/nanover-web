"use strict";

import * as THREE from "three";
import {
  computeSplineFrames,
  extractPolypeptides,
  Sequence,
  SS_COLORS,
  SS_HELIX_MASK,
  SS_SHEET,
  SS_WHITE,
} from "./simple-cartoon/protein-structure";
import tubeFragmentShader from "./simple-cartoon/shaders/tube-fragment.glsl?raw";
import tubeVertexShader from "./simple-cartoon/shaders/tube-vertex.glsl?raw";

export interface SimpleCartoonRendererOptions {
  maxResidues?: number;
  maxHelices?: number;
  loopRadius?: number;
  helixRadius?: number;
  sheetWidth?: number;
  sheetThickness?: number;
  arrowExtra?: number;
  headLength?: number;
  arrowLength?: number;
  minHelixRun?: number;
  minSheetRun?: number;
  tubeSegments?: number;
  tubeSides?: number;
  pipeSides?: number;
  stationsPerSegment?: number;
  dsspInterval?: number;
  fadeSpeed?: number;
}

const DEFAULT_OPTIONS: Required<SimpleCartoonRendererOptions> = {
  maxResidues: 8192,
  maxHelices: 512,
  loopRadius: 0.015,
  helixRadius: 0.09,
  sheetWidth: 0.12,
  sheetThickness: 0.02,
  arrowExtra: 0.9,
  headLength: 0.55,
  arrowLength: 0.25,
  minHelixRun: 2,
  minSheetRun: 2,
  tubeSegments: 16,
  tubeSides: 12,
  pipeSides: 16,
  stationsPerSegment: 6,
  dsspInterval: 1.0,
  fadeSpeed: 0.5,
};


const TUBE_ATTRIBUTE_NAMES = [
  "aStartPoint",
  "aEndPoint",
  "aStartTangent",
  "aEndTangent",
  "aStartNormal",
  "aEndNormal",
] as const;

const RUN_HELIX = 0;
const RUN_SHEET = 1;

interface Run {
  type: number;
  start: number;
  end: number;
  ss: number;
  fade: number;
  target: number;
  axis: [number, number, number, number, number, number] | null;
  extent: [number, number] | null;
  mesh: THREE.Mesh | null;
  geometry: THREE.BufferGeometry | null;
  stations: number;
  curvePoints: THREE.Vector3[] | null;
  binormals: Float32Array | null;
}

const UP = new THREE.Vector3(0, 1, 0);
const scratchQuaternion = new THREE.Quaternion();
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchDirection = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();
const scratchPointA = new THREE.Vector3();
const scratchPointB = new THREE.Vector3();
const scratchTangent = new THREE.Vector3();
const scratchBinormal = new THREE.Vector3();
const scratchNormal = new THREE.Vector3();

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) {
    return target;
  }
  return current + Math.sign(target - current) * maxDelta;
}

export class SimpleCartoonRenderer extends THREE.Object3D {
  private readonly options: Required<SimpleCartoonRendererOptions>;

  private readonly tubeGeometry: THREE.InstancedBufferGeometry;
  private readonly tubeMaterial: THREE.ShaderMaterial;
  private readonly tubeMesh: THREE.Mesh;
  private readonly tubeBuffers: Float32Array[];
  private readonly tubeAttributes: THREE.InstancedBufferAttribute[] = [];
  private readonly tubeLimit: number;

  private readonly pipeMesh: THREE.InstancedMesh;

  private readonly platesGroup = new THREE.Group();
  private readonly plateMaterial: THREE.MeshStandardMaterial;
  private readonly plateCurve = new THREE.CatmullRomCurve3([], false, "centripetal", 0.5);

  private sequences: Sequence[] = [];
  private caIndices = new Int32Array(0);
  private drawnResidues = new Set<number>();
  private vertexCount = 0;
  private backboneSegments = 0;

  private tangents = new Float32Array(0);
  private normals = new Float32Array(0);

  private helixFade = new Float32Array(0);
  private axisProj = new Float32Array(0);
  private axisDir = new Float32Array(0);
  private axisNormal = new Float32Array(0);

  private runs = new Map<string, Run>();
  private readonly runArray: Run[] = [];
  private vertexSheetRun = new Int32Array(0);

  private lastPositions: ArrayLike<number> | null = null;

  private readonly dsspWorker = new Worker(
    new URL("./simple-cartoon/dssp-worker.ts", import.meta.url),
    { type: "module" },
  );
  private dsspTimer = Infinity;
  private dsspDirty = false;
  private topologyVersion = 0;
  private dsspRequestId = 0;
  private dsspInFlight = false;

  constructor(userOptions: SimpleCartoonRendererOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...userOptions };
    this.dsspWorker.onmessage = (event: MessageEvent<{
      type: "result";
      topologyVersion: number;
      requestId: number;
      assignments: Uint8Array;
    }>) => {
      const result = event.data;
      this.dsspInFlight = false;
      if (result.topologyVersion !== this.topologyVersion) {
        return;
      }
      this.updateRuns(result.assignments);
    };

    this.tubeLimit = Math.max(1, this.options.maxResidues);
    this.tubeBuffers = TUBE_ATTRIBUTE_NAMES.map(
      () => new Float32Array(this.tubeLimit * 3),
    );

    const cylinder = new THREE.CylinderGeometry(
      0.5, 0.5, 1,
      this.options.tubeSides,
      this.options.tubeSegments,
      true,
    );
    cylinder.translate(0, 0.5, 0);

    this.tubeGeometry = new THREE.InstancedBufferGeometry();
    this.tubeGeometry.index = cylinder.index;
    this.tubeGeometry.setAttribute("position", cylinder.getAttribute("position"));
    this.tubeGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

    this.tubeBuffers.forEach((buffer, index) => {
      const attribute = new THREE.InstancedBufferAttribute(buffer, 3);
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.tubeGeometry.setAttribute(TUBE_ATTRIBUTE_NAMES[index], attribute);
      this.tubeAttributes.push(attribute);
    });
    this.tubeGeometry.instanceCount = 0;

    this.tubeMaterial = new THREE.ShaderMaterial({
      vertexShader: tubeVertexShader,
      fragmentShader: tubeFragmentShader,
      uniforms: {
        uRadius: { value: this.options.loopRadius },
        uColor: { value: new THREE.Color(...SS_WHITE) },
        uLightDirection: { value: new THREE.Vector3(0, 0, 1) },
        uDiffuse: { value: 0.5 },
      },
    });

    this.tubeMesh = new THREE.Mesh(this.tubeGeometry, this.tubeMaterial);
    this.tubeMesh.frustumCulled = false;
    this.add(this.tubeMesh);

    const pipeGeometry = new THREE.CylinderGeometry(1, 1, 1, this.options.pipeSides, 1, false);
    this.pipeMesh = new THREE.InstancedMesh(
      pipeGeometry,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0 }),
      this.options.maxHelices,
    );
    this.pipeMesh.count = 0;
    this.pipeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pipeMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
    this.pipeMesh.frustumCulled = false;
    this.add(this.pipeMesh);

    this.plateMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(
        (SS_COLORS[SS_SHEET] ?? SS_WHITE)[0],
        (SS_COLORS[SS_SHEET] ?? SS_WHITE)[1],
        (SS_COLORS[SS_SHEET] ?? SS_WHITE)[2],
        THREE.SRGBColorSpace,
      ),
      roughness: 0.55,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    this.add(this.platesGroup);
  }

  get hasData(): boolean {
    return this.backboneSegments > 0;
  }

  get ribbonResidues(): ReadonlySet<number> {
    return this.drawnResidues;
  }

  setTopology(
    atomNames: string[],
    atomResidues: ArrayLike<number>,
    residueNames: string[],
    residueChains: ArrayLike<number>,
    particleFilter: Set<number> | null = null,
  ) {
    const polypeptides = extractPolypeptides(
      atomNames, atomResidues, residueNames, residueChains, particleFilter,
    );

    this.clearRuns();

    this.sequences = polypeptides.sequences;
    this.caIndices = polypeptides.caIndices;
    this.vertexCount = this.caIndices.length;
    this.backboneSegments = Math.min(
      Math.max(0, this.vertexCount - this.sequences.length),
      this.tubeLimit,
    );

    this.drawnResidues = new Set<number>();
    for (const sequence of polypeptides.residueSequences) {
      for (const residue of sequence) {
        this.drawnResidues.add(residue);
      }
    }

    const n3 = this.vertexCount * 3;
    this.tangents = new Float32Array(n3);
    this.normals = new Float32Array(n3);
    this.helixFade = new Float32Array(this.vertexCount);
    this.axisProj = new Float32Array(n3);
    this.axisDir = new Float32Array(n3);
    this.axisNormal = new Float32Array(n3);
    this.vertexSheetRun = new Int32Array(this.vertexCount);

    this.topologyVersion += 1;
    this.dsspWorker.postMessage({
      type: "build",
      topologyVersion: this.topologyVersion,
      residueSequences: polypeptides.residueSequences,
      atomNames,
      atomResidues: Array.from(atomResidues),
    });
    this.dsspTimer = Infinity;
    this.dsspDirty = true;
    this.dsspInFlight = false;

    if (this.lastPositions) {
      this.setPositions(this.lastPositions);
    } else {
      this.tubeGeometry.instanceCount = 0;
      this.pipeMesh.count = 0;
    }
  }

  setPositions(positions: ArrayLike<number>) {
    this.lastPositions = positions;
    if (this.vertexCount === 0) {
      this.tubeGeometry.instanceCount = 0;
      this.pipeMesh.count = 0;
      return;
    }

    for (const { offset, length } of this.sequences) {
      computeSplineFrames(positions, this.caIndices, offset, length, this.tangents, this.normals);
    }

    this.refreshGeometry();
    this.dsspDirty = true;
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.vertexCount === 0) {
      return;
    }

    this.tubeMaterial.uniforms.uLightDirection.value
      .set(0, 0, 1)
      .applyQuaternion(camera.getWorldQuaternion(scratchQuaternion));

    this.dsspTimer += dt;
    if (
      this.dsspTimer >= this.options.dsspInterval
      && this.dsspDirty
      && this.lastPositions
      && !this.dsspInFlight
    ) {
      this.dsspTimer = 0;
      this.dsspDirty = false;
      this.requestDsspCalculation(this.lastPositions);
    }

    if (this.fadeRuns(dt)) {
      this.refreshGeometry();
    }
  }

  dispose() {
    this.clearRuns();
    this.dsspWorker.terminate();
    this.tubeGeometry.dispose();
    this.tubeMaterial.dispose();
    this.pipeMesh.geometry.dispose();
    (this.pipeMesh.material as THREE.Material).dispose();
    this.plateMaterial.dispose();
  }

  private requestDsspCalculation(positions: ArrayLike<number>) {
    const positionCopy = Float32Array.from(positions);
    this.dsspInFlight = true;
    this.dsspWorker.postMessage(
      {
        type: "calculate",
        topologyVersion: this.topologyVersion,
        requestId: ++this.dsspRequestId,
        positions: positionCopy,
      },
      [positionCopy.buffer],
    );
  }

  private runKey(type: number, start: number, end: number): string {
    return `${type}:${start}:${end}`;
  }

  private clearRuns() {
    for (const run of this.runs.values()) {
      this.disposeRun(run);
    }
    this.runs.clear();
  }

  private disposeRun(run: Run) {
    if (run.mesh) {
      this.platesGroup.remove(run.mesh);
      run.mesh = null;
    }
    if (run.geometry) {
      run.geometry.dispose();
      run.geometry = null;
    }
    run.curvePoints = null;
    run.binormals = null;
  }

  private updateRuns(assignments: Uint8Array) {
    if (assignments.length !== this.vertexCount) {
      return;
    }

    const alive = new Set<string>();

    for (const { offset, length } of this.sequences) {
      let runStart = -1;
      let runType = -1;
      for (let i = 0; i <= length; ++i) {
        const v = offset + i;
        const last = i >= length;
        const ss = last ? 0 : assignments[v];
        const type = last
          ? -1
          : (ss & SS_HELIX_MASK) !== 0
            ? RUN_HELIX
            : ss === SS_SHEET
              ? RUN_SHEET
              : -1;

        if (!last && type === runType && runStart >= 0) {
          continue;
        }

        if (runStart >= 0) {
          const runLength = v - runStart;
          const minLength = runType === RUN_HELIX
            ? this.options.minHelixRun
            : this.options.minSheetRun;
          if (runLength >= minLength) {
            const key = this.runKey(runType, runStart, v - 1);
            alive.add(key);
            if (!this.runs.has(key)) {
              const run: Run = {
                type: runType,
                start: runStart,
                end: v - 1,
                ss: assignments[runStart + (runLength >> 1)],
                fade: 0,
                target: 1,
                axis: null,
                extent: null,
                mesh: null,
                geometry: null,
                stations: 0,
                curvePoints: null,
                binormals: null,
              };
              if (runType === RUN_SHEET) {
                this.buildPlate(run);
              }
              this.runs.set(key, run);
            }
          }
        }

        runStart = last || type < 0 ? -1 : v;
        runType = type;
      }
    }

    for (const [key, run] of this.runs) {
      run.target = alive.has(key) ? 1 : 0;
    }
  }

  private fadeRuns(dt: number): boolean {
    const delta = this.options.fadeSpeed * dt;
    let changed = false;

    for (const [key, run] of this.runs) {
      const next = moveTowards(run.fade, run.target, delta);
      if (next !== run.fade) {
        run.fade = next;
        changed = true;
      }
      if (run.target === 0 && run.fade <= 0.001) {
        this.disposeRun(run);
        this.runs.delete(key);
        changed = true;
      }
    }

    return changed;
  }

  // --- geometry refresh -----------------------------------------------------

  private refreshGeometry() {
    const positions = this.lastPositions;
    if (!positions) {
      return;
    }

    const ca = this.caIndices;

    // default axis data: no snapping
    this.helixFade.fill(0);
    this.vertexSheetRun.fill(-1);
    for (let v = 0; v < this.vertexCount; ++v) {
      this.axisProj[v * 3] = positions[ca[v] * 3];
      this.axisProj[v * 3 + 1] = positions[ca[v] * 3 + 1];
      this.axisProj[v * 3 + 2] = positions[ca[v] * 3 + 2];
    }

    this.runArray.length = 0;
    for (const run of this.runs.values()) {
      const index = this.runArray.length;
      this.runArray.push(run);

      if (run.fade <= 0.001) continue;

      if (run.type === RUN_HELIX) {
        if (this.fitHelixAxis(positions, run)) {
          for (let v = run.start; v <= run.end; ++v) {
            this.helixFade[v] = Math.max(this.helixFade[v], run.fade);
          }
        }
      } else if (run.target === 1) {
        for (let v = run.start; v <= run.end; ++v) {
          this.vertexSheetRun[v] = index;
        }
      }
    }

    this.assembleTubes(positions);
    this.updatePipes();
    this.updatePlates(positions);
  }

  private fitHelixAxis(positions: ArrayLike<number>, run: Run): boolean {
    const ca = this.caIndices;
    const length = run.end - run.start + 1;
    let dx = 0, dy = 0, dz = 0;
    for (let v = run.start; v <= run.end; ++v) {
      const s = v * 3;
      const len = Math.hypot(this.tangents[s], this.tangents[s + 1], this.tangents[s + 2]);
      if (len < 1e-9) continue;
      dx += this.tangents[s] / len;
      dy += this.tangents[s + 1] / len;
      dz += this.tangents[s + 2] / len;
    }
    if (Math.hypot(dx, dy, dz) < 1e-6) {
      const first = ca[run.start] * 3;
      const last = ca[run.end] * 3;
      dx = positions[last] - positions[first];
      dy = positions[last + 1] - positions[first + 1];
      dz = positions[last + 2] - positions[first + 2];
      if (Math.hypot(dx, dy, dz) < 1e-9) return false;
    }
    const dlen = Math.hypot(dx, dy, dz);
    dx /= dlen;
    dy /= dlen;
    dz /= dlen;

    let cx = 0, cy = 0, cz = 0;
    for (let v = run.start; v <= run.end; ++v) {
      const a = ca[v] * 3;
      cx += positions[a];
      cy += positions[a + 1];
      cz += positions[a + 2];
    }
    cx /= length;
    cy /= length;
    cz /= length;

    const mid = (run.start + (length >> 1)) * 3;
    let nx = this.normals[mid];
    let ny = this.normals[mid + 1];
    let nz = this.normals[mid + 2];
    const dn = nx * dx + ny * dy + nz * dz;
    nx -= dn * dx;
    ny -= dn * dy;
    nz -= dn * dz;
    if (Math.hypot(nx, ny, nz) < 1e-6) {
      nx = 0;
      ny = dz;
      nz = -dy;
      if (Math.hypot(nx, ny, nz) < 1e-6) {
        nx = -dz;
        ny = 0;
        nz = dx;
      }
    }
    const nlen = Math.hypot(nx, ny, nz);
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;

    let tmin = 0;
    let tmax = 0;
    for (let v = run.start; v <= run.end; ++v) {
      const a = ca[v] * 3;
      const t = (positions[a] - cx) * dx + (positions[a + 1] - cy) * dy + (positions[a + 2] - cz) * dz;
      this.axisProj[v * 3] = cx + dx * t;
      this.axisProj[v * 3 + 1] = cy + dy * t;
      this.axisProj[v * 3 + 2] = cz + dz * t;
      this.axisDir[v * 3] = dx;
      this.axisDir[v * 3 + 1] = dy;
      this.axisDir[v * 3 + 2] = dz;
      this.axisNormal[v * 3] = nx;
      this.axisNormal[v * 3 + 1] = ny;
      this.axisNormal[v * 3 + 2] = nz;

      if (v === run.start || t < tmin) tmin = t;
      if (v === run.start || t > tmax) tmax = t;
    }

    run.axis = [cx, cy, cz, dx, dy, dz];
    run.extent = [tmin, tmax];
    return true;
  }

  // --- loop tubes -----------------------------------------------------------

  private writeTubeVertexFrame(
    seg: number,
    end: 0 | 1,
    v: number,
    positions: ArrayLike<number>,
  ) {
    const [startPoints, endPoints, startTangents, endTangents, startNormals, endNormals] =
      this.tubeBuffers;

    const point = end === 0 ? startPoints : endPoints;
    const tangent = end === 0 ? startTangents : endTangents;
    const normal = end === 0 ? startNormals : endNormals;

    const h = this.helixFade[v];
    const a = this.caIndices[v] * 3;
    const s = v * 3;

    point[seg * 3] = positions[a] + (this.axisProj[s] - positions[a]) * h;
    point[seg * 3 + 1] = positions[a + 1] + (this.axisProj[s + 1] - positions[a + 1]) * h;
    point[seg * 3 + 2] = positions[a + 2] + (this.axisProj[s + 2] - positions[a + 2]) * h;

    const rawLen = Math.hypot(this.tangents[s], this.tangents[s + 1], this.tangents[s + 2]);
    tangent[seg * 3] = this.tangents[s] + (this.axisDir[s] * rawLen - this.tangents[s]) * h;
    tangent[seg * 3 + 1] = this.tangents[s + 1] + (this.axisDir[s + 1] * rawLen - this.tangents[s + 1]) * h;
    tangent[seg * 3 + 2] = this.tangents[s + 2] + (this.axisDir[s + 2] * rawLen - this.tangents[s + 2]) * h;

    let nx = this.normals[s] + (this.axisNormal[s] - this.normals[s]) * h;
    let ny = this.normals[s + 1] + (this.axisNormal[s + 1] - this.normals[s + 1]) * h;
    let nz = this.normals[s + 2] + (this.axisNormal[s + 2] - this.normals[s + 2]) * h;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen > 1e-9) {
      nx /= nlen;
      ny /= nlen;
      nz /= nlen;
    } else {
      nx = this.normals[s];
      ny = this.normals[s + 1];
      nz = this.normals[s + 2];
    }
    normal[seg * 3] = nx;
    normal[seg * 3 + 1] = ny;
    normal[seg * 3 + 2] = nz;
  }

  private writeArrowTipFrame(seg: number, run: Run, positions: ArrayLike<number>) {
    const [startPoints, startTangents, startNormals] = this.tubeBuffers;

    const e = run.end * 3;
    const a = this.caIndices[run.end] * 3;

    const tlen = Math.hypot(this.tangents[e], this.tangents[e + 1], this.tangents[e + 2]);
    if (tlen < 1e-9) {
      this.writeTubeVertexFrame(seg, 0, run.end, positions);
      return;
    }

    const dx = this.tangents[e] / tlen;
    const dy = this.tangents[e + 1] / tlen;
    const dz = this.tangents[e + 2] / tlen;
    const tip = this.options.arrowLength;

    startPoints[seg * 3] = positions[a] + dx * tip;
    startPoints[seg * 3 + 1] = positions[a + 1] + dy * tip;
    startPoints[seg * 3 + 2] = positions[a + 2] + dz * tip;

    startTangents[seg * 3] = dx * tlen;
    startTangents[seg * 3 + 1] = dy * tlen;
    startTangents[seg * 3 + 2] = dz * tlen;

    startNormals[seg * 3] = this.normals[e];
    startNormals[seg * 3 + 1] = this.normals[e + 1];
    startNormals[seg * 3 + 2] = this.normals[e + 2];
  }

  private assembleTubes(positions: ArrayLike<number>) {
    let seg = 0;
    for (const { offset, length } of this.sequences) {
      for (let i = 0; i < length - 1 && seg < this.tubeLimit; ++i) {
        const a = offset + i;
        const b = offset + i + 1;

        const runA = this.vertexSheetRun[a];
        const runB = this.vertexSheetRun[b];

        if (runA >= 0 && runA === runB) {
          continue;
        }

        if (runA >= 0 && this.runArray[runA].end === a) {
          this.writeArrowTipFrame(seg, this.runArray[runA], positions);
          this.writeTubeVertexFrame(seg, 1, b, positions);
          seg += 1;
          continue;
        }

        this.writeTubeVertexFrame(seg, 0, a, positions);
        this.writeTubeVertexFrame(seg, 1, b, positions);
        seg += 1;
      }
    }

    for (const attribute of this.tubeAttributes) {
      attribute.needsUpdate = true;
    }
    this.tubeGeometry.instanceCount = seg;
  }

  // --- helix pipes ----------------------------------------------------------

  private updatePipes() {
    let count = 0;

    for (const run of this.runs.values()) {
      if (run.type !== RUN_HELIX || run.fade <= 0.005 || count >= this.options.maxHelices) {
        continue;
      }

      const axis = run.axis;
      const extent = run.extent;
      if (!axis || !extent) continue;
      const [cx, cy, cz, dx, dy, dz] = axis;
      const [tmin, tmax] = extent;
      const length = tmax - tmin;
      if (length < 1e-4) continue;

      scratchDirection.set(dx, dy, dz);
      scratchQuaternion.setFromUnitVectors(UP, scratchDirection);
      scratchPosition.set(
        cx + dx * (tmin + tmax) * 0.5,
        cy + dy * (tmin + tmax) * 0.5,
        cz + dz * (tmin + tmax) * 0.5,
      );
      const radius = this.options.helixRadius * run.fade;
      scratchScale.set(radius, length, radius);
      scratchMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
      this.pipeMesh.setMatrixAt(count, scratchMatrix);

      const color = SS_COLORS[run.ss] ?? SS_WHITE;
      scratchColor.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
      this.pipeMesh.setColorAt(count, scratchColor);

      count += 1;
    }

    this.pipeMesh.count = count;
    if (count > 0) {
      this.pipeMesh.instanceMatrix.needsUpdate = true;
      if (this.pipeMesh.instanceColor) {
        this.pipeMesh.instanceColor.needsUpdate = true;
      }
    }
  }


  private buildPlate(run: Run) {
    const residueCount = run.end - run.start + 1;
    const pointCount = residueCount + 1;
    const sps = this.options.stationsPerSegment;
    const stations = residueCount * sps;
    run.stations = stations;
    run.curvePoints = Array.from({ length: pointCount }, () => new THREE.Vector3());
    run.binormals = new Float32Array(pointCount * 3);

    const vertexCount = (stations + 1) * 4;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(vertexCount * 3);
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const indices: number[] = [];
    const corner = (station: number, c: number) => station * 4 + c;
    for (let j = 0; j < stations; ++j) {
      for (let k = 0; k < 4; ++k) {
        const a = corner(j, k);
        const b = corner(j, (k + 1) % 4);
        const c = corner(j + 1, (k + 1) % 4);
        const d = corner(j + 1, k);
        indices.push(a, b, c, a, c, d);
      }
    }
    indices.push(corner(0, 0), corner(0, 1), corner(0, 2));
    indices.push(corner(0, 0), corner(0, 2), corner(0, 3));
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

    const mesh = new THREE.Mesh(geometry, this.plateMaterial);
    mesh.frustumCulled = false;
    mesh.visible = false;

    run.geometry = geometry;
    run.mesh = mesh;
    this.platesGroup.add(mesh);
  }

  private plateHalfWidth(d: number, headLen: number): number {
    const { sheetWidth, arrowExtra } = this.options;
    if (headLen <= 1e-6 || d >= headLen) {
      return sheetWidth;
    }
    const wide = sheetWidth * (1 + arrowExtra);
    return wide * (d / headLen);
  }

  private updatePlates(positions: ArrayLike<number>) {
    for (const run of this.runs.values()) {
      if (run.type !== RUN_SHEET || !run.geometry || !run.mesh) {
        continue;
      }
      if (run.fade <= 0.005) {
        run.mesh.visible = false;
        continue;
      }
      this.writePlatePositions(run, positions);
      run.mesh.visible = true;
    }
  }

  private writePlatePositions(run: Run, positions: ArrayLike<number>) {
    const geometry = run.geometry!;
    const curvePoints = run.curvePoints!;
    const binormals = run.binormals!;
    const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;

    const ca = this.caIndices;
    const stations = run.stations;
    const residueCount = run.end - run.start + 1;
    const { sheetThickness, arrowLength } = this.options;

    let totalLen = arrowLength;
    let prevX = 0, prevY = 0, prevZ = 0;
    for (let k = 0; k < residueCount; ++k) {
      const v = run.start + k;
      const a = ca[v] * 3;
      const x = positions[a];
      const y = positions[a + 1];
      const z = positions[a + 2];
      curvePoints[k].set(x, y, z);
      if (k > 0) {
        totalLen += Math.hypot(x - prevX, y - prevY, z - prevZ);
      }
      prevX = x;
      prevY = y;
      prevZ = z;

      const s = v * 3;
      let bx = this.tangents[s + 1] * this.normals[s + 2] - this.tangents[s + 2] * this.normals[s + 1];
      let by = this.tangents[s + 2] * this.normals[s] - this.tangents[s] * this.normals[s + 2];
      let bz = this.tangents[s] * this.normals[s + 1] - this.tangents[s + 1] * this.normals[s];
      const blen = Math.hypot(bx, by, bz);
      if (blen > 1e-9) {
        bx /= blen;
        by /= blen;
        bz /= blen;
      }
      binormals[k * 3] = bx;
      binormals[k * 3 + 1] = by;
      binormals[k * 3 + 2] = bz;
    }

    const e = run.end * 3;
    const lastA = ca[run.end] * 3;
    const tlen = Math.hypot(this.tangents[e], this.tangents[e + 1], this.tangents[e + 2]) || 1;
    const dirX = this.tangents[e] / tlen;
    const dirY = this.tangents[e + 1] / tlen;
    const dirZ = this.tangents[e + 2] / tlen;
    curvePoints[residueCount].set(
      positions[lastA] + dirX * arrowLength,
      positions[lastA + 1] + dirY * arrowLength,
      positions[lastA + 2] + dirZ * arrowLength,
    );
    binormals[residueCount * 3] = binormals[(residueCount - 1) * 3];
    binormals[residueCount * 3 + 1] = binormals[(residueCount - 1) * 3 + 1];
    binormals[residueCount * 3 + 2] = binormals[(residueCount - 1) * 3 + 2];

    this.plateCurve.points = curvePoints;

    const headLen = Math.min(this.options.headLength, totalLen);
    const curveSegments = curvePoints.length - 1;
    const delta = 0.001;

    let lastBx = binormals[0];
    let lastBy = binormals[1];
    let lastBz = binormals[2];

    for (let j = 0; j <= stations; ++j) {
      const t = j / stations;

      this.plateCurve.getPoint(t, scratchPosition);

      const t1 = Math.max(t - delta, 0);
      const t2 = Math.min(t + delta, 1);
      this.plateCurve.getPoint(t1, scratchPointA);
      this.plateCurve.getPoint(t2, scratchPointB);
      scratchTangent.copy(scratchPointB).sub(scratchPointA);
      if (scratchTangent.lengthSq() < 1e-14) {
        scratchTangent.set(dirX, dirY, dirZ);
      }
      scratchTangent.normalize();

      const ft = t * curveSegments;
      const segIndex = Math.min(Math.floor(ft), curveSegments - 1);
      const tau = ft - segIndex;
      const b1 = segIndex * 3;
      const b2 = b1 + 3;
      let bdot = binormals[b1] * binormals[b2]
        + binormals[b1 + 1] * binormals[b2 + 1]
        + binormals[b1 + 2] * binormals[b2 + 2];
      const sign = bdot < 0 ? -1 : 1;
      scratchBinormal.set(
        binormals[b1] + (sign * binormals[b2] - binormals[b1]) * tau,
        binormals[b1 + 1] + (sign * binormals[b2 + 1] - binormals[b1 + 1]) * tau,
        binormals[b1 + 2] + (sign * binormals[b2 + 2] - binormals[b1 + 2]) * tau,
      );
      bdot = scratchBinormal.dot(scratchTangent);
      scratchBinormal.addScaledVector(scratchTangent, -bdot);
      if (scratchBinormal.lengthSq() < 1e-12) {
        scratchBinormal.set(lastBx, lastBy, lastBz);
        scratchBinormal.addScaledVector(scratchTangent, -scratchBinormal.dot(scratchTangent));
        if (scratchBinormal.lengthSq() < 1e-12) {
          scratchBinormal.set(1, 0, 0);
          scratchBinormal.addScaledVector(scratchTangent, -scratchBinormal.dot(scratchTangent));
        }
      }
      scratchBinormal.normalize();
      lastBx = scratchBinormal.x;
      lastBy = scratchBinormal.y;
      lastBz = scratchBinormal.z;

      scratchNormal.crossVectors(scratchBinormal, scratchTangent).normalize();

      const d = (1 - t) * totalLen;
      const w = this.plateHalfWidth(d, headLen) * run.fade;
      const h = sheetThickness;

      const bx = scratchBinormal.x, by = scratchBinormal.y, bz = scratchBinormal.z;
      const nx = scratchNormal.x, ny = scratchNormal.y, nz = scratchNormal.z;
      const px = scratchPosition.x, py = scratchPosition.y, pz = scratchPosition.z;

      const base = j * 12;
      array[base]     = px + bx * w + nx * h;
      array[base + 1] = py + by * w + ny * h;
      array[base + 2] = pz + bz * w + nz * h;
      array[base + 3] = px + bx * w - nx * h;
      array[base + 4] = py + by * w - ny * h;
      array[base + 5] = pz + bz * w - nz * h;
      array[base + 6] = px - bx * w - nx * h;
      array[base + 7] = py - by * w - ny * h;
      array[base + 8] = pz - bz * w - nz * h;
      array[base + 9]  = px - bx * w + nx * h;
      array[base + 10] = py - by * w + ny * h;
      array[base + 11] = pz - bz * w + nz * h;
    }

    attribute.needsUpdate = true;
  }
}

export default SimpleCartoonRenderer;
