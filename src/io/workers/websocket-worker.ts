import { unpack, pack } from "msgpackr";
import { bytesToArray, ArrayConstructor } from "../../core/convert.js";
import { TestFrame, TestMessageData } from "../../core/types.js";

export type SetupMessageData = {
  port: MessagePort;
}

export type ConnectMessageData = {
  host: string;
}

export type CommandRequestData = {
  id: number;
  name: string;
  arguments?: Record<string, unknown>;
}

export type CommandResponseData = {
  request: Partial<CommandRequestData> & Pick<CommandRequestData, "id">;
  response: unknown;
}

export type CommandRegisterData = {
  name: string;
  arguments?: Record<string, unknown>;
  label?: string;
  icon?: string;
}

export type RecvMessageData = {
  state?: {
    updates?: Record<string, unknown>;
    removals?: string[];
  };

  command?:
    | { request: CommandRequestData }
    | { request: CommandRequestData; response: unknown }
    | { register: CommandRegisterData };
}

export type ServerCommandMessage = {
  register?: CommandRegisterData;
  request?: CommandRequestData;
  response?: unknown;
  exception?: string;
}

export type SendMessageData = {
  frame: Partial<TestFrame>;
  command?: ServerCommandMessage | ServerCommandMessage[];
  event?: "open" | "close";
}

let port: MessagePort | null = null;
let socket: WebSocket | null = null;

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

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
    port?.postMessage({ frame: {}, event: "open" } as SendMessageData);
  });

  socket.addEventListener("close", (event) => {
    console.log("CLOSE", event);
    port?.postMessage({ frame: {}, event: "close" } as SendMessageData);
  });

  socket.addEventListener("error", (event) => {
    console.log("ERROR", event);
  });

  socket.addEventListener("message", async (event) => {
    const data = event.data instanceof Blob 
      ? unpack(await event.data.arrayBuffer()) as TestMessageData
      : JSON.parse(event.data) as TestMessageData;
    const frame: Partial<TestFrame> = {};

    const transfer: Transferable[] = [];
    function bytesToArrayManaged<TArray extends { buffer: ArrayBuffer }>(bytes: Uint8Array, type: ArrayConstructor<TArray>)
    {
      const array = bytesToArray(bytes, type);
      transfer.push(array.buffer);
      return array;
    }

    if (data.frame) {
      const particlePositions = data.frame["particle.positions"];
      if (isUint8Array(particlePositions)) {
        frame.positions = bytesToArrayManaged(particlePositions, Float32Array);
      }
      
      const particleElements = data.frame["particle.elements"];
      if (isUint8Array(particleElements)) {
        frame.elements = bytesToArrayManaged(particleElements, Uint8Array);
      }

      const bondPairs = data.frame["bond.pairs"];
      if (isUint8Array(bondPairs)) {
        frame.bonds = bytesToArrayManaged(bondPairs, Uint32Array);
      }

      const particleResidues = data.frame["particle.residues"];
      if (isUint8Array(particleResidues)) {
        frame.residues = bytesToArrayManaged(particleResidues, Int32Array);
      }

      const systemBoxVectors = data.frame["system.box.vectors"];
      if (isUint8Array(systemBoxVectors)) {
        frame.box = bytesToArrayManaged(systemBoxVectors, Float32Array);
      }

      frame.frame = data.frame;
    }

    if (isUint8Array(data.box)) {
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
