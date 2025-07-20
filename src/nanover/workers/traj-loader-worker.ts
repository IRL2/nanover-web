import { unpack } from "msgpackr";
import { decode, decode2 } from "../convert.ts";
import { TestTrajectory, TestTrajectoryDataBytes } from "../types";

export type SetupMessageData = {
  port: MessagePort;
}

export type RecvMessageData = {
  path: string;
}

export type SendMessageData = {
  traj: TestTrajectory;
}

onmessage = (event) => {
  const { port } = event.data as SetupMessageData;
  port.addEventListener("message", async (event) => {
    const { path } = event.data as RecvMessageData;

    const response = await fetch(path);
    const blob = await response.blob();
    const data = unpack(await blob.arrayBuffer()) as TestTrajectoryDataBytes;
    const traj = decode2(data);

    port.postMessage({ traj } as SendMessageData, { transfer: [
      traj.topology.bonds.buffer,
      traj.topology.elements.buffer,
      ...traj.positions.map(e => e.buffer),
    ]});
  });
  port.start();
};
