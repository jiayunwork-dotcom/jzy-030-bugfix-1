// 定序合并引擎：纯函数，不做 IO。
// 合并粒度是“图元的单个属性”：同一图元不同属性的并发改动互不覆盖；
// 同一属性按服务端接收顺序定序，晚到者天然基于新基线重放（直接赋值即收敛）。
import {
  FILL_COLORS,
  LIMITS,
  SHAPE_PATCH_KEYS,
  type AnyAction,
  type CanvasState,
  type ClientOp,
  type Role,
  type Shape,
  type ShapeKind,
  type ShapePatch,
} from '@wb/shared';
import { RejectError } from './permissions.js';
import { randomUUID } from 'node:crypto';

export interface UndoGroup {
  groupId: string;
  actorSessionId: string;
  /** 撤销时按“可应用顺序”排列好的逆动作 */
  inverse: AnyAction[];
  /** 新的编辑会让该组的 redo 失效 */
  dead: boolean;
  undone: boolean;
  ts: number;
}

export interface UndoIndex {
  /** 按会话隔离的操作组时间线 */
  bySession: Map<string, UndoGroup[]>;
  /** groupId -> 组（持有逆动作），供历史提交标记 undone/redo 时定位 */
  byGroup: Map<string, UndoGroup>;
}

export interface PlannedUserOp {
  actions: AnyAction[];
  group: UndoGroup | null;
}

export function createUndoIndex(): UndoIndex {
  return { bySession: new Map(), byGroup: new Map() };
}

export function undoStack(index: UndoIndex, sessionId: string): UndoGroup[] {
  let s = index.bySession.get(sessionId);
  if (!s) {
    s = [];
    index.bySession.set(sessionId, s);
  }
  return s;
}

function inRange(v: number): boolean {
  return Number.isFinite(v) && v >= LIMITS.coordMin && v <= LIMITS.coordMax;
}

function sizeOk(v: number): boolean {
  return Number.isFinite(v) && v >= LIMITS.sizeMin && v <= LIMITS.sizeMax;
}

const KINDS: ReadonlySet<ShapeKind> = new Set(['rect', 'ellipse', 'sticky']);

function validateGeometry(patch: ShapePatch): void {
  for (const key of ['x', 'y', 'z'] as const) {
    const v = patch[key];
    if (v !== undefined && !inRange(v)) {
      throw new RejectError(
        'bad_request',
        `坐标越界：${key}=${v}，允许范围 [${LIMITS.coordMin}, ${LIMITS.coordMax}]。`,
      );
    }
  }
  for (const key of ['w', 'h'] as const) {
    const v = patch[key];
    if (v !== undefined && !sizeOk(v)) {
      throw new RejectError(
        'bad_request',
        `尺寸非法：${key}=${v}，允许范围 [${LIMITS.sizeMin}, ${LIMITS.sizeMax}]。`,
      );
    }
  }
}

function validatePatch(patch: ShapePatch, existing: Shape | undefined): ShapePatch {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new RejectError('bad_request', '更新内容为空。');
  for (const key of keys) {
    if (!(SHAPE_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new RejectError('bad_request', `不允许修改属性：${key}。`);
    }
  }
  validateGeometry(patch);
  if (patch.fill !== undefined && !FILL_COLORS.has(patch.fill)) {
    throw new RejectError('bad_request', `颜色不在允许列表中：${patch.fill}。`);
  }
  if (patch.text !== undefined && patch.text.length > LIMITS.textLen) {
    throw new RejectError('bad_request', `便签文本超长（>${LIMITS.textLen} 字）。`);
  }
  if (!existing) throw new RejectError('not_found', '图元不存在，可能已被删除。');
  if (patch.w !== undefined || patch.h !== undefined) {
    const w = patch.w ?? existing.w;
    const h = patch.h ?? existing.h;
    if (!sizeOk(w) || !sizeOk(h)) throw new RejectError('bad_request', '缩放后尺寸非法。');
  }
  return { ...patch };
}

function geometryTouched(patch: ShapePatch): boolean {
  return patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined;
}

/** 依据当前权威状态规划一个用户操作：校验、定序动作、构造逆动作。不修改 state。 */
export function planUserOp(
  state: CanvasState,
  op: ClientOp,
  actorSessionId: string,
  liveRoles: Map<string, Role>,
): PlannedUserOp {
  switch (op.t) {
    case 'shape.add': {
      const d = op.draft;
      if (!d || typeof d.id !== 'string' || d.id.length === 0 || d.id.length > 64) {
        throw new RejectError('bad_request', '图元 id 非法。');
      }
      if (state.shapes.has(d.id)) {
        throw new RejectError('conflict', `图元 id 已存在：${d.id}。`);
      }
      if (!KINDS.has(d.kind)) throw new RejectError('bad_request', `未知图元类型：${d.kind}。`);
      validateGeometry(d);
      if (!sizeOk(d.w) || !sizeOk(d.h)) {
        throw new RejectError('bad_request', '图元尺寸非法。');
      }
      if (d.fill !== undefined && !FILL_COLORS.has(d.fill)) {
        throw new RejectError('bad_request', '颜色不在允许列表中。');
      }
      if ((d.text ?? '').length > LIMITS.textLen) {
        throw new RejectError('bad_request', '便签文本超长。');
      }
      const shape: Shape = {
        id: d.id,
        canvasId: state.canvasId,
        kind: d.kind,
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        z: d.z ?? state.shapes.size + 1,
        fill: d.fill ?? (d.kind === 'sticky' ? '#fef3c7' : '#ffffff'),
        text: d.text ?? '',
      };
      return {
        actions: [{ kind: 'shape.add', shape }],
        group: makeGroup(actorSessionId, [{ kind: 'shape.delete', id: shape.id }]),
      };
    }

    case 'shape.update': {
      const existing = state.shapes.get(op.id);
      const patch = validatePatch(op.patch, existing);
      const oldPatch: ShapePatch = {};
      for (const key of Object.keys(patch) as (keyof ShapePatch)[]) {
        oldPatch[key] = existing![key] as never;
      }
      const actions: AnyAction[] = [{ kind: 'shape.update', id: op.id, patch }];
      const rerouteIds: string[] = [];
      if (geometryTouched(patch)) {
        for (const conn of state.connections.values()) {
          if (conn.sourceId === op.id || conn.targetId === op.id) rerouteIds.push(conn.id);
        }
        rerouteIds.sort();
        for (const id of rerouteIds) actions.push({ kind: 'connection.reroute', id });
      }
      // 逆动作按应用顺序：先还原属性，再重算连线
      const inverse: AnyAction[] = [{ kind: 'shape.update', id: op.id, patch: oldPatch }];
      for (const id of rerouteIds) inverse.push({ kind: 'connection.reroute', id });
      return { actions, group: makeGroup(actorSessionId, inverse) };
    }

    case 'shape.delete': {
      if (!state.shapes.has(op.id)) {
        throw new RejectError('not_found', '图元不存在，可能已被删除。');
      }
      const shape = state.shapes.get(op.id)!;
      const attached = [...state.connections.values()]
        .filter((c) => c.sourceId === op.id || c.targetId === op.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      const actions: AnyAction[] = [];
      for (const c of attached) actions.push({ kind: 'connection.delete', id: c.id });
      actions.push({ kind: 'shape.delete', id: op.id });
      // 逆动作按应用顺序：先恢复图元，再恢复连线（connection.add 需要端点存在）
      const inverse: AnyAction[] = [{ kind: 'shape.add', shape: structuredClone(shape) }];
      for (const c of attached) {
        inverse.push({
          kind: 'connection.add',
          id: c.id,
          sourceId: c.sourceId,
          targetId: c.targetId,
          label: c.label,
        });
      }
      return { actions, group: makeGroup(actorSessionId, inverse) };
    }

    case 'connection.add': {
      if (!op.id) throw new RejectError('bad_request', '连接线 id 非法。');
      if (state.connections.has(op.id)) {
        throw new RejectError('conflict', `连接线 id 已存在：${op.id}。`);
      }
      if (!state.shapes.has(op.sourceId)) {
        throw new RejectError('not_found', `连接线的起点图元不存在：${op.sourceId}。`);
      }
      if (!state.shapes.has(op.targetId)) {
        throw new RejectError('not_found', `连接线的终点图元不存在：${op.targetId}。`);
      }
      if (op.sourceId === op.targetId) {
        throw new RejectError('bad_request', '连接线的两端不能锚在同一个图元上。');
      }
      const label = op.label ?? '';
      if (label.length > LIMITS.labelLen) throw new RejectError('bad_request', '连接线标签超长。');
      return {
        actions: [
          { kind: 'connection.add', id: op.id, sourceId: op.sourceId, targetId: op.targetId, label },
        ],
        group: makeGroup(actorSessionId, [{ kind: 'connection.delete', id: op.id }]),
      };
    }

    case 'connection.delete': {
      const conn = state.connections.get(op.id);
      if (!conn) throw new RejectError('not_found', '连接线不存在，可能已被删除。');
      return {
        actions: [{ kind: 'connection.delete', id: op.id }],
        group: makeGroup(actorSessionId, [
          {
            kind: 'connection.add',
            id: conn.id,
            sourceId: conn.sourceId,
            targetId: conn.targetId,
            label: conn.label,
          },
        ]),
      };
    }

    case 'setRole': {
      const targetRole = liveRoles.get(op.sessionId);
      if (!targetRole) {
        throw new RejectError('not_found', '目标成员不存在或当前不在线。');
      }
      if (targetRole === 'host') {
        throw new RejectError('forbidden', '房主角色不可被降级。');
      }
      if (targetRole === op.role) {
        throw new RejectError(
          'conflict',
          `该成员已经是${op.role === 'viewer' ? '只读' : '可编辑'}角色。`,
        );
      }
      // 角色变更是管理行为，不进入个人撤销栈
      return {
        actions: [{ kind: 'member.role', sessionId: op.sessionId, role: op.role }],
        group: null,
      };
    }

    default:
      throw new RejectError('bad_request', '未知操作类型。');
  }
}

function makeGroup(actorSessionId: string, inverse: AnyAction[]): UndoGroup {
  return {
    groupId: randomUUID(),
    actorSessionId,
    inverse,
    dead: false,
    undone: false,
    ts: Date.now(),
  };
}

/** 取该会话最近一个可撤销组。 */
function popUndoTarget(index: UndoIndex, sessionId: string): UndoGroup | null {
  const stack = index.bySession.get(sessionId);
  if (!stack) return null;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i].undone) return stack[i];
  }
  return null;
}

/** 取该会话当前可重做的组（跳过已被新编辑杀死的组）。 */
export function peekRedoTarget(index: UndoIndex, sessionId: string): UndoGroup | null {
  const stack = index.bySession.get(sessionId);
  if (!stack) return null;
  for (let i = stack.length - 1; i >= 0; i--) {
    const g = stack[i];
    if (!g.undone) return null;
    if (!g.dead) return g;
  }
  return null;
}

/**
 * 提交落地后维护每会话撤销/重做时间线。
 * 注意：新编辑的组对象由 plan 阶段创建并已持有逆动作，这里按 groupId 找回同一对象，
 * 不能另建空壳（否则撤销时逆动作丢失）。
 */
export function applyCommitToIndex(
  index: UndoIndex,
  commit: {
    groupId: string | null;
    undoable: boolean;
    undoOf: string | null;
    redoOf: string | null;
    actorSessionId: string;
  },
  inverseForNewGroup?: AnyAction[],
): void {
  // 只有“新的可撤销编辑”才压栈；undo/redo 提交本身 undoable=false，
  // 只能标记既有组的 undone 状态，绝不能作为新组入栈。
  if (!commit.groupId) return;
  if (commit.undoOf) {
    const g = index.byGroup.get(commit.undoOf);
    if (g) g.undone = true;
    return;
  }
  if (commit.redoOf) {
    const g = index.byGroup.get(commit.redoOf);
    if (g) g.undone = false;
    return;
  }
  if (!commit.undoable) return;
  const stack = undoStack(index, commit.actorSessionId);
  // 新编辑：杀死此前所有可重做分支
  for (const g of stack) if (g.undone) g.dead = true;
  const group: UndoGroup = {
    groupId: commit.groupId,
    actorSessionId: commit.actorSessionId,
    inverse: inverseForNewGroup ?? [],
    dead: false,
    undone: false,
    ts: Date.now(),
  };
  stack.push(group);
  index.byGroup.set(group.groupId, group);
}

export function undoDepth(index: UndoIndex, sessionId: string): number {
  const stack = index.bySession.get(sessionId);
  if (!stack) return 0;
  let n = 0;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i].undone) n++;
    else break;
  }
  return n;
}

export function redoDepth(index: UndoIndex, sessionId: string): number {
  const stack = index.bySession.get(sessionId);
  if (!stack) return 0;
  let n = 0;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].undone && !stack[i].dead) n++;
    else break;
  }
  return n;
}

/** 规划撤销提交：逆动作已按可应用顺序存储，直接使用。 */
export function planUndo(
  index: UndoIndex,
  sessionId: string,
): { group: UndoGroup; actions: AnyAction[] } {
  const group = popUndoTarget(index, sessionId);
  if (!group) throw new RejectError('conflict', '没有可撤销的操作。');
  return { group, actions: structuredClone(group.inverse) };
}

export type { Role };
