"use strict";

export const STANDARD_AMINO_ACIDS = new Set([
  "ALA", "ARG", "ASN", "ASP", "CYS",
  "GLN", "GLU", "GLY", "HIS", "ILE",
  "LEU", "LYS", "MET", "PHE", "PRO",
  "SER", "THR", "TRP", "TYR", "VAL",
]);

export const SS_NONE = 0;
export const SS_ALPHA_HELIX = 1;
export const SS_THREE_TEN_HELIX = 2;
export const SS_PI_HELIX = 4;
export const SS_SHEET = 8;

export const SS_HELIX_MASK = SS_ALPHA_HELIX | SS_THREE_TEN_HELIX | SS_PI_HELIX;

const PAT_NONE = 0;
const PAT_THREE_TURN = 1;
const PAT_FOUR_TURN = 2;
const PAT_FIVE_TURN = 4;
const PAT_PARALLEL_BRIDGE = 8;
const PAT_ANTIPARALLEL_BRIDGE = 16;

export const SS_COLORS: Record<number, [number, number, number]> = {
  [SS_ALPHA_HELIX]: [1.0, 0.0, 0.5],
  [SS_THREE_TEN_HELIX]: [0.6, 0.0, 0.5],
  [SS_PI_HELIX]: [0.4, 0.0, 0.5],
  [SS_SHEET]: [1.0, 0.8, 0.0],
};
export const SS_WHITE: [number, number, number] = [1.0, 1.0, 1.0];

export interface Sequence {
  offset: number;
  length: number;
}

export interface PolypeptideData {
  sequences: Sequence[];
  caIndices: Int32Array<ArrayBuffer>;
  vertexResidues: number[];
  residueSequences: number[][];
}

export function extractPolypeptides(
  atomNames: string[],
  atomResidues: ArrayLike<number>,
  residueNames: string[],
  residueChains: ArrayLike<number>,
  particleFilter: Set<number> | null,
): PolypeptideData {
  const sequences: Sequence[] = [];
  const residueSequences: number[][] = [];
  const caList: number[] = [];
  const residueList: number[] = [];

  let currentResidues: number[] = [];
  let currentChain = -1;

  const flush = () => {
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

export function computeSplineFrames(
  positions: ArrayLike<number>,
  caIndices: Int32Array,
  offset: number,
  length: number,
  tangents: Float32Array,
  normals: Float32Array,
): void {
  for (let j = 1; j < length - 1; ++j) {
    const v = offset + j;
    const prev = caIndices[v - 1] * 3;
    const next = caIndices[v + 1] * 3;
    tangents[v * 3] = positions[next] - positions[prev];
    tangents[v * 3 + 1] = positions[next + 1] - positions[prev + 1];
    tangents[v * 3 + 2] = positions[next + 2] - positions[prev + 2];
  }
  for (let k = 0; k < 3; ++k) {
    tangents[offset * 3 + k] = tangents[(offset + 1) * 3 + k];
    tangents[(offset + length - 1) * 3 + k] = tangents[(offset + length - 2) * 3 + k];
  }

  for (let i = 0; i < length; ++i) {
    const v = (offset + i) * 3;
    normals[v] = 0;
    normals[v + 1] = 0;
    normals[v + 2] = 0;
  }

  for (let i = 0; i < length - 1; ++i) {
    const a = offset + i;
    const b = offset + i + 1;
    const p1 = caIndices[a] * 3;
    const p2 = caIndices[b] * 3;
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

  const n1x = normals[(offset + 1) * 3];
  const n1y = normals[(offset + 1) * 3 + 1];
  const n1z = normals[(offset + 1) * 3 + 2];
  const n2x = normals[(offset + 2) * 3];
  const n2y = normals[(offset + 2) * 3 + 1];
  const n2z = normals[(offset + 2) * 3 + 2];
  const nx = 2 * n1x - n2x;
  const ny = 2 * n1y - n2y;
  const nz = 2 * n1z - n2z;
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen > 1e-9) {
    normals[offset * 3] = nx / nlen;
    normals[offset * 3 + 1] = ny / nlen;
    normals[offset * 3 + 2] = nz / nlen;
  }

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

export class DsspCalculator {
  private sequences: Sequence[] = [];
  private residueIndices = new Int32Array(0);
  private atomCA = new Int32Array(0);
  private atomN = new Int32Array(0);
  private atomC = new Int32Array(0);
  private atomO = new Int32Array(0);
  private atomH = new Int32Array(0);
  private ordinalByResidue = new Map<number, number>();

  private patterns = new Uint8Array(0);
  private assignments = new Uint8Array(0);
  private acceptor = new Int32Array(0);
  private donor = new Int32Array(0);
  private acceptorEnergy = new Float64Array(0);

  get count(): number {
    return this.residueIndices.length;
  }

  build(
    residueSequences: number[][],
    atomNames: string[],
    atomResidues: ArrayLike<number>,
  ): void {
    const residues: number[] = [];
    const sequences: Sequence[] = [];

    for (const sequence of residueSequences) {
      sequences.push({ offset: residues.length, length: sequence.length });
      for (const residue of sequence) {
        residues.push(residue);
      }
    }

    const count = residues.length;
    this.sequences = sequences;
    this.residueIndices = Int32Array.from(residues);
    this.atomCA = new Int32Array(count).fill(-1);
    this.atomN = new Int32Array(count).fill(-1);
    this.atomC = new Int32Array(count).fill(-1);
    this.atomO = new Int32Array(count).fill(-1);
    this.atomH = new Int32Array(count).fill(-1);

    this.ordinalByResidue = new Map();
    for (let i = 0; i < count; ++i) {
      this.ordinalByResidue.set(residues[i], i);
    }

    for (let atom = 0; atom < atomNames.length; ++atom) {
      const ordinal = this.ordinalByResidue.get(atomResidues[atom]);
      if (ordinal === undefined) continue;

      switch (atomNames[atom].toUpperCase()) {
        case "CA":
          this.atomCA[ordinal] = atom;
          break;
        case "N":
          this.atomN[ordinal] = atom;
          break;
        case "C":
          this.atomC[ordinal] = atom;
          break;
        case "O":
          this.atomO[ordinal] = atom;
          break;
        case "H":
          this.atomH[ordinal] = atom;
          break;
      }
    }

    for (let atom = atomNames.length - 1; atom >= 0; --atom) {
      const ordinal = this.ordinalByResidue.get(atomResidues[atom]);
      if (ordinal === undefined) continue;
      if (this.atomO[ordinal] >= 0) continue;
      if (!atomNames[atom].toUpperCase().startsWith("O")) continue;
      this.atomO[ordinal] = atom;
    }

    this.assignments = new Uint8Array(count);
    this.patterns = new Uint8Array(count);
    this.acceptor = new Int32Array(count).fill(-1);
    this.donor = new Int32Array(count).fill(-1);
    this.acceptorEnergy = new Float64Array(count).fill(1e10);
  }

  calculate(positions: ArrayLike<number>): Uint8Array {
    const count = this.count;
    if (count === 0) return this.assignments;

    const caPos = new Float32Array(count * 3);
    const nPos = new Float32Array(count * 3);
    const cPos = new Float32Array(count * 3);
    const oPos = new Float32Array(count * 3);
    const hPos = new Float32Array(count * 3);
    const valid = new Uint8Array(count);

    for (let i = 0; i < count; ++i) {
      if (
        this.atomCA[i] < 0 || this.atomC[i] < 0
        || this.atomN[i] < 0 || this.atomO[i] < 0
      ) {
        continue;
      }
      valid[i] = 1;
      copyPosition(positions, this.atomCA[i], caPos, i);
      copyPosition(positions, this.atomN[i], nPos, i);
      copyPosition(positions, this.atomC[i], cPos, i);
      copyPosition(positions, this.atomO[i], oPos, i);

      if (this.atomH[i] >= 0) {
        copyPosition(positions, this.atomH[i], hPos, i);
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

    for (const { offset, length } of this.sequences) {
      this.assignSequence(offset, length, valid, caPos, nPos, cPos, oPos, hPos);
    }

    for (let i = 0; i < count; ++i) {
      if (!valid[i]) this.assignments[i] = SS_NONE;
    }

    return this.assignments;
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
      this.assignments[i] = SS_NONE;
      this.patterns[i] = PAT_NONE;
      this.acceptor[i] = -1;
      this.donor[i] = -1;
      this.acceptorEnergy[i] = 1e10;
    }

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
        if (energy < cutoff && energy < this.acceptorEnergy[i]) {
          this.acceptor[i] = j;
          this.acceptorEnergy[i] = energy;
          this.donor[j] = i;
        }

        energy = bondEnergy(oPos, cPos, nPos, hPos, j, i);
        if (energy < cutoff && energy < this.acceptorEnergy[j]) {
          this.acceptor[j] = i;
          this.acceptorEnergy[j] = energy;
          this.donor[i] = j;
        }
      }
    }

    for (let i = offset; i < end; ++i) {
      const acceptor = this.acceptor[i];
      if (acceptor < 0) continue;
      switch (acceptor - i) {
        case 3:
          this.patterns[i] |= PAT_THREE_TURN;
          break;
        case 4:
          this.patterns[i] |= PAT_FOUR_TURN;
          break;
        case 5:
          this.patterns[i] |= PAT_FIVE_TURN;
          break;
      }
    }

    for (let i = offset; i < end; ++i) {
      const acceptor = this.acceptor[i];
      if (acceptor >= 0 && this.acceptor[acceptor] === i) {
        this.patterns[i] |= PAT_ANTIPARALLEL_BRIDGE;
        this.patterns[acceptor] |= PAT_ANTIPARALLEL_BRIDGE;
      }
    }
    for (let i = offset; i < end - 2; ++i) {
      const acceptor = this.acceptor[i];
      if (acceptor < 0) continue;
      const donor = this.donor[i + 2];
      if (donor < 0) continue;
      if (acceptor - donor === 2) {
        this.patterns[i + 1] |= PAT_ANTIPARALLEL_BRIDGE;
        this.patterns[donor + 1] |= PAT_ANTIPARALLEL_BRIDGE;
      }
    }

    for (let i = offset + 1; i < end; ++i) {
      const res2 = this.acceptor[i - 1];
      if (res2 < 0) continue;
      const acceptor = this.acceptor[res2];
      if (acceptor < 0) continue;
      if (acceptor - i === 1) {
        this.patterns[i] |= PAT_PARALLEL_BRIDGE;
        this.patterns[res2] |= PAT_PARALLEL_BRIDGE;
      }
    }
    for (let i = offset; i < end; ++i) {
      const acceptor = this.acceptor[i];
      const donor = this.donor[i];
      if (acceptor < 0 || donor < 0) continue;
      if (acceptor - donor === 2) {
        this.patterns[i] |= PAT_PARALLEL_BRIDGE;
        this.patterns[donor + 1] |= PAT_PARALLEL_BRIDGE;
      }
    }

    this.assignHelix(offset, end, PAT_FIVE_TURN, 5, SS_PI_HELIX);
    this.assignHelix(offset, end, PAT_FOUR_TURN, 4, SS_ALPHA_HELIX);

    for (let i = offset; i < end; ++i) {
      if (this.assignments[i] !== SS_NONE) continue;
      if (
        (this.patterns[i] & PAT_ANTIPARALLEL_BRIDGE) !== 0 ||
        (this.patterns[i] & PAT_PARALLEL_BRIDGE) !== 0
      ) {
        this.assignments[i] = SS_SHEET;
      }
    }

    this.assignHelix(offset, end, PAT_THREE_TURN, 3, SS_THREE_TEN_HELIX);

    const expand: number[] = [];
    for (let i = offset; i < end; ++i) {
      if (this.assignments[i] !== SS_NONE) continue;
      if (i > offset && this.assignments[i - 1] === SS_SHEET) {
        expand.push(i);
      } else if (i < end - 1 && this.assignments[i + 1] === SS_SHEET) {
        expand.push(i);
      }
    }
    for (const i of expand) {
      this.assignments[i] = SS_SHEET;
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
        (this.patterns[i] & pattern) === 0 ||
        (this.patterns[i + 1] & pattern) === 0
      ) {
        continue;
      }
      for (let slot = 1; slot <= helixLength; ++slot) {
        const j = i + slot;
        if (j >= end) break;
        if (this.assignments[j] !== SS_NONE) continue;
        this.assignments[j] = assignment;
      }
    }
  }
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
