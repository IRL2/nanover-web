import { unpack } from "msgpackr";
import { bytesToArray, ArrayConstructor } from "../convert.js";
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

  const transfer: Transferable[] = [];
  function bytesToArrayManaged<TArray extends { buffer: ArrayBuffer }>(bytes: Uint8Array, type: ArrayConstructor<TArray>)
  {
    const array = bytesToArray(bytes, type);
    transfer.push(array.buffer);
    return array;
  }

  socket.addEventListener("message", async (event) => {
    // console.log("SOCKET MSG");

    transfer.length = 0;

    const data = event.data instanceof Blob 
      ? unpack(await event.data.arrayBuffer()) as TestFrameData
      : JSON.parse(event.data) as TestFrameData;
    const frame = {} as TestFrame;

    if (data.frame) {
      if (data.frame["particle.positions"]) {
        frame.positions = bytesToArrayManaged(data.frame["particle.positions"], Float32Array);
      }
      
      if (data.frame["particle.elements"]) {
        frame.elements = bytesToArrayManaged(data.frame["particle.elements"], Uint8Array);
      }

      if (data.frame["bond.pairs"]) {
        frame.bonds = bytesToArrayManaged(data.frame["bond.pairs"], Uint32Array);
      }

      frame.frame = data.frame;
    }

    if (data.box) {
      const box = bytesToArrayManaged(data.box, Float32Array);
      frame.box = box;
    }

    if (data.state) {
      frame.state = data.state;
    }

    port.postMessage({ frame } as SendMessageData, transfer);
  });
};
