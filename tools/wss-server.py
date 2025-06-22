import asyncio
from pathlib import Path
import websockets
import ssl
import json

from nanover.app import NanoverImdClient
from nanover.trajectory.frame_data import PARTICLE_POSITIONS
from nanover.state.state_dictionary import DictionaryChange
from MDAnalysis import AtomGroup
from nanover.mdanalysis.converter import frame_data_to_mdanalysis, add_frame_topology_to_mda

from converter import base64, make_topology, make_positions

async def forward_user(client, websocket):
    while True:
        data: dict = json.loads(await websocket.recv())
        change = DictionaryChange(
            updates=data.get("updates", {}),
            removals=data.get("removals", set()),
        )
        client.attempt_update_multiplayer_state(change)



async def forward_frames(client, websocket):
    limit = 8000

    frame = client.current_frame
    universe = frame_data_to_mdanalysis(frame)
    add_frame_topology_to_mda(universe, frame)
    selection: AtomGroup = universe.select_atoms(f"index 0:{limit}")

    topology = make_topology(
        frame.particle_elements[:len(selection)],
        selection.bonds.to_indices().flat,
    )

    data = {
        "topology": topology,
    }


    fields = frame.raw.arrays["system.box.vectors"].ListFields()
    array = fields[0][1].values
    data["box"] = base64("f", array)

    await websocket.send(json.dumps(data))

    while True:
        frame = client.current_frame
        if PARTICLE_POSITIONS in frame:
            # print("FRAME")
            universe = frame_data_to_mdanalysis(frame)
            selection: AtomGroup = universe.select_atoms(f"index 0:{limit}")
            data = { "positions": make_positions(c * .1 for c in selection.positions.flat) }
            await websocket.send(json.dumps(data))
        await asyncio.sleep(1/30)


async def send_frames(websocket):
    with NanoverImdClient.autoconnect(name="ragzo: NanoVer iMD Server") as nanover_client:
        print("CONNECTED")
        nanover_client.subscribe_to_frames()
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
            if not ip.startswith("127.")
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
    # ssl_cert = Path(__file__).parent / "data/localhost.pem"
    # ssl_key = Path(__file__).parent / "data/localhost.key"

    # ssl_context.load_verify_locations(ssl_cert)
    # ssl_context.load_cert_chain(ssl_cert, keyfile=ssl_key, password="password")
    print(ssl_context)

    async with websockets.serve(send_frames, "0.0.0.0", 0) as server:
        ip = get_local_ip()
        port = server.sockets[0].getsockname()[1]

        data = {
            "name": "test server",
            "web": f"https://{ip}:5500",
            "endpoint": f"ws://{ip}:{port}",
        }

        async with websockets.connect("wss://irl-discovery.onrender.com/") as discovery:
            await asyncio.gather(
                run_discovery(discovery, data),
                asyncio.Future(),
            )



if __name__ == "__main__":
    asyncio.run(main())
