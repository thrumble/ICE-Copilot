// Local development server - serves the frontend AND the API on one port.
// Usage: npm run dev   (opens http://localhost:8787)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chatHandler from './chat.js';
import titleHandler from './title.js';

const API_ROUTES = {
  '/api/chat': chatHandler,
  '/api/title': titleHandler
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

for (const name of ['.env.local', '.env']) {
  const filePath = path.join(ROOT, name);
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // A blank variable inherited from the shell should not hide a valid value
    // from .env.local. Non-empty shell variables still take precedence.
    if (!(key in process.env) || !process.env[key]?.trim()) process.env[key] = value;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function adaptResponse(res) {
  return {
    setHeader: (name, value) => res.setHeader(name, value),
    status(code) {
      return {
        json: (payload) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        },
        end: () => {
          res.statusCode = code;
          res.end();
        }
      };
    }
  };
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  let filePath = path.normalize(path.join(ROOT, relative));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, 'index.html');
  }

  sendFile(res, filePath);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${process.env.PORT || 8787}`);

  if (url.pathname.startsWith('/api/')) {
    const handler = API_ROUTES[url.pathname];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      const bodyText = await readBody(req);
      req.body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
      return;
    }

    try {
      await handler(req, adaptResponse(res));
    } catch (err) {
      console.error('Unhandled API error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      } else {
        res.end();
      }
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => {
  console.log(`FXBC Copilot running at http://localhost:${PORT}`);
});
