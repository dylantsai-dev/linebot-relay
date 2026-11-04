#!/usr/bin/env python3
"""Render PNG fallbacks in public/ from src/brand/mark.svg (needs: pip install playwright && playwright install chromium).

    python3 scripts/render-icons.py

favicon-32.png: light variant, transparent corners. apple-touch-icon.png: 180x180, full-bleed tile (iOS rounds it)."""
import asyncio, base64, pathlib, re
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'public'

def variant(svg: str, size: int, full_bleed: bool) -> str:
    svg = re.sub(r'@media[^{]*\{.*?\}\s*\}', '', svg, flags=re.S)  # PNGs can't switch theme: keep the light variant
    svg = re.sub(r'width="\d+" height="\d+"', f'width="{size}" height="{size}"', svg, count=1)
    if full_bleed:
        svg = re.sub(r'(class="rm-tile"[^>]*?) rx="[\d.]+"', r'\1', svg)
    return svg

async def main():
    src = (ROOT / 'src' / 'brand' / 'mark.svg').read_text()
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        for name, size, bleed in [('favicon-32.png', 32, False), ('apple-touch-icon.png', 180, True)]:
            page = await browser.new_page(viewport={'width': size, 'height': size})
            data = base64.b64encode(variant(src, size, bleed).encode()).decode()
            await page.set_content(f'<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,{data}" style="display:block"></body></html>')
            await page.wait_for_timeout(100)
            await page.screenshot(path=str(PUBLIC / name), omit_background=True, clip={'x': 0, 'y': 0, 'width': size, 'height': size})
            print('wrote', PUBLIC / name)
        await browser.close()

asyncio.run(main())
