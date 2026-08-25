# Two Ways to Cut a Solid

A side-by-side WebGL demo of the same boolean operation evaluated two ways:

| | MESH · B-rep | FIELD · SDF |
| --- | --- | --- |
| What a solid *is* | a bag of triangles | a function returning distance |
| Boolean | BSP-tree CSG, in JS | `min` / `max`, in the shader |
| Produces | real geometry you could export | pixels, and nothing else |
| Cost scales with | triangle count, on the CPU | screen pixels, on the GPU |
| Smooth blends | no equivalent | one `smin()` |

Single self-contained `index.html`. No build step, no libraries — raw WebGL 1.0
and a BSP CSG solver written from scratch.

Both panes share one camera, one material and one lighting rig. The lighting
GLSL is written once and pasted into both fragment shaders, because if the two
panes were lit even slightly differently the comparison would be worthless.
Verified: the silhouettes agree to 0.3% and interior pixels to under 1/255.

## Controls

| Gesture | Effect |
| --- | --- |
| One-finger drag | Push the cutter sphere through the solid |
| Two-finger drag | Orbit the camera |
| Wheel | Cutter depth |
| Arrow keys | Move the cutter (Shift to orbit) |
| Subtract / Union / Intersect | The operation, applied to both panes |
| Blend radius | Fillets the field. The mesh side has no answer for this |
| Mesh detail | Cutter tessellation — watch the solve time climb |
| Wireframe | Reveals the CSG topology |
| Step heat | Colours the field pane by raymarch iterations per pixel |

## What the demo is actually showing

**The blend slider is the point.** In a distance field, a smooth union is
`smin()` — a three-line function, free, no special cases. Getting the same
fillet out of a mesh boolean is a genuinely hard, separate problem. Push the
slider and the mesh pane just sits there reporting `no equivalent`.

**The detail slider is the other point.** Measured in Chromium:

| detail | solve |
| --- | --- |
| 8 | 0.30 ms |
| 14 (default) | 0.80 ms |
| 22 | 7.0 ms |
| 28 | 20.7 ms |

Doubling the tessellation costs roughly twenty times as much. That is not an
implementation failure — a BSP over a *convex* solid degenerates into a chain,
because every face plane has every other face behind it. Meanwhile the field
pane does not move, because there is nothing to solve.

**Turn on the wireframe** to see what the mesh side actually hands you: triangle
soup around the cut, long slivers, no clean quads. Fine to render, bad to
subdivide or deform. The field pane has no wireframe because there is nothing
to draw one on.

**Turn on step heat** to see where the field's cost really goes — bright pixels
are ones where the ray took many small steps, which is exactly where the
raymarcher grazes a surface tangentially.

## Implementation notes

The CSG is the classic Thibault/Naylor BSP construction popularised by Evan
Wallace's `csg.js`: put each solid's polygons in a BSP tree, use each tree to
clip the other's polygons, splice the survivors together. Two deliberate
departures, both for robustness:

- **Split fragments inherit their parent's plane** rather than recomputing one
  from three possibly near-collinear vertices.
- **The cutter sphere is emitted as triangles, not quads.** A UV sphere's quads
  are not planar, and BSP clipping quietly misbehaves on polygons that are not.

Degenerate fragments are culled before upload — without that, slivers z-fight
into visible specks across the flat faces. The solver is JIT-warmed at startup,
because otherwise the very first drag is the slowest solve of the session by an
order of magnitude.

On the field side, rays skip to the scene's bounding sphere before marching,
normals come from the usual tetrahedral central difference, and the pane drops
its render scale if frame time suggests the GPU is struggling — measured
excluding CSG time, so the detail slider cannot trick the page into shrinking
its own resolution.

## Honest limits

BSP CSG is the *fragile* kind of mesh boolean. It is here because it is small
enough to read in one sitting and needs no dependencies — not because it is what
you would ship. For production mesh booleans use
[manifold](https://github.com/elalish/manifold) (guaranteed-manifold output,
WASM, the engine behind OpenSCAD) or
[three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) (BVH-accelerated,
fast enough to drag interactively). Both handle coplanar faces and near-miss
intersections far better than this does.

Neither side here reconstructs UVs. Booleans destroy them, and the cut surface
needs a planar projection or something smarter.
