/**
 * World Magnetic Model 2025 (WMM2025) — offline magnetic declination calculator.
 * Valid: 2025.0 – 2030.0.
 * Source: Alken et al. (2024), NOAA NCEI / BGS.  Public domain.
 *
 * Algorithm: spherical harmonic expansion using Schmidt quasi-normal
 * Legendre functions, degrees 1–12 (n ≤ MAX_N).
 */

export const WMM_MODEL_YEAR = "WMM2025";
export const WMM_VALID_FROM = 2025.0;
export const WMM_VALID_TO   = 2030.0;

const RE    = 6371200;   // WMM reference spherical radius (m)
const MAX_N = 12;

/** [n, m, gnm (nT), hnm (nT), ġnm (nT/yr), ḣnm (nT/yr)] */
type COFRow = [number, number, number, number, number, number];

// WMM2025 main-field + secular-variation coefficients, epoch 2025.0
// Source: NOAA NCEI WMM2025.COF (public domain)
const COF: COFRow[] = [
  // n  m        g           h       ġ       ḣ
  [1 , 0 ,  -29351.8,       0.0,    12.0,    0.0],
  [1 , 1 ,   -1410.8,    4545.4,     9.7,  -21.5],
  [2 , 0 ,   -2556.6,       0.0,   -11.6,    0.0],
  [2 , 1 ,    2951.1,   -3133.6,    -5.2,  -27.7],
  [2 , 2 ,    1649.3,    -815.1,    -8.0,  -12.1],
  [3 , 0 ,    1361.0,       0.0,    -1.3,    0.0],
  [3 , 1 ,   -2404.1,     -56.6,    -4.2,    4.0],
  [3 , 2 ,    1243.8,     237.5,     0.4,   -0.3],
  [3 , 3 ,     453.6,    -549.5,   -15.6,   -4.1],
  [4 , 0 ,     895.0,       0.0,    -1.6,    0.0],
  [4 , 1 ,     799.5,     278.6,    -2.4,   -1.1],
  [4 , 2 ,      55.7,    -133.9,    -6.0,    4.1],
  [4 , 3 ,    -281.1,     212.0,     5.6,    1.6],
  [4 , 4 ,      12.1,    -375.6,    -7.0,   -4.4],
  [5 , 0 ,    -233.2,       0.0,     0.6,    0.0],
  [5 , 1 ,     368.9,      45.4,     1.4,   -0.5],
  [5 , 2 ,     187.2,     220.2,     0.0,    2.2],
  [5 , 3 ,    -138.7,    -122.9,     0.6,    0.4],
  [5 , 4 ,    -142.0,      43.0,     2.2,    1.7],
  [5 , 5 ,      20.9,     106.1,     0.9,    1.9],
  [6 , 0 ,      64.4,       0.0,    -0.2,    0.0],
  [6 , 1 ,      63.8,     -18.4,    -0.4,    0.3],
  [6 , 2 ,      76.9,      16.8,     0.9,   -1.6],
  [6 , 3 ,    -115.7,      48.8,     1.2,   -0.4],
  [6 , 4 ,     -40.9,     -59.8,    -0.9,    0.9],
  [6 , 5 ,      14.9,      10.9,     0.3,    0.7],
  [6 , 6 ,     -60.7,      72.7,     0.9,    0.9],
  [7 , 0 ,      79.5,       0.0,    -0.0,    0.0],
  [7 , 1 ,     -77.0,     -48.9,    -0.1,    0.6],
  [7 , 2 ,      -8.8,     -14.4,    -0.1,    0.5],
  [7 , 3 ,      59.3,      -1.0,     0.5,   -0.8],
  [7 , 4 ,      15.8,      23.4,    -0.1,    0.0],
  [7 , 5 ,       2.5,      -7.4,    -0.8,   -1.0],
  [7 , 6 ,     -11.1,     -25.1,    -0.8,    0.6],
  [7 , 7 ,      14.2,      -2.3,     0.8,   -0.2],
  [8 , 0 ,      23.2,       0.0,    -0.1,    0.0],
  [8 , 1 ,      10.8,       7.1,     0.2,   -0.2],
  [8 , 2 ,     -17.5,     -12.6,     0.0,    0.5],
  [8 , 3 ,       2.0,      11.4,     0.5,   -0.4],
  [8 , 4 ,     -21.7,      -9.7,    -0.1,    0.4],
  [8 , 5 ,      16.9,      12.7,     0.3,   -0.5],
  [8 , 6 ,      15.0,       0.7,     0.2,   -0.6],
  [8 , 7 ,     -16.8,      -5.2,    -0.0,    0.3],
  [8 , 8 ,       0.9,       3.9,     0.2,    0.2],
  [9 , 0 ,       4.6,       0.0,    -0.0,    0.0],
  [9 , 1 ,       7.8,     -24.8,    -0.1,   -0.3],
  [9 , 2 ,       3.0,      12.2,     0.1,    0.3],
  [9 , 3 ,      -0.2,       8.3,     0.3,   -0.3],
  [9 , 4 ,      -2.5,      -3.3,    -0.3,    0.3],
  [9 , 5 ,     -13.1,      -5.2,     0.0,    0.2],
  [9 , 6 ,       2.4,       7.2,     0.3,   -0.1],
  [9 , 7 ,       8.6,      -0.6,    -0.1,   -0.2],
  [9 , 8 ,      -8.7,       0.8,     0.1,    0.4],
  [9 , 9 ,     -12.9,      10.0,    -0.1,    0.1],
  [10, 0 ,      -1.3,       0.0,     0.1,    0.0],
  [10, 1 ,      -6.4,       3.3,     0.0,    0.0],
  [10, 2 ,       0.2,       0.0,     0.1,   -0.0],
  [10, 3 ,       2.0,       2.4,     0.1,   -0.2],
  [10, 4 ,      -1.0,       5.3,    -0.0,    0.1],
  [10, 5 ,      -0.6,      -9.1,    -0.3,   -0.1],
  [10, 6 ,      -0.9,       0.4,     0.0,    0.1],
  [10, 7 ,       1.5,      -4.2,    -0.1,    0.0],
  [10, 8 ,       0.9,      -3.8,    -0.1,   -0.1],
  [10, 9 ,      -2.7,       0.9,    -0.0,    0.2],
  [10, 10,      -3.9,      -9.1,    -0.0,   -0.0],
  [11, 0 ,       2.9,       0.0,     0.0,    0.0],
  [11, 1 ,      -1.5,       0.0,    -0.0,   -0.0],
  [11, 2 ,      -2.5,       2.9,     0.0,    0.1],
  [11, 3 ,       2.4,      -0.6,     0.0,   -0.0],
  [11, 4 ,      -0.6,       0.2,     0.0,    0.1],
  [11, 5 ,      -0.1,       0.5,    -0.1,   -0.0],
  [11, 6 ,      -0.6,      -0.3,     0.0,   -0.0],
  [11, 7 ,      -0.1,      -1.2,    -0.0,    0.1],
  [11, 8 ,       1.1,      -1.7,    -0.1,   -0.0],
  [11, 9 ,      -1.0,      -2.9,    -0.1,    0.0],
  [11, 10,      -0.2,      -1.8,    -0.1,    0.0],
  [11, 11,       2.6,      -2.3,    -0.1,    0.0],
  [12, 0 ,      -2.0,       0.0,     0.0,    0.0],
  [12, 1 ,      -0.2,      -1.3,     0.0,   -0.0],
  [12, 2 ,       0.3,       0.7,    -0.0,    0.0],
  [12, 3 ,       1.2,       1.0,    -0.0,   -0.1],
  [12, 4 ,      -1.3,      -1.4,    -0.0,    0.1],
  [12, 5 ,       0.6,      -0.0,    -0.0,   -0.0],
  [12, 6 ,       0.6,       0.6,     0.1,   -0.0],
  [12, 7 ,       0.5,      -0.1,    -0.0,   -0.0],
  [12, 8 ,      -0.1,       0.8,     0.0,    0.0],
  [12, 9 ,      -0.4,       0.1,     0.0,   -0.0],
  [12, 10,      -0.2,      -1.0,    -0.1,   -0.0],
  [12, 11,      -1.3,       0.1,    -0.0,    0.0],
  [12, 12,      -0.7,       0.2,    -0.1,   -0.1],
];

/**
 * Returns magnetic declination in degrees (positive = East of true north).
 * @param latDeg  Geodetic latitude, degrees
 * @param lonDeg  Geodetic longitude, degrees (negative = West)
 * @param altKm   Altitude above WGS84 ellipsoid, km (use 0 for sea level / map use)
 * @param decimalYear  e.g. 2026.5
 */
export function getMagneticDeclination(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
  decimalYear = currentDecimalYear(),
): number {
  const dt = decimalYear - WMM_VALID_FROM;
  const latR = (latDeg * Math.PI) / 180;
  const lonR = (lonDeg * Math.PI) / 180;

  // WGS84 → geocentric spherical
  const a = 6378137.0;
  const b = 6356752.31425;
  const cosLat = Math.cos(latR);
  const sinLat = Math.sin(latR);
  const N = (a * a) / Math.sqrt((a * cosLat) ** 2 + (b * sinLat) ** 2);
  const rCos = (N + altKm * 1000) * cosLat;
  const rZ   = (N * (b / a) ** 2 + altKm * 1000) * sinLat;
  const r    = Math.sqrt(rCos ** 2 + rZ ** 2);

  // Geocentric colatitude
  const theta = Math.PI / 2 - Math.atan2(rZ, rCos);
  const cosT  = Math.cos(theta);
  const sinT  = Math.sin(theta);

  // Time-varying Gauss coefficients, pre-multiplied by the Schmidt
  // semi-normalisation factors so they pair with the Gauss-normalised
  // Legendre functions below (same split as NOAA's reference geomag.c).
  const S = schmidtFactors();
  const g = buildTable();
  const h = buildTable();
  for (const [n, m, gv, hv, gd, hd] of COF) {
    g[n][m] = (gv + gd * dt) * S[n][m];
    h[n][m] = (hv + hd * dt) * S[n][m];
  }

  // Gauss-normalised associated Legendre functions + theta-derivatives.
  // (The previous version mixed fully-normalised recursion constants into a
  // Schmidt seed, which skewed every term above degree 1 — e.g. Denver came
  // out ~9.2°E instead of NOAA's ~7.5°E.)
  const P  = buildTable();
  const dP = buildTable();
  P[0][0] = 1;
  for (let n = 1; n <= MAX_N; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        P[n][m]  = sinT * P[n - 1][m - 1];
        dP[n][m] = sinT * dP[n - 1][m - 1] + cosT * P[n - 1][m - 1];
      } else if (n === 1) {
        P[n][m]  = cosT * P[0][0];
        dP[n][m] = cosT * dP[0][0] - sinT * P[0][0];
      } else {
        const k   = ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3));
        const p2  = m > n - 2 ? 0 : P[n - 2][m];
        const dp2 = m > n - 2 ? 0 : dP[n - 2][m];
        P[n][m]  = cosT * P[n - 1][m] - k * p2;
        dP[n][m] = cosT * dP[n - 1][m] - sinT * P[n - 1][m] - k * dp2;
      }
    }
  }

  // Sum the spherical harmonic series (geocentric r, theta, phi components)
  let Btheta = 0;
  let Bphi   = 0;
  let Br     = 0;
  const sinTSafe = Math.max(sinT, 1e-10);
  for (let n = 1; n <= MAX_N; n++) {
    const ratio = (RE / r) ** (n + 2);
    for (let m = 0; m <= n; m++) {
      const cosML = Math.cos(m * lonR);
      const sinML = Math.sin(m * lonR);
      const ghmC  = g[n][m] * cosML + h[n][m] * sinML;
      const ghmS  = g[n][m] * sinML - h[n][m] * cosML;
      Br     += ratio * (n + 1) * ghmC * P[n][m];
      Btheta -= ratio * ghmC * dP[n][m];
      Bphi   += ratio * m * ghmS * P[n][m] / sinTSafe;
    }
  }

  // Rotate geocentric → geodetic (X = north, Y = east). psi is the
  // geodetic − geocentric latitude offset; tiny in CONUS, but it matters at
  // high latitudes where the vertical component dominates.
  const psi = latR - (Math.PI / 2 - theta);
  const X   = -Btheta * Math.cos(psi) - Br * Math.sin(psi);
  const Y   =  Bphi;

  return (Math.atan2(Y, X) * 180) / Math.PI;
}

/** Returns the current date as a decimal year (e.g., 2026.37). */
export function currentDecimalYear(): number {
  const now   = new Date();
  const start = new Date(now.getFullYear(), 0, 1).getTime();
  const end   = new Date(now.getFullYear() + 1, 0, 1).getTime();
  return now.getFullYear() + (now.getTime() - start) / (end - start);
}

/** True when `decimalYear` falls inside the model's published validity window. */
export function isWmmValid(decimalYear = currentDecimalYear()): boolean {
  return decimalYear >= WMM_VALID_FROM && decimalYear < WMM_VALID_TO;
}

/** Map-label form of the epoch the declination is computed for, e.g. "2026.8". */
export function declinationEpochLabel(decimalYear = currentDecimalYear()): string {
  return decimalYear.toFixed(1);
}

// Schmidt semi-normalisation factors S[n][m] (geomag.c recurrence).
let schmidtCache: number[][] | null = null;
function schmidtFactors(): number[][] {
  if (schmidtCache) return schmidtCache;
  const S = buildTable();
  S[0][0] = 1;
  for (let n = 1; n <= MAX_N; n++) {
    S[n][0] = S[n - 1][0] * (2 * n - 1) / n;
    for (let m = 1; m <= n; m++) {
      S[n][m] = S[n][m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
    }
  }
  schmidtCache = S;
  return S;
}

function buildTable(): number[][] {
  return Array.from({ length: MAX_N + 1 }, () => new Array(MAX_N + 1).fill(0));
}
