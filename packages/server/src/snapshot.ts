// 快照与增量：重连时要么拿到全量快照，要么基于 lastSeq 追增量，绝不依赖本地缓存
import type {
  CanvasState,
  Commit,
  Peer,
  Role,
  ServerMessage,
} from '@wb/shared';

export interface YouInfo {
  sessionId: string;
  name: string;
  role: Role;
  color: string;
}

export function buildSnapshot(
  state: CanvasState,
  seq: number,
  you: YouInfo,
  undoDepth: number,
  redoDepth: number,
): ServerMessage & { kind: 'snapshot' } {
  return {
    kind: 'snapshot',
    canvasId: state.canvasId,
    seq,
    shapes: structuredClone([...state.shapes.values()]),
    connections: structuredClone([...state.connections.values()]),
    you,
    undoDepth,
    redoDepth,
  };
}

export function buildDelta(
  seq: number,
  commits: Commit[],
  you: YouInfo,
  undoDepth: number,
  redoDepth: number,
): ServerMessage & { kind: 'delta' } {
  return {
    kind: 'delta',
    seq,
    commits: structuredClone(commits),
    you,
    undoDepth,
    redoDepth,
  };
}

/**
 * 决定重连补发方式：
 * - lastSeq 无值或落后于日志窗口起点 → 全量快照
 * - 否则补发 (lastSeq, currentSeq] 的增量
 */
export function resolveCatchup(
  log: Commit[],
  lastSeq: number | null | undefined,
): { mode: 'snapshot' } | { mode: 'delta'; commits: Commit[] } {
  if (lastSeq === null || lastSeq === undefined) return { mode: 'snapshot' };
  if (!Number.isFinite(lastSeq) || lastSeq < 0) return { mode: 'snapshot' };
  if (log.length === 0) {
    return lastSeq === 0 ? { mode: 'delta', commits: [] } : { mode: 'snapshot' };
  }
  const oldest = log[0].seq;
  if (lastSeq < oldest - 1) return { mode: 'snapshot' };
  if (lastSeq > log[log.length - 1].seq) return { mode: 'snapshot' };
  return { mode: 'delta', commits: log.filter((c) => c.seq > lastSeq) };
}

export function buildPresence(peers: Peer[]): ServerMessage & { kind: 'presence' } {
  return { kind: 'presence', peers: peers.map((p) => ({ ...p, selection: [...p.selection] })) };
}
