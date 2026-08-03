import { unpack } from "msgpackr";
import { decode } from "../../core/convert.ts";
import { TestTrajectory, TestTrajectoryDataBytes } from "../../core/types";

export type SetupMessageData = {
  port: MessagePort;
}

export type RecvMessageData = {
  path?: string;
  arrayBuffer?: ArrayBuffer;
  filename?: string;
}

export type SendMessageData = {
  traj: TestTrajectory;
}

onmessage = (event) => {
  const { port } = event.data as SetupMessageData;
  port.addEventListener("message", async (event) => {
    const { path, arrayBuffer, filename } = event.data as RecvMessageData;

    let data: TestTrajectoryDataBytes;

    if (arrayBuffer) {
      // Handle ArrayBuffer from Google Drive
      console.log('Loading trajectory from Google Drive:', filename);
      data = unpack(arrayBuffer) as TestTrajectoryDataBytes;
    } else if (path) {
      const response = await fetch(path);
      const blob = await response.blob();
      data = unpack(await blob.arrayBuffer()) as TestTrajectoryDataBytes;
    } else {
      console.error('No path or arrayBuffer provided');
      return;
    }

    const traj = decode(data);

    port.postMessage({ traj } as SendMessageData, { transfer: [
      traj.topology.bonds.buffer,
      traj.topology.elements.buffer,
      ...traj.positions.map(e => e.buffer),
    ]});
  });
  port.start();
};
