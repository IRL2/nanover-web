import fs from "node:fs";
import { pack } from "msgpackr";

function base64ToBytes(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

function decode(data) {
  const traj = {
    topology: {
      elements: new Uint8Array(base64ToBytes(data.topology.elements)),
      bonds: new Uint32Array(base64ToBytes(data.topology.bonds).buffer),
    },
    positions: data.positions.map((positions) => new Float32Array(base64ToBytes(positions).buffer)),
  }

  return traj;
}

function encode(traj) {
  const data = {
    topology: {
      elements: traj.topology.elements.buffer,
      bonds: traj.topology.bonds.buffer,
    },
    positions: traj.positions.map((positions) => positions.buffer),
  }

  return data;
}

const json = fs.readFileSync("./public/data/ludo-gluhut-6.json");
const dataSmall = JSON.parse(json);
const decoded = decode(dataSmall);
const encoded = encode(decoded);
const dataBytes = pack(encoded);

fs.writeFileSync("./public/data/ludo-gluhut-6.msgpack", dataBytes);
