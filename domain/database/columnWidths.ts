/**
 * Column width overrides for the result grid, keyed by scope and column name so
 * a hand-resized column keeps its width the next time the same result opens.
 */

export type ColumnWidthMap = Record<string, number>;

export const MIN_COLUMN_PX = 60;
export const MAX_COLUMN_PX = 1200;

export function clampColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return MIN_COLUMN_PX;
  return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, Math.round(value)));
}

export function widthScopeKey(connectionId: string, table: string | undefined, columns: readonly string[]): string {
  const trimmed = table?.trim();
  const target = trimmed && trimmed.length > 0 ? trimmed.toLowerCase() : columns.join('|').toLowerCase();
  return `${connectionId}::${target}`;
}

export function sanitizeColumnWidths(input: unknown): ColumnWidthMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: ColumnWidthMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    result[key] = clampColumnWidth(value);
  }
  return result;
}

export function scopeWidths(map: ColumnWidthMap, scope: string): Record<string, number> {
  const prefix = `${scope}::`;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith(prefix)) continue;
    result[key.slice(prefix.length)] = value;
  }
  return result;
}

export function applyWidths(
  autoWidths: readonly number[],
  columns: readonly { name: string }[],
  overrides: Record<string, number>,
): number[] {
  return autoWidths.map((width, index) => {
    const name = columns[index]?.name;
    if (!name) return width;
    const override = overrides[name.toLowerCase()];
    return override ? clampColumnWidth(override) : width;
  });
}
