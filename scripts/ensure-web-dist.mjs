/**
 * Wrangler requires `web/dist` to exist when `[assets.directory]` is set.
 * Vite dev serves the SPA from source and never creates `dist/`, so local
 * `wrangler dev` would exit before binding :8787 unless this directory exists.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
mkdirSync(join(root, 'web', 'dist'), { recursive: true });
