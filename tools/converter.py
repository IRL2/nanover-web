import struct
from typing import Iterable

def pack_array(typecode: str, count: int, values: Iterable):
    return struct.pack(f"{count}{typecode}", *values)
