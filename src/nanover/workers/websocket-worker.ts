import { unpack, pack } from "msgpackr";
import { bytesToArray, ArrayConstructor } from "../convert.js";
import { TestFrame, TestMessageData } from "../types.js";

export type SetupMessageData = {
  port: MessagePort;
}

export type ConnectMessageData = {
  host: string;
}

export type CommandRequestData = {
  id: number;
  name: string;
  arguments?: Object;
}

export type CommandResponseData = {
  request: Partial<CommandRequestData> & Pick<CommandRequestData, "id">;
  response: any;
}

export type RecvMessageData = {
  state?: {
    updates: { [key: string]: any };
    removals: string[];
  };

  command?: CommandRequestData[];
}

export type SendMessageData = {
  frame: Partial<TestFrame>;
  command?: CommandResponseData[];
}

let port: MessagePort | null = null;
let socket: WebSocket | null = null;

function connectToHost(host: string) {
  if (!port) {
    console.error("Port not initialized");
    return;
  }

  if (socket) {
    socket.close();
    socket = null;
  }

  console.log("CONNECTING", host);

  socket = new WebSocket(host);

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
    const data = event.data instanceof Blob 
      ? unpack(await event.data.arrayBuffer()) as TestMessageData
      : JSON.parse(event.data) as TestMessageData;
    const frame = {} as TestFrame;

    const transfer: Transferable[] = [];
    function bytesToArrayManaged<TArray extends { buffer: ArrayBuffer }>(bytes: Uint8Array, type: ArrayConstructor<TArray>)
    {
      const array = bytesToArray(bytes, type);
      transfer.push(array.buffer);
      return array;
    }

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


      if (data.frame["system.box.vectors"]) {
        frame.box = bytesToArrayManaged(data.frame["system.box.vectors"], Float32Array);
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

    port!.postMessage({ frame, command: data.command } as SendMessageData, transfer);
  });
}

onmessage = (event) => {
  const data = event.data as SetupMessageData | ConnectMessageData;

  if ('port' in data && data.port) {
    port = data.port;
    port.addEventListener("message", (event: { data: RecvMessageData }) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const bytes = pack(event.data);
        socket.send(bytes);
      }
    });
    port.start();
    return;
  }

  if ('host' in data && data.host) {
    connectToHost(data.host);
  }
};
