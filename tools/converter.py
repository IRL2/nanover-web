import struct
import msgpack
from typing import Iterable
from nanover.mdanalysis.converter import ELEMENT_INDEX

def write_webtraj(selection, io):
    universe = selection.universe
    
    elements = (ELEMENT_INDEX[e] for e in selection.elements)
    bonds = selection.bonds.to_indices().flat

    topology = {
        "elements": pack_array("B", len(selection.elements), elements),
        "bonds": pack_array("L", len(bonds), bonds),
    }
    
    positions = []
    for t in universe.trajectory:
        positions.append(pack_array("f", len(selection.positions) * 3, (c * .1 for c in selection.positions.flat)))
    
    data = {
        "topology": topology,
        "positions": positions,
    }

    io.write(msgpack.packb(data))

def pack_array(typecode: str, count: int, values: Iterable):
    return struct.pack(f"{count}{typecode}", *values)
