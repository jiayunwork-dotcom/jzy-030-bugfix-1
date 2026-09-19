// 连接线几何：锚点贴合 + 确定性正交走向 + 不穿过图元本体
import type { Connection, Pt, Shape } from './types.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rectOf = (s: Shape): Rect => ({ x: s.x, y: s.y, w: s.w, h: s.h });

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function centerOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * 矩形边界上离 p 最近的点。p 在内部时按与四条边的距离选最近边界，
 * 平局按 上→右→下→左 的固定次序打破，保证可复现。
 */
export function nearestOnRect(r: Rect, p: Pt): Pt {
  const left = r.x;
  const right = r.x + r.w;
  const top = r.y;
  const bottom = r.y + r.h;
  if (p.x < left) return { x: left, y: clamp(p.y, top, bottom) };
  if (p.x > right) return { x: right, y: clamp(p.y, top, bottom) };
  if (p.y < top) return { x: clamp(p.x, left, right), y: top };
  if (p.y > bottom) return { x: clamp(p.x, left, right), y: bottom };
  const dTop = p.y - top;
  const dRight = right - p.x;
  const dBottom = bottom - p.y;
  const dLeft = p.x - left;
  const best = Math.min(dTop, dRight, dBottom, dLeft);
  if (best === dTop) return { x: p.x, y: top };
  if (best === dRight) return { x: right, y: p.y };
  if (best === dBottom) return { x: p.x, y: bottom };
  return { x: left, y: p.y };
}

/** 椭圆边界上沿 p 方向的交点；退化为点时返回圆心。 */
export function nearestOnEllipse(r: Rect, p: Pt): Pt {
  const c = centerOf(r);
  const rx = r.w / 2;
  const ry = r.h / 2;
  if (rx <= 0 || ry <= 0) return c;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (dx === 0 && dy === 0) return { x: c.x + rx, y: c.y };
  const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export function nearestOnShape(s: Shape, p: Pt): Pt {
  return s.kind === 'ellipse' ? nearestOnEllipse(rectOf(s), p) : nearestOnRect(rectOf(s), p);
}

/**
 * 线段 a-b 是否穿入矩形 r 内部（严格内点，不含边界）。
 * Liang–Barsky 裁剪；与边界共线（贴边）或仅角点接触不算穿过。
 */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect, pad = 0): boolean {
  const minX = r.x - pad;
  const minY = r.y - pad;
  const maxX = r.x + r.w + pad;
  const maxY = r.y + r.h + pad;

  const onVEdge =
    a.x === b.x &&
    (a.x === minX || a.x === maxX) &&
    Math.max(a.y, b.y) > minY &&
    Math.min(a.y, b.y) < maxY;
  const onHEdge =
    a.y === b.y &&
    (a.y === minY || a.y === maxY) &&
    Math.max(a.x, b.x) > minX &&
    Math.min(a.x, b.x) < maxX;
  if (onVEdge || onHEdge) return false;

  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (
    !clip(-dx, a.x - minX) ||
    !clip(dx, maxX - a.x) ||
    !clip(-dy, a.y - minY) ||
    !clip(dy, maxY - a.y)
  ) {
    return false;
  }
  return t1 - t0 > 1e-9;
}

/** 折线段是否穿过任一障碍（用外接矩形近似椭圆障碍，保守避让）。 */
function pathHits(path: Pt[], obstacles: Rect[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    for (const r of obstacles) {
      if (segmentHitsRect(path[i], path[i + 1], r)) return true;
    }
  }
  return false;
}

function pathBox(path: Pt[]): number {
  const xs = path.map((p) => p.x);
  const ys = path.map((p) => p.y);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}

const GAP = 24;

/**
 * 确定性连接线路由：
 * 1) 端点贴合到各自边界上离对端最近的锚点；
 * 2) 直连不穿障则用直线；
 * 3) 否则在障碍整体的左/右（竖直通道）与上/下（水平通道）四个外侧通道中，
 *    选一个不穿障且包围盒最小的，平局按 左→右→上→下 固定次序。
 * 障碍按 id 排序，仅几何参与计算 → 任意刷新结果一致、不抖动。
 */
export function routeConnection(
  shapes: Map<string, Shape>,
  sourceId: string,
  targetId: string,
): Pt[] {
  const a = shapes.get(sourceId);
  const b = shapes.get(targetId);
  if (!a || !b) return [];
  const p0 = nearestOnShape(a, centerOf(rectOf(b)));
  const p1 = nearestOnShape(b, centerOf(rectOf(a)));
  const direct = [p0, p1];

  const obstacles: Rect[] = [...shapes.values()]
    .filter((s) => s.id !== sourceId && s.id !== targetId)
    .sort((x, y) => x.id.localeCompare(y.id))
    .map(rectOf);

  if (!pathHits(direct, obstacles)) return quantize(direct);

  // 与直连线段相关（跨越段包围盒相交）的障碍整体外边界
  const loX = Math.min(p0.x, p1.x);
  const hiX = Math.max(p0.x, p1.x);
  const loY = Math.min(p0.y, p1.y);
  const hiY = Math.max(p0.y, p1.y);
  let boundL = Infinity;
  let boundR = -Infinity;
  let boundT = Infinity;
  let boundB = -Infinity;
  for (const r of obstacles) {
    const overlapX = r.x < hiX && r.x + r.w > loX;
    const overlapY = r.y < hiY && r.y + r.h > loY;
    if (overlapX && overlapY) {
      boundL = Math.min(boundL, r.x - GAP);
      boundR = Math.max(boundR, r.x + r.w + GAP);
      boundT = Math.min(boundT, r.y - GAP);
      boundB = Math.max(boundB, r.y + r.h + GAP);
    }
  }

  // 候选顺序即平局打破顺序：左、右、上、下
  const candidates: Array<{ name: string; path: Pt[] }> = [];
  if (Number.isFinite(boundL)) {
    candidates.push({ name: 'left', path: verticalChannel(p0, p1, boundL) });
    candidates.push({ name: 'right', path: verticalChannel(p0, p1, boundR) });
    candidates.push({ name: 'top', path: horizontalChannel(p0, p1, boundT) });
    candidates.push({ name: 'bottom', path: horizontalChannel(p0, p1, boundB) });
  }

  let best: Pt[] | null = null;
  let bestBox = Infinity;
  for (const c of candidates) {
    if (pathHits(c.path, obstacles)) continue;
    const box = pathBox(c.path);
    if (box < bestBox) {
      bestBox = box;
      best = c.path;
    }
  }
  // 理论上外通道必然绕过；极端退化兜底为直线
  return quantize(best ?? direct);
}

/** 竖直通道：p0 水平到 channelX，竖直跨越，再水平到 p1。 */
function verticalChannel(p0: Pt, p1: Pt, channelX: number): Pt[] {
  return simplify([
    p0,
    { x: channelX, y: p0.y },
    { x: channelX, y: p1.y },
    p1,
  ]);
}

/** 水平通道：p0 竖直到 channelY，水平跨越，再竖直到 p1。 */
function horizontalChannel(p0: Pt, p1: Pt, channelY: number): Pt[] {
  return simplify([
    p0,
    { x: p0.x, y: channelY },
    { x: p1.x, y: channelY },
    p1,
  ]);
}

/** 去除共线/重合的冗余点。 */
function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (prev && last) {
      const collinear =
        (prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y);
      if (collinear) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** 所有几何值统一量化到 0.01，消除浮点重算抖动。 */
export function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function quantize(points: Pt[]): Pt[] {
  return points.map((p) => ({ x: round(p.x), y: round(p.y) }));
}

/** 图元集合变化后重算受影响连线（移动/缩放后调用）。 */
export function rerouteAffected(
  shapes: Map<string, Shape>,
  connections: Connection[],
  changedIds: Set<string>,
): Map<string, Pt[]> {
  const result = new Map<string, Pt[]>();
  for (const conn of connections) {
    if (changedIds.has(conn.sourceId) || changedIds.has(conn.targetId)) {
      result.set(conn.id, routeConnection(shapes, conn.sourceId, conn.targetId));
    }
  }
  return result;
}

export function pointsToSvgPath(points: Pt[]): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`)
    .join(' ');
}
