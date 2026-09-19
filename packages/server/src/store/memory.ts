// 内存存储：权威状态完全由提交日志重放得到，便于测试与无数据库运行
import {
  applyAction,
  newCanvasState,
  type AnyAction,
  type Commit,
  type Role,
} from '@wb/shared';
import {
  applyCommitToIndex,
  createUndoIndex,
  type UndoIndex,
} from '../engine.js';
import type { MemberRow, RoomData, RoomStore, StoredCommit } from './types.js';

interface RoomRecord {
  data: RoomData;
  undoIndex: UndoIndex;
  /** groupId -> 逆动作 */
  inverses: Map<string, AnyAction[]>;
}

export class MemoryStore implements RoomStore {
  private rooms = new Map<string, RoomRecord>();

  private build(canvasId: string): RoomRecord {
    const data: RoomData = {
      canvasId,
      state: newCanvasState(canvasId),
      log: [],
      seq: 0,
      members: new Map(),
    };
    return { data, undoIndex: createUndoIndex(), inverses: new Map() };
  }

  async loadOrCreate(canvasId: string): Promise<RoomData> {
    let rec = this.rooms.get(canvasId);
    if (!rec) {
      rec = this.build(canvasId);
      this.rooms.set(canvasId, rec);
    }
    return rec.data;
  }

  record(room: RoomData): RoomRecord {
    return this.rooms.get(room.canvasId)!;
  }

  index(room: RoomData): UndoIndex {
    return this.record(room).undoIndex;
  }

  async upsertMember(
    canvasId: string,
    member: Omit<MemberRow, 'createdAt'>,
  ): Promise<MemberRow> {
    const rec = this.rooms.get(canvasId)!;
    const existing = rec.data.members.get(member.sessionId);
    const row: MemberRow = {
      ...member,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    rec.data.members.set(member.sessionId, row);
    rec.data.state.members.set(member.sessionId, {
      sessionId: row.sessionId,
      name: row.name,
      role: row.role,
      color: row.color,
    });
    return row;
  }

  async updateMemberRole(
    room: RoomData,
    sessionId: string,
    role: Role,
    isHost: boolean,
  ): Promise<void> {
    const rec = this.rooms.get(room.canvasId)!;
    const m = rec.data.members.get(sessionId);
    if (m) {
      m.role = role;
      m.isHost = isHost;
    }
    const sm = rec.data.state.members.get(sessionId);
    if (sm) sm.role = role;
  }

  async appendCommit(room: RoomData, stored: StoredCommit): Promise<void> {
    const rec = this.rooms.get(room.canvasId)!;
    rec.data.log.push(stored.commit);
    rec.data.seq = stored.commit.seq;
    for (const action of stored.commit.actions) applyAction(rec.data.state, action);
    if (stored.inverse && stored.commit.groupId) {
      rec.inverses.set(stored.commit.groupId, stored.inverse);
    }
    applyCommitToIndex(rec.undoIndex, stored.commit, stored.inverse);
  }

  async commitsAfter(room: RoomData, afterSeq: number): Promise<Commit[]> {
    const rec = this.rooms.get(room.canvasId)!;
    return rec.data.log.filter((c) => c.seq > afterSeq);
  }

  async findCommit(room: RoomData, groupId: string): Promise<StoredCommit | null> {
    const rec = this.rooms.get(room.canvasId)!;
    const commit = rec.data.log.find((c) => c.groupId === groupId);
    if (!commit) return null;
    return { commit, inverse: rec.inverses.get(groupId) };
  }
}
