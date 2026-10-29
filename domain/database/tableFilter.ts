/**
 * Case-insensitive substring match for the schema tree.
 *
 * The previous implementation fell back to an in-order subsequence match, which
 * made "sms" hit unrelated names such as `OCSAPP_MVNE.CF_DYNAMIC_MSISDN` and
 * made the filter feel broken. Users expect "filter by this substring".
 */
export function matchesTableQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().includes(needle);
}

export function filterTables<T extends { name: string }>(tables: readonly T[], query: string): T[] {
  const needle = query.trim();
  if (!needle) return [...tables];
  return tables.filter((table) => matchesTableQuery(table.name, needle));
}
