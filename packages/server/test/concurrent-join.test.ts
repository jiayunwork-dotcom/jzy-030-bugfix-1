// 并发加入同一画布的回归：房间只能建一次，两路都进同一房间；
// 存储故障时给客户端明确错误而不是让进程退出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { MemoryStore } from '../src/store/memory.js';
import { FakeConn } from './helpers.js';
import type { ServerMessage } from '@wb/shared';

/**
 * loadOrCreate 中途让出事件循环，模拟真实数据库的网络往返。
 * 同步完成的 MemoryStore 复现不了“两路 join 同时穿过 getRoom”的交错。
 */
class AsyncMemoryStore extends MemoryStore {
  async loadOrCreate(canvasId: string) {
    await new Promise((r) => setTimeout(r, 10));
    return super.loadOrCreate(canvasId);
  }
}

function snapshotsOf(conn: FakeConn) {
  return conn.messages.filter(
    (m): m is Extract<ServerMessage, { kind: 'snapshot' }> => m.kind === 'snapshot',
  );
}

test('两路几乎同时加入同一画布：只建一个房间，双方都拿到快照且互见', async () => {
  const hub = new Hub(new AsyncMemoryStore());
  const a = new FakeConn(hub);
  const b = new FakeConn(hub);
  // 同一拍发出，中间不 flush —— 正是“间隔压到几十毫秒以内”的复现手法
  a.sendRaw({ kind: 'join', canvasId: 'room-race', name: '甲', sessionId: 's1', lastSeq: null });
  b.sendRaw({ kind: 'join', canvasId: 'room-race', name: '乙', sessionId: 's2', lastSeq: null });

  const [sa, sb] = await Promise.all([
    a.waitFor((m) => m.kind === 'snapshot', 3000),
    b.waitFor((m) => m.kind === 'snapshot', 3000),
  ]);
  assert.ok(sa, '甲应拿到快照');
  assert.ok(sb, '乙应拿到快照');

  // 同一个房间：两边的 presence 最终都要同时包含两路
  const [pa, pb] = await Promise.all([
    a.waitFor((m) => m.kind === 'presence' && m.peers.length === 2, 3000),
    b.waitFor((m) => m.kind === 'presence' && m.peers.length === 2, 3000),
  ]);
  assert.equal(pa.kind === 'presence' && pa.peers.length, 2);
  assert.equal(pb.kind === 'presence' && pb.peers.length, 2);

  // 恰好一个房主（房间分裂的征兆是两路都自认房主、互不可见）
  const roles = [
    (sa as Extract<ServerMessage, { kind: 'snapshot' }>).you.role,
    (sb as Extract<ServerMessage, { kind: 'snapshot' }>).you.role,
  ].sort();
  assert.deepEqual(roles, ['editor', 'host']);

  // 任何一路都不该收到错误帧
  assert.equal(a.messages.some((m) => m.kind === 'error'), false);
  assert.equal(b.messages.some((m) => m.kind === 'error'), false);

  // 一路放矩形，另一路实时收到
  a.sendRaw({
    kind: 'op',
    clientId: 'op1',
    op: { t: 'shape.add', draft: { id: 'r1', kind: 'rect', x: 10, y: 10, w: 80, h: 60 } },
  });
  const commit = await b.waitFor(
    (m) => m.kind === 'commit' && JSON.stringify(m).includes('"r1"'),
    3000,
  );
  assert.ok(commit, '乙应实时收到甲放下的矩形');
});

test('房间加载失败：发起方收到错误，进程与 Hub 存活，后续加入不受影响', async () => {
  class FlakyStore extends AsyncMemoryStore {
    fail = true;
    override async loadOrCreate(canvasId: string) {
      await new Promise((r) => setTimeout(r, 1));
      if (this.fail) throw new Error('db is down');
      return super.loadOrCreate(canvasId);
    }
  }
  const store = new FlakyStore();
  const hub = new Hub(store);

  const a = new FakeConn(hub);
  a.sendRaw({ kind: 'join', canvasId: 'room-down', name: '甲', sessionId: 's1', lastSeq: null });
  const err = await a.waitFor((m) => m.kind === 'error', 3000);
  assert.equal(err.kind, 'error', '加载失败必须给这一路明确错误，而不是静默或崩进程');

  // 存储恢复后，同一画布可以正常进入（失败不留残渣）
  store.fail = false;
  const b = new FakeConn(hub);
  b.sendRaw({ kind: 'join', canvasId: 'room-down', name: '乙', sessionId: 's2', lastSeq: null });
  const snap = await b.waitFor((m) => m.kind === 'snapshot', 3000);
  assert.equal(snap.kind, 'snapshot');

  // 其他画布也不受牵连
  const c = new FakeConn(hub);
  c.sendRaw({ kind: 'join', canvasId: 'room-else', name: '丙', sessionId: 's3', lastSeq: null });
  const snap2 = await c.waitFor((m) => m.kind === 'snapshot', 3000);
  assert.equal(snap2.kind, 'snapshot');
  assert.equal(snapshotsOf(c).length, 1);
});
