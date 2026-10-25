# WebGL Lab

Small WebGL experiments. Each folder is one self-contained demo: a single
`index.html` with no libraries and no build step.

| Folder | Demo |
| --- | --- |
| [`ball-in-box/`](ball-in-box/) | Ball in a Glass Box: drag an acrylic box and a brass ball reacts to it (built for the iPhone) |
| [`boolean-comparison/`](boolean-comparison/) | Two Ways to Cut a Solid: the same boolean as mesh CSG and as an SDF, side by side |
| [`modeler/`](modeler/) | Poly Bench: a small editable-poly modeller (select, move, extrude, chamfer) |
| [`ocean/`](ocean/) | Phillips Spectrum Ocean: Tessendorf's *Simulating Ocean Water* on the GPU |

## Running a demo

Open the `index.html` directly, or serve the repo and open it on a phone in the
same Wi-Fi:

```
python3 -m http.server 8000
```

then browse to `http://<your-computer-ip>:8000/<folder>/`.

With GitHub Pages enabled for this repo, each demo is at `/<folder>/` on the
Pages site.

## Tests

`modeler` and `ocean` have tests for their core code:

```
node modeler/tests/mesh.test.js
node ocean/tests/ocean.test.js
```
