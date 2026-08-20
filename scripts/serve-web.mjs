// Local preview of the marketing site (static/) — `npm run web:dev`.
//
// Mirrors the two things Render's static service does that a plain file server
// doesn't, so what you click locally matches production:
//   - the /terms and /privacy rewrites from render.yaml
//   - the pinned Content-Type on the extension-less AASA file
//
// Serves on http://localhost:4321 (override with PORT=…). Also prints a LAN URL
// so you can open it on a phone on the same Wi-Fi.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
const PORT = Number(process.env.PORT || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// render.yaml routes
const REWRITES = { '/': '/index.html', '/terms': '/terms.html', '/privacy': '/privacy.html' };

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const rel = REWRITES[url] ?? url;
    const file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>404</h1><p>No file for <code>${rel}</code>.</p><p><a href="/">Home</a></p>`);
        console.log(`404 ${url}`);
        return;
      }
      const type = url.endsWith('/apple-app-site-association')
        ? 'application/json'
        : TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
      console.log(`200 ${url}`);
    });
  })
  .listen(PORT, () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i.family === 'IPv4' && !i.internal)?.address;
    console.log(`\n  Calen site → http://localhost:${PORT}`);
    if (lan) console.log(`  on your phone → http://${lan}:${PORT}`);
    console.log('');
  });
