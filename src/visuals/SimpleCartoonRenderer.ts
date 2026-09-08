"use strict";

import * as THREE from "three";
import {
  computeSplineFrames,
  DsspCalculator,
  extractPolypeptides,
  Sequence,
  SS_COLORS,
  SS_HELIX_MASK,
  SS_SHEET,
  SS_WHITE,
} from "./protein-structure";

// Simple ("classical") cartoon renderer, drawing the secondary structure as
// rigid geometric primitives in the style of the original ribbon diagrams:
//
//  - alpha helices -> one rigid cylinder ("pipe") per helix, placed along the
//    fitted helix axis (a single instanced cylinder, updated by matrix only)
//  - beta strands  -> one uniform extruded plate ("arrow") per strand: a single
//    continuous geometry swept along the smoothed strand path with evenly
//    resampled stations, flaring into an arrow head at the C-terminal end
//  - loops/coils   -> a thin constant-radius tube following the alpha carbon
//    hermite spline, connecting pipes and plates (drawn along the whole
//    backbone; inside helices it is blended onto the pipe axis and hidden
//    inside the pipe/plate volumes)
//
// Unlike the spline CartoonRenderer, no cross sections morph between residues:
// pipes are perfectly rigid cylinders, plates are uniform slabs. Elements grow
// and shrink smoothly (pipe radius, plate width) as the DSSP assignment, which
// is recomputed about once a second, fades in and out per helix/strand run.

export interface SimpleCartoonRendererOptions {
  maxResidues?: number;
  maxHelices?: number;
  // radius of loop tubes (nm)
  loopRadius?: number;
  // radius of helix pipes (nm)
  helixRadius?: number;
  // half width of beta plates (nm)
  sheetWidth?: number;
  // half thickness of beta plates (nm)
  sheetThickness?: number;
  // extra width factor of the arrow head over the plate body
  arrowExtra?: number;
  // physical length of the arrow head region, measured back from the tip (nm)
  headLength?: number;
  // length of the arrow head past the last strand residue (nm)
  arrowLength?: number;
  // lengthwise subdivisions of each tube segment
  tubeSegments?: number;
  // radial subdivisions of the tube cylinder
  tubeSides?: number;
  // radial subdivisions of helix pipes
  pipeSides?: number;
  // path stations per hermite segment when extruding plates
  stationsPerSegment?: number;
  // seconds between DSSP recalculations
  dsspInterval?: number;
  // fade speed (per second) of element grow/shrink transitions
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
  tubeSegments: 16,
  tubeSides: 12,
  pipeSides: 16,
  stationsPerSegment: 4,
  dsspInterval: 1.0,
  fadeSpeed: 0.5,
};

// --- thin constant-radius tube along a hermite spline segment ---------------

const TUBE_VERTEX_SHADER = /* glsl */ `
attribute vec3 aStartPoint;
attribute vec3 aEndPoint;
attribute vec3 aStartTangent;
attribute vec3 aEndTangent;
attribute vec3 aStartNormal;
attribute vec3 aEndNormal;

uniform float uRadius;

varying vec3 vNormal;

vec3 hermitePoint(float t, vec3 p1, vec3 m1, vec3 p2, vec3 m2) {
  float t2 = t * t;
  float t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * p1
       + (t3 - 2.0 * t2 + t) * m1
       + (-2.0 * t3 + 3.0 * t2) * p2
       + (t3 - t2) * m2;
}

vec3 hermiteTangent(float t, vec3 p1, vec3 m1, vec3 p2, vec3 m2) {
  float t2 = t * t;
  return (6.0 * t2 - 6.0 * t) * p1
       + (3.0 * t2 - 4.0 * t + 1.0) * m1
       + (-6.0 * t2 + 6.0 * t) * p2
       + (3.0 * t2 - 2.0 * t) * m2;
}

void main() {
  float bias = position.y;
  vec2 u = normalize(position.xz);

  vec3 pos = hermitePoint(bias, aStartPoint, aStartTangent, aEndPoint, aEndTangent);
  vec3 tangent = normalize(hermiteTangent(bias, aStartPoint, aStartTangent, aEndPoint, aEndTangent));

  // flip-free reference frame from the averaged start/end binormals
  vec3 startBinormal = normalize(cross(aStartTangent, aStartNormal));
  vec3 endBinormal = normalize(cross(aEndTangent, aEndNormal));
  vec3 referenceBinormal = startBinormal + endBinormal;
  referenceBinormal -= dot(referenceBinormal, tangent) * tangent;
  referenceBinormal = normalize(referenceBinormal);
  vec3 referenceNormal = normalize(cross(referenceBinormal, tangent));

  vec3 local = pos + uRadius * (referenceBinormal * u.x + referenceNormal * u.y);
  vNormal = normalize(mat3(modelMatrix) * (referenceBinormal * u.x + referenceNormal * u.y));

  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(local, 1.0);
}
`;

const TUBE_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uLightDirection;
uniform vec3 uColor;
uniform float uDiffuse;

varying vec3 vNormal;

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightDirection);
  vec3 color = uColor * clamp(mix(1.0, dot(n, l), uDiffuse), 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

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
  // vertex indices (into the flattened alpha carbon list), inclusive
  start: number;
  end: number;
  // secondary structure assignment (helix family) for coloring
  ss: number;
  fade: number;
  target: number;
  // helix only: fitted axis (cx, cy, cz, dx, dy, dz) and projection extent
  axis: [number, number, number, number, number, number] | null;
  extent: [number, number] | null;
  // plate only
  mesh: THREE.Mesh | null;
  geometry: THREE.BufferGeometry | null;
  stations: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const scratchQuaternion = new THREE.Quaternion();
const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchDirection = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) {
    return target;
  }
  return current + Math.sign(target - current) * maxDelta;
}

function hermitePoint(t: number, p1: number, m1: number, p2: number, m2: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
}

function hermiteTangent(t: number, p1: number, m1: number, p2: number, m2: number): number {
  const t2 = t * t;
  return (6 * t2 - 6 * t) * p1 + (3 * t2 - 4 * t + 1) * m1 + (-6 * t2 + 6 * t) * p2 + (3 * t2 - 2 * t) * m2;
}

export class SimpleCartoonRenderer extends THREE.Object3D {
  private readonly options: Required<SimpleCartoonRendererOptions>;

  // thin loop tube (instanced hermite spline segments)
  private readonly tubeGeometry: THREE.InstancedBufferGeometry;
  private readonly tubeMaterial: THREE.ShaderMaterial;
  private readonly tubeMesh: THREE.Mesh;
  private readonly tubeBuffers: Float32Array[];
  private readonly tubeAttributes: THREE.InstancedBufferAttribute[] = [];
  private readonly tubeLimit: number;

  // rigid helix pipes (one instanced cylinder, matrix per helix)
  private readonly pipeMesh: THREE.InstancedMesh;

  // beta plates (one extruded arrow geometry per strand run)
  private readonly platesGroup = new THREE.Group();
  private readonly plateMaterial: THREE.MeshStandardMaterial;

  private sequences: Sequence[] = [];
  private caIndices = new Int32Array(0);
  private drawnResidues = new Set<number>();
  private vertexCount = 0;
  private backboneSegments = 0;

  private tangents = new Float32Array(0);
  private normals = new Float32Array(0);

  // per-vertex blend toward the axis of the helix run covering it
  private helixFade = new Float32Array(0);
  private axisProj = new Float32Array(0);
  private axisDir = new Float32Array(0);
  private axisNormal = new Float32Array(0);

  private runs = new Map<string, Run>();

  private lastPositions: ArrayLike<number> | null = null;

  private readonly dssp = new DsspCalculator();
  private dsspTimer = Infinity;
  private dsspDirty = false;

  constructor(userOptions: SimpleCartoonRendererOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...userOptions };

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
      vertexShader: TUBE_VERTEX_SHADER,
      fragmentShader: TUBE_FRAGMENT_SHADER,
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
      color: new THREE.Color(...(SS_COLORS[SS_SHEET] ?? SS_WHITE)),
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

  // Residues covered by the ribbon drawing (its whole polypeptide path), used
  // to decide which particles the ball-and-stick renderer should skip.
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

    this.dssp.build(polypeptides.residueSequences, atomNames, atomResidues);
    this.dsspTimer = Infinity;
    this.dsspDirty = true;

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

    // headlamp: the light direction points back toward the camera
    this.tubeMaterial.uniforms.uLightDirection.value
      .set(0, 0, 1)
      .applyQuaternion(camera.getWorldQuaternion(scratchQuaternion));

    this.dsspTimer += dt;
    if (this.dsspTimer >= this.options.dsspInterval && this.dsspDirty && this.lastPositions) {
      this.dsspTimer = 0;
      this.dsspDirty = false;
      this.updateRuns(this.dssp.calculate(this.lastPositions));
    }

    if (this.fadeRuns(dt)) {
      this.refreshGeometry();
    }
  }

  dispose() {
    this.clearRuns();
    this.tubeGeometry.dispose();
    this.tubeMaterial.dispose();
    this.pipeMesh.geometry.dispose();
    (this.pipeMesh.material as THREE.Material).dispose();
    this.plateMaterial.dispose();
  }

  // --- runs (contiguous helices / strands) ----------------------------------

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

        if (runStart >= 0 && v - runStart >= 2) {
          const key = this.runKey(runType, runStart, v - 1);
          alive.add(key);
          if (!this.runs.has(key)) {
            const run: Run = {
              type: runType,
              start: runStart,
              end: v - 1,
              ss: assignments[runStart + ((v - runStart) >> 1)],
              fade: 0,
              target: 1,
              axis: null,
              extent: null,
              mesh: null,
              geometry: null,
              stations: 0,
            };
            if (runType === RUN_SHEET) {
              this.buildPlate(run);
            }
            this.runs.set(key, run);
          }
        }

        runStart = last || type < 0 ? -1 : v;
        runType = type;
      }
    }

    for (const [key, run] of this.runs) {
      if (alive.has(key)) {
        run.target = 1;
      } else {
        run.target = 0;
      }
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
    for (let v = 0; v < this.vertexCount; ++v) {
      this.axisProj[v * 3] = positions[ca[v] * 3];
      this.axisProj[v * 3 + 1] = positions[ca[v] * 3 + 1];
      this.axisProj[v * 3 + 2] = positions[ca[v] * 3 + 2];
    }

    // fit the axis of every visible helix run, marking its vertices
    for (const run of this.runs.values()) {
      if (run.type !== RUN_HELIX || run.fade <= 0.001) continue;
      if (this.fitHelixAxis(positions, run)) {
        for (let v = run.start; v <= run.end; ++v) {
          this.helixFade[v] = Math.max(this.helixFade[v], run.fade);
        }
      }
    }

    this.assembleTubes(positions);
    this.updatePipes();
    this.updatePlates(positions);
  }

  // Fit the rigid axis of a helix run and store per-vertex projections.
  // Returns false for degenerate runs.
  private fitHelixAxis(positions: ArrayLike<number>, run: Run): boolean {
    const ca = this.caIndices;
    const length = run.end - run.start + 1;

    // direction: the transverse spiral components of the cardinal tangents
    // cancel over a helix, leaving the axial direction
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

    // axis point: centroid of the run's alpha carbons
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

    // a stable perpendicular normal for the pipe frame
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

  private assembleTubes(positions: ArrayLike<number>) {
    let seg = 0;
    for (const { offset, length } of this.sequences) {
      for (let i = 0; i < length - 1 && seg < this.tubeLimit; ++i, ++seg) {
        this.writeTubeVertexFrame(seg, 0, offset + i, positions);
        this.writeTubeVertexFrame(seg, 1, offset + i + 1, positions);
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
      scratchColor.setRGB(color[0], color[1], color[2]);
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

  // --- beta plates ----------------------------------------------------------

  private buildPlate(run: Run) {
    const segmentCount = run.end - run.start + 1; // hermite segments + arrow tip
    const sps = this.options.stationsPerSegment;
    const stations = segmentCount * sps;
    run.stations = stations;

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
    // start cap
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

  // Half width of the plate at a distance d (nm) back from the arrow tip:
  // constant body, flaring to the head width, then tapering to a point.
  private plateHalfWidth(d: number, headLen: number): number {
    const { sheetWidth, arrowExtra } = this.options;
    if (headLen <= 1e-6 || d >= headLen) {
      return sheetWidth;
    }
    const wide = sheetWidth * (1 + arrowExtra);
    const taperEnd = headLen * 0.6;
    if (d <= taperEnd) {
      return wide * (d / Math.max(taperEnd, 1e-6));
    }
    return wide + (sheetWidth - wide) * ((d - taperEnd) / (headLen - taperEnd));
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

  // Sweep the arrow cross section along the strand path: hermite segments
  // through the strand's alpha carbons plus a straight arrow head extension.
  private writePlatePositions(run: Run, positions: ArrayLike<number>) {
    const geometry = run.geometry!;
    const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;

    const sps = this.options.stationsPerSegment;
    const stations = run.stations;
    const segmentCount = run.end - run.start + 1;
    const { sheetThickness, arrowLength } = this.options;

    // approximate path length so the arrow head keeps a fixed physical size
    const ca = this.caIndices;
    let totalLen = arrowLength;
    for (let v = run.start; v < run.end; ++v) {
      const a = ca[v] * 3;
      const b = ca[v + 1] * 3;
      totalLen += Math.hypot(
        positions[b] - positions[a],
        positions[b + 1] - positions[a + 1],
        positions[b + 2] - positions[a + 2],
      );
    }
    const headLen = Math.min(this.options.headLength, totalLen);

    // segment endpoint frames (CA vertices; the tip segment extends the last)
    const p1 = [0, 0, 0], p2 = [0, 0, 0];
    const m1 = [0, 0, 0], m2 = [0, 0, 0];
    const n1 = [0, 0, 0], n2 = [0, 0, 0];

    for (let j = 0; j <= stations; ++j) {
      const segIndex = Math.min(Math.floor(j / sps), segmentCount - 1);
      const t = (j - segIndex * sps) / sps;

      this.plateSegmentFrame(run, segIndex, positions, p1, m1, n1, p2, m2, n2);

      const px = hermitePoint(t, p1[0], m1[0], p2[0], m2[0]);
      const py = hermitePoint(t, p1[1], m1[1], p2[1], m2[1]);
      const pz = hermitePoint(t, p1[2], m1[2], p2[2], m2[2]);
      let tx = hermiteTangent(t, p1[0], m1[0], p2[0], m2[0]);
      let ty = hermiteTangent(t, p1[1], m1[1], p2[1], m2[1]);
      let tz = hermiteTangent(t, p1[2], m1[2], p2[2], m2[2]);
      const tlen = Math.hypot(tx, ty, tz) || 1;
      tx /= tlen;
      ty /= tlen;
      tz /= tlen;

      // flip-free reference frame (averaged binormals, as in the paper)
      let b1x = n1[1] * m1[2] - n1[2] * m1[1];
      let b1y = n1[2] * m1[0] - n1[0] * m1[2];
      let b1z = n1[0] * m1[1] - n1[1] * m1[0];
      const b1len = Math.hypot(b1x, b1y, b1z) || 1;
      b1x /= b1len; b1y /= b1len; b1z /= b1len;
      let b2x = n2[1] * m2[2] - n2[2] * m2[1];
      let b2y = n2[2] * m2[0] - n2[0] * m2[2];
      let b2z = n2[0] * m2[1] - n2[1] * m2[0];
      const b2len = Math.hypot(b2x, b2y, b2z) || 1;
      b2x /= b2len; b2y /= b2len; b2z /= b2len;

      let bx = b1x + b2x;
      let by = b1y + b2y;
      let bz = b1z + b2z;
      const bt = bx * tx + by * ty + bz * tz;
      bx -= bt * tx; by -= bt * ty; bz -= bt * tz;
      const blen = Math.hypot(bx, by, bz) || 1;
      bx /= blen; by /= blen; bz /= blen;

      // normal = binormal x tangent
      const nx = by * tz - bz * ty;
      const ny = bz * tx - bx * tz;
      const nz = bx * ty - by * tx;

      const d = (1 - j / stations) * totalLen;
      const w = this.plateHalfWidth(d, headLen) * run.fade;
      const h = sheetThickness;

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

  private plateSegmentFrame(
    run: Run,
    segIndex: number,
    positions: ArrayLike<number>,
    p1: number[], m1: number[], n1: number[],
    p2: number[], m2: number[], n2: number[],
  ) {
    const ca = this.caIndices;
    const a = run.start + segIndex;
    const b = Math.min(a + 1, run.end);

    const ia = ca[a] * 3;
    const ib = ca[b] * 3;
    p1[0] = positions[ia]; p1[1] = positions[ia + 1]; p1[2] = positions[ia + 2];
    p2[0] = positions[ib]; p2[1] = positions[ib + 1]; p2[2] = positions[ib + 2];
    m1[0] = this.tangents[a * 3]; m1[1] = this.tangents[a * 3 + 1]; m1[2] = this.tangents[a * 3 + 2];
    m2[0] = this.tangents[b * 3]; m2[1] = this.tangents[b * 3 + 1]; m2[2] = this.tangents[b * 3 + 2];
    n1[0] = this.normals[a * 3]; n1[1] = this.normals[a * 3 + 1]; n1[2] = this.normals[a * 3 + 2];
    n2[0] = this.normals[b * 3]; n2[1] = this.normals[b * 3 + 1]; n2[2] = this.normals[b * 3 + 2];

    if (segIndex === run.end - run.start) {
      // straight arrow head extension past the last strand residue
      const len = Math.hypot(m2[0], m2[1], m2[2]) || 1;
      const dx = m2[0] / len;
      const dy = m2[1] / len;
      const dz = m2[2] / len;
      const tip = this.options.arrowLength;
      p1[0] = p2[0]; p1[1] = p2[1]; p1[2] = p2[2];
      m1[0] = dx * tip; m1[1] = dy * tip; m1[2] = dz * tip;
      p2[0] = p1[0] + dx * tip; p2[1] = p1[1] + dy * tip; p2[2] = p1[2] + dz * tip;
      m2[0] = dx * tip; m2[1] = dy * tip; m2[2] = dz * tip;
      n1[0] = n2[0]; n1[1] = n2[1]; n1[2] = n2[2];
    }
  }
}

export default SimpleCartoonRenderer;
