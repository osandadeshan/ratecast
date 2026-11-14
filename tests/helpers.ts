import assert from "node:assert/strict";

/** Assert two floats are equal within a tolerance. */
export function near(actual: number, expected: number, tol = 1e-12, msg?: string) {
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `expected ${actual} ≈ ${expected} (±${tol})`);
}
