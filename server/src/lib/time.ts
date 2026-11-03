export function iso(v: Date | string | number): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

export function isoOrNull(v: Date | string | number | null | undefined): string | null {
  return v === null || v === undefined ? null : iso(v);
}
