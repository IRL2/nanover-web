import { saveBlobAs } from "./utility.js";

export default async function start() {
    const i = 0;
    const path = `./traj-${i}-small.json`;
    
    /** @type {TestTrajectory} */
    const traj = await fetch(path).then((r) => r.json()).then(decode);
    console.log(traj);

    // saveBlobAs(new Blob([JSON.stringify(better)]), "traj-small.json");
    saveBlobAs(new Blob([traj.topology.elements, traj.topology.bonds, ...traj.positions], {type: "octet/stream"}), "test.traj");

    /** @type {TestTrajectoryDataSmall} */
    const data = await fetch(`./traj-${i}-small.json`).then((r) => r.json());
    
    const traj2 = {
        topology: {
            elements: base64ToBytes(data.topology.elements),
            bonds: new Uint32Array(base64ToBytes(data.topology.bonds).buffer),
        },
        positions: data.positions.map((positions) => new Float32Array(base64ToBytes(positions).buffer)),
    }

    console.log(traj2);
}

export function bytesToBase64(array) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(array.buffer)));
}

export function base64ToBytes(str) {
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/**
 * @param {TestTrajectoryDataSmall} data 
 * @returns {TestTrajectory}
 */
export function decode(data) {
    const traj = {
        topology: {
            elements: new Uint8Array(base64ToBytes(data.topology.elements)),
            bonds: new Uint32Array(base64ToBytes(data.topology.bonds).buffer),
        },
        positions: data.positions.map((positions) => new Float32Array(base64ToBytes(positions).buffer)),
    }

    return traj;
}
