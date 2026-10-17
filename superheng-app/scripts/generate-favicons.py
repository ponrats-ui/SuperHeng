#!/usr/bin/env python3
"""Regenerate SuperHeng's favicon set from the app's own monogram.

The "H" in the app header is not an image asset — `app-header.tsx` draws it: a
rounded crimson tile (`Brand.crimson`) filled with a 135° gradient from
`crimsonBright` to `crimsonDeep`, with the letter set in gold (`goldBright`).
There is therefore no logo file to copy a favicon from, and hand-drawing a new
mark here would let the tab icon and the in-app mark drift apart. This script
reproduces that monogram from the same hex values instead, so the two stay the
same mark by construction.

Run from `superheng-app/`:

    python scripts/generate-favicons.py

Writes the browser-facing files into `public/` (served from the site root in dev
and copied into `dist/` on export) and refreshes `assets/images/favicon.png`,
which `app.json` hands to Expo as `expo.web.favicon`.

Requires Pillow and, on Windows, the bundled Arial Black face. Pass a different
font path as the first argument if Arial Black is unavailable — any heavy sans
will do; the tile, gradient and gold colour are what carry the identity.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --- Brand values, copied from src/constants/theme.ts -----------------------

CRIMSON_BRIGHT = (0xE8, 0x39, 0x4F)
CRIMSON_DEEP = (0x7C, 0x0A, 0x1B)
GOLD_BRIGHT = (0xF0, 0xCE, 0x63)

# --- Shape -----------------------------------------------------------------

# The monogram is a 36px tile with Radius.md (12px) corners, i.e. a third of its
# own width. Keeping that ratio is what makes the tab icon read as the same mark
# rather than a different, squarer logo.
CORNER_RADIUS_RATIO = 1 / 3

# Cap height of the "H" as a share of the tile. The in-app letter is deliberately
# smaller (fontSize 20 in a 36px box); an icon has no padding to share with text
# around it, so the letter is scaled up until the tile no longer looks empty.
GLYPH_HEIGHT_RATIO = 0.54

# Corner masks are drawn at 4x and downsampled: Pillow's rounded_rectangle has no
# antialiasing, so at 16px the corners would otherwise come out visibly jagged.
SUPERSAMPLE = 4

MASTER_SIZE = 1024

WINDOWS_ARIAL_BLACK = r"C:\Windows\Fonts\ariblk.ttf"

# --- Output -----------------------------------------------------------------

# (path, pixels, rounded?) — the apple-touch icon is square because iOS applies
# its own corner mask and would otherwise show crimson-then-transparent corners.
OUTPUTS: tuple[tuple[str, int, bool], ...] = (
    ("public/favicon-16x16.png", 16, True),
    ("public/favicon-32x32.png", 32, True),
    ("public/apple-touch-icon.png", 180, False),
    ("assets/images/favicon.png", 48, True),
)

# Icon sizes packed into the multi-resolution .ico. Windows picks the closest.
ICO_SIZES = (16, 24, 32, 48, 64)


def gradient_tile(size: int) -> Image.Image:
    """A 135° (top-left to bottom-right) crimson gradient, as the header uses."""
    span = max(size - 1, 1)
    pixels = bytearray()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * span)
            pixels += bytes(
                round(a + (b - a) * t)
                for a, b in zip(CRIMSON_BRIGHT, CRIMSON_DEEP)
            )
    return Image.frombytes("RGB", (size, size), bytes(pixels))


def rounded_mask(size: int) -> Image.Image:
    """Antialiased rounded-square alpha mask."""
    big = size * SUPERSAMPLE
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    radius = round(big * CORNER_RADIUS_RATIO)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=radius, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def draw_monogram(size: int, font_path: str, rounded: bool) -> Image.Image:
    """The tile plus its gold "H", at any square size."""
    tile = gradient_tile(size).convert("RGBA")

    # Scale the face so the letter's cap height lands on GLYPH_HEIGHT_RATIO. The
    # cap height of "H" is its whole bbox: the letter has neither ascender nor
    # descender beyond the cap line, which is why the glyph is probed directly.
    probe = ImageFont.truetype(font_path, size)
    left, top, right, bottom = ImageDraw.Draw(tile).textbbox((0, 0), "H", font=probe)
    measured_cap = bottom - top
    if measured_cap <= 0:
        raise SystemExit(f"{font_path} gave the letter H no height at {size}px")
    wanted_cap = size * GLYPH_HEIGHT_RATIO
    font = ImageFont.truetype(font_path, round(size * wanted_cap / measured_cap))

    draw = ImageDraw.Draw(tile)
    left, top, right, bottom = draw.textbbox((0, 0), "H", font=font)
    draw.text(
        # Centred on the glyph's ink, not on its font metrics: textbbox includes
        # the side bearings, which for "H" are small but not symmetric.
        ((size - (right - left)) / 2 - left, (size - (bottom - top)) / 2 - top),
        "H",
        font=font,
        fill=GOLD_BRIGHT,
    )

    if rounded:
        tile.putalpha(rounded_mask(size))
    return tile


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    font_path = sys.argv[1] if len(sys.argv) > 1 else WINDOWS_ARIAL_BLACK
    if not Path(font_path).exists():
        raise SystemExit(f"font not found: {font_path} (pass a path as arg 1)")

    (here / "public").mkdir(exist_ok=True)

    # One high-resolution render, then downscale: resampling a large master keeps
    # the gradient and the letter's diagonals clean at 16px, which is the size
    # that actually shows up in a browser tab.
    master = draw_monogram(MASTER_SIZE, font_path, rounded=True)
    square_master = draw_monogram(MASTER_SIZE, font_path, rounded=False)

    for relative, pixels, rounded in OUTPUTS:
        source = master if rounded else square_master
        path = here / relative
        source.resize((pixels, pixels), Image.LANCZOS).save(path)
        print(f"wrote {relative} ({pixels}x{pixels})")

    # The .ico carries the same rounded mark as the PNGs. Browsers composite its
    # alpha channel correctly; a square fallback in the same file would show as a
    # different logo in the one place (the tab) users see it most.
    ico = here / "public/favicon.ico"
    master.resize((256, 256), Image.LANCZOS).save(
        ico, format="ICO", sizes=[(s, s) for s in ICO_SIZES]
    )
    print(f"wrote public/favicon.ico {ICO_SIZES}")


if __name__ == "__main__":
    main()
