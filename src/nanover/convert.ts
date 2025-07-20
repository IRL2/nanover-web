import { TestTrajectory, TestTrajectoryDataSmall, TestTrajectoryDataBytes } from "./types";

export function bytesToBase64(array: ArrayBufferView) {
  const bytes = new Uint8Array(array.buffer);
  return btoa(String.fromCharCode.apply(null, bytes as unknown as number[]));
}

export function base64ToBytes(str: string) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export function bytesToArray(bytes: Uint8Array, type: any) {
  // TODO: can we avoid slicing (copy)
  return new type(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 
    0, 
    bytes.byteLength / type.BYTES_PER_ELEMENT,
  )
}

export function decode(data: TestTrajectoryDataSmall): TestTrajectory {
  const traj = {
    topology: {
      elements: new Uint8Array(base64ToBytes(data.topology.elements)),
      bonds: new Uint32Array(base64ToBytes(data.topology.bonds).buffer),
    },
    positions: data.positions.map((positions) => new Float32Array(base64ToBytes(positions).buffer)),
  }

  return traj;
}

export function decode2(data: TestTrajectoryDataBytes): TestTrajectory {
  const traj = {
    topology: {
      elements: bytesToArray(data.topology.elements, Uint8Array),
      bonds: bytesToArray(data.topology.bonds, Uint32Array),
    },
    positions: data.positions.map((positions) => bytesToArray(positions, Float32Array)),
  }

  return traj;
}
