// 连接与广播：房间生命周期、加入/重连、定序串行化、在线状态广播
import {
  colorForSession,
  LIMITS,
  type ClientMessage,
  type ClientOp,
  type Commit,
  type Peer,
  type Pt,
  type Role,
  type ServerMessage,
} from '@wb/shared';
import { randomUUID } from 'node:crypto';
import { peekRedoTarget, planUndo, planUserOp, undoDepth, redoDepth } from './engine.js';
import { RejectError, authorize } from './permissions.js';
import { buildDelta, buildPresence, buildSnapshot, resolveCatchup } from './snapshot.js';
import type { RoomData, RoomStore } from './store/types.js';

export interface Connection {
  send(msg: ServerMessage): void;
  close(): void;
}

interface LivePeer {
  sessionId: string;
  name: string;
  role: Role;
  color: string;
  cursor: Pt | null;
  selection: string[];
}

interface Room {
  data: RoomData;
  peers: Map<Connection, LivePeer>;
  /** 串行化所有写操作，保证“按服务端接收顺序定序” */
  tail: Promise<unknown>;
  presenceDirty: boolean;
  presenceTimer: NodeJS.Timeout | null;
}

const CANVAS_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export class Hub {
  private rooms = new Map<string, Room>();
  private evictTimers = new Map<string, NodeJS.Timeout>();
  private static readonly EMPTY_TTL_MS = 10 * 60 * 1000;

  constructor(private store: RoomStore) {}

  /** 房间空了之后延迟回收 Hub 包装层；store 里的权威状态始终保留。 */
  private scheduleEviction(canvasId: string): void {
    const existing = this.evictTimers.get(canvasId);
    if (existing) return;
    const timer = setTimeout(() => {
      this.evictTimers.delete(canvasId);
      const room = this.rooms.get(canvasId);
      if (room && room.peers.size === 0) {
        if (room.presenceTimer) clearTimeout(room.presenceTimer);
        this.rooms.delete(canvasId);
      }
    }, Hub.EMPTY_TTL_MS);
    timer.unref?.();
    this.evictTimers.set(canvasId, timer);
  }

  private cancelEviction(canvasId: string): void {
    const timer = this.evictTimers.get(canvasId);
    if (timer) {
      clearTimeout(timer);
      this.evictTimers.delete(canvasId);
    }
  }

  // ---------- 入口 ----------

  handleMessage(conn: Connection, raw: unknown): void {
    let msg: ClientMessage;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : (raw as ClientMessage);
    } catch {
      return conn.send({ kind: 'error', code: 'bad_request', reason: '消息不是合法 JSON。' });
    }
    if (!msg || typeof msg.kind !== 'string') {
      return conn.send({ kind: 'error', code: 'bad_request', reason: '消息格式非法。' });
    }
    try {
      switch (msg.kind) {
        case 'join':
          this.enqueue(msg.canvasId, (room) =>
            this.handleJoin(room, conn, msg).catch((err) => this.sendRejection(conn, err)),
          );
          break;
        case 'op':
          this.withRoom(conn, (room, peer) =>
            this.handleOp(room, peer, msg.clientId, msg.op),
          );
          break;
        case 'undo':
          this.withRoom(conn, (room, peer) => this.handleUndo(room, peer));
          break;
        case 'redo':
          this.withRoom(conn, (room, peer) => this.handleRedo(room, peer));
          break;
        case 'presence':
          this.handlePresence(conn, msg);
          break;
        default:
          conn.send({ kind: 'error', code: 'bad_request', reason: '未知消息类型。' });
      }
    } catch (err) {
      this.sendRejection(conn, err);
    }
  }

  handleClose(conn: Connection): void {
    for (const [canvasId, room] of this.rooms) {
      if (!room.peers.has(conn)) continue;
      const peer = room.peers.get(conn)!;
      this.enqueue(canvasId, (r) => {
        r.peers.delete(conn);
        const p = peer;
        return (async () => {
          const stillLive = [...r.peers.values()].some((x) => x.sessionId === p.sessionId);
          if (!stillLive) await this.maybeMigrateHost(r, p.sessionId);
          if (r.peers.size === 0) {
            if (r.presenceTimer) clearTimeout(r.presenceTimer);
            r.presenceDirty = false;
            // 保留 store 中的权威状态/日志/撤销索引；仅当房间长时间无人时回收 Hub 包装层
            this.scheduleEviction(canvasId);
          } else {
            this.markPresence(r);
          }
        })();
      });
      return;
    }
  }

  // ---------- 加入 / 重连 ----------

  private async handleJoin(room: Room, conn: Connection, msg: Extract<ClientMessage, { kind: 'join' }>): Promise<void> {
    const canvasId = msg.canvasId;
    if (!canvasId || !CANVAS_RE.test(canvasId)) {
      throw new RejectError('bad_request', `画布 id 非法（1-${LIMITS.canvasIdLen} 位字母数字、-、_）。`);
    }
    const name = (msg.name ?? '').toString().slice(0, LIMITS.nameLen) || '匿名';

    // 已有同名连接：顶掉旧连接
    const old = [...room.peers.entries()].find(([, p]) => p.sessionId === msg.sessionId);
    if (old) {
      room.peers.delete(old[0]);
      old[0].send({ kind: 'kick', reason: '该会话已在其他标签页重新连接。' });
    }

    let sessionId = msg.sessionId && /^[a-zA-Z0-9-]{8,128}$/.test(msg.sessionId) ? msg.sessionId : null;
    let row = sessionId ? room.data.members.get(sessionId) : undefined;
    if (!sessionId || !row) {
      sessionId = randomUUID();
      const hasHost = [...room.data.members.values()].some((m) => m.isHost);
      row = await this.store.upsertMember(canvasId, {
        sessionId,
        name,
        role: hasHost ? 'editor' : 'host',
        color: colorForSession(sessionId),
        isHost: !hasHost,
      });
    } else {
      row = await this.store.upsertMember(canvasId, { ...row, name });
    }
    const peer: LivePeer = {
      sessionId: row.sessionId,
      name: row.name,
      role: row.role,
      color: row.color,
      cursor: null,
      selection: [],
    };
    room.peers.set(conn, peer);

    const index = this.store.index(room.data);
    const you = { sessionId: peer.sessionId, name: peer.name, role: peer.role, color: peer.color };
    const uDepth = undoDepth(index, peer.sessionId);
    const rDepth = redoDepth(index, peer.sessionId);

    const decision = resolveCatchup(room.data.log, msg.lastSeq ?? null);
    if (decision.mode === 'snapshot') {
      conn.send(buildSnapshot(room.data.state, room.data.seq, you, uDepth, rDepth));
    } else {
      // 增量统一封装在 delta 一帧里（含最终 seq 与撤销/重做深度），不另发裸 commit
      conn.send(buildDelta(room.data.seq, decision.commits, you, uDepth, rDepth));
    }
    this.markPresence(room);
  }

  // ---------- 写操作定序 ----------

  private async handleOp(room: Room, peer: LivePeer, clientId: string, op: ClientOp): Promise<void> {
    const liveRoles = this.liveRoles(room);
    const targetRole = op.t === 'setRole' ? liveRoles.get(op.sessionId) : undefined;
    authorize({ sessionId: peer.sessionId, role: peer.role }, op, targetRole);
    const planned = planUserOp(room.data.state, op, peer.sessionId, liveRoles);

    const commit: Commit = {
      seq: room.data.seq + 1,
      canvasId: room.data.canvasId,
      actorSessionId: peer.sessionId,
      groupId: planned.group?.groupId ?? null,
      undoable: planned.group !== null,
      undoOf: null,
      redoOf: null,
      actions: planned.actions,
    };
    await this.store.appendCommit(room.data, {
      commit,
      inverse: planned.group ? planned.group.inverse : undefined,
    });

    // setRole 立即更新在线身份（被降级者通过该提交触发进行中拖动回滚）
    let roleChanged = false;
    for (const action of commit.actions) {
      if (action.kind === 'member.role') {
        roleChanged = true;
        for (const p of room.peers.values()) {
          if (p.sessionId === action.sessionId) p.role = action.role;
        }
      }
    }

    this.broadcast(room, { kind: 'commit', commit });
    if (roleChanged) this.markPresence(room);
    this.sendStack(room, peer.sessionId);
  }

  private async handleUndo(room: Room, peer: LivePeer): Promise<void> {
    if (peer.role === 'viewer') {
      throw new RejectError('forbidden', '只读成员无法撤销编辑。');
    }
    const index = this.store.index(room.data);
    const { group, actions } = planUndo(index, peer.sessionId);
    const commit: Commit = {
      seq: room.data.seq + 1,
      canvasId: room.data.canvasId,
      actorSessionId: peer.sessionId,
      groupId: group.groupId,
      undoable: false,
      undoOf: group.groupId,
      redoOf: null,
      actions,
    };
    await this.store.appendCommit(room.data, { commit });
    this.broadcast(room, { kind: 'commit', commit });
    this.sendStack(room, peer.sessionId);
  }

  private async handleRedo(room: Room, peer: LivePeer): Promise<void> {
    if (peer.role === 'viewer') {
      throw new RejectError('forbidden', '只读成员无法重做编辑。');
    }
    const index = this.store.index(room.data);
    const group = peekRedoTarget(index, peer.sessionId);
    if (!group) throw new RejectError('conflict', '没有可重做的操作。');
    const stored = await this.store.findCommit(room.data, group.groupId);
    if (!stored) throw new RejectError('conflict', '原始操作已超出日志保留窗口，无法重做。');
    const commit: Commit = {
      seq: room.data.seq + 1,
      canvasId: room.data.canvasId,
      actorSessionId: peer.sessionId,
      groupId: group.groupId,
      undoable: false,
      undoOf: null,
      redoOf: group.groupId,
      actions: structuredClone(stored.commit.actions),
    };
    await this.store.appendCommit(room.data, { commit });
    this.broadcast(room, { kind: 'commit', commit });
    this.sendStack(room, peer.sessionId);
  }

  // ---------- 在线状态 ----------

  private handlePresence(conn: Connection, msg: Extract<ClientMessage, { kind: 'presence' }>): void {
    for (const room of this.rooms.values()) {
      const peer = room.peers.get(conn);
      if (!peer) continue;
      if (msg.cursor !== undefined) {
        peer.cursor = msg.cursor === null ? null : { x: msg.cursor.x, y: msg.cursor.y };
      }
      if (Array.isArray(msg.selection)) peer.selection = msg.selection.slice(0, 50);
      this.markPresence(room);
      return;
    }
  }

  private markPresence(room: Room): void {
    room.presenceDirty = true;
    if (room.presenceTimer) return;
    room.presenceTimer = setTimeout(() => {
      room.presenceTimer = null;
      if (!room.presenceDirty) return;
      room.presenceDirty = false;
      const peers: Peer[] = [...room.peers.values()].map((p) => ({
        sessionId: p.sessionId,
        name: p.name,
        role: p.role,
        color: p.color,
        cursor: p.cursor,
        selection: p.selection,
      }));
      this.broadcast(room, buildPresence(peers));
    }, 50);
    // presence 是尽力而为的，不应阻止进程退出/测试结束
    room.presenceTimer.unref?.();
  }

  // ---------- 房主迁移 ----------

  private async maybeMigrateHost(room: Room, leavingSessionId: string): Promise<void> {
    const leaving = room.data.members.get(leavingSessionId);
    if (!leaving || !leaving.isHost) return;
    // 还有其他在线者：选最早加入的成员接任房主
    const liveSessions = new Set([...room.peers.values()].map((p) => p.sessionId));
    const candidates = [...room.data.members.values()]
      .filter((m) => liveSessions.has(m.sessionId))
      .sort((a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId));
    const next = candidates[0];
    if (!next) return; // 房间清空：保留房主身份以便其重连恢复
    const actions: Commit['actions'] = [
      { kind: 'member.role', sessionId: leavingSessionId, role: 'viewer' },
      { kind: 'member.role', sessionId: next.sessionId, role: 'host' },
    ];
    const commit: Commit = {
      seq: room.data.seq + 1,
      canvasId: room.data.canvasId,
      actorSessionId: 'system',
      groupId: null,
      undoable: false,
      undoOf: null,
      redoOf: null,
      actions,
    };
    await this.store.updateMemberRole(room.data, leavingSessionId, 'viewer', false);
    await this.store.updateMemberRole(room.data, next.sessionId, 'host', true);
    await this.store.appendCommit(room.data, { commit });
    for (const p of room.peers.values()) {
      if (p.sessionId === next.sessionId) p.role = 'host';
    }
    this.broadcast(room, { kind: 'commit', commit });
  }

  // ---------- 工具 ----------

  private liveRoles(room: Room): Map<string, Role> {
    const m = new Map<string, Role>();
    for (const p of room.peers.values()) m.set(p.sessionId, p.role);
    return m;
  }

  private sendStack(room: Room, sessionId: string): void {
    const index = this.store.index(room.data);
    for (const [conn, peer] of room.peers) {
      if (peer.sessionId === sessionId) {
        conn.send({ kind: 'stack', undoDepth: undoDepth(index, sessionId), redoDepth: redoDepth(index, sessionId) });
      }
    }
  }

  private broadcast(room: Room, msg: ServerMessage): void {
    for (const conn of room.peers.keys()) conn.send(msg);
  }

  private async getRoom(canvasId: string): Promise<Room> {
    let room = this.rooms.get(canvasId);
    if (!room) {
      const data = await this.store.loadOrCreate(canvasId);
      room = { data, peers: new Map(), tail: Promise.resolve(), presenceDirty: false, presenceTimer: null };
      this.rooms.set(canvasId, room);
    }
    this.cancelEviction(canvasId);
    return room;
  }

  private enqueue(canvasId: string, task: (room: Room) => Promise<void>): void {
    if (!canvasId || !CANVAS_RE.test(canvasId)) return;
    void this.getRoom(canvasId).then((room) => {
      room.tail = room.tail.then(() =>
        task(room).catch((err) => {
          // join 阶段的错误无法关联连接（理论上调用方已持有 conn，由各自处理）
          // eslint-disable-next-line no-console
          console.error('room task failed:', err);
        }),
      );
    });
  }

  private withRoom(
    conn: Connection,
    fn: (room: Room, peer: LivePeer) => Promise<void>,
  ): void {
    for (const room of this.rooms.values()) {
      const peer = room.peers.get(conn);
      if (peer) {
        room.tail = room.tail.then(() => fn(room, peer!).catch((err) => this.sendRejection(conn, err)));
        return;
      }
    }
    conn.send({ kind: 'error', code: 'forbidden', reason: '尚未加入画布，请先发送 join。' });
  }

  private sendRejection(conn: Connection, err: unknown): void {
    if (err instanceof RejectError) {
      conn.send({ kind: 'error', code: err.code, reason: err.message });
    } else {
      conn.send({ kind: 'error', code: 'bad_request', reason: '服务器内部错误。' });
      // eslint-disable-next-line no-console
      console.error(err);
    }
  }
}
