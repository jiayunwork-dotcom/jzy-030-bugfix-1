import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nearestOnRect,
  nearestOnEllipse,
  routeConnection,
  segmentHitsRect,
  pointsToSvgPath,
} from '../src/geometry.js';
import type { Shape } from '../src/types.js';

function shape(id: string, x: number, y: number, w: number, h: number, kind: Shape['kind'] = 'rect'): Shape {
  return { id, canvasId: 'c', kind, x, y, w, h, z: 1, fill: '#fff', text: '' };
}

test('nearestOnRect：外部点贴合最近边，内部点按固定平局次序', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  assert.deepEqual(nearestOnRect(r, { x: 200, y: 50 }), { x: 100, y: 50 });
  assert.deepEqual(nearestOnRect(r, { x: 50, y: -20 }), { x: 50, y: 0 });
  // 中心点到四边等距：固定选上边
  assert.deepEqual(nearestOnRect(r, { x: 50, y: 50 }), { x: 50, y: 0 });
});

test('nearestOnEllipse：方向相交在椭圆边界上', () => {
  const r = { x: 0, y: 0, w: 100, h: 200 }; // 中心 (50,100)，rx=50，ry=100
  const p = nearestOnEllipse(r, { x: 500, y: 100 }); // 正右 → (100,100)
  assert.ok(Math.abs(p.x - 100) < 1e-9);
  assert.ok(Math.abs(p.y - 100) < 1e-9);
  const center = nearestOnEllipse(r, { x: 50, y: 100 });
  assert.ok(Math.abs(center.x - 100) < 1e-9); // 退化到 +rx
});

test('segmentHitsRect：穿过为真，切线/外离为假（精确）', () => {
  const r = { x: 100, y: 100, w: 100, h: 100 };
  assert.equal(segmentHitsRect({ x: 0, y: 150 }, { x: 300, y: 150 }, r), true);
  assert.equal(segmentHitsRect({ x: 0, y: 100 }, { x: 300, y: 100 }, r), false, '贴边切线不算穿过');
  assert.equal(segmentHitsRect({ x: 0, y: 0 }, { x: 50, y: 50 }, r), false);
});

test('routeConnection：水平相邻图元锚点贴合两边中点，直连', () => {
  const shapes = new Map([
    ['a', shape('a', 0, 0, 100, 100)],
    ['b', shape('b', 300, 0, 100, 100)],
  ]);
  const path = routeConnection(shapes, 'a', 'b');
  assert.equal(path.length, 2);
  assert.deepEqual(path[0], { x: 100, y: 50 });
  assert.deepEqual(path[1], { x: 300, y: 50 });
});

test('routeConnection：直线被中间图元挡住时改走正交，且结果确定可复现', () => {
  const shapes = new Map([
    ['a', shape('a', 0, 100, 80, 80)],
    ['b', shape('b', 400, 100, 80, 80)],
    ['mid', shape('mid', 200, 110, 80, 60)],
  ]);
  const p1 = routeConnection(shapes, 'a', 'b');
  const p2 = routeConnection(shapes, 'a', 'b');
  assert.deepEqual(p1, p2, '重复计算逐点一致，无抖动');
  // 不应是穿过 mid 的直线（2 点），应是绕行折线（≥3 点）
  assert.ok(p1.length >= 3);
  for (let i = 0; i < p1.length - 1; i++) {
    assert.equal(
      segmentHitsRect(p1[i], p1[i + 1], { x: 200, y: 110, w: 80, h: 60 }),
      false,
      '绕行路径不得穿过中间图元',
    );
  }
});

test('routeConnection：重叠/贴近等退化情形仍返回确定的两端点', () => {
  const shapes = new Map([
    ['a', shape('a', 0, 0, 100, 100)],
    ['b', shape('b', 50, 50, 100, 100)],
  ]);
  const p1 = routeConnection(shapes, 'a', 'b');
  const p2 = routeConnection(shapes, 'a', 'b');
  assert.ok(p1.length >= 2);
  assert.deepEqual(p1, p2);
});

test('pointsToSvgPath：量化到 0.01 消除浮点抖动', () => {
  const d = pointsToSvgPath([
    { x: 1.0000001, y: 2.0000001 },
    { x: 3.9999999, y: 4.123456 },
  ]);
  assert.equal(d, 'M 1 2 L 4 4.12');
});
