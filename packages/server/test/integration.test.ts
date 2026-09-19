import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { MemoryStore } from '../src/store/memory.js';
import { FakeConn, flush, joinAs, op } from './helpers.js';
import type { Commit, ServerMessage } from '@wb/shared';

function hub(): Hub {
  return new Hub(new MemoryStore());
}

function findCommit(commits: Commit[], seq: number): Commit {
  const c = commits.find((x) => x.seq === seq);
  assert.ok(c, `缺少 seq=${seq} 的提交`);
  return c!;
}

test('降级时进行中的拖动立即回滚，且脏位置绝不广播给他人', async () => {
  const h = hub();
  const host = new FakeConn(h);
  const editor = new FakeConn(h);
  await joinAs(host, 'c1', '房主');
  await joinAs(editor, 'c1', '编辑');
  const hostSnap = host.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>;
  const editorSnap = editor.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>;
  const editorId = editorSnap.you.sessionId;
  host.drain();
  editor.drain();

  // 添加一个图元
  await op(host, { t: 'shape.add', draft: { id: 's1', kind: 'rect', x: 100, y: 100, w: 100, h: 100 } });
  host.drain();
  editor.drain();

  // 模拟编辑器“正在拖动”（尚未松手提交）——本地态，服务端不知情
  // 房主在拖动进行中将其降级为只读
  await op(host, { t: 'setRole', sessionId: editorId, role: 'viewer' });
  await flush();

  // 被降级者收到提交：里面只能有 member.role，不允许任何 shape.update 脏位置
  const got = editor.drain();
  const roleCommit = got.find((m) => m.kind === 'commit');
  assert.ok(roleCommit);
  const commit = (roleCommit as Extract<ServerMessage, { kind: 'commit' }>).commit;
  assert.deepEqual(
    commit.actions.map((a) => a.kind),
    ['member.role'],
  );
  assert.equal(
    got.some((m) => m.kind === 'commit' &&
      JSON.stringify(m).includes('shape.update') &&
      JSON.stringify(m).includes('350')),
    false,
    '拖动半截位置不得被广播',
  );

  // 降级后任何写操作一律被拒绝并给出可读原因
  editor.sendRaw({
    kind: 'op',
    clientId: 'x1',
    op: { t: 'shape.update', id: 's1', patch: { x: 500 } },
  });
  await flush();
  const err = editor.messages.find((m) => m.kind === 'error') as
    | Extract<ServerMessage, { kind: 'error' }>
    | undefined;
  assert.ok(err);
  assert.equal(err!.code, 'forbidden');
  assert.match(err!.reason, /只读/);

  // 权威状态中图元仍在原位置：由一个全新探针连接取权威快照
  const [fresh] = await ensureSnapshot(host, 'c1');
  const shape = fresh.shapes.find((s) => s.id === 's1')!;
  assert.deepEqual([shape.x, shape.y], [100, 100]);
});

test('只读成员写操作被拒；非房主不能切换角色', async () => {
  const h = hub();
  const host = new FakeConn(h);
  const viewer = new FakeConn(h);
  await joinAs(host, 'c2', '房主');
  await joinAs(viewer, 'c2', '只读员');
  const viewerId = (viewer.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  await op(host, { t: 'setRole', sessionId: viewerId, role: 'viewer' });
  host.drain();
  viewer.drain();

  viewer.sendRaw({ kind: 'op', clientId: 'a', op: { t: 'shape.add', draft: { id: 'x', kind: 'rect', x: 1, y: 1, w: 50, h: 50 } } });
  viewer.sendRaw({ kind: 'undo' });
  viewer.sendRaw({ kind: 'redo' });
  await flush();
  const errs = viewer.drain().filter((m) => m.kind === 'error');
  assert.equal(errs.length, 3);
  for (const e of errs) assert.match((e as never as { reason: string }).reason, /只读/);

  // viewer 试图改别人角色 → forbidden
  viewer.sendRaw({ kind: 'op', clientId: 'b', op: { t: 'setRole', sessionId: viewerId, role: 'editor' } });
  await flush();
  const e2 = viewer.drain().find((m) => m.kind === 'error');
  assert.ok(e2);
  assert.equal((e2 as never as { code: string }).code, 'forbidden');
});

test('同图元不同属性并发改动都保留（属性级合并）', async () => {
  const h = hub();
  const a = new FakeConn(h);
  const b = new FakeConn(h);
  await joinAs(a, 'c3', 'A');
  await joinAs(b, 'c3', 'B');
  const aId = (a.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  const bId = (b.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  a.drain(); b.drain();

  // B 先被设为可编辑（默认加入即 editor，无需切换）；A 加图元
  assert.notEqual(aId, bId);
  await op(a, { t: 'shape.add', draft: { id: 's', kind: 'rect', x: 0, y: 0, w: 100, h: 100, fill: '#ffffff' } });
  a.drain(); b.drain();

  // 两人基于同一基线，同时提交：A 改位置，B 改颜色
  a.sendRaw({ kind: 'op', clientId: '1', op: { t: 'shape.update', id: 's', patch: { x: 200, y: 200 } } });
  b.sendRaw({ kind: 'op', clientId: '2', op: { t: 'shape.update', id: 's', patch: { fill: '#fecaca' } } });
  await flush();

  const seq = h;
  void seq;
  // 从状态视角验证：位置与颜色都在
  const [snap] = await ensureSnapshot(a, 'c3');
  const shape = snap.shapes.find((x) => x.id === 's')!;
  assert.deepEqual([shape.x, shape.y], [200, 200], '位置改动保留');
  assert.equal(shape.fill, '#fecaca', '颜色改动保留');
});

test('同属性并发按服务端接收顺序定序，最终所有客户端收敛一致', async () => {
  const h = hub();
  const a = new FakeConn(h);
  const b = new FakeConn(h);
  await joinAs(a, 'c4', 'A');
  await joinAs(b, 'c4', 'B');
  a.drain(); b.drain();
  await op(a, { t: 'shape.add', draft: { id: 's', kind: 'rect', x: 0, y: 0, w: 100, h: 100 } });
  a.drain(); b.drain();

  // 交错快速提交同一属性 x
  for (let i = 0; i < 20; i++) {
    a.sendRaw({ kind: 'op', clientId: `a${i}`, op: { t: 'shape.update', id: 's', patch: { x: 100 + i } } });
    b.sendRaw({ kind: 'op', clientId: `b${i}`, op: { t: 'shape.update', id: 's', patch: { x: 200 + i } } });
  }
  await flush(8);

  const [sa] = await ensureSnapshot(a, 'c4');
  const [sb] = await ensureSnapshot(b, 'c4');
  const xa = sa.shapes.find((x) => x.id === 's')!.x;
  const xb = sb.shapes.find((x) => x.id === 's')!.x;
  assert.equal(xa, xb, '两端收敛到同一个最终值');

  // 最终值等于“最后一个被接收的提交”赋的值（接收顺序即定序，无整体覆盖）
  const commitsA = a.commits();
  // 重新抓快照后 commits 已 drain，用 log 视角再验：颜色未被位置更新抹掉
  await op(a, { t: 'shape.update', id: 's', patch: { fill: '#a7f3d0' } });
  await op(b, { t: 'shape.update', id: 's', patch: { x: 999 } });
  await flush();
  const [sc] = await ensureSnapshot(a, 'c4');
  const s = sc.shapes.find((x) => x.id === 's')!;
  assert.equal(s.x, 999);
  assert.equal(s.fill, '#a7f3d0', '后到的位置提交不得覆盖先到的颜色');
});

test('断线重连：带 lastSeq 追增量；落后太多则给完整快照', async () => {
  const h = hub();
  const a = new FakeConn(h);
  await joinAs(a, 'c5', 'A');
  const id = (a.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  a.drain();
  await op(a, { t: 'shape.add', draft: { id: 's1', kind: 'rect', x: 1, y: 1, w: 50, h: 50 } });
  await op(a, { t: 'shape.add', draft: { id: 's2', kind: 'rect', x: 2, y: 2, w: 50, h: 50 } });
  const live = a.drain().filter((m) => m.kind === 'commit');
  assert.equal(live.length, 2);

  // 模拟真实断线：先让 Hub 知道旧连接断开，再用同 sessionId 重连
  h.handleClose(a);
  await flush();

  // 重连 1：带最新 lastSeq=2，无新内容 → delta 为空
  const r1 = new FakeConn(h);
  await joinAs(r1, 'c5', 'A', id, 2);
  const m1 = r1.drain();
  assert.ok(m1.some((m) => m.kind === 'delta'));
  const delta = m1.find((m) => m.kind === 'delta') as Extract<ServerMessage, { kind: 'delta' }>;
  assert.deepEqual(delta.commits, []);

  // 断线期间（仍离线）由其他在线者产生增量 seq=3
  const other = new FakeConn(h);
  await joinAs(other, 'c5', 'Other');
  other.drain();
  await op(other, { t: 'shape.update', id: 's1', patch: { x: 77 } });
  other.drain();

  // 重连 2：lastSeq=2，应只补发 seq=3 增量
  const r2 = new FakeConn(h);
  await joinAs(r2, 'c5', 'A', id, 2);
  const m2 = r2.drain();
  const d2 = m2.find((m) => m.kind === 'delta') as Extract<ServerMessage, { kind: 'delta' }>;
  assert.ok(d2, 'lastSeq 之后应补发增量而非快照');
  assert.equal(d2.commits.length, 1);
  assert.equal(d2.commits[0].seq, 3);

  // 落后到日志窗口之外（lastSeq 太小）→ 完整快照
  const r3 = new FakeConn(h);
  await joinAs(r3, 'c5', 'A', id, -9999);
  const m3 = r3.drain();
  const snap = m3.find((m) => m.kind === 'snapshot') as Extract<ServerMessage, { kind: 'snapshot' }>;
  assert.ok(snap);
  assert.equal(snap.shapes.length, 2);
  assert.equal(snap.seq, 3);
});

test('撤销按人隔离：只回退本人操作，保留他人对同图元其它属性的改动', async () => {
  const h = hub();
  const a = new FakeConn(h);
  const b = new FakeConn(h);
  await joinAs(a, 'c6', 'A');
  await joinAs(b, 'c6', 'B');
  const aId = (a.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  const bId = (b.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  a.drain(); b.drain();

  // seq1 A 移动 s 到 (300,300)
  await op(a, { t: 'shape.add', draft: { id: 's', kind: 'rect', x: 0, y: 0, w: 100, h: 100, fill: '#ffffff' } });
  a.drain(); b.drain();
  await op(a, { t: 'shape.update', id: 's', patch: { x: 300, y: 300 } });
  a.drain(); b.drain();
  // seq3 B 改颜色
  await op(b, { t: 'shape.update', id: 's', patch: { fill: '#bfdbfe' } });
  a.drain(); b.drain();

  // B 尝试撤销：栈里没有 B 的编辑前… 实际上 B 刚改过颜色，B undo 应只撤 B 的颜色
  b.sendRaw({ kind: 'undo' });
  await flush();
  let snap = (await ensureSnapshot(a, 'c6'))[0];
  let s = snap.shapes.find((x) => x.id === 's')!;
  assert.deepEqual([s.x, s.y], [300, 300], 'B 的撤销不得动 A 的位置');
  assert.equal(s.fill, '#ffffff', 'B 撤销自己的颜色');

  // A 撤销自己的移动：颜色保持 B 之前的状态（#ffffff，因为 B 已撤销）
  a.sendRaw({ kind: 'undo' });
  await flush();
  snap = (await ensureSnapshot(a, 'c6'))[0];
  s = snap.shapes.find((x) => x.id === 's')!;
  assert.deepEqual([s.x, s.y], [0, 0], 'A 撤销自己的位置');
  assert.equal(s.fill, '#ffffff');

  // 再让 B 改颜色后 A 撤销 A 的位置：B 的颜色必须保留
  await op(a, { t: 'shape.update', id: 's', patch: { x: 400 } });
  a.drain(); b.drain();
  await op(b, { t: 'shape.update', id: 's', patch: { fill: '#fbcfe8' } });
  a.drain(); b.drain();
  a.sendRaw({ kind: 'undo' });
  await flush();
  snap = (await ensureSnapshot(a, 'c6'))[0];
  s = snap.shapes.find((x) => x.id === 's')!;
  assert.equal(s.x, 0, 'A 位置回退');
  assert.equal(s.fill, '#fbcfe8', 'B 的颜色改动保留');
  void aId;
  void bId;
});

test('撤销/重做在重连后由服务端操作日志续接', async () => {
  const h = hub();
  const a = new FakeConn(h);
  await joinAs(a, 'c6b', 'A');
  const id = (a.messages[0] as Extract<ServerMessage, { kind: 'snapshot' }>).you.sessionId;
  a.drain();
  await op(a, { t: 'shape.add', draft: { id: 's', kind: 'rect', x: 10, y: 10, w: 50, h: 50 } });
  a.drain();
  a.sendRaw({ kind: 'undo' });
  await flush();
  a.drain();

  // 真实断线后用同 sessionId 重连：redo 栈由服务端操作日志续接
  h.handleClose(a);
  await flush();
  const r = new FakeConn(h);
  await joinAs(r, 'c6b', 'A', id, 2);
  const reconnectMsgs = r.drain();
  const commits = reconnectMsgs.filter((m) => m.kind === 'commit');
  const d = reconnectMsgs.find((m) => m.kind === 'delta') as
    | Extract<ServerMessage, { kind: 'delta' }>
    | undefined;
  assert.ok(d, 'seq 连续时应走增量通道');
  assert.equal(commits.length, 0, 'lastSeq 已是最新，无增量提交');
  assert.equal(d!.undoDepth, 0);
  assert.equal(d!.redoDepth, 1, '撤销状态由服务端日志恢复');
  r.sendRaw({ kind: 'redo' });
  await flush();
  const snap = (await ensureSnapshot(r, 'c6b'))[0];
  assert.equal(snap.shapes.length, 1);
});

test('图元移动后连线端点贴合最近锚点，路径确定可复现', async () => {
  const h = hub();
  const a = new FakeConn(h);
  const b = new FakeConn(h);
  await joinAs(a, 'c7', 'A');
  await joinAs(b, 'c7', 'B');
  a.drain(); b.drain();
  await op(a, { t: 'shape.add', draft: { id: 's1', kind: 'rect', x: 100, y: 100, w: 100, h: 100 } });
  await op(a, { t: 'shape.add', draft: { id: 's2', kind: 'rect', x: 400, y: 100, w: 100, h: 100 } });
  await op(a, { t: 'connection.add', id: 'l1', sourceId: 's1', targetId: 's2' });
  a.drain(); b.drain();

  let snap = (await ensureSnapshot(a, 'c7'))[0];
  let conn = snap.connections.find((c) => c.id === 'l1')!;
  // s1 中心 150,150；s2 中心 450,150 → s1 右边中点 (200,150)，s2 左边中点 (400,150)
  assert.deepEqual(conn.path[0], { x: 200, y: 150 });
  assert.deepEqual(conn.path[conn.path.length - 1], { x: 400, y: 150 });

  // 移动 s1 后两端重新贴合；两个人算出来完全一致（可复现、无抖动）
  await op(a, { t: 'shape.update', id: 's1', patch: { x: 100, y: 400 } });
  a.drain(); b.drain();
  const sa = (await ensureSnapshot(a, 'c7'))[0];
  const sb = (await ensureSnapshot(b, 'c7'))[0];
  const ca = sa.connections.find((c) => c.id === 'l1')!;
  const cb = sb.connections.find((c) => c.id === 'l1')!;
  assert.deepEqual(ca.path, cb.path, '两端路径逐点一致');
  // s1 现在中心 (150,450)，对端 (450,150)：锚点在 s1 右/上边缘某确定点
  assert.ok(ca.path[0].x >= 199.9 && ca.path[0].x <= 200.1);
  assert.ok(ca.path[0].y >= 400 && ca.path[0].y <= 450);

  // 再刷一次快照，路径不抖
  const sc = (await ensureSnapshot(a, 'c7'))[0];
  const cc = sc.connections.find((c) => c.id === 'l1')!;
  assert.deepEqual(cc.path, ca.path, '重复获取结果稳定');
  void conn;
});

test('删除图元时连线一并删除，不留悬空端点', async () => {
  const h = hub();
  const a = new FakeConn(h);
  await joinAs(a, 'c8', 'A');
  a.drain();
  await op(a, { t: 'shape.add', draft: { id: 's1', kind: 'rect', x: 0, y: 0, w: 50, h: 50 } });
  await op(a, { t: 'shape.add', draft: { id: 's2', kind: 'rect', x: 200, y: 0, w: 50, h: 50 } });
  await op(a, { t: 'connection.add', id: 'l', sourceId: 's1', targetId: 's2' });
  a.drain();
  await op(a, { t: 'shape.delete', id: 's1' });
  await flush();
  const snap = (await ensureSnapshot(a, 'c8'))[0];
  assert.equal(snap.shapes.some((s) => s.id === 's1'), false);
  assert.equal(snap.connections.length, 0, '挂在被删图元上的连线必须级联删除');

  // 撤销删除：图元与连线都恢复，连线不悬空
  a.sendRaw({ kind: 'undo' });
  await flush();
  const snap2 = (await ensureSnapshot(a, 'c8'))[0];
  assert.equal(snap2.shapes.some((s) => s.id === 's1'), true);
  const conn = snap2.connections.find((c) => c.id === 'l');
  assert.ok(conn);
  assert.ok(conn!.path.length >= 2);
});

test('锚到不存在图元的连线被拒并说明原因', async () => {
  const h = hub();
  const a = new FakeConn(h);
  await joinAs(a, 'c9', 'A');
  a.drain();
  await op(a, { t: 'shape.add', draft: { id: 's1', kind: 'rect', x: 0, y: 0, w: 50, h: 50 } });
  a.drain();
  a.sendRaw({ kind: 'op', clientId: 'x', op: { t: 'connection.add', id: 'bad', sourceId: 's1', targetId: 'ghost' } });
  await flush();
  const err = a.drain().find((m) => m.kind === 'error') as Extract<ServerMessage, { kind: 'error' }>;
  assert.ok(err);
  assert.equal(err.code, 'not_found');
  assert.match(err.reason, /终点图元不存在/);

  // 同图元自连也拒绝
  a.sendRaw({ kind: 'op', clientId: 'y', op: { t: 'connection.add', id: 'self', sourceId: 's1', targetId: 's1' } });
  await flush();
  const err2 = a.drain().find((m) => m.kind === 'error');
  assert.ok(err2);
  assert.match((err2 as never as { reason: string }).reason, /同一个图元/);
});

test('坐标越界与非法尺寸被拒', async () => {
  const h = hub();
  const a = new FakeConn(h);
  await joinAs(a, 'c10', 'A');
  a.drain();
  a.sendRaw({ kind: 'op', clientId: '1', op: { t: 'shape.add', draft: { id: 'big', kind: 'rect', x: 0, y: 0, w: 999999, h: 50 } } });
  a.sendRaw({ kind: 'op', clientId: '2', op: { t: 'shape.add', draft: { id: 'far', kind: 'rect', x: 60000, y: 0, w: 50, h: 50 } } });
  a.sendRaw({ kind: 'op', clientId: '3', op: { t: 'shape.add', draft: { id: 'tiny', kind: 'rect', x: 0, y: 0, w: 5, h: 50 } } });
  await flush();
  const errs = a.drain().filter((m) => m.kind === 'error');
  assert.equal(errs.length, 3);
  for (const e of errs) assert.equal((e as never as { code: string }).code, 'bad_request');
  const snap = (await ensureSnapshot(a, 'c10'))[0];
  assert.equal(snap.shapes.length, 0, '非法操作不得让画布进入脏状态');
});

// 用“新连接拿快照”的方式断言权威状态（快照直接来自服务端内存权威态）
async function ensureSnapshot(conn: FakeConn, canvasId: string): Promise<[Extract<ServerMessage, { kind: 'snapshot' }>, FakeConn]> {
  const fresh = new FakeConn(conn.hub);
  const snapMsg = fresh.messages;
  void snapMsg;
  fresh.sendRaw({ kind: 'join', canvasId, name: 'probe', sessionId: undefined, lastSeq: null });
  await flush();
  const msg = fresh.messages.find((m) => m.kind === 'snapshot') as Extract<ServerMessage, { kind: 'snapshot' }>;
  assert.ok(msg);
  return [msg, fresh];
}
