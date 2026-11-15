import { defineConfig } from 'vitest/config';
import { transform } from 'esbuild';

export default defineConfig({
  plugins: [{
    name: 'campus-stage3-decorators',
    enforce: 'pre',
    async transform(source, id) {
      if (!/\/src\/(?:action-)?host\.ts$/.test(id.replaceAll('\\', '/'))) return;
      return transform(source, { loader: 'ts', format: 'esm', target: 'es2023', sourcemap: 'inline', sourcefile: id });
    },
  }],
});
