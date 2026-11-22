import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the browser-level UI tests.
 *
 * If scripts/setup-browser-deps.sh has been run into .cache/chromium-deps, the
 * extracted libraries are prepended to LD_LIBRARY_PATH so Playwright's bundled
 * Chromium can launch without root. On a machine with system libraries this is
 * a no-op.
 */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const override = process.env.CHROMIUM_DEPS_DIR;
const localDeps = resolve(here, '.cache/chromium-deps');
const candidates = override
  ? override.split(':')
  : [
      resolve(localDeps, 'usr/lib/aarch64-linux-gnu'),
      resolve(localDeps, 'lib/aarch64-linux-gnu'),
      resolve(localDeps, 'usr/lib/x86_64-linux-gnu'),
      resolve(localDeps, 'lib/x86_64-linux-gnu'),
    ];
const present = candidates.filter((p) => existsSync(p));
if (present.length > 0) {
  process.env.LD_LIBRARY_PATH = [present.join(':'), process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(':');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1500, height: 1000 },
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
