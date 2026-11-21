import { defineConfig, type UserConfig } from 'vite';
import { resolve } from 'node:path';

// Two targets share one codebase:
//   --mode extension  -> dist/extension (Chrome MV3 side panel extension)
//   --mode web        -> dist/web       (hosted demo on Firebase Hosting)
export default defineConfig(({ mode }): UserConfig => {
  const isExtension = mode === 'extension';

  if (isExtension) {
    return {
      publicDir: resolve(import.meta.dirname, 'extension/public'),
      define: { __TARGET__: JSON.stringify('extension') },
      build: {
        outDir: resolve(import.meta.dirname, 'dist/extension'),
        emptyOutDir: true,
        target: 'chrome139',
        modulePreload: false,
        rollupOptions: {
          input: {
            sidepanel: resolve(import.meta.dirname, 'extension/sidepanel.html'),
            background: resolve(import.meta.dirname, 'extension/background.ts'),
            content: resolve(import.meta.dirname, 'extension/content.ts'),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === 'background' || chunk.name === 'content'
                ? '[name].js'
                : 'assets/[name]-[hash].js',
          },
        },
      },
    };
  }

  return {
    root: resolve(import.meta.dirname, 'web'),
    // GitHub Pages serves the demo from /<repo>/; local and Firebase Hosting builds use '/'.
    base: process.env.WEB_BASE ?? '/',
    envDir: import.meta.dirname,
    publicDir: resolve(import.meta.dirname, 'web/public'),
    define: { __TARGET__: JSON.stringify('web') },
    build: {
      outDir: resolve(import.meta.dirname, 'dist/web'),
      emptyOutDir: true,
      target: 'chrome139',
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'web/index.html'),
          bridge: resolve(import.meta.dirname, 'web/bridge.html'),
        },
      },
    },
  };
});
