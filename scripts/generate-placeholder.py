#!/usr/bin/env python3
"""Generate original geometric placeholders using only Python's standard library.

SPDX-License-Identifier: MIT
Copyright (c) 2026 Claude Chan Pet macOS contributors
These simple geometric drawings do not reproduce upstream character artwork.
Existing user-supplied media is never overwritten.
"""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'assets' / 'pet'


def png(width, height, rgba):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\0' + bytes(rgba[y * width * 4:(y + 1) * width * 4]) for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def draw(width, height, pose='front', expression=0):
    pixels = bytearray(width * height * 4)
    def ellipse(cx, cy, rx, ry, color):
        for y in range(max(0, int(cy-ry-1)), min(height, int(cy+ry+2))):
            for x in range(max(0, int(cx-rx-1)), min(width, int(cx+rx+2))):
                if ((x-cx)/rx)**2 + ((y-cy)/ry)**2 <= 1:
                    offset=(y*width+x)*4
                    pixels[offset:offset+4]=bytes(color)
    def circle(x,y,r,color): ellipse(x,y,r,r,color)
    copper=(190,103,61,255); peach=(234,174,118,255); cream=(255,238,211,255); ink=(74,46,36,255)
    if height > 100:
        ellipse(width*.40,height*.91,width*.10,height*.055,ink)
        ellipse(width*.60,height*.91,width*.10,height*.055,ink)
        ellipse(width*.5,height*.59,width*.37,height*.30,copper)
        ellipse(width*.5,height*.60,width*.29,height*.24,peach)
        circle(width*.5,height*.16,width*.07,copper)
        ellipse(width*.5,height*.35,width*.38,height*.24,cream)
        cy=height*.35; r=width*.027
    else:
        circle(width*.5,height*.5,width*.44,cream)
        cy=height*.44; r=width*.04
    if pose == 'back':
        circle(width*.5,cy,width*.09,copper)
    else:
        shift=width*.07 if pose=='side' else 0
        for cx in (width*.39+shift,width*.61+shift):
            ellipse(cx,cy,r,r*(.4 if expression%3==2 else 1.4),ink)
        for step in range(17):
            t=math.pi*step/16
            x=width*.5+shift+math.cos(t)*width*.075
            y=cy+height*.055+math.sin(t)*height*.035
            circle(x,y,max(1,width*.009),ink)
    return png(width,height,pixels)


def main():
    # An existing pack belongs to its owner. The generator does not modify it.
    if (DEST/'front.png').exists():
        print('Using existing local media; nothing overwritten.')
        return
    DEST.mkdir(parents=True,exist_ok=True)
    for pose in ('front','side','back'):
        (DEST/(pose+'.png')).write_bytes(draw(192,256,pose))
    for expression in range(1,11):
        (DEST/('face-%02d.png'%expression)).write_bytes(draw(64,64,expression=expression))
    (DEST/'PLACEHOLDER.txt').write_text('Original geometric placeholders generated from scripts/generate-placeholder.py; MIT. No upstream character media.\n')
    print('Generated original geometric placeholders. No upstream media downloaded.')


if __name__ == '__main__':
    main()
