import asyncio
from functools import partial
from pathlib import Path
from typing import Callable, Any

import websockets
import ssl
import json
import aiohttp
import msgpack

from nanover.app import NanoverImdClient
from nanover.trajectory.frame_data import PARTICLE_POSITIONS, FrameData, PARTICLE_COUNT, RESIDUE_COUNT, CHAIN_COUNT, \
    SIMULATION_COUNTER, RESIDUE_CHAINS, BOND_PAIRS, PARTICLE_ELEMENTS, BOX_VECTORS, PARTICLE_RESIDUES
from nanover.state.state_dictionary import DictionaryChange
from MDAnalysis import AtomGroup
from nanover.mdanalysis.converter import frame_data_to_mdanalysis, add_frame_topology_to_mda

from converter import pack_array

async def forward_user(client, websocket):
    while True:
        data: dict = msgpack.unpackb(await websocket.recv())
        
        change = DictionaryChange(
            updates=data.get("updates", {}),
            removals=data.get("removals", set()),
        )

        client.attempt_update_multiplayer_state(change)


pack_float32 = partial(pack_array, "f")
pack_uint32 = partial(pack_array, "I")
pack_uint8 = partial(pack_array, "B")

converters: dict[str, Callable[[], Any]] = {
    PARTICLE_COUNT: int,
    CHAIN_COUNT: int,
    RESIDUE_COUNT: int,
    SIMULATION_COUNTER: int,

    PARTICLE_POSITIONS: pack_float32,
    PARTICLE_ELEMENTS: pack_uint8,
    PARTICLE_RESIDUES: pack_uint32,

    BOND_PAIRS: pack_uint32,

    RESIDUE_CHAINS: pack_uint32,
    BOX_VECTORS: pack_float32,
}


def convert_frame(frame: FrameData):
    data = {}

    for key in frame.value_keys:
        converter = converters.get(key, lambda value: value)
        data[key] = converter(frame.values[key])

    for key in frame.array_keys:
        converter = converters.get(key, list)
        data[key] = converter(frame.arrays[key])

    return data


async def forward_frames(client, websocket):
    frame = client.current_frame
    universe = frame_data_to_mdanalysis(frame)
    add_frame_topology_to_mda(universe, frame)

    data = {
        "frame": convert_frame(frame),
    }

    fields = frame.raw.arrays["system.box.vectors"].ListFields()
    array2 = fields[0][1].values
    data["box"] = pack_array("f", array2)

    await websocket.send(msgpack.packb(data))

    while True:
        frame = client.latest_frame

        if PARTICLE_POSITIONS in frame:
            data = {
                "frame": convert_frame(frame),
                "state": client.latest_multiplayer_values,
            }

            bin = msgpack.packb(data)

            await websocket.send(bin)
        await asyncio.sleep(1/60)


async def send_frames(websocket):
    with NanoverImdClient.autoconnect(name="DEMO-gluhut") as nanover_client:
        print("CONNECTED")
        nanover_client.subscribe_to_frames()
        nanover_client.subscribe_multiplayer()
        nanover_client.wait_until_first_frame()
        
        await asyncio.gather(
            forward_frames(nanover_client, websocket),
            forward_user(nanover_client, websocket),
        )


async def run_discovery(websocket, data):
    init = json.loads(await websocket.recv())
    print(init, data)
    await websocket.send(json.dumps(data))
    await asyncio.Future()


def get_local_ip():
    import socket; 

    def attempt():
        yield from [
            ip 
            for ip in socket.gethostbyname_ex(socket.gethostname())[2] 
            if ip.startswith("192.")
        ][:1]

        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 53))
        name = s.getsockname()[0]
        s.close()
        yield name

    ip = next(attempt())

    return ip


async def main():
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_key = Path(__file__).parent / "../localhost.key"
    ssl_cert = Path(__file__).parent / "../localhost.pem"

    ssl_context.load_verify_locations(ssl_cert)
    ssl_context.load_cert_chain(ssl_cert, keyfile=ssl_key, password="nanover")
    print(ssl_context)

    print("POLLING DISCOVERY")
    async with aiohttp.ClientSession() as session:
        response = await session.get("https://irl-discovery.onrender.com/list")
        print("list:", await response.json())

    print("RUNNING SERVER")
    async with websockets.serve(send_frames, "0.0.0.0", 0) as server_insecure:
        async with websockets.serve(send_frames, "0.0.0.0", 0, ssl=ssl_context) as server:
            ip = get_local_ip()
            port = server.sockets[0].getsockname()[1]
            port_insecure = server_insecure.sockets[0].getsockname()[1]

            data = {
                "name": "test server",
                "web": f"https://{ip}:5500",
                "https": f"https://{ip}:5500",
                "wss": f"wss://{ip}:{port}",
                "ws": f"ws://{ip}:{port_insecure}",
            }

            async with websockets.connect("wss://irl-discovery.onrender.com/", open_timeout=5) as discovery:
                await asyncio.gather(
                    run_discovery(discovery, data),
                    asyncio.Future(),
                )



if __name__ == "__main__":
    asyncio.run(main())
