import { decode } from "../convert.ts";
import { TestTrajectory } from "../types";

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
    const data = await response.json();
    const traj = decode(data);

    port.postMessage({ traj } as SendMessageData);
  });
  port.start();
};
