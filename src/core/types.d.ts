type SharedMessageRecord = Record<string, unknown>;

export type TestTrajectoryDataBytes = {
  topology: {
    elements: Uint8Array;
    bonds: Uint8Array;
  };
  positions: Uint8Array[];
}

export type TestTrajectory = {
  topology: {
    elements: Uint8Array;
    bonds: Uint32Array;
  }
  positions: Float32Array[];
}

export type TestMessageData = {
  box?: Uint8Array;

  state?: SharedMessageRecord;
  frame?: SharedMessageRecord;
  command?: unknown;
}

export type TestFrame = {
  positions: Float32Array;
  elements: Uint8Array;
  bonds: Uint32Array;
  box: Float32Array;
  residues: Int32Array;
  
  state: SharedMessageRecord;
  frame: SharedMessageRecord;
}
