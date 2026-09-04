/* Tests for the Tessendorf ocean core.

   The spectrum, h0 construction and butterfly table are extracted straight out
   of index.html between the <ocean-core> markers, so there is exactly one copy
   of that code. The inverse FFT below is a plain CPU reference used only to
   check what the GPU pipeline should be producing.

   Run: node tests/ocean.test.js                                            */
const fs = require('fs'), path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.split('/* <ocean-core>')[1].split('/* </ocean-core> */')[0]
                .replace(/^[^\n]*\n/, '');
const C = new Function(src + '; return { G, phillips, rng, gauss, buildH0, butterflyTexture };')();

/* ---- CPU reference: dispersion, time evolution, inverse FFT ------------- */
function omega(k, p) {
  let w = (p.depth > 0) ? Math.sqrt(C.G*k*Math.tanh(k*p.depth)) : Math.sqrt(C.G*k);
  if (p.period > 0) { const w0 = 2*Math.PI/p.period; w = Math.floor(w/w0)*w0; }
  return w;
}
function spectraAt(h0, p, t) {
  const N = p.N, mk = () => new Float64Array(N*N*2);
  const H = mk(), DX = mk(), DZ = mk(), SX = mk(), SZ = mk();
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const kx = 2*Math.PI*(i - N/2)/p.patch, kz = 2*Math.PI*(j - N/2)/p.patch;
    const k = Math.hypot(kx, kz), w = omega(k, p)*t;
    const c = Math.cos(w), s = Math.sin(w), o = (j*N+i)*4, q = (j*N+i)*2;
    const hr = h0[o]*c - h0[o+1]*s + h0[o+2]*c + h0[o+3]*s;
    const hi = h0[o]*s + h0[o+1]*c - h0[o+2]*s + h0[o+3]*c;
    H[q] = hr; H[q+1] = hi;
    const kxn = k > 1e-9 ? kx/k : 0, kzn = k > 1e-9 ? kz/k : 0;
    DX[q] = -hi*kxn; DX[q+1] =  hr*kxn;     // +i k_hat h
    DZ[q] = -hi*kzn; DZ[q+1] =  hr*kzn;
    SX[q] = -hi*kx;  SX[q+1] =  hr*kx;
    SZ[q] = -hi*kz;  SZ[q+1] =  hr*kz;
  }
  return { H, DX, DZ, SX, SZ };
}
function fft1d(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2)*Math.PI/len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len/2; k++) {
        const ar = re[i+k], ai = im[i+k];
        const br = re[i+k+len/2]*cr - im[i+k+len/2]*ci;
        const bi = re[i+k+len/2]*ci + im[i+k+len/2]*cr;
        re[i+k] = ar+br; im[i+k] = ai+bi;
        re[i+k+len/2] = ar-br; im[i+k+len/2] = ai-bi;
        const t = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = t;
      }
    }
  }
}
function ifft2d(field, N) {
  const R = new Float64Array(N*N), I = new Float64Array(N*N);
  const re = new Float64Array(N), im = new Float64Array(N);
  let i, j;
  for (i = 0; i < N*N; i++) { R[i] = field[i*2]; I[i] = field[i*2+1]; }
  for (j = 0; j < N; j++) {
    for (i = 0; i < N; i++) { re[i] = R[j*N+i]; im[i] = I[j*N+i]; }
    fft1d(re, im, true);
    for (i = 0; i < N; i++) { R[j*N+i] = re[i]; I[j*N+i] = im[i]; }
  }
  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) { re[j] = R[j*N+i]; im[j] = I[j*N+i]; }
    fft1d(re, im, true);
    for (j = 0; j < N; j++) { R[j*N+i] = re[j]; I[j*N+i] = im[j]; }
  }
  const out = new Float64Array(N*N*2);
  for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
    const s = ((i+j)&1) ? -1 : 1;
    out[(j*N+i)*2] = R[j*N+i]*s; out[(j*N+i)*2+1] = I[j*N+i]*s;
  }
  return out;
}

/* ------------------------------------------------------------------ tests */
let pass = 0, fail = 0;
const ck = (n, ok, d='') => { ok?pass++:fail++; console.log(`  [${ok?'ok ':'FAIL'}] ${n}${d?'  '+d:''}`); };
const base = { N:64, patch:250, windSpeed:12, windDir:0.6, amplitude:8.6e-4,
               dirPower:2, against:0.07, cutoff:1, depth:0, period:200, seed:1337 };
const P = o => Object.assign({}, base, o);
const imRatio = f => { let re=0, im=0;
  for (let i = 0; i < f.length/2; i++) { re = Math.max(re, Math.abs(f[i*2])); im = Math.max(im, Math.abs(f[i*2+1])); }
  return im/re; };

console.log('Phillips spectrum (eq. 40)');
{
  const p = P(), L = p.windSpeed*p.windSpeed/C.G;
  const wx = Math.cos(p.windDir), wz = Math.sin(p.windDir);
  const at = k => C.phillips(k*wx, k*wz, P({cutoff:0}));
  ck('falls off as k^-4 past the peak', Math.abs(at(4/L)/at(8/L) - 16)/16 < 0.05,
     `ratio ${(at(4/L)/at(8/L)).toFixed(2)} (expect 16)`);
  ck('zero at k = 0', C.phillips(0, 0, p) === 0);
  ck('vanishes perpendicular to the wind', C.phillips(-wz*4/L, wx*4/L, p) < at(4/L)*1e-6);
  ck('stronger wind carries more energy',
     C.phillips(0.05*wx, 0.05*wz, P({windSpeed:20})) > C.phillips(0.05*wx, 0.05*wz, P({windSpeed:8})));
  ck('short-wave cutoff suppresses ripples',
     C.phillips(3*wx, 3*wz, P({cutoff:2})) < C.phillips(3*wx, 3*wz, P({cutoff:0}))*0.01);
  ck('waves against the wind are damped',
     Math.abs(C.phillips(-4/L*wx, -4/L*wz, P({cutoff:0}))/at(4/L) - 0.07) < 1e-6);
}

console.log('dispersion (eq. 33 - 35)');
{
  ck('deep water is sqrt(gk)', Math.abs(omega(0.4, P({period:0})) - Math.sqrt(C.G*0.4)) < 1e-12);
  ck('finite depth slows long waves', omega(0.02, P({period:0, depth:10})) < omega(0.02, P({period:0}))*0.999);
  ck('finite depth matches deep water for short waves',
     Math.abs(omega(5, P({period:0, depth:60})) - omega(5, P({period:0}))) < 1e-6);
  const T = 120, w = omega(0.37, P({period:T}));
  ck('quantised omega is a multiple of 2pi/T',
     Math.abs(w/(2*Math.PI/T) - Math.round(w/(2*Math.PI/T))) < 1e-9);
}

console.log('surface (eq. 42 - 44)');
{
  const p = P(), h0 = C.buildH0(p), sp = spectraAt(h0, p, 3.7);
  const h = ifft2d(sp.H, p.N);
  // the whole reason the conjugate term is read from the mirrored texel
  ck('height field is real', imRatio(h) < 1e-5, `|im|/|re| = ${imRatio(h).toExponential(1)}`);
  ck('displacement field is real', imRatio(ifft2d(sp.DX, p.N)) < 1e-5);
  ck('slope field is real', imRatio(ifft2d(sp.SZ, p.N)) < 1e-5);
  let mx = 0;
  for (let i = 0; i < p.N*p.N; i++) mx = Math.max(mx, Math.abs(h[i*2]));
  ck('height field is non-trivial', mx > 0.3, `max |h| = ${mx.toFixed(2)} m`);

  // band-limit first: central differences lose sin(k dx)/(k dx) near Nyquist
  const bp = P({cutoff:12}), bh0 = C.buildH0(bp), bs = spectraAt(bh0, bp, 3.7);
  const bh = ifft2d(bs.H, bp.N), bsx = ifft2d(bs.SX, bp.N);
  const N = bp.N, dxs = bp.patch/N;
  let num = 0, den = 0;
  for (let j = 2; j < N-2; j++) for (let i = 2; i < N-2; i++) {
    const fd = (bh[(j*N+i+1)*2] - bh[(j*N+i-1)*2])/(2*dxs), ex = bsx[(j*N+i)*2];
    num += (fd-ex)*(fd-ex); den += ex*ex;
  }
  ck('spectral slope matches finite differences', Math.sqrt(num/den) < 0.05,
     `relative rms ${Math.sqrt(num/den).toFixed(3)}`);
}

console.log('choppy displacement (eq. 44)');
{
  // The sign of the displacement decides whether choppiness sharpens the
  // crests or the troughs, and getting it backwards looks plausible enough at
  // a glance to survive review - it shipped once. Pin it with a statistic:
  // mass must converge where the surface is high, so the divergence of D has
  // to be negatively correlated with height. Foam follows the same sign,
  // which is why it belongs on crests rather than in troughs.
  const p = P({ N:128, cutoff:0.3 });
  const h0 = C.buildH0(p), sp = spectraAt(h0, p, 3.0);
  const N = p.N, ds = p.patch/N;
  const h = ifft2d(sp.H, N), dx = ifft2d(sp.DX, N), dz = ifft2d(sp.DZ, N);
  const at = (f,i,j) => f[((((j%N)+N)%N)*N + (((i%N)+N)%N))*2];
  let sh=0, sd=0, shh=0, sdd=0, shd=0, sj=0, sjj=0, shj=0, n=0;
  const lam = 1.0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const axx=(at(dx,i+1,j)-at(dx,i-1,j))/(2*ds), azz=(at(dz,i,j+1)-at(dz,i,j-1))/(2*ds);
    const axz=(at(dx,i,j+1)-at(dx,i,j-1))/(2*ds), azx=(at(dz,i+1,j)-at(dz,i-1,j))/(2*ds);
    const div = axx + azz;
    const J = (1+lam*axx)*(1+lam*azz) - lam*lam*axz*azx;
    const H = at(h,i,j);
    sh+=H; sd+=div; shh+=H*H; sdd+=div*div; shd+=H*div;
    sj+=J; sjj+=J*J; shj+=H*J; n++;
  }
  const corr = (sa,sb,saa,sbb,sab) => { const a=sa/n, b=sb/n;
    return (sab/n - a*b)/Math.sqrt((saa/n - a*a)*(sbb/n - b*b)); };
  const cd = corr(sh,sd,shh,sdd,shd), cj = corr(sh,sj,shh,sjj,shj);
  ck('displacement pulls mass toward the crests', cd < -0.3, `corr(h, div D) = ${cd.toFixed(3)}`);
  ck('the surface compresses at crests, so foam lands there', cj < -0.3,
     `corr(h, Jacobian) = ${cj.toFixed(3)}`);
}

console.log('scaling and looping');
{
  const rms = o => { const p = P(o), h = ifft2d(spectraAt(C.buildH0(p), p, 0).H, p.N);
    let s = 0; for (let i = 0; i < p.N*p.N; i++) s += h[i*2]*h[i*2];
    return Math.sqrt(s/(p.N*p.N)); };
  ck('rms height grows with wind speed', rms({windSpeed:16}) > rms({windSpeed:8})*2);
  const a = rms({N:64}), b = rms({N:128}), c = rms({N:256});
  // the dk = 2pi/L factor in h0 is what makes this hold
  ck('wave height is resolution independent', Math.abs(c-b)/b < 0.08 && Math.abs(b-a)/b < 0.15,
     `${a.toFixed(3)} / ${b.toFixed(3)} / ${c.toFixed(3)} m at N = 64/128/256`);
  // A = 8.6e-4 is the calibration point, not the app's current default: it is
  // what pins the spectrum normalisation to a physically sensible sea.
  ck('the calibrated amplitude gives a plausible sea', b > 0.4 && b < 0.9,
     `A = 8.6e-4 -> rms ${b.toFixed(2)} m, Hs ${(4*b).toFixed(1)} m at 12 m/s`);

  const T = 100, p = P({N:32, period:T}), h0 = C.buildH0(p);
  const A = ifft2d(spectraAt(h0, p, 11).H, 32), B = ifft2d(spectraAt(h0, p, 11+T).H, 32);
  let d = 0, m = 0;
  for (let i = 0; i < 32*32; i++) { d = Math.max(d, Math.abs(A[i*2]-B[i*2])); m = Math.max(m, Math.abs(A[i*2])); }
  ck('animation loops exactly over the period', d/m < 1e-4, `drift ${(d/m).toExponential(1)}`);
}

console.log('butterfly table');
{
  const N = 64, bt = C.butterflyTexture(N);
  ck('one row per stage', bt.stages === 6 && bt.data.length === 6*N*4);
  let ok = true;
  for (let s = 0; s < bt.stages; s++) for (let x = 0; x < N; x++) {
    const o = (s*N+x)*4;
    if (Math.abs(Math.hypot(bt.data[o], bt.data[o+1]) - 1) > 1e-6) ok = false;   // unit twiddle
    if (bt.data[o+2] < 0 || bt.data[o+2] >= N || bt.data[o+3] < 0 || bt.data[o+3] >= N) ok = false;
  }
  ck('twiddles are unit length and indices in range', ok);
  const seen = new Set();
  for (let x = 0; x < N; x++) seen.add(bt.data[x*4+2]).add(bt.data[x*4+3]);
  ck('stage 0 touches every element (bit reversal is a permutation)', seen.size === N);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
