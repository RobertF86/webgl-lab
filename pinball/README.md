# Pinball

A playable pinball table as a rigid-body simulation: swept circle–segment
contacts, restitution and friction per surface, ball spin, and flippers driven
as rotating capsules. The rules follow electromechanical Bally tables of the
late seventies; the artwork borrows their silk-screen style in the FridayVFX
palette.

No libraries, no build step — plain scripts loaded in order. `index.html`
renders with WebGPU (`pinball-gpu.js`); `webgl.html` renders with WebGL
(`pinball.js`) and is loaded automatically when WebGPU is not available. All
other modules — physics, table, rules, artwork — are shared by both.

## Controls

| Key | Effect |
| --- | --- |
| `Space` | Start a game; then hold to pull the plunger, release to launch |
| `←` `→` | Left and right flipper |
| `N` | Nudge |
| `R` | New game |

On touch devices three buttons appear instead: left flipper, **LAUNCH**, right
flipper. A game has three balls. The readout shows score, ball, bonus and
multiplier, and below that ball speed, spin, the number of collision segments
and discs, and the frame rate.

## The table

Dimensions follow real machines: a 27 mm, 80 g ball, and a table 0.52 m wide
and 1.15 m long, inclined at 6.5°. The shooter lane sits on the right, so the
playable area is centred at x = −0.027 m, and flippers, slingshots and lanes are
mirrored around that line — the cabinet is symmetric, the playfield is not.

On the table: three pop bumpers, two slingshots, a bank of four and a bank of
three drop targets, two standup targets, the V-F-X top lanes, and an inlane and
outlane on each side. The geometry is described once, in `tisch.js`; physics,
artwork and rules all read the same description.

**Lanes.** Since 23 October 2026 the lanes at the bottom are modelled on the
Gottlieb *Snow Derby*: the inlane ends above the flipper pivot and feeds the
ball onto the flipper; the outlane runs past the outside of the flipper and
drains. The inlane is 47 mm wide, the outlane 32 mm. With the flipper held, a
ball coming down the inlane stops at the end of the divider, and can be released
and caught again as on a real machine.

**Slingshots** only kick when the ball runs into the rubber faster than
0.25 m/s; below that they are plain rubber. The kick is strongest in the middle
of the rubber and zero at the two posts, and a slingshot that has fired stays
quiet for 120 ms. That lets a ball settle in the corner between a held flipper
and the slingshot post, from where it can be aimed.

## Rules

| | |
| --- | --- |
| Pop bumper | 100; every fifth hit raises the bonus |
| Slingshot | 10, only when it actually kicks |
| Standup target | 500; both together 2,000 and bonus up |
| Drop target | 1,000; a complete bank 5,000 and multiplier up |
| Top lane V / F / X | 500; all three 3,000 and bonus up |
| Inlane | 200 and bonus up |
| Outlane | 500 as a consolation |
| Skill shot | 5,000 if the first hit after the launch is a top lane |
| Bonus | ladder × 1,000 × multiplier, paid when the ball drains |
| Extra ball | once, at 75,000 |

The bonus ladder counts up during a ball and is only paid out when it drains,
so one long ball is worth more than several short ones.

## How the simulation works

The physics (`physik.js`) is two-dimensional, in the plane of the playfield.
That is not a shortcut: the ball never leaves the playfield, and gravity acts
as g·sin(6.5°) down the table. Three things set it apart from a naive version:

- **Real times of impact.** The ball moves only up to its first contact, the
  contact is resolved, and the step continues with the remaining time. A ball at
  6 m/s covers 10 cm per frame — more than any wall is thick. Every obstacle is
  a capsule (a segment with a radius); ball against capsule reduces to a point
  against a capsule of radius r + R, which covers walls and rounded ends in one
  calculation. Only approach counts as a hit.
- **Spin.** The ball carries an angular velocity that builds up through
  friction at the contact and changes the next bounce.
- **Impulses, not reflection.** Normal and tangential impulses are computed
  separately, with friction limited by the Coulomb cone, so several
  simultaneous contacts stay stable instead of depending on their order.

Each frame runs 12 substeps (720 Hz at 60 fps). Flippers swing at up to
30 rad/s and pass their angular velocity into the contact. The plunger launches
the ball at 3.2 to 6.6 m/s depending on how long it was pulled.

## Rendering

The playfield artwork, the backglass and the cabinet sides are drawn
procedurally into canvases (`spielfeld.js`), from the same table description, in
silk-screen order: background, bands, rays, then discs and inserts. The same
module returns the list of lamps, so the rules can switch them.

Both renderers draw the scene into an offscreen buffer, add a glow pass at a
quarter of the width and height, and composite onto the canvas. Chrome and ball
are lit by two cube maps built from a real HDRI (see Credits): a 256 px
reflection map and a 16 px irradiance map for the dome light. They are stored as 8-bit PNG in the
encoding x = c / (c + 1), so luminances well above 1 survive; without that, the
brightest point would be 1.0 and chrome would look like grey plastic.

The WebGPU renderer puts all per-object values of a frame into one uniform
buffer, 256 bytes per object, bound by dynamic offset. On top of the WebGL
version it has:

- a dark room: a near-black background with a warm fringe at the top, where
  the WebGL version keeps a studio backdrop;
- reflections of the playfield in metal parts, by intersecting the reflection
  ray with the playfield plane;
- a light map of all 29 lamps (256 × 512, one instanced draw) that chrome and
  ball reflect;
- lamp sprites, and inserts as dark plastic that glow additively through a
  mask — in WebGL the inserts only get the light of the six point lights;
- the dividers between inlane and outlane as spring-steel wire guides instead
  of chrome tubes (the physics treats both as the same capsule);
- mipmaps of the reflection map averaged in linear space rather than in the
  encoded values.

Physics, table and rules are the same in both versions.

## Files

| file | contents |
| --- | --- |
| `raum.js` | mapping from the table plane to world space, matrices |
| `physik.js` | ball physics: times of impact, spin, impulses, kickers |
| `tisch.js` | the table geometry, defined once |
| `spiel.js` | rules, scoring, ball cycle (shooter lane, drain, next ball) |
| `spielfeld.js` | playfield artwork, backglass, cabinet sheets, lamp list, baked shadows |
| `umgebung.js` | loads the cube maps from `umgebung/` |
| `pinball-gpu.js` | models, camera, input and the WebGPU renderer |
| `pinball.js` | the same with the WebGL renderer |
| `umgebung/env_*.png`, `kuppel_*.png` | reflection cube (256 px) and irradiance cube (16 px) |
| `umgebung/holz.jpg`, `leder.jpg` | wood (cabinet edge, shooter lane) and leather (inner walls), licensed photos (see Credits); without them the renderer falls back to a procedural oak and a flat colour |
| `logo.png` | the FridayVFX logo, used on the playfield, backglass and cabinet |

## Comparison switches

URL parameters, read by both renderers (the fallback passes them on):
`?alt=1` restores the earlier contact handling, and `?sling_kick=<m/s>`,
`?sling_schwelle=<m/s>`, `?sling_profil=0|1`, `?sling_sperre=<s>` override
the slingshot values above; `?sling_alt=1` sets all four to the old behaviour.
The readout notes any deviation. The WebGPU version also exposes
`window.pinballDebug` for inspection.

## Credits

The environment cube maps are converted from the HDRI
["Colorful Studio"](https://polyhaven.com/a/colorful_studio) by Sergej
Majboroda, Poly Haven, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Nothing is loaded from Poly Haven at runtime.

The wood (`umgebung/holz.jpg`) and leather (`umgebung/leder.jpg`, Adobe Stock
615161189) photos are used under licences held by Robert Freitag. They are not
covered by any licence of this repository; do not reuse them.
