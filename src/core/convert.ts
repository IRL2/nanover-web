import { TestTrajectory, TestTrajectoryDataBytes } from "./types";

export interface ArrayConstructor<TArray>
{
  new <TArrayBuffer extends ArrayBufferLike = ArrayBuffer>(buffer: TArrayBuffer, byteOffset?: number, length?: number): TArray;
  readonly BYTES_PER_ELEMENT: number,
}

export function bytesToArray<TArray>(bytes: Uint8Array, type: ArrayConstructor<TArray>) {
  // TODO: can we avoid slicing (copy)
  return new type(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 
    0, 
    bytes.byteLength / type.BYTES_PER_ELEMENT,
  )
}

export function decode(data: TestTrajectoryDataBytes): TestTrajectory {
  const traj = {
    topology: {
      elements: bytesToArray(data.topology.elements, Uint8Array),
      bonds: bytesToArray(data.topology.bonds, Uint32Array),
    },
    positions: data.positions.map((positions) => bytesToArray(positions, Float32Array)),
  }

  return traj;
}
