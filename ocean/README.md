# Phillips Spectrum Ocean

Jerry Tessendorf's *Simulating Ocean Water* implemented on the GPU, with the
parameters of each stage exposed. Single self-contained `index.html` — WebGL2,
no libraries, no build step.

## What runs each frame

| stage | what it does |
| --- | --- |
| **Spectrum** | `h(k,t) = h₀(k)·e^{iωt} + conj(h₀(−k))·e^{−iωt}` (eq. 43), plus the displacement and slope spectra (eq. 44) |
| **FFT** | `2·log₂N` butterfly passes, horizontal then vertical, off a precomputed twiddle table |
| **Permute** | the `(−1)^(x+y)` recentring, unpacked into a displacement map and a slope map |
| **Render** | a distance-warped grid displaced in the vertex shader |

At N = 256 that is **18 passes a frame**.

Five real fields are needed — height, two displacement components, two slope
components. A complex inverse transform of a Hermitian spectrum yields a *real*
field, so two fields ride in one transform (one in the real part, one in the
imaginary) and three complex transforms carry all five. They are packed
two-per-RGBA-texture and pushed through the same butterfly passes with multiple
render targets.

## Parameters

**Spectrum** (eq. 40–42) — wind speed, wind direction, amplitude *A*,
directional power, against-wind damping, short-wave cutoff *ℓ*, patch size *L*,
grid resolution *N*, seed.
**Dispersion** (eq. 33–35) — depth (0 = deep water), loop period *T*, time scale.
**Displacement** (eq. 44) — choppiness *λ*, foam threshold, foam amount.
**Grid** — viewport mesh extent and falloff.
**Surface** — sun elevation and azimuth, exposure, eye height.

Grid resolution *N* runs 64–2048; mesh detail runs 192–1024 (74k to **2.10M
triangles**); grid extent and falloff shape where those vertices land. The three
are independent, and the section below is about which one is actually limiting
you.

Drag to look around, wheel to change eye height. `window.oceanDebug` exposes the
spectrum functions and a float readback of the FFT result, which is what the
verification below uses.

## Where the detail actually comes from

Three independent ceilings, and it is worth knowing which one is binding —
the readout names it:

| ceiling | set by |
| --- | --- |
| shortest wave in the spectrum | the short-wave cutoff, `exp(−k²ℓ²)`, which rolls off at **2πℓ** |
| shortest wave the FFT grid can hold | Nyquist, **2L/N** |
| shortest wave the viewport mesh can draw | grid falloff and extent vs mesh detail |

**The cutoff dominates everything, and it is easy to set far too high.** rms
surface slope — the statistic the eye reads as texture — measured at L = 200 m,
14 m/s:

| N | ℓ = 1.0 m | ℓ = 0.12 m |
| --- | --- | --- |
| 128 | 0.0838 | 0.1003 |
| 256 | 0.0838 | 0.1085 |
| 512 | 0.0838 | 0.1135 |
| 1024 | 0.0838 | 0.1146 |
| 2048 | 0.0838 | 0.1146 |

At ℓ = 1.0 the number **does not move at all** from N = 128 to N = 2048. That
cutoff rolls off at 2πℓ ≈ 6.3 m, so 98% of the slope energy sits above 5 m and
*nothing* survives below 1.5 m — the spectrum is saturated by N = 128 and every
extra texel is computing zeros. Raising the resolution is a no-op until the
cutoff is lowered. (This was the original default, and it was wrong.) Read back
off the GPU's own slope map the same thing holds: flat 0.088 → 0.082 at ℓ = 1.0,
climbing 0.1033 → 0.1132 at ℓ = 0.12.

A cutoff matched to the grid is roughly **ℓ ≈ L / (πN)**. Below that the
spectrum carries waves the grid cannot represent and they alias; above it, grid
resolution is wasted.

Mesh density is the third ceiling and converges cleanly on its own — freezing
time and changing only the mesh gives a mean per-pixel change of 1.43/255 for
288 → 512 and 0.68 for 512 → 1024, halving per doubling. Because the grid warps
vertices toward the viewer as `|u|^falloff`, both the falloff and the extent are
exposed: at the default 2.4 the near field takes most of the vertices and the
mid field, where most of the visible water is, stays comparatively coarse.

The Jacobian that drives foam is computed **in the permute pass, not per
vertex**. It varies per texel, so at a 1024² grid computing it per vertex meant
five texture fetches for 1.05M vertices — 5M a frame for a quantity with only N²
distinct values.

## Pushing it until it breaks

N = 2048 runs: 24 passes, **448 MB** of float textures, and a ~2.8 s freeze
while h0 is built on the CPU. All three numbers are in the readout, and h0
rebuilds wait for slider release once they cost more than 25 ms. If an
allocation fails the previous resolution is kept and the readout says so, rather
than the page dying.

## Three details that matter## Three details that matter

**The conjugate term must be the mirrored `h₀(−k)`, not a fresh random draw.**
Drawing it independently is a common shortcut, but it breaks the Hermitian
symmetry that makes the inverse transform come out real — the height field then
carries an imaginary residue you have to discard. Done properly the imaginary
part is zero to floating-point noise (measured: 3×10⁻¹⁶ relative), which is
testable.

**The Nyquist row and column are zeroed.** `n = −N/2` has no `+N/2` partner in
the grid, so the *k*-weighted fields — displacement and slope, whose weight is
odd in *k* — cannot be Hermitian there and leak an imaginary part into the
surface. It is the highest band, where Phillips has almost no energy anyway.

**Each mode carries `dk = 2π/L`.** Phillips is a spectral *density*. Without
that factor the surface variance depends on the resolution, and doubling *N*
quarters the wave height. With it, rms height is 0.559 / 0.622 / 0.619 m at
N = 64 / 128 / 256 — flat, as it should be.

## Verification

```
node tests/ocean.test.js
```

22 assertions, run against the core extracted straight out of `index.html`
between the `<ocean-core>` markers so there is one copy of the code: the *k*⁻⁴
falloff, directional and against-wind behaviour, the cutoff, the deep and
finite-depth dispersion relations, quantised ω, realness of all three fields,
spectral slope against finite differences, resolution independence, and exact
looping over the period.

The **GPU pipeline was checked against the CPU reference** by reading the float
FFT result back with `readPixels` and comparing it to a plain JS inverse
transform of the same `h₀`: agreement to a relative rms of **1.1×10⁻⁴**, which
is float32 precision. Physically, wind speed maps to significant wave height
about as oceanography says it should:

| wind | H<sub>s</sub> |
| --- | --- |
| 8 m/s | 0.9 m |
| 12 m/s | 2.5 m |
| 18 m/s | 6.3 m |
| 24 m/s | 8.0 m |

## Known limits

- **One cascade.** Near-field detail is limited by the patch texel size —
  at L = 200 m and N = 256 that is 0.8 m, so water close to the eye is soft.
  Mesh detail cannot fix this; only a smaller *L*, a larger *N*, or several
  FFTs at different patch sizes summed together, which is what production
  systems do and is the obvious next step.
- **The grid warp is a compromise.** At the default extent of 2600 m about a
  third of the vertices land beyond the 1500 m displacement fade, where the
  water is flat — the price of reaching the horizon in one draw. Both extent
  and falloff are exposed so you can spend them differently.
- **Displacement and slope maps are RGBA32F** where the driver can filter them,
  falling back to 16F. Half-float throws away short-wave detail, which is small
  next to the swell it rides on.
- **Foam is a Jacobian threshold, not simulated.** `J < 1` marks where the
  horizontal displacement is compressing the surface. It has no advection,
  persistence or decay, so foam appears and vanishes with the wave rather than
  trailing behind it.
- **No reflections beyond the analytic sky**, no refraction, no shoreline.
- Depth affects dispersion only; there is no shoaling or refraction over a bed.
