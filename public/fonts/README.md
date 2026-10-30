# Bundled fonts

[BIZ UDGothic and BIZ UDPGothic](https://github.com/googlefonts/morisawa-biz-ud-gothic) are Japanese and Latin typefaces from Morisawa, distributed under the SIL Open Font License 1.1. See `BIZ-UD-OFL.txt` for the copyright notice and license.

- UI and Preview text: BIZ UDPGothic Regular (400) and Bold (700), with proportional spacing.
- Raw and code: BIZ UDGothic Regular (400) and Bold (700), with fixed-width spacing; Japanese full-width characters occupy twice the advance of Latin half-width characters.

The source TTF files come from [`fonts/ttf/` at commit `18934af56b9c003ca58c54bffbf226848cb11032`](https://github.com/googlefonts/morisawa-biz-ud-gothic/tree/18934af56b9c003ca58c54bffbf226848cb11032/fonts/ttf), tagged `v1.051`. The committed WOFF2 files were compressed with fontTools 4.68.0 and Brotli 1.2.1, without subsetting. Character maps, glyph order and advance widths are retained.

For a font update, obtain the four TTF files and `OFL.txt` from the selected upstream revision, and compress each font:

```sh
uv run --no-project --isolated --with 'fonttools[woff]==4.68.0' --with 'brotli==1.2.1' \
  python -m fontTools.ttLib.woff2 compress FONT.ttf -o FONT.woff2
```

The conversion tools are only needed when updating the bundled files, not to run or test the Viewer. All four fonts are served locally; no Google Fonts API or CDN is used at runtime. Characters not covered by these fonts, including some symbols and emoji, may use system fallback fonts.
