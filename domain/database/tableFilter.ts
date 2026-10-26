/**
 * Fuzzy matching for the schema tree. Tables are matched by a case-insensitive
 * substring, or — when the characters are not contiguous — by an in-order
 * subsequence (so "usrord" still finds "user_orders").
 */
export function matchesTableQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = name.toLowerCase();
  if (haystack.includes(needle)) return true;
  let cursor = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

export function filterTables<T extends { name: string }>(tables: readonly T[], query: string): T[] {
  const needle = query.trim();
  if (!needle) return [...tables];
  return tables.filter((table) => matchesTableQuery(table.name, needle));
}
