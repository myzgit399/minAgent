"""Regenerate every desktop icon asset from minAgent/pics/icon.jpg.

The Windows .ico is written as multi-frame 32bpp DIBs (see _build-ico.py):
Pillow's own ICO writer only emits the smallest frame, which is what made the
packaged exe show one stretched raster at every size.
"""
import io
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _build_ico import build as build_ico  # noqa: E402

DESKTOP = os.path.abspath(os.path.join(HERE, '..', 'apps', 'desktop'))
SRC = os.path.abspath(os.path.join(HERE, '..', 'pics', 'icon.jpg'))
ASSETS = os.path.join(DESKTOP, 'assets')
APPX = os.path.join(ASSETS, 'appx')

src = Image.open(SRC).convert('RGB')
background = src.getpixel((0, 0))
print('source', SRC, src.size, 'background', background)


def square(size):
    img = Image.new('RGBA', (size, size), background + (255,))
    ratio = min(size / src.width, size / src.height)
    w, h = max(1, round(src.width * ratio)), max(1, round(src.height * ratio))
    img.paste(src.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2))
    return img


# --- app icons: Windows .ico (exe icon, window/taskbar) + macOS/Linux PNG ----
main = square(1024)
main.save(os.path.join(ASSETS, 'icon.png'))
main.save(os.path.join(ASSETS, 'icon-dark.png'))

sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
frames = []
for s in sizes:
    buf = io.BytesIO()
    square(s).save(buf, format='PNG')
    frames.append((s, buf.getvalue()))
build_ico(frames, os.path.join(ASSETS, 'icon.ico'))
build_ico(frames, os.path.join(ASSETS, 'icon-dark.ico'))
print('wrote icon.ico frames', sizes)


# --- MSIX / appx logo set ----------------------------------------------------
def save_appx(name, w, h):
    # Fit inside the slot; never crop the portrait artwork into a square tile.
    img = Image.new('RGBA', (w, h), background + (255,))
    ratio = min(w / src.width, h / src.height)
    tw, th = max(1, round(src.width * ratio)), max(1, round(src.height * ratio))
    img.paste(src.resize((tw, th), Image.LANCZOS), ((w - tw) // 2, (h - th) // 2))
    img.save(os.path.join(APPX, name))


scales = {'': 1, '.scale-125': 1.25, '.scale-150': 1.5, '.scale-200': 2, '.scale-400': 4}
for suffix, sc in scales.items():
    save_appx(f'Square44x44Logo{suffix}.png', round(44 * sc), round(44 * sc))
    save_appx(f'Square150x150Logo{suffix}.png', round(150 * sc), round(150 * sc))
    save_appx(f'StoreLogo{suffix}.png', round(50 * sc), round(50 * sc))
    save_appx(f'Wide310x150Logo{suffix}.png', round(310 * sc), round(150 * sc))
for t in [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]:
    for alt in ['', '_altform-lightunplated', '_altform-unplated']:
        save_appx(f'Square44x44Logo.targetsize-{t}{alt}.png', t, t)
print('wrote appx logo set ->', APPX)
