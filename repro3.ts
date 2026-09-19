import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { PgStore } from './packages/server/src/store/pg.js';

const freePort = (): Promise<number> => new Promise((res, rej) => {
  const s = createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => res(typeof a==='object'&&a?a.port:0)); });
});
process.on('unhandledRejection', (err) => console.log('UNHANDLED REJECTION:', (err as Error).message));

const port = await freePort();
const dir = join(tmpdir(), `repro3-${Date.now()}`); mkdirSync(dir, { recursive: true });
const cluster = new EmbeddedPostgres({ databaseDir: dir, user: 'whiteboard', password: 'whiteboard', port, persistent: false, onLog(){}, onError(){} });
await cluster.initialise(); await cluster.start();
try { await cluster.createDatabase('whiteboard'); } catch {}

const url = `postgres://whiteboard:whiteboard@127.0.0.1:${port}/whiteboard`;
const store = await PgStore.create(url);

// 两个并发 loadOrCreate，同一全新画布，分别 await（模拟 hub 两个 join 各持 Promise）
const p1 = store.loadOrCreate('room-bug');
const p2 = store.loadOrCreate('room-bug');
const [r1, r2] = await Promise.allSettled([p1, p2]);
console.log('p1:', r1.status, r1.status==='fulfilled' ? r1.value.canvasId : r1.reason?.message);
console.log('p2:', r2.status, r2.status==='fulfilled' ? r2.value.canvasId : r2.reason?.message);
console.log('same RoomData:', r1.status==='fulfilled' && r2.status==='fulfilled' && r1.value === r2.value);
await store.close();
await cluster.stop();
process.exit(0);
