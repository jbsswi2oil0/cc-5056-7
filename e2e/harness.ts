import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localDeps = resolve(here, '../.cache/chromium-deps');
for (const sub of ['usr/lib/aarch64-linux-gnu', 'lib/aarch64-linux-gnu', 'usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu']) {
  const p = resolve(localDeps, sub);
  if (existsSync(p) && !(process.env.LD_LIBRARY_PATH ?? '').includes(p)) {
    process.env.LD_LIBRARY_PATH = [p, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
}

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';

export async function launch(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('window:error', (e) => errors.push(String(e)));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  (page as unknown as { __errors: string[] }).__errors = errors;
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="composite-canvas"]');
  return { browser, page };
}

export function errorsOf(page: Page): string[] {
  return (page as unknown as { __errors: string[] }).__errors ?? [];
}
