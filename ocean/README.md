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
**Surface** — sun elevation and azimuth, exposure, eye height.

Drag to look around, wheel to change eye height. `window.oceanDebug` exposes the
spectrum functions and a float readback of the FFT result, which is what the
verification below uses.

## Three details that matter

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
  Production systems run several FFTs at different patch sizes and sum them;
  that is the obvious next step. Lowering *L* trades long waves for near detail.
- **Foam is a Jacobian threshold, not simulated.** `J < 1` marks where the
  horizontal displacement is compressing the surface. It has no advection,
  persistence or decay, so foam appears and vanishes with the wave rather than
  trailing behind it.
- **No reflections beyond the analytic sky**, no refraction, no shoreline.
- Depth affects dispersion only; there is no shoaling or refraction over a bed.
