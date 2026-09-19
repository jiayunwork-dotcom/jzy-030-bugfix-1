// 协作者状态层：服务端提交应用 + 本地拖动乐观态 + 降级即时回滚。
// 纯函数 reducer，方便自动化测试锁住“降级时进行中拖动立即回弹且无脏位置”。
import {
  applyCommit,
  newCanvasState,
  routeConnection,
  type CanvasState,
  type Commit,
  type Connection,
  type Peer,
  type Pt,
  type Role,
  type Shape,
} from '@wb/shared';

export interface YouInfo {
  sessionId: string;
  name: string;
  role: Role;
  color: string;
}

export interface DragState {
  shapeId: string;
  /** 拖动开始时的指针位置 */
  pointer: Pt;
  /** 拖动开始时的服务端权威几何，回滚就回到这里 */
  origin: { x: number; y: number; w: number; h: number };
}

export interface BoardState {
  canvasId: string;
  seq: number;
  loaded: boolean;
  shapes: Map<string, Shape>;
  connections: Map<string, Connection>;
  peers: Peer[];
  you: YouInfo | null;
  undoDepth: number;
  redoDepth: number;
  drag: DragState | null;
  selection: string[];
  notice: string | null;
}

export type BoardAction =
  | {
      kind: 'snapshot';
      canvasId: string;
      seq: number;
      shapes: Shape[];
      connections: Connection[];
      you: YouInfo;
      undoDepth: number;
      redoDepth: number;
    }
  | { kind: 'delta'; seq: number; commits: Commit[]; you: YouInfo; undoDepth: number; redoDepth: number }
  | { kind: 'commit'; commit: Commit }
  | { kind: 'presence'; peers: Peer[] }
  | { kind: 'stack'; undoDepth: number; redoDepth: number }
  | { kind: 'error'; reason: string }
  | { kind: 'notice-clear' }
  | { kind: 'drag.start'; shapeId: string; pointer: Pt }
  | { kind: 'drag.move'; pointer: Pt }
  | { kind: 'drag.commit' }
  | { kind: 'drag.cancel' }
  | { kind: 'select'; ids: string[] };

export function initialBoardState(canvasId: string): BoardState {
  return {
    canvasId,
    seq: 0,
    loaded: false,
    shapes: new Map(),
    connections: new Map(),
    peers: [],
    you: null,
    undoDepth: 0,
    redoDepth: 0,
    drag: null,
    selection: [],
    notice: null,
  };
}

function applyToState(state: CanvasState, commit: Commit): void {
  applyCommit(state, commit);
}

/** 提交里是否把某会话降级为只读。 */
function roleDowngradedToViewer(commit: Commit, sessionId: string): boolean {
  return commit.actions.some(
    (a) => a.kind === 'member.role' && a.sessionId === sessionId && a.role === 'viewer',
  );
}

/** 应用服务端提交；若自己正被降级且手上有未提交拖动，立即回滚到拖动前权威位置。 */
function applyRemoteCommit(board: BoardState, commit: Commit): boolean {
  const downgraded =
    board.you !== null && roleDowngradedToViewer(commit, board.you.sessionId);
  const draft = newCanvasState(board.canvasId);
  draft.shapes = board.shapes;
  draft.connections = board.connections;
  draft.members = new Map();
  applyToState(draft, commit);
  board.seq = Math.max(board.seq, commit.seq);

  if (downgraded && board.you && board.drag) {
    // 关键：不等松手、不广播半截位置，立刻把图元还原到降级前
    const shape = board.shapes.get(board.drag.shapeId);
    if (shape) Object.assign(shape, board.drag.origin);
    board.drag = null;
  }
  return downgraded;
}

export function boardReducer(prev: BoardState, action: BoardAction): BoardState {
  const board: BoardState = {
    ...prev,
    shapes: new Map(prev.shapes),
    connections: new Map(prev.connections),
  };
  switch (action.kind) {
    case 'snapshot': {
      const state = newCanvasState(action.canvasId);
      for (const s of action.shapes) state.shapes.set(s.id, structuredClone(s));
      for (const c of action.connections) state.connections.set(c.id, structuredClone(c));
      board.shapes = state.shapes;
      board.connections = state.connections;
      board.seq = action.seq;
      board.loaded = true;
      board.you = action.you;
      board.undoDepth = action.undoDepth;
      board.redoDepth = action.redoDepth;
      // 重连拿到权威快照，任何未提交本地态一律作废
      board.drag = null;
      board.notice = null;
      return board;
    }
    case 'delta': {
      const state = newCanvasState(board.canvasId);
      state.shapes = board.shapes;
      state.connections = board.connections;
      state.members = new Map();
      for (const c of action.commits) {
        applyToState(state, c);
        board.seq = Math.max(board.seq, c.seq);
      }
      board.you = action.you;
      board.undoDepth = action.undoDepth;
      board.redoDepth = action.redoDepth;
      board.loaded = true;
      board.drag = null;
      return board;
    }
    case 'commit': {
      const downgraded = applyRemoteCommit(board, action.commit);
      if (downgraded && board.you) {
        board.you = { ...board.you, role: 'viewer' };
        board.notice = '你已被房主切换为只读，进行中的编辑已回滚。';
      }
      return board;
    }
    case 'presence':
      board.peers = action.peers;
      return board;
    case 'stack':
      board.undoDepth = action.undoDepth;
      board.redoDepth = action.redoDepth;
      return board;
    case 'error':
      board.notice = action.reason;
      // 被拒绝的写操作：回到服务端权威状态（本地乐观拖动如有则回滚）
      if (board.drag) {
        const shape = board.shapes.get(board.drag.shapeId);
        if (shape) Object.assign(shape, board.drag.origin);
        board.drag = null;
      }
      return board;
    case 'notice-clear':
      board.notice = null;
      return board;
    case 'drag.start': {
      if (board.you?.role === 'viewer') return board;
      const shape = board.shapes.get(action.shapeId);
      if (!shape) return board;
      board.drag = {
        shapeId: action.shapeId,
        pointer: action.pointer,
        origin: { x: shape.x, y: shape.y, w: shape.w, h: shape.h },
      };
      return board;
    }
    case 'drag.move': {
      if (!board.drag) return board;
      const shape = board.shapes.get(board.drag.shapeId);
      if (!shape) return board;
      shape.x = board.drag.origin.x + (action.pointer.x - board.drag.pointer.x);
      shape.y = board.drag.origin.y + (action.pointer.y - board.drag.pointer.y);
      return board;
    }
    case 'drag.commit':
      board.drag = null;
      return board;
    case 'drag.cancel': {
      if (board.drag) {
        const shape = board.shapes.get(board.drag.shapeId);
        if (shape) Object.assign(shape, board.drag.origin);
      }
      board.drag = null;
      return board;
    }
    case 'select':
      board.selection = action.ids;
      return board;
    default:
      return board;
  }
}

/** 拖动过程中本地渲染用：连线跟随本地几何即时重算（不广播）。 */
export function viewConnections(board: BoardState): Connection[] {
  if (!board.drag) return [...board.connections.values()];
  const out: Connection[] = [];
  for (const conn of board.connections.values()) {
    if (conn.sourceId === board.drag.shapeId || conn.targetId === board.drag.shapeId) {
      out.push({ ...conn, path: routeConnection(board.shapes, conn.sourceId, conn.targetId) });
    } else {
      out.push(conn);
    }
  }
  return out;
}
