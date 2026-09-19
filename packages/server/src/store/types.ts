// 持久化抽象：内存实现（测试/默认）与 PostgreSQL 实现共用同一接口
import type { Commit, Role } from '@wb/shared';
import type { UndoIndex } from '../engine.js';
import { randomUUID } from 'node:crypto';

export interface MemberRow {
  sessionId: string;
  name: string;
  role: Role;
  color: string;
  isHost: boolean;
  createdAt: number;
}

export interface RoomData {
  canvasId: string;
  /** 由日志重放得到的权威内存状态 */
  state: import('@wb/shared').CanvasState;
  /** 定序后的提交日志（内存窗口，PG 为全量） */
  log: Commit[];
  seq: number;
  members: Map<string, MemberRow>;
}

export interface StoredCommit {
  commit: Commit;
  /** 该组逆动作（仅 undoable 领导提交），供撤销与日志重建使用 */
  inverse?: import('@wb/shared').AnyAction[];
}

export interface RoomStore {
  /** 首次加载（不存在则建空白画布）。 */
  loadOrCreate(canvasId: string): Promise<RoomData>;
  /** 注册/更新成员（首次加入为普通成员；host 身份由 hostSessionId 保证唯一）。 */
  upsertMember(
    canvasId: string,
    member: Omit<MemberRow, 'createdAt'>,
  ): Promise<MemberRow>;
  /** 原子地持久化一个已定序提交（状态随日志重放）。 */
  appendCommit(room: RoomData, stored: StoredCommit): Promise<void>;
  /** 原子更新成员角色。 */
  updateMemberRole(
    room: RoomData,
    sessionId: string,
    role: Role,
    isHost: boolean,
  ): Promise<void>;
  /** 读取 (seq > afterSeq) 的提交，用于断线追增量。 */
  commitsAfter(room: RoomData, afterSeq: number): Promise<Commit[]>;
  /** 找历史领导提交（撤销/重做）。 */
  findCommit(room: RoomData, groupId: string): Promise<StoredCommit | null>;
  /** 该房间按会话隔离的撤销/重做索引。 */
  index(room: RoomData): UndoIndex;
}

export function makeMemberId(): string {
  return randomUUID();
}
