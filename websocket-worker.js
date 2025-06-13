import { base64ToBytes } from "./convert.js";

onmessage = (event) => {
    const { port, host } = event.data;

    console.log("CONNECTING", host);

    port.addEventListener("message", (event) => {
        console.log("WHY");
    });
    port.start();

    const socket = new WebSocket(host);

    socket.addEventListener("open", (event) => {
        console.log("SOCKET CONNECTED");
    });

    socket.addEventListener("close", (event) => {
    });

    socket.addEventListener("error", (event) => {
    });

    socket.addEventListener("message", (event) => {
        console.log("SOCKET MSG");
        const data = JSON.parse(event.data);
        const frame = {};
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
            const box =  new Float32Array(base64ToBytes(data.box).buffer);
            frame.box = box;
            transfer.push(box.buffer);
        }

        port.postMessage({ frame }, transfer);
    });
};