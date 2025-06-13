from array import array
from base64 import b64encode
from typing import Iterable
from json import dumps
from MDAnalysis import AtomGroup
from nanover.mdanalysis.converter import frame_data_to_mdanalysis, add_frame_topology_to_mda


def base64(format: str, values: Iterable):
    return b64encode(array(format, values)).decode("UTF-8")


def make_topology(elements: Iterable[int], bonds: Iterable[int]):
    return {
        "elements": base64("B", elements),
        "bonds": base64("L", bonds),
    }


def make_positions(postions: Iterable[float]):
    return base64("f", postions)


def frame_to_web(frame):
    limit = 8000
    universe = frame_data_to_mdanalysis(frame)
    add_frame_topology_to_mda(universe, frame)
    selection: AtomGroup = universe.select_atoms(f"index 0:{limit}")

    topology = make_topology(
        frame.particle_elements[:len(selection)],
        selection.bonds.to_indices().flat,
    )

    data = {
        "topology": topology,
        "positions": make_positions(c * .1 for c in selection.positions.flat),
    }

    return dumps(data)
