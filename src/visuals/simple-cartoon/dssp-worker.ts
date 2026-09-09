import { DsspCalculator } from "./protein-structure";

type BuildMessage = {
  type: "build";
  topologyVersion: number;
  residueSequences: number[][];
  atomNames: string[];
  atomResidues: number[];
};

type CalculateMessage = {
  type: "calculate";
  topologyVersion: number;
  requestId: number;
  positions: Float32Array;
};

const dssp = new DsspCalculator();

self.onmessage = (event: MessageEvent<BuildMessage | CalculateMessage>) => {
  const message = event.data;

  if (message.type === "build") {
    dssp.build(message.residueSequences, message.atomNames, message.atomResidues);
    return;
  }

  const assignments = dssp.calculate(message.positions);
  const result = new Uint8Array(assignments);
  self.postMessage({
    type: "result",
    topologyVersion: message.topologyVersion,
    requestId: message.requestId,
    assignments: result,
  });
};
