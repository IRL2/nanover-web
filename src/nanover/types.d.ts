export type TestTrajectoryDataSmall = {
  topology: {
    elements: string;
    bonds: string;
  };
  positions: string[];
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
    elements: string;
    bonds: string;
  }
  positions: string;
  box: string;
}

export type TestFrame = {
  topology?: {
    elements: Uint8Array;
    bonds: Uint32Array;
  }
  positions?: Float32Array;
  box?: Float32Array;
}
