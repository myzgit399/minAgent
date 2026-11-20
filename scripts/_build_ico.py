"""Build a Windows .ico from PNG frames (32bpp DIB entries, bottom-up, AND mask)."""
import io
import struct

from PIL import Image


def _dib(img_bytes):
    image = Image.open(io.BytesIO(img_bytes)).convert('RGBA')
    w, h = image.size
    # DIBs are stored bottom-up: emit scanlines in reverse order.
    xor = image.transpose(Image.FLIP_TOP_BOTTOM).tobytes('raw', 'BGRA')
    stride = ((w + 31) // 32) * 4
    and_mask = b'\x00' * (stride * h)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + xor + and_mask


def build(frames, out_path):
    """frames: list of (size, png_bytes) in desired order."""
    images = [_dib(p) for _, p in frames]
    out = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    for (size, _), data in zip(frames, images):
        dim = 0 if size >= 256 else size
        out += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for data in images:
        out += data
    with open(out_path, 'wb') as fh:
        fh.write(out)
