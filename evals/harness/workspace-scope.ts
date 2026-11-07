/** Only framework-owned revision metadata is exempt from fixture write scope. */
export function unexpectedWorkspacePaths(actual: readonly string[], allowed: readonly string[]): string[] {
  const expected = new Set([...allowed, '.fw-revisions.json']);
  return actual.filter(path => !expected.has(path)).sort();
}
