import { execSync } from 'node:child_process';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Stamp the bundle with the commit it was built from and the build wall
// clock so the sign-in footer can show "this is what's running right
// now". GitHub Actions sets GITHUB_SHA on every workflow run; locally
// we shell out to git. If neither works (e.g. a tarball with no .git),
// the fallback "dev" is honest about that.
const commitSha =
  process.env.GITHUB_SHA?.trim() ||
  (() => {
    try {
      return execSync('git rev-parse HEAD', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      return 'dev';
    }
  })();
const buildTimestamp = new Date().toISOString();

export default defineConfig({
  root: __dirname,
  plugins: [preact(), tailwindcss()],
  define: {
    __COMMIT_SHA__: JSON.stringify(commitSha),
    __BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/r': 'http://127.0.0.1:8787',
    },
  },
});
