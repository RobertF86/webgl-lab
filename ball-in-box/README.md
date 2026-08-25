# Ball in a Glass Box

A WebGL physics demo built for the iPhone: a brass test mass loose inside an
open-topped acrylic box. Drag the box and the ball answers — it lags behind when
you yank sideways, slams into the wall you drag toward, goes light when you drop
the box, and rolls to a stop when you hold still.

Single self-contained `index.html`. No build step, no libraries, no bundler —
raw WebGL 1.0 and about 900 lines of JavaScript.

## Viewing it on a phone

Any of these work:

- **Serve it locally** and open the LAN address on the phone (same Wi-Fi):
  ```
  cd rnd/webgl-ball-in-box && python3 -m http.server 8000
  ```
  then browse to `http://<your-computer-ip>:8000` on the iPhone.
- **GitHub Pages** — enable Pages for the repo and open
  `/rnd/webgl-ball-in-box/`.
- **Open the file directly** — it runs fine from `file://` too; only the web
  font fails to load, and the fallback stack covers that.

Add it to the Home Screen and it launches full-screen with no browser chrome.

## Controls

| Gesture | Effect |
| --- | --- |
| One-finger drag | Move the box left/right and up/down |
| Two-finger drag | Move the box in depth (toward/away) |
| Arrow keys | Same, with Shift for depth |
| Trackpad / wheel | Depth |
| **Reset** | Recentre the box and drop the ball again |
| **Tune** | Gravity, bounce and friction sliders |

Shake hard enough and the ball genuinely leaves through the open top — there is
no invisible lid. It is put back a few seconds after it is clearly gone.

## How the simulation works

The sim runs at a fixed **240 Hz** on its own accumulator, decoupled from the
frame rate, so it behaves the same at 60 fps and at 120 fps.

**Contacts** are sphere-vs-AABB against the five wall slabs, evaluated in the
box's local frame. Because the test uses the true closest point on each slab,
one routine covers the inner faces, the outer faces, the rim and every edge and
corner — the ball can rest on the rim or bounce off the outside of the box
without any special cases.

**Response** is a standard impulse pair at each contact. The normal impulse uses
restitution, dropped to zero below 0.55 m/s so a resting ball does not shiver.
The friction impulse is Coulomb-limited and capped by the tangential effective
mass of a solid sphere (2/7 of its mass at the contact point); applying it at the
surface rather than the centre generates the torque that turns a sliding ball
into a rolling one. Orientation integrates as a quaternion, and the three
engraved great circles on the ball exist so the spin is actually visible.

Wall velocity enters every contact as the relative velocity `ball − box`, which
is the whole trick: the ball does not react to *where* the box is, it reacts to
how fast the wall is moving when it arrives.

**Tunnelling** is prevented rather than made unlikely: the box's per-substep
displacement is capped at a fraction of the ball's radius, so no wall can ever
cross the ball between two substeps regardless of how fast you swipe.

## Rendering

One lit shader with four modes (glass wall, milled floor plate, brass ball,
studio ground) plus a gradient backdrop. Opaque geometry draws first, then the
four glass walls sorted back-to-front with depth writes off. Back-face culling
means the near wall shows its outer face and the far wall its inner face, so
each pane contributes exactly one layer of glass.

The scene reads its colours from the same CSS custom properties as the interface,
so the 3D view follows the viewer's light/dark theme.
