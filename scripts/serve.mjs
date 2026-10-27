// Tiny local dev server for the static site (no dependencies).
//   npm start            -> http://localhost:8080
//   PORT=3000 npm start  -> another port
// Files are served with no-store caching, so edits show up on a normal reload.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, extname, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8080;

// The Supabase settings file is generated from .env (it is gitignored). Create it if it is missing.
if (!existsSync(join(root, 'assets/js/env.js'))) {
  if (existsSync(join(root, '.env'))) {
    spawnSync(process.execPath, [join(root, 'scripts/build-env.mjs')], { stdio: 'inherit' });
  } else {
    console.warn('\n! No .env found, so ordering and the staff dashboard are disabled.');
    console.warn('  Copy .env.example to .env, fill in your Supabase values, then run: npm run build\n');
  }
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.mp4': 'video/mp4',
};

http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  let file = resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + '\\') && !file.startsWith(root + '/')) { res.writeHead(403).end('Forbidden'); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`American Roadhouse running at http://localhost:${port}`);
  console.log(`Ordering page: http://localhost:${port}/order.html`);
});
