#!/usr/bin/env python3
"""Draw the figure at the top of README.md from docs/what-was-checked.md.

    python3 tools/readme_figure.py

Writes docs/images/speed-light.svg and docs/images/speed-dark.svg, and prints the sentence the figure's alt text uses.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "what-was-checked.md"
OUT = ROOT / "docs" / "images"
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
THEMES = {
    "light": {"text": "#0b0b0b", "muted": "#52514e", "bar": "#2a78d6"},
    "dark": {"text": "#f0efec", "muted": "#c3c2b7", "bar": "#3987e5"},
}
SPEED = re.compile(r"Speed, for a reply of two sentences: (\d+) tokens per second on the iPhone 18 Pro, (\d+) on the Pixel 11 Pro, (\d+) in Chrome\.")
LABELS = ["iPhone 18 Pro", "Pixel 11 Pro"]
TITLE = "Gemma 4 E2B through this provider"
NOTE = "Tokens per second for a reply of two sentences: iPhone 2026-11-05; Pixel 2026-11-06, first run (next run: 14)."
WIDTH, BAR, VALUE_ROOM = 860, 22, 90


def read():
    """Return [(label, tokens per second)], read from the record."""
    if not SOURCE.is_file():
        sys.exit(f"readme_figure: {SOURCE} not found")
    speed = SPEED.search(SOURCE.read_text(encoding="utf-8"))
    if speed is None:
        sys.exit(f"readme_figure: no speed sentence in {SOURCE}")
    return [(label, int(speed.group(i + 1))) for i, label in enumerate(LABELS)]


def text(x, y, body, size, fill, weight="400"):
    return f'<text x="{x:g}" y="{y:g}" font-size="{size}" font-weight="{weight}" fill="{fill}">{body}</text>'


def draw(rows, theme, desc):
    c = THEMES[theme]
    unit = (WIDTH - VALUE_ROOM) / max(v for _, v in rows)
    parts = [text(0, 28, TITLE, 20, c["text"], "600"), text(0, 52, NOTE, 14, c["muted"])]
    y = 88
    for label, value in rows:
        parts.append(text(0, y, label, 15, c["text"]))
        w = value * unit
        parts.append(f'<rect x="0" y="{y + 8:g}" width="{w:g}" height="{BAR}" rx="4" fill="{c["bar"]}"/>')
        parts.append(text(w + 8, y + 8 + 16, f"{value} tok/s", 15, c["text"], "600"))
        y += 62
    height = y - 62 + 8 + BAR + 8
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {height:g}" width="{WIDTH}" height="{height:g}" '
        f'role="img" aria-labelledby="t d" font-family="{FONT}">\n'
        f'<title id="t">{TITLE}</title>\n<desc id="d">{desc}</desc>\n' + "\n".join(parts) + "\n</svg>\n"
    )


def main():
    rows = read()
    desc = TITLE + ". " + NOTE + " " + " ".join(f"{label}: {value} tokens per second." for label, value in rows)
    OUT.mkdir(parents=True, exist_ok=True)
    for theme in THEMES:
        (OUT / f"speed-{theme}.svg").write_text(draw(rows, theme, desc), encoding="utf-8")
    print(desc)


if __name__ == "__main__":
    main()
