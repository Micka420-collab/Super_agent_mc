// Documentation captures with the pre-installed Chromium (Playwright):
//   node capture.mjs page <url> <out.png> [width] [height]   → screenshot of a live page (the mind's dashboard)
//   node capture.mjs upscale <in.png> <out.png> <factor>      → nearest-neighbour enlargement (keeps the retina's blocks crisp)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

// Playwright is resolved like `require('playwright')` (global install / NODE_PATH), not as a project dependency.
const { chromium } = createRequire(import.meta.url)('playwright');

const [mode, a, b, c, d] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  if (mode === 'page') {
    const page = await browser.newPage({ viewport: { width: Number(c ?? 1280), height: Number(d ?? 800) }, deviceScaleFactor: 1 });
    await page.goto(a, { waitUntil: 'domcontentloaded' }); // the dashboard keeps a WebSocket open: never 'networkidle'
    await page.waitForTimeout(4500); // let the dashboard poll status, goals, timeline and the retina a couple of times
    await page.screenshot({ path: b, fullPage: false });
  } else if (mode === 'upscale') {
    const factor = Number(c ?? 4);
    const page = await browser.newPage();
    const src = `data:image/png;base64,${readFileSync(a).toString('base64')}`;
    const dataUrl = await page.evaluate(async ({ src, factor }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width * factor;
      canvas.height = img.height * factor;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    }, { src, factor });
    writeFileSync(b, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  await browser.close();
}
