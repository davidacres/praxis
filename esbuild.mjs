import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  alias: {
    'jsonc-parser': 'jsonc-parser/lib/esm/main.js'
  },
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/extension.js',
  sourcemap: !production,
  minify: production,
  sourcesContent: !production,
  logLevel: 'info',
  external: ['vscode'],
  tsconfig: 'tsconfig.json'
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}