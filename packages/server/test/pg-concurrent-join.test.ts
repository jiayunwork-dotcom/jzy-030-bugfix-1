// 真实 PostgreSQL 回归：两路几乎同时加入同一画布。
// 锁定的行为：进程不退出、双方都拿到快照、进入同一房间、后续操作实时可见、数据真正落库。
// 运行方式：TEST_DATABASE_URL=postgres://whiteboard:whiteboard@localhost:5432/whiteboard npm test
// （未设置该环境变量时本文件自动跳过，不影响无数据库环境下的测试。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Hub } from '../src/hub.js';
import { PgStore } from '../src/store/pg.js';
import { FakeConn } from './helpers.js';
import type { ServerMessage } from '@wb/shared';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;

test(
  '并发加入同一画布（真实 PostgreSQL）：进程存活，双方都拿到快照并真正落库',
  { skip: DATABASE_URL ? false : '需要 TEST_DATABASE_URL 指向真实 PostgreSQL' },
  async () => {
    const store = await PgStore.create(DATABASE_URL!);
    const verify = new pg.Client({ connectionString: DATABASE_URL! });
    await verify.connect();
    const canvasId = `room-pg-${randomUUID()}`;
    try {
      const hub = new Hub(store);
      const a = new FakeConn(hub);
      const b = new FakeConn(hub);
      // 两路 join 压在同一拍发出（间隔远小于几十毫秒）
      a.sendRaw({ kind: 'join', canvasId, name: '甲', sessionId: 's1', lastSeq: null });
      b.sendRaw({ kind: 'join', canvasId, name: '乙', sessionId: 's2', lastSeq: null });

      // 双方都拿到快照（若进程被唯一键冲突打挂，这里永远等不到）
      const [sa, sb] = (await Promise.all([
        a.waitFor((m) => m.kind === 'snapshot', 10_000),
        b.waitFor((m) => m.kind === 'snapshot', 10_000),
      ])) as Extract<ServerMessage, { kind: 'snapshot' }>[];
      assert.equal(sa.canvasId, canvasId);
      assert.equal(sb.canvasId, canvasId);

      // 同一个房间：presence 同时包含两路，且恰好一个房主
      await Promise.all([
        a.waitFor((m) => m.kind === 'presence' && m.peers.length === 2, 10_000),
        b.waitFor((m) => m.kind === 'presence' && m.peers.length === 2, 10_000),
      ]);
      assert.deepEqual([sa.you.role, sb.you.role].sort(), ['editor', 'host']);
      assert.equal(a.messages.some((m) => m.kind === 'error'), false);
      assert.equal(b.messages.some((m) => m.kind === 'error'), false);

      // 一路放矩形，另一路实时收到提交
      a.sendRaw({
        kind: 'op',
        clientId: 'op1',
        op: { t: 'shape.add', draft: { id: 'rect-1', kind: 'rect', x: 10, y: 10, w: 80, h: 60 } },
      });
      const commit = await b.waitFor(
        (m) => m.kind === 'commit' && JSON.stringify(m).includes('"rect-1"'),
        10_000,
      );
      assert.ok(commit, '乙应实时看到甲放下的矩形');

      // 真正落库：画布恰好一行、两名成员、op_log 里有这次提交
      const { rows: canvasRows } = await verify.query(
        'SELECT COUNT(*)::int AS n FROM canvases WHERE id = $1',
        [canvasId],
      );
      assert.equal(canvasRows[0].n, 1, 'canvases 必须恰好一行（重复建行即唯一键冲突的来源）');
      const { rows: memberRows } = await verify.query(
        'SELECT COUNT(*)::int AS n FROM members WHERE canvas_id = $1',
        [canvasId],
      );
      assert.equal(memberRows[0].n, 2);
      const { rows: opRows } = await verify.query(
        "SELECT COUNT(*)::int AS n FROM op_log WHERE canvas_id = $1 AND actions::text LIKE '%rect-1%'",
        [canvasId],
      );
      assert.equal(opRows[0].n, 1, 'shape.add 提交必须写入 op_log');
      const { rows: shapeRows } = await verify.query(
        'SELECT kind, x, y, w, h FROM shapes WHERE canvas_id = $1 AND id = $2 AND deleted = FALSE',
        [canvasId, 'rect-1'],
      );
      assert.deepEqual(shapeRows, [{ kind: 'rect', x: 10, y: 10, w: 80, h: 60 }]);

      // 探针：竞态之后 Hub 仍健康，第三路加入照常拿到快照
      const probe = new FakeConn(hub);
      probe.sendRaw({ kind: 'join', canvasId, name: '探针', sessionId: 's3', lastSeq: null });
      const ps = (await probe.waitFor((m) => m.kind === 'snapshot', 10_000)) as Extract<
        ServerMessage,
        { kind: 'snapshot' }
      >;
      assert.equal(ps.shapes.length, 1, '第三路应看到已落库的矩形');
    } finally {
      await verify.query('DELETE FROM canvases WHERE id = $1', [canvasId]);
      await verify.end();
      await store.close();
    }
  },
);
