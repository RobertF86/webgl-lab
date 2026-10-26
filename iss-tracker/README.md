# ISS Tracker

The International Space Station on its current orbit around the Earth, with
the real sky behind it: stars to magnitude 6.5, the Sun, the Moon and five
planets, the orbit and ground track, the visibility circle, and a procedural
model of the station for the close-up. Live by default, with pause and
×10 / ×100 time-lapse.

WebGPU only — no WebGL version. Without WebGPU the page shows *"WebGPU is not
available in this browser."* No framework, no build step, and nothing is
fetched from third parties at runtime: orbital elements, star catalogue,
textures and music all ship in this folder. Fonts come from `../fonts/`.

## Controls

| Input | Effect |
| --- | --- |
| Drag (mouse, one finger) | Rotate the camera, with momentum |
| Wheel, two fingers | Zoom (Earth 1.2–12 Earth radii, Follow 0.05–5000 km, Look: field of view 5–70°) |
| Double-click / double-tap the marker or model | Follow the ISS |
| Double-tap the Earth in Look mode | Back to Earth |
| `f` / `e` | Follow the ISS / back to Earth |
| `j` | Jump to the real time ("Now"); the rate stays |
| `Space` | Pause / resume |
| Arrow keys | Rotate (Look mode: look around) |
| `+` / `=` and `-` (also the numpad keys) | Zoom |
| `m` | Music on/off |

The **Controls** panel switches the camera between Earth, Follow ISS and Look,
the frame between Earth-fixed and Inertial, and toggles clouds, atmosphere,
city lights, orbit, ground track, visibility circle, labels and the star
magnitude limit. The time bar has Live, Pause, ×10, ×100, Now and the speaker
button. Clicking the ISS label follows the station; clicking the Moon, the Sun
or a planet turns the Look camera toward it.

**Music** is on by default. Most browsers block sound until the first user
action; the speaker button then stays pressed with a dashed outline, and the
first click, tap or key press starts the music. The choice made with the button
or `m` is remembered in `localStorage`.

## How it works

**Orbit.** `sgp4.js` is a port of David Vallado's SGP4 reference code
(version 2020-07-13, AIAA 2006-6753), near-Earth branch only, with the WGS-72
constants and in the same order of operations. Positions come out in TEME;
GMST turns them Earth-fixed, and WGS84 gives latitude, longitude and altitude.
The deep-space branch (periods of 225 minutes and more) is not ported, which
does not matter for the ISS.

**Orbital elements.** `bahn.js` holds one two-line element set from CelesTrak.
On the website it is refreshed with every deploy; in this repository it is a
snapshot. SGP4 with a TLE is good to about 1 km at the epoch and drifts by
roughly 1–3 km per day after that. From 14 days after the epoch the panel
warns *"orbit data is N days old; position may be off by tens of
kilometres"*. To update it, replace the two TLE lines with a current set for
NORAD 25544 from CelesTrak and set `epoche` (the TLE epoch, ISO 8601) and
`geholt` (fetch time) to match; the position itself uses the epoch in the TLE.

**Sky.** `himmelsmechanik.js` computes the Sun after Meeus (chapter 25), the
Moon with the short method of the Astronomical Almanac (about 0.3°), the
planets from JPL's approximate orbital elements (Standish, valid 1800–2050), and
precession from J2000 to the date. The stars come from `sterne.bin`: 8404
entries of the Yale Bright Star Catalogue to magnitude 6.5, as unit vectors with
magnitude and a colour from B−V, rotated to the date when loaded.

**Rendering.** Three layers per frame, each a render pass into the same 4×
MSAA buffer; the last one resolves to the canvas:

1. `himmel` — stars, Sun and planets as screen-space quads, rotation only.
2. `welt` — Earth, Moon, atmosphere, clouds, orbit, ground track and marker,
   in Earth radii with reversed-Z depth. The world is drawn camera-relative:
   positions are shifted by the camera position in double precision on the
   CPU, because float32 rounds to about 0.76 m at one Earth radius.
3. `iss` — the station model in metres around its centre, only when it is
   closer than 200 km and not behind the Earth.

The Earth has day and night maps with city lights, cloud shadows, glint on
water, and an atmosphere after O'Neil (Rayleigh and Mie scattering); the Sun
turns red behind the limb. A single WebGPU texture may be at most 8192 px wide,
so the day map comes in two stages: an 8192 or 4096 px base map for the
distance, and 32 detail tiles at the full resolution of the 21600 × 10800 px
source map (about 1.9 km per pixel at the equator). The tiles load only when
the camera is within 6000 km of the station or follows it, nearest to its
ground point first, into a texture array that evicts the least recently used
tile. The station model is flat-shaded with GGX sunlight, Earth shadow and
earthshine; the solar arrays track the Sun, and the position lights
pulse red to port and green to starboard. Orbit and ground track are drawn as
screen-space ribbons with round joins.

Tone mapping (ACES) and sRGB encoding happen in the fragment shaders; the
device pixel ratio is capped at 2 and lowered if the render targets do not fit
into GPU memory.

## Files

| file | contents |
| --- | --- |
| `bahn.js` | TLE of the ISS (NORAD 25544), epoch, fetch time |
| `zeit.js` | Julian date, GMST (IAU 1982), the simulation clock |
| `sgp4.js` | SGP4 propagator, TEME → Earth-fixed, WGS84 geodesy |
| `himmelsmechanik.js` | Sun, Moon, planets, precession |
| `sterne.js`, `sterne.bin` | star catalogue and its loader |
| `gpu.js` | device start, shaders, buffers, textures with mipmaps, sphere mesh, matrices |
| `kamera.js` | camera modes Earth / Follow / Look, transitions, input |
| `himmel.js` | sky layer: stars, Sun, planet discs; the shared tone-mapping code |
| `kacheln.js` | detail tiles of the day map |
| `erde.js` | Earth, clouds, atmosphere, Moon |
| `spur.js` | orbit, ground track, visibility circle, marker |
| `iss-modell.js`, `iss.js` | procedural station model and its renderer |
| `labels.js` | HTML labels: projection, occlusion, placement |
| `klang.js` | background music |
| `tracker.js` | the application: start-up, loading, frame loop, panels |
| `texturen/` | Earth day, night, clouds, land/water mask, Moon; `kacheln/` holds the detail tiles |
| `audio/` | the music as OGG and MP3 |

The modules are plain scripts, one global object each, loaded in the order
given in `index.html`. The Node tests named in their comments are not part of
this repository.

## Known limits

- **Textures are fixed:** the day map is from July 2004, the night map from
  2016, the clouds a single snapshot — not the current weather.
- **Stars** use J2000 positions without proper motion; for the fastest bright
  stars that is up to about 1′ by 2026.
- **The land/water mask** is 2048 × 1024 (about 20 km per pixel at the
  equator); very small islands are missing.
- **The NASA day map has a seam at the date line**, most visible in the sea ice
  north of about 67° N. It is in the source data.
- The number of tile slots and the base map size are chosen from the window
  size at load time; a window enlarged later keeps the smaller stage until
  reload.

## Credits

| Files | Source | License |
| --- | --- | --- |
| `texturen/erde-tag-*.jpg`, `texturen/kacheln/*.jpg` | NASA Earth Observatory, Blue Marble Next Generation with topography and bathymetry, July 2004 | Public domain, courtesy NASA Earth Observatory |
| `texturen/erde-nacht-4096.jpg` | NASA Earth Observatory, Black Marble 2016 (Suomi NPP VIIRS) | Public domain, courtesy NASA Earth Observatory |
| `texturen/wolken-2048.jpg` | NASA Earth Observatory, Blue Marble clouds | Public domain, courtesy NASA Earth Observatory |
| `texturen/maske-2048.png` | derived from the GEBCO-08 bathymetry map of the NASA Earth Observatory | Public domain, courtesy NASA Earth Observatory (data: GEBCO) |
| `texturen/mond-1024.jpg` | NASA SVS CGI Moon Kit (LRO LROC colour mosaic) | Public domain, courtesy NASA's Scientific Visualization Studio |
| `sterne.bin` | Yale Bright Star Catalogue, 5th edition (Hoffleit & Warren 1991) | Public domain |
| `bahn.js` | GP data for NORAD 25544 from [CelesTrak](https://celestrak.org/) | Publicly available |
| `audio/space-ambient.{ogg,mp3}` | "Space Ambient" by leberch, [Pixabay](https://pixabay.com/music/ambient-space-ambient-509783/); ends faded, normalised to −16 LUFS | Pixabay Content License |

The Pixabay Content License does not allow the music file to be redistributed
on its own. It is included only as part of this demo; do not extract it or
pass it on separately — if you want the track, get it from Pixabay.
