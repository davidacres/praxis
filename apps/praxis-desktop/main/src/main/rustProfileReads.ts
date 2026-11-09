/** Keep JSON parser diagnostics consistent with the desktop's V8 parser. */
export function decodeRustProfile<T extends { issues: Array<{ path: string; message: string }> }>(
  result: T | { invalidJson: string }, kind: 'run' | 'deployment'
): T {
  if ('invalidJson' in result) {
    try { JSON.parse(result.invalidJson); }
    catch (error) {
      return { issues: [{ path: '', message: `Could not read ${kind} profile: ${(error as Error).message}` }] } as T;
    }
    throw new Error('Rust returned an invalid profile parse result.');
  }
  return result;
}
