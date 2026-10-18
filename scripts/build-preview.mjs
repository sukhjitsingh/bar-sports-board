// Builds a single self-contained preview of tv.html (data.js inlined, sample-score controls on).
// Usage: node scripts/build-preview.mjs [out.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'tv-preview.html');
const html = readFileSync(join(root, 'tv.html'), 'utf8');
const data = readFileSync(join(root, 'data.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const tag = '<script src="data.js"></script>';
if (!html.includes(tag)) throw new Error('tv.html no longer loads data.js with the expected tag');
writeFileSync(out, html.replace(tag, `<script>window.TV_PREVIEW = true;</script>\n<script>\n${data}\n</script>`));
console.log('wrote', out);
