// Lets node run renderer sources directly: resolves extensionless relative imports to .ts and
// swaps `react` and the notes IPC client for stubs, so notesSession's sequencing is testable.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier === 'react') return { url: new URL('./stubReact.mjs', '${import.meta.url}').href, shortCircuit: true };
  if (specifier === './notesClient') return { url: new URL('./stubNotesClient.mjs', '${import.meta.url}').href, shortCircuit: true };
  if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier) && context.parentURL) {
    const file = fileURLToPath(new URL(specifier + '.ts', context.parentURL));
    if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  return next(specifier, context);
}
`));
