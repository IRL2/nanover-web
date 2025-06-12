import { decode } from "./convert.js";

onmessage = (event) => {
    const { port } = event.data;
    console.log("LSTN PORT", port);
    port.addEventListener("message", (event) => {
        console.log("PORT RECV", event);
        const { path } = event.data;
        fetch(path).then((r) => r.json()).then(decode).then((traj) => port.postMessage({ traj }));
    });
    port.start();
};