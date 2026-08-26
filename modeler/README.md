# Poly Bench

A small editable-poly modeller in WebGL. Start from a box, select vertices,
edges or faces, move/rotate/scale them, extrude and chamfer.

Single self-contained `index.html` — raw WebGL 1.0, no libraries, no build step.

## Controls

| | |
| --- | --- |
| Tap the model | Toggle that vertex / edge / face in the selection |
| Drag empty space | Orbit |
| Two fingers | Pan and zoom |
| Wheel | Zoom |
| Drag a gizmo handle | Move / rotate / scale along that axis |
| Centre handle | Free move in the screen plane, or uniform scale |
| `1` `2` `3` | Vertex / Edge / Face level |
| `Q` `W` `E` `R` | Select / Move / Rotate / Scale |
| `A` | Select all &nbsp;·&nbsp; `Ctrl+Z` / `Ctrl+Shift+Z` undo, redo |

**Extrude** works on a face selection; the new cap stays selected so you can
extrude again immediately. **Chamfer** works on an edge selection, or on a
vertex selection (which chamfers every edge meeting it). Both use the Amount
slider, and both are undoable.

## The mesh core

The canonical form is deliberately dumb — a position list and a list of faces
holding vertex indices. Connectivity (half-edges, ordered vertex fans) is
derived on demand and thrown away, so operations never patch adjacency in
place: they emit a fresh mesh. That keeps them independently testable and
makes undo a snapshot.

**Extrude.** Vertices whose incident faces are *all* selected sit strictly
inside the region and simply move. Everything on the rim is duplicated, so the
original rim stays behind to receive the side walls. Rim half-edges are
collected from the original winding before any rewrite, which is what keeps the
side quads facing outward.

**Chamfer.** Cut the fan of faces around each affected vertex at every selected
edge.

- With **two or more cuts**, each arc between consecutive cuts collapses to one
  new vertex. Three or more cuts also leaves a hole, which gets an n-gon cap.
- With **exactly one cut** the fan opens into a path instead of splitting into
  arcs, and both ends of that path sit on the same edge. That needs two new
  vertices — one per adjacent face — and every face between them carries
  *both*, which is why a corner maps to a list of indices rather than one.

Corner positions come from intersecting the two offset edge-lines, not from
bisecting the edge directions. That distinction matters: with exactly two cuts
both arcs are bounded by the same pair of edges, so a bisector places them at
the *same point* and the chamfer collapses to zero area. Intersecting each
arc's own offset lines separates them correctly.

## Tests

The mesh operations are tested headlessly, without a browser, because that is
where the real risk lives. Run them with:

```
node tests/mesh.test.js
```

The test extracts the core straight out of `index.html` between the
`<mesh-core>` markers, so there is exactly one copy of the code. It checks Euler
characteristic, closed-manifoldness, outward normals, signed volume and exact
face counts:

| case | result |
| --- | --- |
| box | V8 E12 F6, volume 8 |
| extrude one face | V12 E20 F10, volume 8 → 12 |
| chamfer all 12 edges | V24 E48 F26 — 18 quads + 8 triangles |
| chamfer one edge | 2 pentagons appear, still closed |
| chamfer a 4-edge loop | closed, normals outward |
| oversized chamfer | clamped, stays valid |

Every case holds Euler = 2 with no non-manifold or open edges. The browser layer
is tested separately by driving the real UI.

## Known limits

- **Closed manifold meshes only.** The vertex-fan walk bails on a boundary
  edge, so an open mesh will not chamfer. Nothing here creates one, but a future
  delete-face would.
- **No UVs.** Booleans and chamfers both destroy them; reconstructing them needs
  a planar projection per cut face.
- **Extrude is per-region, not per-face.** A multi-face selection extrudes along
  its averaged normal (3ds Max's "Group" mode), not face-by-face.
- **No edge extrude, no soft selection, no modifiers, no load/save** — next.

## Next

Modifiers as a non-destructive stack over the canonical mesh, an OBJ
import/export (the canonical form is already almost exactly OBJ), edge loop and
ring selection, and inset/bevel as a combined operation.
