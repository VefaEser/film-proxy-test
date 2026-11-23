
export function normalizePageSize(value, fallback = 10) {
  const n = Number.parseInt(value, 10);

  if (
    !Number.isInteger(n) ||
    n < 10 ||
    n > 100 ||
    n % 10 !== 0
  ) {
    return fallback;
  }

  return n;
}
