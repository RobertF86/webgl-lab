# Box Stack

Rigid bodies in 3D: a stack of boxes on a studio floor, and a heavy ball to
knock it over. The hard part is the stack itself — a tall tower has to stand
still and fall asleep, and still come down when something hits it.

No libraries, no build step. The physics lives in `rbd.js` and is shared by both
pages: `index.html` renders with WebGPU (`stapel-gpu.js`), `webgl.html` with
WebGL 1.0 (`stapel.js`) and is loaded automatically when WebGPU is not
available. The fonts come from `../fonts/`.

## Controls

| | |
| --- | --- |
| Drag | Orbit the camera |
| Wheel | Zoom |
| **Fire** / `Space` | Shoot a ball from the camera at the stack |
| **Push** | Shove the lowest layers sideways |
| **Rebuild** / `R` | Rebuild the stack from the sliders |
| **Pause** / `P` | Pause the simulation |
| **Tune** | Stack, world and ball sliders |

The stack sliders (columns, rows, layers, box size, gap, box mass) apply on
rebuild; gravity, friction, bounce and solver iterations apply live. Every
second layer is offset by half a box, as in a brick wall. At most three balls
are in the scene, and each is removed after 12 seconds. After four seconds
without camera input the view slowly orbits on its own.

The readout shows bodies, awake bodies, contacts, step time and frame rate.

## Files

| file | contents |
| --- | --- |
| `rbd.js` | the simulation: bodies, collision, solver, sleeping — no DOM, no GPU |
| `stapel-gpu.js` | scene, camera, controls and the WebGPU renderer |
| `stapel.js` | the same scene and controls with the WebGL renderer |
| `index.html`, `webgl.html` | the same page, apart from the renderer script and the fallback messages |

## How the simulation works

The world steps at a fixed 60 Hz on its own accumulator, and each step runs four
substeps — 240 per second. The comment in `rbd.js` records why: at 120 per
second an eight-box tower drifted 40 mm in six seconds and never fell asleep,
at 240 it stays within 12 mm and sleeps. More iterations or a different contact
order did not change that.

**Broad phase:** sort the bounding boxes along x and sweep. Within each pair
the two bodies are ordered by id. Taking the order from the x-sort let it flip
from step to step for boxes with the same x — a tower — so the contact normal
flipped and warm starting never found its counterpart.

**Box against box** is a separating-axis test over all 15 axes. When the best
axis is a face axis, the incident face is clipped against the side planes of
the reference face (Sutherland–Hodgman), which gives up to four contact points
per pair. That manifold is what makes stacks stable; one point per pair tips
every tower. Face axes are slightly preferred over edge axes, because edge
contacts at nearly the same depth otherwise alternate from step to step. Sphere
against box uses the closest point on the box; the floor takes every corner
below zero as a contact.

**Solver:** sequential impulses in the style of Erin Catto — accumulated normal
and friction impulses, two friction directions inside the Coulomb limit, and
warm starting from the previous step. The friction tangents are derived from the
contact normal, not from the sliding direction, so warm-started friction still
points the right way and resting stacks do not creep. Restitution only applies
to real impacts.

**Penetration** above a 3 mm slop is pushed out through separate bias
velocities (split impulses) that move the bodies and are then discarded. With
the correction in the real velocity, a tall tower gained energy every step — it
jittered and never slept.

**Sleeping** works per island: bodies connected by contacts (union-find) fall
asleep together or not at all. A single body may not sleep while something
touching it still moves, otherwise the bottom box of a tower becomes a fixed
wall the rest jitters against. Sleeping bodies count as static in the solver;
anything moving that touches them wakes them up.

## Rendering

A soft gradient backdrop, a studio floor with one soft contact shadow per body
(larger and fainter with height), a warm key light, a cool fill and brass as
the accent — the same visual language as the other demos. Boxes glow briefly on
a hard impact, and sleeping boxes are drawn slightly darker.

The WebGPU version draws floor, boxes, balls and shadows instanced: one entry
per body in an instance buffer (model matrix, normal matrix, colour, gloss,
glow, metalness) instead of uniforms per draw call. It renders in one pass with
4× MSAA, and converts the projection to WebGPU's 0…1 depth range. Scene,
controls and telemetry are the same as in the WebGL version.
