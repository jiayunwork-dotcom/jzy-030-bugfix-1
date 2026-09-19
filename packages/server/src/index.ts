import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { config } from './config.js';
import { Hub } from './hub.js';
import { attachWebSocket } from './ws.js';
import { MemoryStore } from './store/memory.js';
import { PgStore } from './store/pg.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function main(): Promise<void> {
  const store = config.databaseUrl
    ? await PgStore.create(config.databaseUrl)
    : new MemoryStore();
  // eslint-disable-next-line no-console
  console.log(
    config.databaseUrl
      ? 'persistence: PostgreSQL 16'
      : 'persistence: in-memory (set DATABASE_URL for PostgreSQL)',
  );

  const hub = new Hub(store);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // 静态前端（生产镜像里由后端托管）
    if (config.staticDir && existsSync(config.staticDir)) {
      let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(config.staticDir, pathname);
      if (!filePath.startsWith(config.staticDir)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      try {
        const body = await readFile(filePath);
        res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
        res.end(body);
        return;
      } catch {
        // SPA 回退
        const fallback = await readFile(join(config.staticDir, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(fallback);
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  attachWebSocket(server, hub);
  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`collab whiteboard listening on :${config.port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
