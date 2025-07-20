import { unpack } from "msgpackr";
import { bytesToArray } from "../convert.js";
import { TestFrame, TestFrameData } from "../types.js";

export type SetupMessageData = {
  port: MessagePort;
  host: string;
}

export type RecvMessageData = {
}

export type SendMessageData = {
  frame: Partial<TestFrame>;
}

onmessage = (event) => {
  const { port, host } = event.data as SetupMessageData;

  console.log("CONNECTING", host);

  port.addEventListener("message", (event) => {
    const { } = event.data as RecvMessageData;
    console.log("WHY", event.data);
  });
  port.start();

  const socket = new WebSocket(host);

  socket.addEventListener("open", (event) => {
    console.log("SOCKET CONNECTED", event);
  });

  socket.addEventListener("close", (event) => {
    console.log("CLOSE", event);
  });

  socket.addEventListener("error", (event) => {
    console.log("ERROR", event);
  });

  socket.addEventListener("message", async (event) => {
    // console.log("SOCKET MSG");

    const data = event.data instanceof Blob 
      ? unpack(await event.data.arrayBuffer()) as TestFrameData
      : JSON.parse(event.data) as TestFrameData;
    const frame = {} as TestFrame;
    const transfer = [];

    if (data.topology) {
      const elements = bytesToArray(data.topology.elements, Uint8Array);
      const bonds = bytesToArray(data.topology.bonds, Uint32Array);

      frame.topology = { elements, bonds, };
      transfer.push(elements.buffer, bonds.buffer);
    }

    if (data.positions) {
      const positions = bytesToArray(data.positions, Float32Array);
      frame.positions = positions;
      transfer.push(positions.buffer);
    }

    if (data.box) {
      const box = bytesToArray(data.box, Float32Array);
      frame.box = box;
      transfer.push(box.buffer);
    }

    if (data.state) {
      frame.state = data.state;
    }

    port.postMessage({ frame } as SendMessageData, transfer);
  });
};
