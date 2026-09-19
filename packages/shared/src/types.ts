// 画布领域模型与协作协议（前后端共用，单一事实来源）

export type Role = 'host' | 'editor' | 'viewer';
export type ShapeKind = 'rect' | 'ellipse' | 'sticky';

export interface Pt {
  x: number;
  y: number;
}

export interface Shape {
  id: string;
  canvasId: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  fill: string;
  text: string;
}

export interface Connection {
  id: string;
  canvasId: string;
  sourceId: string;
  targetId: string;
  label: string;
  /** 由服务端依据当前图元位置计算出的确定性折线路由 */
  path: Pt[];
}

export type ShapePatch = Partial<
  Pick<Shape, 'x' | 'y' | 'w' | 'h' | 'z' | 'fill' | 'text'>
>;

export const SHAPE_PATCH_KEYS = ['x', 'y', 'w', 'h', 'z', 'fill', 'text'] as const;

/** 服务端定序后的原子动作。同一 commit 内按数组顺序应用。 */
export type AnyAction =
  | { kind: 'shape.add'; shape: Shape }
  | { kind: 'shape.update'; id: string; patch: ShapePatch }
  | { kind: 'shape.delete'; id: string }
  | { kind: 'connection.add';
      id: string;
      sourceId: string;
      targetId: string;
      label: string;
    }
  | { kind: 'connection.delete'; id: string }
  /** 图元几何变化后对受影响连线的确定性重算（派生动作） */
  | { kind: 'connection.reroute'; id: string }
  | { kind: 'member.role'; sessionId: string; role: Role };

/** 一次接收 = 一个定序提交（级联删除、undo/redo 都打包成一个提交） */
export interface Commit {
  seq: number;
  canvasId: string;
  /** 操作者会话；undo/redo 的逆动作内嵌时保留原操作者 */
  actorSessionId: string;
  groupId: string | null;
  undoable: boolean;
  /** 非空表示该提交是对某个历史组的撤销（actions 为逆动作，已按应用顺序排列） */
  undoOf: string | null;
  /** 非空表示该提交是重做 */
  redoOf: string | null;
  actions: AnyAction[];
}

export interface CanvasState {
  canvasId: string;
  shapes: Map<string, Shape>;
  connections: Map<string, Connection>;
  members: Map<string, { sessionId: string; name: string; role: Role; color: string }>;
}

/** 客户端发起的写操作 */
export type ClientOp =
  | { t: 'shape.add'; draft: ShapeDraft }
  | { t: 'shape.update'; id: string; patch: ShapePatch }
  | { t: 'shape.delete'; id: string }
  | {
      t: 'connection.add';
      id: string;
      sourceId: string;
      targetId: string;
      label?: string;
    }
  | { t: 'connection.delete'; id: string }
  | { t: 'setRole'; sessionId: string; role: 'editor' | 'viewer' };

export interface ShapeDraft {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
  fill?: string;
  text?: string;
}

export interface Peer {
  sessionId: string;
  name: string;
  role: Role;
  color: string;
  cursor: Pt | null;
  selection: string[];
}

export type ClientMessage =
  | {
      kind: 'join';
      canvasId: string;
      name: string;
      sessionId?: string | null;
      lastSeq?: number | null;
    }
  | { kind: 'op'; clientId: string; op: ClientOp }
  | { kind: 'presence'; cursor?: Pt | null; selection?: string[] }
  | { kind: 'undo' }
  | { kind: 'redo' };

export type ErrorCode = 'forbidden' | 'not_found' | 'bad_request' | 'conflict';

export type ServerMessage =
  | {
      kind: 'snapshot';
      canvasId: string;
      seq: number;
      shapes: Shape[];
      connections: Connection[];
      you: { sessionId: string; name: string; role: Role; color: string };
      undoDepth: number;
      redoDepth: number;
    }
  | {
      kind: 'delta';
      seq: number;
      commits: Commit[];
      you: { sessionId: string; name: string; role: Role; color: string };
      undoDepth: number;
      redoDepth: number;
    }
  | { kind: 'commit'; commit: Commit }
  | { kind: 'presence'; peers: Peer[] }
  | { kind: 'error'; code: ErrorCode; reason: string; clientId?: string }
  | { kind: 'stack'; undoDepth: number; redoDepth: number }
  | { kind: 'kick'; reason: string };

export function newCanvasState(canvasId: string): CanvasState {
  return {
    canvasId,
    shapes: new Map(),
    connections: new Map(),
    members: new Map(),
  };
}

/** 应用一个已定序提交。客户端与服务端共用，保证同一日志收敛到同一状态。 */
export function applyCommit(state: CanvasState, commit: Commit): void {
  for (const action of commit.actions) {
    applyAction(state, action);
  }
}

export function applyAction(state: CanvasState, action: AnyAction): void {
  switch (action.kind) {
    case 'shape.add':
      // 幂等：历史回放/逆动作恢复时 id 已存在则跳过，绝不重复覆盖
      if (state.shapes.has(action.shape.id)) break;
      state.shapes.set(action.shape.id, structuredClone(action.shape));
      break;
    case 'shape.update': {
      const shape = state.shapes.get(action.id);
      if (shape) Object.assign(shape, action.patch);
      break;
    }
    case 'shape.delete': {
      state.shapes.delete(action.id);
      // 兜底：任何锚到该图元的连线一并移除，绝不留悬空端点
      for (const [cid, conn] of state.connections) {
        if (conn.sourceId === action.id || conn.targetId === action.id) {
          state.connections.delete(cid);
        }
      }
      break;
    }
    case 'connection.add': {
      if (!state.shapes.has(action.sourceId) || !state.shapes.has(action.targetId)) {
        // 重放历史时端点可能已删除：跳过而不是产生悬空连线
        break;
      }
      // 路径在应用时依据当前几何重算，天然确定、无刷新抖动
      const path = routeConnection(state.shapes, action.sourceId, action.targetId);
      state.connections.set(action.id, {
        id: action.id,
        canvasId: state.canvasId,
        sourceId: action.sourceId,
        targetId: action.targetId,
        label: action.label,
        path,
      });
      break;
    }
    case 'connection.delete':
      state.connections.delete(action.id);
      break;
    case 'connection.reroute': {
      const conn = state.connections.get(action.id);
      if (conn && state.shapes.has(conn.sourceId) && state.shapes.has(conn.targetId)) {
        conn.path = routeConnection(state.shapes, conn.sourceId, conn.targetId);
      }
      break;
    }
    case 'member.role': {
      const member = state.members.get(action.sessionId);
      if (member) member.role = action.role;
      break;
    }
  }
}

// 路由依赖放在文件尾部导入也可，这里直接同包引用
import { routeConnection } from './geometry.js';
