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

export type TestFrameData = {
  topology?: {
    elements: Uint8Array;
    bonds: Uint8Array;
  }
  positions: Uint8Array;
  box: Uint8Array;

  state: Object.<string, any>;
  frame: Object.<string, any>;
}

export type TestFrame = {
  positions: Float32Array;
  elements: Uint8Array;
  bonds: Uint32Array;
  box: Float32Array;
  
  state: Object.<string, any>;
  frame: Object.<string, any>;
}
