# WebGL Lab

Small real-time graphics experiments for the browser. Each folder is one demo
with no libraries and no build step. The demos render with **WebGPU**; the six
that also have a WebGL version keep it as `webgl.html` and switch to it
automatically when WebGPU is not available. The ISS tracker is WebGPU only.

The same demos run in the LAB on fridayvfx.com, all seven on the
[WebGPU Playground](https://www.fridayvfx.com/fridayvfx/cms/lab/webgpu-playground/).

| Folder | Demo | WebGL fallback |
| --- | --- | --- |
| [`ball-in-box/`](ball-in-box/) | Ball in a Glass Box: drag an acrylic box and a brass ball reacts to it (built for the iPhone) | yes |
| [`boolean-comparison/`](boolean-comparison/) | Two Ways to Cut a Solid: the same boolean as mesh CSG and as an SDF, side by side | yes |
| [`box-stack/`](box-stack/) | Box Stack: 3D rigid bodies — a stack of boxes, knocked over by a ball | yes |
| [`modeler/`](modeler/) | Poly Bench: a small editable-poly modeller (select, move, extrude, chamfer) | yes |
| [`ocean/`](ocean/) | Phillips Spectrum Ocean: Tessendorf's *Simulating Ocean Water* on the GPU | yes |
| [`pinball/`](pinball/) | Pinball: a playable table as a rigid-body simulation, with swept contacts and ball spin | yes |
| [`iss-tracker/`](iss-tracker/) | ISS Tracker: the International Space Station on its current orbit (SGP4), against the real sky | no |

## WebGPU first, WebGL as fallback

`index.html` checks `navigator.gpu` and `requestAdapter()` at startup. If either
is missing, or creating the pipelines fails validation, the page calls
`location.replace("webgl.html#fallback=<reason>")` and the WebGL version loads
with a small banner naming the reason. The ISS tracker has no WebGL version and
shows a notice instead.

In the multi-file demos (`box-stack`, `pinball`) physics and game logic are
separate from rendering: both pages load the same simulation modules, and only
the renderer exists twice.

WebGPU is only available in a secure context — `https://` or `localhost`. A page
opened over plain HTTP on a LAN address, for example on a phone in the same
Wi-Fi, gets the WebGL version, and the ISS tracker does not start.

## Running a demo

Serve the repository root, not a single demo folder — the pages load their
fonts from `../fonts/`:

```
python3 -m http.server 8000
```

then browse to `http://localhost:8000/<folder>/`. To get the WebGPU version on
another device, serve the repo over HTTPS.

Once GitHub Pages is enabled for this repo, each demo is at
`https://robertf86.github.io/webgl-lab/<folder>/`.

## Tests

`modeler` and `ocean` have tests for their core code:

```
node modeler/tests/mesh.test.js
node ocean/tests/ocean.test.js
```

Both read the core straight out of `index.html` between marker comments;
`webgl.html` carries an identical copy of that block. The Node tests named in
the source comments of `box-stack`, `pinball` and `iss-tracker`
(`tests/*_test.js`) are not part of this repository.

## Fonts

All demos except `pinball` load their typefaces from `fonts/fonts.css`:
self-hosted WOFF2 files, Latin subset only, so nothing is requested from Google
Fonts. `pinball` names JetBrains Mono in its stylesheet without loading it and
falls back to the system monospace font.

## Third-party assets and licenses

| Files | Source | License |
| --- | --- | --- |
| `fonts/*.woff2` | Archivo, Barlow Semi Condensed, IBM Plex Mono, IBM Plex Sans, JetBrains Mono, Spectral | SIL Open Font License 1.1; license texts with the copyright notices in [`fonts/licenses/`](fonts/licenses/) |
| `pinball/umgebung/env_*.png`, `kuppel_*.png` | Converted from the HDRI ["Colorful Studio"](https://polyhaven.com/a/colorful_studio) by Sergej Majboroda, Poly Haven (256 px reflection cube, 16 px irradiance cube) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `pinball/umgebung/holz.jpg` | Wood photo (cabinet edge, shooter lane) | Used under a licence held by Robert Freitag; not covered by any licence of this repository, do not reuse |
| `pinball/umgebung/leder.jpg` | Leather photo (inner walls), Adobe Stock 615161189 | Used under an Adobe Stock licence held by Robert Freitag; not covered by any licence of this repository, do not reuse |
| `iss-tracker/texturen/erde-tag-*.jpg`, `texturen/kacheln/*.jpg` | NASA Earth Observatory, Blue Marble Next Generation with topography and bathymetry, July 2004 | Public domain, courtesy NASA Earth Observatory |
| `iss-tracker/texturen/erde-nacht-4096.jpg` | NASA Earth Observatory, Black Marble 2016 (Suomi NPP VIIRS) | Public domain, courtesy NASA Earth Observatory |
| `iss-tracker/texturen/wolken-2048.jpg` | NASA Earth Observatory, Blue Marble clouds | Public domain, courtesy NASA Earth Observatory |
| `iss-tracker/texturen/maske-2048.png` | Land/water mask derived from the GEBCO-08 bathymetry map of the NASA Earth Observatory | Public domain, courtesy NASA Earth Observatory (data: GEBCO) |
| `iss-tracker/texturen/mond-1024.jpg` | NASA SVS CGI Moon Kit (LRO LROC colour mosaic) | Public domain, courtesy NASA's Scientific Visualization Studio |
| `iss-tracker/sterne.bin` | Yale Bright Star Catalogue, 5th edition (Hoffleit & Warren 1991), stars to magnitude 6.5 | Public domain |
| `iss-tracker/bahn.js` | ISS orbital elements (NORAD 25544) from [CelesTrak](https://celestrak.org/) | Publicly available GP data |
| `iss-tracker/audio/space-ambient.{ogg,mp3}` | "Space Ambient" by leberch, [Pixabay](https://pixabay.com/music/ambient-space-ambient-509783/); ends faded, normalised to −16 LUFS | Pixabay Content License — see below |

**About the music.** The Pixabay Content License does not allow the audio file
to be redistributed on its own. It is included here only as part of the ISS
tracker; do not extract it or pass it on as a separate file. If you want to use
the track, get it from Pixabay under its license.

`iss-tracker/sgp4.js` is a port of David Vallado's SGP4 reference code
(Vallado, Crawford, Hujsak, Kelso, *Revisiting Spacetrack Report #3*,
AIAA 2006-6753).
