/**
 * Deterministic math: the same bits on every platform.
 *
 * JavaScript's Math.sin, Math.exp and friends are compiled C, and compilers may
 * fuse multiply-adds on one architecture and not another (ARM64 versus x64), so
 * their last bit differs. In a simulation that bit compounds over hundreds of
 * ticks, and evidence recorded on a laptop would not reproduce in CI. These are
 * ports of fdlibm (Sun Microsystems, 1993; the FreeBSD kernels for sin and cos)
 * written with only +, −, ×, ÷ and sqrt, which IEEE 754 fixes bit for bit, and
 * evaluated one operation at a time as JavaScript requires.
 *
 * Every computation that shapes a world or a score uses these, never Math.*.
 */

const buf = new DataView(new ArrayBuffer(8));
const hi = (x: number) => { buf.setFloat64(0, x); return buf.getInt32(0); };
const lo = (x: number) => { buf.setFloat64(0, x); return buf.getUint32(4); };
const fromWords = (h: number, l: number) => { buf.setInt32(0, h); buf.setUint32(4, l); return buf.getFloat64(0); };
const withHigh = (x: number, h: number) => fromWords(h, lo(x));
/** 2^k for -1022 ≤ k ≤ 1023, exactly. */
const pow2 = (k: number) => fromWords((k + 1023) << 20, 0);

// ---------- sin, cos ----------

const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function kSin(x: number, y: number, iy: 0 | 1): number {
  const z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6), v = z * x;
  return iy === 0 ? x + v * (S1 + z * r) : x - ((z * (0.5 * y - v * r) - y) - v * S1);
}
function kCos(x: number, y: number): number {
  const z = x * x, w = z * z, r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z, one = 1.0 - hz;
  return one + (((1.0 - one) - hz) + (z * r - x * y));
}

const invpio2 = 6.36619772367581382433e-01;
const pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11;
const pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21;
const pio2_3 = 2.02226624871116645580e-21, pio2_3t = 8.47842766036889956997e-32;
/** Beyond this the three-part reduction loses accuracy; worlds never get near it. */
const REDUCE_LIMIT = 1.0e6;

/** x = n·π/2 + (y0 + y1), with |y0 + y1| ≤ π/4: fdlibm's medium-size reduction, always to full precision. */
function reduce(x: number): [number, number, number] {
  if (!(Math.abs(x) < REDUCE_LIMIT)) throw new RangeError(`dmath: angle ${x} is outside the deterministic range`);
  const t = Math.abs(x);
  if (t <= 7.85398163397448278999e-01) return [0, x, 0];
  const n = Math.trunc(t * invpio2 + 0.5), fn = n;
  let r = t - fn * pio2_1, w = fn * pio2_1t;
  let u = r; w = fn * pio2_2; r = u - w; w = fn * pio2_2t - ((u - r) - w);
  u = r; w = fn * pio2_3; r = u - w; w = fn * pio2_3t - ((u - r) - w);
  const y0 = r - w, y1 = (r - y0) - w;
  return x < 0 ? [-n, -y0, -y1] : [n, y0, y1];
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const [n, y0, y1] = reduce(x);
  switch (n & 3) { case 0: return kSin(y0, y1, 1); case 1: return kCos(y0, y1); case 2: return -kSin(y0, y1, 1); default: return -kCos(y0, y1); }
}
export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const [n, y0, y1] = reduce(x);
  switch (n & 3) { case 0: return kCos(y0, y1); case 1: return -kSin(y0, y1, 1); case 2: return -kCos(y0, y1); default: return kSin(y0, y1, 1); }
}

// ---------- atan, atan2 ----------

const atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
const atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const aT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
  9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
  4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];

export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const neg = x < 0;
  let ax = Math.abs(x), id = -1;
  if (ax >= 7.378697629483821e19) return neg ? -(atanhi[3] + atanlo[3]) : atanhi[3] + atanlo[3]; // 2^66
  if (ax < 0.4375) { if (ax < 1.862645149230957e-9) return x; }
  else if (ax < 1.1875) { if (ax < 0.6875) { id = 0; ax = (2.0 * ax - 1.0) / (2.0 + ax); } else { id = 1; ax = (ax - 1.0) / (ax + 1.0); } }
  else if (ax < 2.4375) { id = 2; ax = (ax - 1.5) / (1.0 + 1.5 * ax); }
  else { id = 3; ax = -1.0 / ax; }
  const z = ax * ax, w = z * z;
  const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
  const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = atanhi[id] - ((ax * (s1 + s2) - atanlo[id]) - ax);
  return neg ? -r : r;
}

const PI = 3.1415926535897931160e+00, PI_LO = 1.2246467991473531772e-16, PI_2 = 1.5707963267948965580e+00;

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Math.atan2(y, x); // exact constants; worlds never reach them
  if (x === 1) return atan(y);
  const m = (y < 0 || Object.is(y, -0) ? 1 : 0) | (x < 0 || Object.is(x, -0) ? 2 : 0);
  if (y === 0) return m === 0 || m === 1 ? y : m === 2 ? PI : -PI;
  if (x === 0) return y < 0 ? -PI_2 : PI_2;
  const ratio = Math.abs(y / x);
  let z: number;
  if (ratio > 1.152921504606847e18) z = PI_2 + 0.5 * PI_LO; // |y/x| > 2^60
  else if (x < 0 && ratio < 8.673617379884035e-19) z = 0.0; // |y/x| < 2^-60
  else z = atan(ratio);
  switch (m) { case 0: return z; case 1: return -z; case 2: return PI - (z - PI_LO); default: return (z - PI_LO) - PI; }
}

// ---------- exp, log, tanh ----------

const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
  P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;

export function exp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 7.09782712893383973096e+02) return Infinity;
  if (x < -7.45133219101941108420e+02) return 0;
  let hiPart = 0, loPart = 0, k = 0;
  const ax = Math.abs(x), neg = x < 0;
  if (ax > 0.5 * LN2_HI * 1.0000000000000002) { // |x| > 0.5 ln 2
    if (ax < 1.5 * LN2_HI) { hiPart = x - (neg ? -LN2_HI : LN2_HI); loPart = neg ? -LN2_LO : LN2_LO; k = neg ? -1 : 1; }
    else { k = Math.trunc(INVLN2 * x + (neg ? -0.5 : 0.5)); hiPart = x - k * LN2_HI; loPart = k * LN2_LO; }
    x = hiPart - loPart;
  } else if (ax < 3.725290298461914e-9) return 1.0 + x; // |x| < 2^-28
  const t = x * x, c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
  const y = 1.0 - ((loPart - (x * c) / (2.0 - c)) - hiPart);
  return k >= -1021 ? y * pow2(k) : y * pow2(k + 1000) * pow2(-1000);
}

const Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01,
  Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01, Lg7 = 1.479819860511658591e-01;

export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  let hx = hi(x), k = 0;
  if (hx < 0x00100000) { k -= 54; x *= 1.80143985094819840000e+16; hx = hi(x); } // subnormal
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i0 = (hx + 0x95f64) & 0x100000;
  x = withHigh(x, hx | (i0 ^ 0x3ff00000)); // normalize x or x/2
  k += i0 >> 20;
  const f = x - 1.0, dk = k;
  if ((0x000fffff & (2 + hx)) < 3) { // |f| < 2^-20
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    return k === 0 ? f - R : dk * LN2_HI - ((R - dk * LN2_LO) - f);
  }
  const s = f / (2.0 + f), z = s * s, w = z * z;
  const t1 = w * (Lg2 + w * (Lg4 + w * Lg6)), t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7))), R = t2 + t1;
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + R)) : dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - R) : dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

/** tanh from exp: deterministic, accurate to ~1e-15 away from 0 and ~1e-11 relative very near 0. */
export function tanh(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  if (ax < 3.725290298461914e-9) return x;
  if (ax >= 22) return x < 0 ? -1 : 1;
  const t = exp(2 * ax), r = 1 - 2 / (t + 1);
  return x < 0 ? -r : r;
}

/** sqrt is correctly rounded everywhere; scaling is unnecessary at the magnitudes worlds use. */
export const hypot = (a: number, b: number): number => Math.sqrt(a * a + b * b);
