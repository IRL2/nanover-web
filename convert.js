export async function start() {
    const i = 6;
    const path = `./traj-${i}.json`;
    
    /** @type {TestTrajectoryData} */
    const traj = await fetch(path).then((r) => r.json());

    const elements = new Uint8Array(traj.topology.elements);
    const bonds = new Uint32Array(traj.topology.bonds.flat());
    const positions = traj.positions.map((positions) => new Float32Array(positions.flat()));

    console.log(elements, bonds, positions);

    const better = {
        topology: {
            elements: bytesToBase64(elements), 
            bonds: bytesToBase64(bonds),
        },
        positions: positions.map((positions) => bytesToBase64(positions)),
    };

    console.log(JSON.stringify(better));

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
