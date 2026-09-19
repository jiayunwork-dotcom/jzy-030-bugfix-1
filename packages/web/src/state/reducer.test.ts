// 前端协作者状态层测试：重点锁住“降级时进行中拖动立即回滚、无脏位置外溢”
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardReducer, initialBoardState, viewConnections } from './reducer';
import type { Commit, Shape } from '@wb/shared';

function shape(id: string, x = 100, y = 100): Shape {
  return { id, canvasId: 'cv', kind: 'rect', x, y, w: 100, h: 100, z: 1, fill: '#ffffff', text: '' };
}

function withSnapshot(role: 'host' | 'editor' | 'viewer' = 'editor', session = 'me') {
  let s = initialBoardState('cv');
  s = boardReducer(s, {
    kind: 'snapshot',
    canvasId: 'cv',
    seq: 1,
    shapes: [shape('s1')],
    connections: [],
    you: { sessionId: session, name: '我', role, color: '#f00' },
    undoDepth: 0,
    redoDepth: 0,
  });
  return s;
}

function roleCommit(seq: number, session: string, role: 'editor' | 'viewer'): Commit {
  return {
    seq,
    canvasId: 'cv',
    actorSessionId: 'host',
    groupId: null,
    undoable: false,
    undoOf: null,
    redoOf: null,
    actions: [{ kind: 'member.role', sessionId: session, role }],
  };
}

test('进行中的拖动：收到降级提交的同一帧立即回弹到拖动前位置', () => {
  let s = withSnapshot('editor');
  // 开始拖并移动很远（本地乐观态）
  s = boardReducer(s, { kind: 'drag.start', shapeId: 's1', pointer: { x: 0, y: 0 } });
  s = boardReducer(s, { kind: 'drag.move', pointer: { x: 250, y: 350 } });
  assert.deepEqual([s.shapes.get('s1')!.x, s.shapes.get('s1')!.y], [350, 450]);
  assert.ok(s.drag);

  // 同一帧收到房主降级提交：不等松手，立刻回滚
  s = boardReducer(s, { kind: 'commit', commit: roleCommit(2, 'me', 'viewer') });
  assert.equal(s.drag, null, '拖动状态必须立即终止');
  assert.deepEqual(
    [s.shapes.get('s1')!.x, s.shapes.get('s1')!.y],
    [100, 100],
    '图元必须回弹到降级前的权威位置',
  );
  assert.equal(s.you!.role, 'viewer');
  assert.match(s.notice ?? '', /只读/);
});

test('拖动中的本地半截位置只存在本地视图，提交内容由松手时决定；被拒错误同样回滚', () => {
  let s = withSnapshot('editor');
  s = boardReducer(s, { kind: 'drag.start', shapeId: 's1', pointer: { x: 0, y: 0 } });
  s = boardReducer(s, { kind: 'drag.move', pointer: { x: 999, y: 999 } });
  // 服务端拒绝（如越权）→ error 帧把乐观态拉回权威位置
  s = boardReducer(s, { kind: 'error', reason: '当前角色为只读，无法编辑画布。' });
  assert.equal(s.drag, null);
  assert.deepEqual([s.shapes.get('s1')!.x, s.shapes.get('s1')!.y], [100, 100]);
});

test('别人的降级不影响我的拖动', () => {
  let s = withSnapshot('editor');
  s = boardReducer(s, { kind: 'drag.start', shapeId: 's1', pointer: { x: 0, y: 0 } });
  s = boardReducer(s, { kind: 'drag.move', pointer: { x: 50, y: 60 } });
  s = boardReducer(s, { kind: 'commit', commit: roleCommit(2, 'someone-else', 'viewer') });
  assert.ok(s.drag, '无关成员的角色变更不打断我');
  assert.deepEqual([s.shapes.get('s1')!.x, s.shapes.get('s1')!.y], [150, 160]);
  assert.equal(s.you!.role, 'editor');
});

test('只读身份无法发起拖动', () => {
  let s = withSnapshot('viewer');
  s = boardReducer(s, { kind: 'drag.start', shapeId: 's1', pointer: { x: 0, y: 0 } });
  assert.equal(s.drag, null);
});

test('快照到达（重连）时丢弃任何未提交本地态，以服务端为准', () => {
  let s = withSnapshot('editor');
  s = boardReducer(s, { kind: 'drag.start', shapeId: 's1', pointer: { x: 0, y: 0 } });
  s = boardReducer(s, { kind: 'drag.move', pointer: { x: 300, y: 300 } });
  s = boardReducer(s, {
    kind: 'snapshot',
    canvasId: 'cv',
    seq: 9,
    shapes: [shape('s1', 100, 100)],
    connections: [],
    you: { sessionId: 'me', name: '我', role: 'editor', color: '#f00' },
    undoDepth: 0,
    redoDepth: 0,
  });
  assert.equal(s.drag, null);
  assert.deepEqual([s.shapes.get('s1')!.x, s.shapes.get('s1')!.y], [100, 100]);
});

test('viewConnections：拖动时挂接连线即时跟随本地几何重算', () => {
  let s = withSnapshot('editor');
  s = boardReducer(s, {
    kind: 'snapshot',
    canvasId: 'cv',
    seq: 1,
    shapes: [shape('a', 0, 0), shape('b', 300, 0)],
    connections: [
      {
        id: 'l',
        canvasId: 'cv',
        sourceId: 'a',
        targetId: 'b',
        label: '',
        path: [
          { x: 100, y: 50 },
          { x: 300, y: 50 },
        ],
      },
    ],
    you: { sessionId: 'me', name: '我', role: 'editor', color: '#f00' },
    undoDepth: 0,
    redoDepth: 0,
  });
  s = boardReducer(s, { kind: 'drag.start', shapeId: 'a', pointer: { x: 0, y: 0 } });
  s = boardReducer(s, { kind: 'drag.move', pointer: { x: 0, y: 200 } });
  const conns = viewConnections(s);
  const l = conns.find((c) => c.id === 'l')!;
  // a 下移到 (0,200)，中心 (50,250)，对端 b 中心 (350,50)：起点贴合 a 的右/上边界
  assert.ok(l.path[0].y >= 200 && l.path[0].y <= 250, '连线起点跟随移动后的图元');
  assert.ok(l.path[0].x <= 100);
});
