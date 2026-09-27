/** A value as one POSIX shell word: single-quoted, embedded quotes closed and re-opened. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
