"use strict";

import * as THREE from "three";

// Port of the cartoon (ribbon) renderer from nanover-imd-xr, implementing the
// visually-continuous secondary structure rendering described in
// Jamieson-Binnie & Glowacki, Front. Comput. Sci. (2021),
// https://doi.org/10.3389/fcomp.2021.642172
//
// Pipeline (mirrors the Unity "cartoon" visualiser):
//  - polypeptide sequences are extracted from particle/residue names and chains
//  - a cardinal (hermite) spline passes through the alpha carbons, with normals
//    derived from the second derivative of the curve
//  - DSSP secondary structure is assigned at low frequency, and per-residue
//    colors/widths fade smoothly toward their targets
//  - each spline segment is drawn as an instanced cylinder, deformed on the GPU
//    by the vertex shader, which morphs the elliptical cross section between
//    segment end points instead of rotating it (avoiding twist flips)

export interface CartoonRendererOptions {
  maxResidues?: number;
  // radius of the tube core (nm)
  scale?: number;
  // half width of helix/sheet ribbons (nm)
  width?: number;
  // lengthwise subdivisions of each spline segment
  segments?: number;
  // radial subdivisions of each spline segment
  sides?: number;
  // seconds between DSSP recalculations
  dsspInterval?: number;
  // fade speed (per second) toward target colors/widths
  fadeSpeed?: number;
}

const DEFAULT_OPTIONS: Required<CartoonRendererOptions> = {
  maxResidues: 8192,
  scale: 0.05,
  width: 0.1,
  segments: 16,
  sides: 24,
  dsspInterval: 1.0,
  fadeSpeed: 0.5,
};

const STANDARD_AMINO_ACIDS = new Set([
  "ALA", "ARG", "ASN", "ASP", "CYS",
  "GLN", "GLU", "GLY", "HIS", "ILE",
  "LEU", "LYS", "MET", "PHE", "PRO",
  "SER", "THR", "TRP", "TYR", "VAL",
]);

const SS_NONE = 0;
const SS_ALPHA_HELIX = 1;
const SS_THREE_TEN_HELIX = 2;
const SS_PI_HELIX = 4;
const SS_SHEET = 8;

const PAT_NONE = 0;
const PAT_THREE_TURN = 1;
const PAT_FOUR_TURN = 2;
const PAT_FIVE_TURN = 4;
const PAT_PARALLEL_BRIDGE = 8;
const PAT_ANTIPARALLEL_BRIDGE = 16;

const SS_COLORS: Record<number, [number, number, number]> = {
  [SS_ALPHA_HELIX]: [1.0, 0.0, 0.5],
  [SS_THREE_TEN_HELIX]: [0.6, 0.0, 0.5],
  [SS_PI_HELIX]: [0.4, 0.0, 0.5],
  [SS_SHEET]: [1.0, 0.8, 0.0],
};
const SS_WHITE: [number, number, number] = [1.0, 1.0, 1.0];

const SS_WIDTHS: Record<number, number> = {
  [SS_ALPHA_HELIX]: 1,
  [SS_THREE_TEN_HELIX]: 1,
  [SS_PI_HELIX]: 1,
  [SS_SHEET]: 1,
};

const VERTEX_SHADER = /* glsl */ `
attribute vec3 aStartPoint;
attribute vec3 aEndPoint;
attribute vec3 aStartTangent;
attribute vec3 aEndTangent;
attribute vec3 aStartNormal;
attribute vec3 aEndNormal;
attribute vec3 aStartColor;
attribute vec3 aEndColor;
attribute float aStartScale;
attribute float aEndScale;

uniform float uRadius;

varying vec3 vColor;
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

vec2 normalizeSafe(vec2 v) {
  float mag = length(v);
  if (mag < 1e-9) return vec2(0.0);
  return v / mag;
}

void main() {
  // distance along the segment is encoded in the cylinder's y (0 to 1)
  float bias = position.y;
  float t = smoothstep(0.0, 1.0, bias);

  // cross section point on the unit circle
  vec2 vNorm = normalize(position.xz);

  vec3 pos = hermitePoint(bias, aStartPoint, aStartTangent, aEndPoint, aEndTangent);
  vec3 tangent = normalize(hermiteTangent(bias, aStartPoint, aStartTangent, aEndPoint, aEndTangent));

  // reference frame from the averaged start/end binormals
  vec3 startBinormal = normalize(cross(aStartTangent, aStartNormal));
  vec3 endBinormal = normalize(cross(aEndTangent, aEndNormal));
  vec3 referenceBinormal = startBinormal + endBinormal;
  referenceBinormal -= dot(referenceBinormal, tangent) * tangent;
  referenceBinormal = normalize(referenceBinormal);
  vec3 referenceNormal = normalize(cross(referenceBinormal, tangent));

  // major axis directions of the ellipse at either end, scaled by the ribbon width
  vec3 startNormal = aStartScale * normalize(cross(aStartNormal, aStartTangent));
  vec3 endNormal = aEndScale * normalize(cross(aEndNormal, aEndTangent));

  // morphing cross sections: one vector lerps toward the end normal, the other
  // toward the reflected end normal, superposing clockwise/counterclockwise twists
  vec3 normalA = mix(startNormal, endNormal, t);
  vec3 normalB = mix(-startNormal, endNormal, t);

  vec2 n1 = vec2(dot(normalA, referenceBinormal), dot(normalA, referenceNormal));
  vec2 n2 = vec2(dot(normalB, referenceBinormal), dot(normalB, referenceNormal));

  vec2 d1 = 0.5 * (n1 + n2);
  vec2 d2 = 0.5 * (n1 - n2);

  vec2 d1Norm = normalizeSafe(d1);
  vec2 d2Norm = normalizeSafe(d2);

  float dot1 = dot(vNorm, d1Norm);
  float dot2 = dot(vNorm, d2Norm);

  // tube core plus elliptical deformation
  vec2 crossSection = 0.5 * uRadius * vNorm
    + sign(dot1) * abs(dot1) * d1
    + sign(dot2) * abs(dot2) * d2;

  vec3 local = pos
    + referenceBinormal * crossSection.x
    + referenceNormal * crossSection.y;

  // approximate surface normal from the perpendiculars of the ellipse axes
  vec2 dd1 = vec2(d1.y, -d1.x);
  vec2 dd2 = vec2(d2.y, -d2.x);
  vec2 dd1Norm = normalizeSafe(dd1);
  vec2 dd2Norm = normalizeSafe(dd2);
  vec2 normalXZ = normalize(0.5 * uRadius * vNorm
    + dd1 * dot(dd1Norm, vNorm)
    + dd2 * dot(dd2Norm, vNorm));

  vec3 nrm = referenceBinormal * normalXZ.x + referenceNormal * normalXZ.y;

  vec4 world = modelMatrix * vec4(local, 1.0);
  vNormal = normalize(mat3(modelMatrix) * nrm);
  vColor = mix(pow(aStartColor, vec3(2.2)), pow(aEndColor, vec3(2.2)), t);

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uLightDirection;
uniform float uDiffuse;

varying vec3 vColor;
varying vec3 vNormal;

void main() {
  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightDirection);
  vec3 color = vColor * clamp(mix(1.0, dot(n, l), uDiffuse), 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

interface Sequence {
  offset: number;
  length: number;
}

const ATTRIBUTE_NAMES = [
  "aStartPoint",
  "aEndPoint",
  "aStartTangent",
  "aEndTangent",
  "aStartNormal",
  "aEndNormal",
  "aStartColor",
  "aEndColor",
  "aStartScale",
  "aEndScale",
] as const;

export class CartoonRenderer extends THREE.Object3D {
  readonly mesh: THREE.Mesh;

  private readonly options: Required<CartoonRendererOptions>;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly instanceBuffers: Float32Array[];
  private readonly pointAttributes: THREE.InstancedBufferAttribute[] = [];
  private readonly shadeAttributes: THREE.InstancedBufferAttribute[] = [];
  private readonly segmentLimit: number;

  private sequences: Sequence[] = [];
  private caIndices = new Int32Array(0);
  private verticesByResidue = new Map<number, number[]>();
  private drawnResidues = new Set<number>();
  private vertexCount = 0;
  private segmentCount = 0;

  private tangents = new Float32Array(0);
  private normals = new Float32Array(0);
  private vertexColors = new Float32Array(0);
  private vertexTargetColors = new Float32Array(0);
  private vertexWidths = new Float32Array(0);
  private vertexTargetWidths = new Float32Array(0);

  private lastPositions: ArrayLike<number> | null = null;

  private dsspResidueIndices = new Int32Array(0);
  private dsspAtomCA = new Int32Array(0);
  private dsspAtomN = new Int32Array(0);
  private dsspAtomC = new Int32Array(0);
  private dsspAtomO = new Int32Array(0);
  private dsspAtomH = new Int32Array(0);
  private dsspSequences: Sequence[] = [];
  private dsspCount = 0;
  private dsspOrdinalByResidue = new Map<number, number>();
  private ssAssignments = new Uint8Array(0);
  private ssPatterns = new Uint8Array(0);
  private ssAcceptor = new Int32Array(0);
  private ssDonor = new Int32Array(0);
  private ssAcceptorEnergy = new Float64Array(0);
  private dsspTimer = Infinity;
  private dsspDirty = false;

  constructor(userOptions: CartoonRendererOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...userOptions };

    this.segmentLimit = Math.max(1, this.options.maxResidues - 1);
    this.instanceBuffers = [
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit * 3),
      new Float32Array(this.segmentLimit),
      new Float32Array(this.segmentLimit),
    ];

    const cylinder = new THREE.CylinderGeometry(
      0.5, 0.5, 1,
      this.options.sides,
      this.options.segments,
      true,
    );
    cylinder.translate(0, 0.5, 0);

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = cylinder.index;
    this.geometry.setAttribute("position", cylinder.getAttribute("position"));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

    this.instanceBuffers.forEach((buffer, index) => {
      const itemSize = index < 8 ? 3 : 1;
      const attribute = new THREE.InstancedBufferAttribute(buffer, itemSize);
      attribute.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(ATTRIBUTE_NAMES[index], attribute);
      if (index < 6) {
        this.pointAttributes.push(attribute);
      } else {
        this.shadeAttributes.push(attribute);
      }
    });

    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uRadius: { value: this.options.scale },
        uLightDirection: { value: new THREE.Vector3(0, 0, 1) },
        uDiffuse: { value: 0.5 },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.add(this.mesh);
  }

  get hasData(): boolean {
    return this.segmentCount > 0;
  }

  // Residues that are part of a drawn polypeptide ribbon. Used to decide which
  // particles the ball-and-stick renderer should skip.
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
    const { sequences, caIndices, vertexResidues, residueSequences } =
      this.calculateSequences(atomNames, atomResidues, residueNames, residueChains, particleFilter);

    this.sequences = sequences;
    this.caIndices = caIndices;
    this.drawnResidues = new Set<number>();
    for (const sequence of residueSequences) {
      for (const residue of sequence) {
        this.drawnResidues.add(residue);
      }
    }
    this.vertexCount = caIndices.length;
    this.segmentCount = Math.min(
      Math.max(0, this.vertexCount - sequences.length),
      this.segmentLimit,
    );

    this.verticesByResidue = new Map();
    for (let v = 0; v < this.vertexCount; ++v) {
      const residue = vertexResidues[v];
      const list = this.verticesByResidue.get(residue);
      if (list) {
        list.push(v);
      } else {
        this.verticesByResidue.set(residue, [v]);
      }
    }

    this.tangents = new Float32Array(this.vertexCount * 3);
    this.normals = new Float32Array(this.vertexCount * 3);
    this.vertexColors = new Float32Array(this.vertexCount * 3);
    this.vertexTargetColors = new Float32Array(this.vertexCount * 3);
    this.vertexWidths = new Float32Array(this.vertexCount);
    this.vertexTargetWidths = new Float32Array(this.vertexCount);
    for (let i = 0; i < this.vertexCount; ++i) {
      this.vertexColors[i * 3] = 1;
      this.vertexColors[i * 3 + 1] = 1;
      this.vertexColors[i * 3 + 2] = 1;
      this.vertexTargetColors[i * 3] = 1;
      this.vertexTargetColors[i * 3 + 1] = 1;
      this.vertexTargetColors[i * 3 + 2] = 1;
    }

    this.buildDsspResidueData(residueSequences, atomNames, atomResidues);
    this.dsspTimer = Infinity;
    this.dsspDirty = true;

    if (this.lastPositions) {
      this.setPositions(this.lastPositions);
    } else {
      this.geometry.instanceCount = 0;
    }
  }

  setPositions(positions: ArrayLike<number>) {
    this.lastPositions = positions;
    if (this.vertexCount === 0) {
      this.geometry.instanceCount = 0;
      return;
    }

    for (const { offset, length } of this.sequences) {
      this.calculateTangentsAndNormals(positions, offset, length);
    }

    const [startPoints, endPoints, startTangents, endTangents, startNormals, endNormals] =
      this.instanceBuffers;

    let seg = 0;
    for (const { offset, length } of this.sequences) {
      for (let i = 0; i < length - 1 && seg < this.segmentCount; ++i, ++seg) {
        const a = offset + i;
        const b = offset + i + 1;
        const ia = this.caIndices[a] * 3;
        const ib = this.caIndices[b] * 3;

        startPoints[seg * 3] = positions[ia];
        startPoints[seg * 3 + 1] = positions[ia + 1];
        startPoints[seg * 3 + 2] = positions[ia + 2];
        endPoints[seg * 3] = positions[ib];
        endPoints[seg * 3 + 1] = positions[ib + 1];
        endPoints[seg * 3 + 2] = positions[ib + 2];

        for (let k = 0; k < 3; ++k) {
          startTangents[seg * 3 + k] = this.tangents[a * 3 + k];
          endTangents[seg * 3 + k] = this.tangents[b * 3 + k];
          startNormals[seg * 3 + k] = this.normals[a * 3 + k];
          endNormals[seg * 3 + k] = this.normals[b * 3 + k];
        }
      }
    }

    for (const attribute of this.pointAttributes) {
      attribute.needsUpdate = true;
    }
    this.geometry.instanceCount = this.segmentCount;
    this.writeShadeAttributes();
    this.dsspDirty = true;
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.vertexCount === 0) {
      return;
    }

    // headlamp: the light direction points back toward the camera
    this.material.uniforms.uLightDirection.value
      .set(0, 0, 1)
      .applyQuaternion(camera.getWorldQuaternion(scratchQuaternion));

    this.dsspTimer += dt;
    if (this.dsspTimer >= this.options.dsspInterval && this.dsspDirty && this.lastPositions) {
      this.dsspTimer = 0;
      this.dsspDirty = false;
      this.calculateSecondaryStructure(this.lastPositions);
    }

    if (this.fadeShades(dt)) {
      this.writeShadeAttributes();
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }

  private calculateSequences(
    atomNames: string[],
    atomResidues: ArrayLike<number>,
    residueNames: string[],
    residueChains: ArrayLike<number>,
    particleFilter: Set<number> | null,
  ) {
    const sequences: Sequence[] = [];
    const residueSequences: number[][] = [];
    const caList: number[] = [];
    const residueList: number[] = [];

    let currentResidues: number[] = [];
    let currentChain = -1;

    const flush = () => {
      // a stable ribbon needs at least 3 alpha carbons
      if (currentResidues.length >= 3) {
        sequences.push({
          offset: caList.length - currentResidues.length,
          length: currentResidues.length,
        });
        residueSequences.push(currentResidues);
      } else {
        caList.length -= currentResidues.length;
        residueList.length -= currentResidues.length;
      }
      currentResidues = [];
    };

    for (let atom = 0; atom < atomNames.length; ++atom) {
      if (particleFilter && !particleFilter.has(atom)) continue;
      if (atomNames[atom].toUpperCase() !== "CA") continue;
      const residue = atomResidues[atom];
      const residueName = residueNames[residue];
      if (!residueName || !STANDARD_AMINO_ACIDS.has(residueName.toUpperCase())) continue;

      const chain = residueChains[residue] ?? 0;
      if (chain !== currentChain && currentResidues.length > 0) {
        flush();
      }

      currentChain = chain;
      currentResidues.push(residue);
      caList.push(atom);
      residueList.push(residue);
    }

    if (currentResidues.length > 0) {
      flush();
    }

    return {
      sequences,
      caIndices: Int32Array.from(caList),
      vertexResidues: residueList,
      residueSequences,
    };
  }

  private calculateTangentsAndNormals(
    positions: ArrayLike<number>,
    offset: number,
    length: number,
  ) {
    const ca = this.caIndices;
    const tangents = this.tangents;
    const normals = this.normals;

    // cardinal spline tangents
    for (let j = 1; j < length - 1; ++j) {
      const v = offset + j;
      const prev = ca[v - 1] * 3;
      const next = ca[v + 1] * 3;
      tangents[v * 3] = positions[next] - positions[prev];
      tangents[v * 3 + 1] = positions[next + 1] - positions[prev + 1];
      tangents[v * 3 + 2] = positions[next + 2] - positions[prev + 2];
    }
    for (let k = 0; k < 3; ++k) {
      tangents[offset * 3 + k] = tangents[(offset + 1) * 3 + k];
      tangents[(offset + length - 1) * 3 + k] = tangents[(offset + length - 2) * 3 + k];
    }

    // normals from the perpendicular component of the second derivative at each
    // segment end, averaged over the adjacent segments
    for (let i = 0; i < length; ++i) {
      const v = (offset + i) * 3;
      normals[v] = 0;
      normals[v + 1] = 0;
      normals[v + 2] = 0;
    }

    for (let i = 0; i < length - 1; ++i) {
      const a = offset + i;
      const b = offset + i + 1;
      const p1 = ca[a] * 3;
      const p2 = ca[b] * 3;
      const m1 = a * 3;
      const m2 = b * 3;

      const p1x = positions[p1], p1y = positions[p1 + 1], p1z = positions[p1 + 2];
      const p2x = positions[p2], p2y = positions[p2 + 1], p2z = positions[p2 + 2];
      const m1x = tangents[m1], m1y = tangents[m1 + 1], m1z = tangents[m1 + 2];
      const m2x = tangents[m2], m2y = tangents[m2 + 1], m2z = tangents[m2 + 2];

      let n0x = -6 * p1x - 4 * m1x + 6 * p2x - 2 * m2x;
      let n0y = -6 * p1y - 4 * m1y + 6 * p2y - 2 * m2y;
      let n0z = -6 * p1z - 4 * m1z + 6 * p2z - 2 * m2z;
      let n1x = 6 * p1x + 2 * m1x - 6 * p2x + 4 * m2x;
      let n1y = 6 * p1y + 2 * m1y - 6 * p2y + 4 * m2y;
      let n1z = 6 * p1z + 2 * m1z - 6 * p2z + 4 * m2z;

      const m1sqr = m1x * m1x + m1y * m1y + m1z * m1z;
      if (m1sqr > 1e-12) {
        const d = (n0x * m1x + n0y * m1y + n0z * m1z) / m1sqr;
        n0x -= d * m1x;
        n0y -= d * m1y;
        n0z -= d * m1z;
      }
      const m2sqr = m2x * m2x + m2y * m2y + m2z * m2z;
      if (m2sqr > 1e-12) {
        const d = (n1x * m2x + n1y * m2y + n1z * m2z) / m2sqr;
        n1x -= d * m2x;
        n1y -= d * m2y;
        n1z -= d * m2z;
      }

      normals[a * 3] += n0x;
      normals[a * 3 + 1] += n0y;
      normals[a * 3 + 2] += n0z;
      normals[b * 3] += n1x;
      normals[b * 3 + 1] += n1y;
      normals[b * 3 + 2] += n1z;
    }

    for (let i = 0; i < length; ++i) {
      const v = (offset + i) * 3;
      const len = Math.hypot(normals[v], normals[v + 1], normals[v + 2]);
      if (len > 1e-9) {
        normals[v] /= len;
        normals[v + 1] /= len;
        normals[v + 2] /= len;
      } else {
        normals[v] = 1;
        normals[v + 1] = 0;
        normals[v + 2] = 0;
      }
    }

    // the first normal extrapolates from the next two
    const n1x = normals[(offset + 1) * 3];
    const n1y = normals[(offset + 1) * 3 + 1];
    const n1z = normals[(offset + 1) * 3 + 2];
    const n2x = normals[(offset + 2) * 3];
    const n2y = normals[(offset + 2) * 3 + 1];
    const n2z = normals[(offset + 2) * 3 + 2];
    let nx = 2 * n1x - n2x;
    let ny = 2 * n1y - n2y;
    let nz = 2 * n1z - n2z;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen > 1e-9) {
      normals[offset * 3] = nx / nlen;
      normals[offset * 3 + 1] = ny / nlen;
      normals[offset * 3 + 2] = nz / nlen;
    }

    // orient normals so consecutive normals differ by at most 90 degrees
    for (let j = 1; j < length; ++j) {
      const prev = (offset + j - 1) * 3;
      const curr = (offset + j) * 3;
      const dot =
        normals[prev] * normals[curr] +
        normals[prev + 1] * normals[curr + 1] +
        normals[prev + 2] * normals[curr + 2];
      if (dot < 0) {
        normals[curr] = -normals[curr];
        normals[curr + 1] = -normals[curr + 1];
        normals[curr + 2] = -normals[curr + 2];
      }
    }
  }

  private buildDsspResidueData(
    residueSequences: number[][],
    atomNames: string[],
    atomResidues: ArrayLike<number>,
  ) {
    const residues: number[] = [];
    const dsspSequences: Sequence[] = [];

    for (const sequence of residueSequences) {
      dsspSequences.push({ offset: residues.length, length: sequence.length });
      for (const residue of sequence) {
        residues.push(residue);
      }
    }

    const count = residues.length;
    this.dsspCount = count;
    this.dsspSequences = dsspSequences;
    this.dsspResidueIndices = Int32Array.from(residues);
    this.dsspAtomCA = new Int32Array(count).fill(-1);
    this.dsspAtomN = new Int32Array(count).fill(-1);
    this.dsspAtomC = new Int32Array(count).fill(-1);
    this.dsspAtomO = new Int32Array(count).fill(-1);
    this.dsspAtomH = new Int32Array(count).fill(-1);

    this.dsspOrdinalByResidue = new Map();
    for (let i = 0; i < count; ++i) {
      this.dsspOrdinalByResidue.set(residues[i], i);
    }

    for (let atom = 0; atom < atomNames.length; ++atom) {
      const ordinal = this.dsspOrdinalByResidue.get(atomResidues[atom]);
      if (ordinal === undefined) continue;

      switch (atomNames[atom].toUpperCase()) {
        case "CA":
          this.dsspAtomCA[ordinal] = atom;
          break;
        case "N":
          this.dsspAtomN[ordinal] = atom;
          break;
        case "C":
          this.dsspAtomC[ordinal] = atom;
          break;
        case "O":
          this.dsspAtomO[ordinal] = atom;
          break;
        case "H":
          this.dsspAtomH[ordinal] = atom;
          break;
      }
    }

    // O is sometimes named OC1/OC2; guess the first atom starting with O
    for (let atom = atomNames.length - 1; atom >= 0; --atom) {
      const ordinal = this.dsspOrdinalByResidue.get(atomResidues[atom]);
      if (ordinal === undefined) continue;
      if (this.dsspAtomO[ordinal] >= 0) continue;
      if (!atomNames[atom].toUpperCase().startsWith("O")) continue;
      this.dsspAtomO[ordinal] = atom;
    }

    this.ssAssignments = new Uint8Array(count);
    this.ssPatterns = new Uint8Array(count);
    this.ssAcceptor = new Int32Array(count).fill(-1);
    this.ssDonor = new Int32Array(count).fill(-1);
    this.ssAcceptorEnergy = new Float64Array(count).fill(1e10);
  }

  private hasEssentialAtoms(ordinal: number): boolean {
    return this.dsspAtomCA[ordinal] >= 0
      && this.dsspAtomC[ordinal] >= 0
      && this.dsspAtomN[ordinal] >= 0
      && this.dsspAtomO[ordinal] >= 0;
  }

  private calculateSecondaryStructure(positions: ArrayLike<number>) {
    const count = this.dsspCount;
    if (count === 0) return;

    const caPos = new Float32Array(count * 3);
    const nPos = new Float32Array(count * 3);
    const cPos = new Float32Array(count * 3);
    const oPos = new Float32Array(count * 3);
    const hPos = new Float32Array(count * 3);
    const valid = new Uint8Array(count);

    for (let i = 0; i < count; ++i) {
      if (!this.hasEssentialAtoms(i)) continue;
      valid[i] = 1;
      copyPosition(positions, this.dsspAtomCA[i], caPos, i);
      copyPosition(positions, this.dsspAtomN[i], nPos, i);
      copyPosition(positions, this.dsspAtomC[i], cPos, i);
      copyPosition(positions, this.dsspAtomO[i], oPos, i);

      if (this.dsspAtomH[i] >= 0) {
        copyPosition(positions, this.dsspAtomH[i], hPos, i);
      } else {
        let dx: number, dy: number, dz: number;
        if (i > 0 && valid[i - 1] && distanceSquared(cPos, i - 1, nPos, i) <= 0.04) {
          dx = cPos[(i - 1) * 3] - oPos[(i - 1) * 3];
          dy = cPos[(i - 1) * 3 + 1] - oPos[(i - 1) * 3 + 1];
          dz = cPos[(i - 1) * 3 + 2] - oPos[(i - 1) * 3 + 2];
        } else {
          dx = oPos[i * 3] - cPos[i * 3];
          dy = oPos[i * 3 + 1] - cPos[i * 3 + 1];
          dz = oPos[i * 3 + 2] - cPos[i * 3 + 2];
        }
        const len = Math.hypot(dx, dy, dz);
        if (len > 1e-9) {
          dx = (dx / len) * 0.1008;
          dy = (dy / len) * 0.1008;
          dz = (dz / len) * 0.1008;
        } else {
          dx = 0;
          dy = 0;
          dz = 0;
        }
        hPos[i * 3] = nPos[i * 3] + dx;
        hPos[i * 3 + 1] = nPos[i * 3 + 1] + dy;
        hPos[i * 3 + 2] = nPos[i * 3 + 2] + dz;
      }
    }

    for (const { offset, length } of this.dsspSequences) {
      this.assignSequence(offset, length, valid, caPos, nPos, cPos, oPos, hPos);
    }

    for (let i = 0; i < count; ++i) {
      const vertices = this.verticesByResidue.get(this.dsspResidueIndices[i]);
      if (!vertices) continue;
      const ss = valid[i] ? this.ssAssignments[i] : SS_NONE;
      const color = SS_COLORS[ss] ?? SS_WHITE;
      const width = SS_WIDTHS[ss] ?? 0;
      for (const v of vertices) {
        this.vertexTargetColors[v * 3] = color[0];
        this.vertexTargetColors[v * 3 + 1] = color[1];
        this.vertexTargetColors[v * 3 + 2] = color[2];
        this.vertexTargetWidths[v] = width;
      }
    }
  }

  private assignSequence(
    offset: number,
    length: number,
    valid: Uint8Array,
    caPos: Float32Array,
    nPos: Float32Array,
    cPos: Float32Array,
    oPos: Float32Array,
    hPos: Float32Array,
  ) {
    const end = offset + length;
    const cutoff = -0.5;

    for (let i = offset; i < end; ++i) {
      this.ssAssignments[i] = SS_NONE;
      this.ssPatterns[i] = PAT_NONE;
      this.ssAcceptor[i] = -1;
      this.ssDonor[i] = -1;
      this.ssAcceptorEnergy[i] = 1e10;
    }

    // hydrogen bonds between residues spaced at least 3 apart
    for (let i = offset; i < end - 3; ++i) {
      if (!valid[i]) continue;
      for (let j = i + 3; j < end; ++j) {
        if (!valid[j]) continue;
        const dist = distanceSquared(caPos, i, caPos, j);
        if (dist > 0.64) {
          j += Math.floor((Math.sqrt(dist) - 0.8) / 0.5);
          continue;
        }

        let energy = bondEnergy(oPos, cPos, nPos, hPos, i, j);
        if (energy < cutoff && energy < this.ssAcceptorEnergy[i]) {
          this.ssAcceptor[i] = j;
          this.ssAcceptorEnergy[i] = energy;
          this.ssDonor[j] = i;
        }

        energy = bondEnergy(oPos, cPos, nPos, hPos, j, i);
        if (energy < cutoff && energy < this.ssAcceptorEnergy[j]) {
          this.ssAcceptor[j] = i;
          this.ssAcceptorEnergy[j] = energy;
          this.ssDonor[i] = j;
        }
      }
    }

    // turns
    for (let i = offset; i < end; ++i) {
      const acceptor = this.ssAcceptor[i];
      if (acceptor < 0) continue;
      switch (acceptor - i) {
        case 3:
          this.ssPatterns[i] |= PAT_THREE_TURN;
          break;
        case 4:
          this.ssPatterns[i] |= PAT_FOUR_TURN;
          break;
        case 5:
          this.ssPatterns[i] |= PAT_FIVE_TURN;
          break;
      }
    }

    // antiparallel bridges
    for (let i = offset; i < end; ++i) {
      const acceptor = this.ssAcceptor[i];
      if (acceptor >= 0 && this.ssAcceptor[acceptor] === i) {
        this.ssPatterns[i] |= PAT_ANTIPARALLEL_BRIDGE;
        this.ssPatterns[acceptor] |= PAT_ANTIPARALLEL_BRIDGE;
      }
    }
    for (let i = offset; i < end - 2; ++i) {
      const acceptor = this.ssAcceptor[i];
      if (acceptor < 0) continue;
      const donor = this.ssDonor[i + 2];
      if (donor < 0) continue;
      if (acceptor - donor === 2) {
        this.ssPatterns[i + 1] |= PAT_ANTIPARALLEL_BRIDGE;
        this.ssPatterns[donor + 1] |= PAT_ANTIPARALLEL_BRIDGE;
      }
    }

    // parallel bridges
    for (let i = offset + 1; i < end; ++i) {
      const res2 = this.ssAcceptor[i - 1];
      if (res2 < 0) continue;
      const acceptor = this.ssAcceptor[res2];
      if (acceptor < 0) continue;
      if (acceptor - i === 1) {
        this.ssPatterns[i] |= PAT_PARALLEL_BRIDGE;
        this.ssPatterns[res2] |= PAT_PARALLEL_BRIDGE;
      }
    }
    for (let i = offset; i < end; ++i) {
      const acceptor = this.ssAcceptor[i];
      const donor = this.ssDonor[i];
      if (acceptor < 0 || donor < 0) continue;
      if (acceptor - donor === 2) {
        this.ssPatterns[i] |= PAT_PARALLEL_BRIDGE;
        this.ssPatterns[donor + 1] |= PAT_PARALLEL_BRIDGE;
      }
    }

    // helices and sheets
    this.assignHelix(offset, end, PAT_FIVE_TURN, 5, SS_PI_HELIX);
    this.assignHelix(offset, end, PAT_FOUR_TURN, 4, SS_ALPHA_HELIX);

    for (let i = offset; i < end; ++i) {
      if (this.ssAssignments[i] !== SS_NONE) continue;
      if (
        (this.ssPatterns[i] & PAT_ANTIPARALLEL_BRIDGE) !== 0 ||
        (this.ssPatterns[i] & PAT_PARALLEL_BRIDGE) !== 0
      ) {
        this.ssAssignments[i] = SS_SHEET;
      }
    }

    this.assignHelix(offset, end, PAT_THREE_TURN, 3, SS_THREE_TEN_HELIX);

    // expand sheets to adjacent unassigned residues
    const expand: number[] = [];
    for (let i = offset; i < end; ++i) {
      if (this.ssAssignments[i] !== SS_NONE) continue;
      if (i > offset && this.ssAssignments[i - 1] === SS_SHEET) {
        expand.push(i);
      } else if (i < end - 1 && this.ssAssignments[i + 1] === SS_SHEET) {
        expand.push(i);
      }
    }
    for (const i of expand) {
      this.ssAssignments[i] = SS_SHEET;
    }
  }

  private assignHelix(
    offset: number,
    end: number,
    pattern: number,
    helixLength: number,
    assignment: number,
  ) {
    for (let i = offset; i < end - 1; ++i) {
      if (
        (this.ssPatterns[i] & pattern) === 0 ||
        (this.ssPatterns[i + 1] & pattern) === 0
      ) {
        continue;
      }
      for (let slot = 1; slot <= helixLength; ++slot) {
        const j = i + slot;
        if (j >= end) break;
        if (this.ssAssignments[j] !== SS_NONE) continue;
        this.ssAssignments[j] = assignment;
      }
    }
  }

  private fadeShades(dt: number): boolean {
    const delta = this.options.fadeSpeed * dt;
    let changed = false;

    for (let i = 0; i < this.vertexWidths.length; ++i) {
      const next = moveTowards(this.vertexWidths[i], this.vertexTargetWidths[i], delta);
      if (next !== this.vertexWidths[i]) {
        this.vertexWidths[i] = next;
        changed = true;
      }
    }

    for (let i = 0; i < this.vertexColors.length; ++i) {
      const next = moveTowards(this.vertexColors[i], this.vertexTargetColors[i], delta);
      if (next !== this.vertexColors[i]) {
        this.vertexColors[i] = next;
        changed = true;
      }
    }

    return changed;
  }

  private writeShadeAttributes() {
    const [, , , , , , startColors, endColors, startScales, endScales] = this.instanceBuffers;

    let seg = 0;
    for (const { offset, length } of this.sequences) {
      for (let i = 0; i < length - 1 && seg < this.segmentCount; ++i, ++seg) {
        const a = offset + i;
        const b = offset + i + 1;
        for (let k = 0; k < 3; ++k) {
          startColors[seg * 3 + k] = this.vertexColors[a * 3 + k];
          endColors[seg * 3 + k] = this.vertexColors[b * 3 + k];
        }
        startScales[seg] = this.vertexWidths[a] * this.options.width;
        endScales[seg] = this.vertexWidths[b] * this.options.width;
      }
    }
    for (const attribute of this.shadeAttributes) {
      attribute.needsUpdate = true;
    }
  }
}

const scratchQuaternion = new THREE.Quaternion();

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) {
    return target;
  }
  return current + Math.sign(target - current) * maxDelta;
}

function copyPosition(
  positions: ArrayLike<number>,
  atom: number,
  target: Float32Array,
  ordinal: number,
) {
  target[ordinal * 3] = positions[atom * 3];
  target[ordinal * 3 + 1] = positions[atom * 3 + 1];
  target[ordinal * 3 + 2] = positions[atom * 3 + 2];
}

function distanceSquared(
  a: Float32Array,
  i: number,
  b: Float32Array,
  j: number,
): number {
  const dx = a[i * 3] - b[j * 3];
  const dy = a[i * 3 + 1] - b[j * 3 + 1];
  const dz = a[i * 3 + 2] - b[j * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

// electrostatic hydrogen bond energy; res1 is the acceptor (C=O), res2 the donor (N-H)
function bondEnergy(
  oPos: Float32Array,
  cPos: Float32Array,
  nPos: Float32Array,
  hPos: Float32Array,
  res1: number,
  res2: number,
): number {
  const rON = Math.sqrt(distanceSquared(oPos, res1, nPos, res2));
  const rCH = Math.sqrt(distanceSquared(cPos, res1, hPos, res2));
  const rOH = Math.sqrt(distanceSquared(oPos, res1, hPos, res2));
  const rCN = Math.sqrt(distanceSquared(cPos, res1, nPos, res2));
  if (rON < 1e-6 || rCH < 1e-6 || rOH < 1e-6 || rCN < 1e-6) return 1e10;
  return 0.42 * 0.2 * 33.2 * (1 / rON + 1 / rCH - 1 / rOH - 1 / rCN);
}
