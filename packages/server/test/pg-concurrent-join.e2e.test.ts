// 真正走到落库的回归（验收用例）：
// 真实 PostgreSQL + 独立 server 进程 + 真实 WebSocket。
// 复现“同一画布多路几乎同时 join 导致 canvases_pkey 冲突、进程退出”，锁定修复后行为：
//   1. 并发 join 时 server 进程不退出，/health 始终 200；
//   2. 每一路都拿到首帧（无 lastSeq 为 snapshot，lastSeq=0 为空 delta）；
//   3. 一边放矩形，另一边立刻收到 commit；
//   4. 画布、成员、提交、图元都真实落库；
//   5. 多路（>2）并发加入新画布同样不崩，且恰好一个房主；
//   6. server 日志不再出现 canvases_pkey / duplicate key。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import pg from 'pg';
import WebSocket from 'ws';
import type { ServerMessage } from '@wb/shared';
import { embeddedPgAvailable, getFreePort, startEmbeddedPostgres, type EmbeddedCluster } from './pg-helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const SERVER_ENTRY = join(repoRoot, 'packages', 'server', 'src', 'index.ts');
const HTTP_WAIT_MS = 20_000;

/** 真实 WebSocket 上的“按谓词取帧”辅助：未匹配的消息始终保留在缓存里。 */
class WsClient {
  private queue: ServerMessage[] = [];
  private waiters: Array<{
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];
  private closed = false;
  readonly socket: WebSocket;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const idx = this.waiters.findIndex((w) => {
        try {
          return w.pred(msg);
        } catch {
          return false;
        }
      });
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w!.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
    this.socket.on('close', () => {
      this.closed = true;
    });
  }

  async open(): Promise<void> {
    await once(this.socket, 'open');
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  async waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 8_000): Promise<ServerMessage> {
    const idx = this.queue.findIndex((m) => {
      try {
        return pred(m);
      } catch {
        return false;
      }
    });
    if (idx >= 0) return this.queue.splice(idx, 1)[0]!;
    return await new Promise<ServerMessage>((resolve, reject) => {
      const entry = { pred, resolve };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待服务端消息超时；已缓存帧=[${this.queue.map((m) => m.kind).join(',')}]`));
      }, timeoutMs);
      const wrappedResolve = entry.resolve;
      entry.resolve = (m): void => {
        clearTimeout(timer);
        wrappedResolve(m);
      };
      this.waiters.push(entry);
    });
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }

  async closedFully(): Promise<void> {
    if (this.socket.readyState !== this.socket.CLOSED) await once(this.socket, 'close');
  }
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HTTP_WAIT_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server 未在 ${HTTP_WAIT_MS}ms 内就绪：${String(lastErr)}`);
}

function startServer(port: number, databaseUrl: string): {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stderr: string[];
} {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port), DATABASE_URL: databaseUrl, STATIC_DIR: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  return { child, stderr };
}

test('真实 PostgreSQL：并发加入同一画布，进程不退出、各方都拿到首帧、编辑实时同步且落库', { timeout: 120_000 }, async (t) => {
  if (!embeddedPgAvailable()) {
    t.skip('当前平台缺少 embedded-postgres 预编译二进制，跳过真实落库回归。');
    return;
  }

  const cluster: EmbeddedCluster = await startEmbeddedPostgres('e2e');
  const pool = new pg.Pool({ connectionString: cluster.url, max: 5 });
  const httpPort = await getFreePort();
  const { child, stderr } = startServer(httpPort, cluster.url);
  try {
    await waitForHealth(httpPort);

    // —— 核心复现：新画布两路几乎同时 join，连续多轮（每轮全新画布 id，覆盖创建窗口）——
    // 偶数轮按浏览器真实首连（不带 lastSeq → snapshot），
    // 奇数轮按带 lastSeq=0（新画布 → 空 delta）。两种首连在并发创建窗口里都必须安全。
    const ROUNDS = 6;
    for (let i = 1; i <= ROUNDS; i++) {
      const canvasId = `room-bug-${i}`;
      const wantSnapshot = i % 2 === 0;
      const a = new WsClient(httpPort);
      const b = new WsClient(httpPort);
      await Promise.all([a.open(), b.open()]);

      // 同一同步时刻各发一条 join，服务端在同一个 loadOrCreate 完成前收到两路
      const joinFrame = (name: string): unknown =>
        wantSnapshot
          ? { kind: 'join', canvasId, name, sessionId: null }
          : { kind: 'join', canvasId, name, sessionId: null, lastSeq: 0 };
      a.send(joinFrame('甲'));
      b.send(joinFrame('乙'));

      const initial = (c: WsClient): Promise<ServerMessage> =>
        wantSnapshot
          ? c.waitFor((m) => m.kind === 'snapshot' && m.canvasId === canvasId)
          : c.waitFor((m) => m.kind === 'delta');
      const [firstA, firstB] = await Promise.all([initial(a), initial(b)]);
      if (wantSnapshot) {
        for (const m of [firstA, firstB]) {
          assert.equal(m.kind, 'snapshot');
          assert.equal((m as Extract<ServerMessage, { kind: 'snapshot' }>).canvasId, canvasId);
          assert.deepEqual((m as Extract<ServerMessage, { kind: 'snapshot' }>).shapes, []);
        }
      } else {
        for (const m of [firstA, firstB]) {
          assert.equal(m.kind, 'delta', 'lastSeq=0 的新画布首帧为空增量');
          assert.deepEqual((m as Extract<ServerMessage, { kind: 'delta' }>).commits, []);
        }
      }

      assert.equal(child.killed, false, 'server 进程必须存活');
      assert.equal(child.exitCode, null, 'server 不得自行退出');
      const health = await fetch(`http://127.0.0.1:${httpPort}/health`);
      assert.equal(health.status, 200, '/health 必须持续可用');

      // 一边放矩形，另一边马上能看见
      const rectId = `rect-${i}`;
      a.send({
        kind: 'op',
        clientId: `add-${i}`,
        op: { t: 'shape.add', draft: { id: rectId, kind: 'rect', x: 100, y: 100, w: 120, h: 80 } },
      });
      const commit = (await b.waitFor(
        (m) =>
          m.kind === 'commit' &&
          (m as Extract<ServerMessage, { kind: 'commit' }>).commit.actions.some(
            (act) =>
              act.kind === 'shape.add' &&
              (act as { shape: { id: string } }).shape.id === rectId,
          ),
      )) as Extract<ServerMessage, { kind: 'commit' }>;
      assert.equal(commit.commit.seq, 1, '每张新画布首个编辑定序为 seq=1');

      a.close();
      b.close();
      await Promise.all([a.closedFully(), b.closedFully()]);
    }

    // —— 多路（4 路）同一毫秒加入又一张全新画布（snapshot 首连）———
    {
      const canvasId = 'room-many';
      const clients = [0, 1, 2, 3].map(() => new WsClient(httpPort));
      await Promise.all(clients.map((c) => c.open()));
      for (let i = 0; i < clients.length; i++) {
        clients[i]!.send({ kind: 'join', canvasId, name: `u${i}`, sessionId: null });
      }
      const snaps = await Promise.all(
        clients.map((c) => c.waitFor((m) => m.kind === 'snapshot' && m.canvasId === canvasId)),
      );
      assert.equal(snaps.length, 4, '四路并发加入必须全部拿到快照');
      const roles = snaps.map((m) => (m as Extract<ServerMessage, { kind: 'snapshot' }>).you.role);
      assert.equal(roles.filter((r) => r === 'host').length, 1, '恰好一个房主');
      assert.equal(roles.filter((r) => r === 'editor').length, 3, '其余三路均为可编辑成员');
      for (const c of clients) c.close();
      await Promise.all(clients.map((c) => c.closedFully()));
    }

    // —— 真正落库校验：canvas/member/op_log/shape 行都在 ———
    {
      const canvases = await pool.query('SELECT id FROM canvases ORDER BY id');
      const ids = canvases.rows.map((r) => r.id as string);
      for (let i = 1; i <= ROUNDS; i++) assert.ok(ids.includes(`room-bug-${i}`));
      assert.ok(ids.includes('room-many'));

      const members = await pool.query(
        'SELECT canvas_id, COUNT(*)::int AS n FROM members GROUP BY canvas_id ORDER BY canvas_id',
      );
      const byCanvas = new Map(members.rows.map((r) => [r.canvas_id as string, r.n as number]));
      for (let i = 1; i <= ROUNDS; i++) assert.equal(byCanvas.get(`room-bug-${i}`), 2);
      assert.equal(byCanvas.get('room-many'), 4);

      // 每张画布恰有一次用户编辑（shape.add，seq=1）。
      // 注：首个连接关闭而另一路仍在线时会产生房主迁移的 member.role 系统提交，
      // 那不属于编辑，这里只统计用户编辑动作。
      const ops = await pool.query(
        `SELECT canvas_id,
                COUNT(*)::int AS n,
                MIN(seq)::int AS first_seq
         FROM op_log
         WHERE canvas_id = ANY($1)
           AND undoable = TRUE
         GROUP BY canvas_id ORDER BY canvas_id`,
        [Array.from({ length: ROUNDS }, (_, k) => `room-bug-${k + 1}`)],
      );
      assert.equal(ops.rowCount, ROUNDS, '每张画布都必须有那次 shape.add 编辑');
      for (const r of ops.rows) {
        assert.equal(r.n, 1, `画布 ${r.canvas_id as string} 应只有一次可撤销编辑`);
        assert.equal(r.first_seq, 1, '首次编辑定序为 seq=1');
      }

      const shapes = await pool.query(
        'SELECT id FROM shapes WHERE canvas_id = $1 AND deleted = FALSE',
        ['room-bug-1'],
      );
      assert.equal(shapes.rowCount, 1);
      assert.equal(shapes.rows[0]!.id, 'rect-1');
    }

    // 崩溃证据必须消失
    const allStderr = stderr.join('');
    assert.equal(
      /canvases_pkey|duplicate key value/i.test(allStderr),
      false,
      `server 日志不得再出现唯一键冲突：\n${allStderr}`,
    );

    await waitForHealth(httpPort);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit').catch(() => {});
    await pool.end();
    await cluster.stop();
  }
});
