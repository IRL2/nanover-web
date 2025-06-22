import { base64ToBytes } from "../convert.js";
import { TestFrame, TestFrameData } from "../types.js";

export type SetupMessageData = {
  port: MessagePort;
  host: string;
}

export type RecvMessageData = {
}

export type SendMessageData = {
  frame: TestFrame;
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

  socket.addEventListener("message", (event) => {
    console.log("SOCKET MSG");
    const data = JSON.parse(event.data) as TestFrameData;
    const frame = {} as TestFrame;
    const transfer = [];

    if (data.topology) {
      const elements = new Uint8Array(base64ToBytes(data.topology.elements).buffer);
      const bonds = new Uint32Array(base64ToBytes(data.topology.bonds).buffer);

      frame.topology = { elements, bonds, };
      transfer.push(elements.buffer, bonds.buffer);
    }

    if (data.positions) {
      const positions = new Float32Array(base64ToBytes(data.positions).buffer);
      frame.positions = positions;
      transfer.push(positions.buffer);
    }

    if (data.box) {
      const box = new Float32Array(base64ToBytes(data.box).buffer);
      frame.box = box;
      transfer.push(box.buffer);
    }

    port.postMessage({ frame } as SendMessageData, transfer);
  });
};
