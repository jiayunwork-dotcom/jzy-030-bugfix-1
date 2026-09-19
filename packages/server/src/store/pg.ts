// PostgreSQL 16 持久化：op_log 为唯一真源，shapes/connections 为物化状态，
// 房间加载时回放日志重建内存状态与撤销索引，重启后画布与协作状态可恢复。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  applyAction,
  newCanvasState,
  type AnyAction,
  type Commit,
  type Role,
  type Shape,
} from '@wb/shared';
import { applyCommitToIndex, createUndoIndex, type UndoIndex } from '../engine.js';
import type { MemberRow, RoomData, RoomStore, StoredCommit } from './types.js';

interface CacheEntry {
  data: RoomData;
  undoIndex: UndoIndex;
  inverses: Map<string, AnyAction[]>;
}

export class PgStore implements RoomStore {
  private cache = new Map<string, CacheEntry>();

  constructor(private pool: pg.Pool) {}

  static async create(databaseUrl: string): Promise<PgStore> {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    const store = new PgStore(pool);
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  index(room: RoomData): UndoIndex {
    return this.cache.get(room.canvasId)!.undoIndex;
  }

  async loadOrCreate(canvasId: string): Promise<RoomData> {
    const existing = this.cache.get(canvasId);
    if (existing) return existing.data;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query('SELECT id FROM canvases WHERE id = $1', [canvasId]);
      if (res.rowCount === 0) {
        await client.query('INSERT INTO canvases (id, created_at) VALUES ($1, $2)', [
          canvasId,
          Date.now(),
        ]);
      }
      const state = newCanvasState(canvasId);
      const members = new Map<string, MemberRow>();
      const hostRes = await client.query('SELECT host_session_id FROM canvases WHERE id = $1', [canvasId]);
      const hostId: string | null = hostRes.rows[0]?.host_session_id ?? null;
      const memberRes = await client.query(
        `SELECT session_id, name, role, color, created_at FROM members
         WHERE canvas_id = $1 ORDER BY created_at ASC`,
        [canvasId],
      );
      for (const r of memberRes.rows) {
        const role = r.role as Role;
        const row: MemberRow = {
          sessionId: r.session_id,
          name: r.name,
          role,
          color: r.color,
          isHost: r.session_id === hostId,
          createdAt: Number(r.created_at),
        };
        members.set(r.session_id, row);
        state.members.set(r.session_id, {
          sessionId: r.session_id,
          name: r.name,
          role,
          color: r.color,
        });
      }
      // 权威状态完全由 op_log 重放得到；shapes/connections 仅为外部可查的物化视图。
      const undoIndex = createUndoIndex();
      const logRes = await client.query(
        `SELECT seq, group_id, actor, undoable, undo_of, redo_of, actions, inverse
         FROM op_log WHERE canvas_id = $1 ORDER BY seq ASC`,
        [canvasId],
      );
      const log: Commit[] = [];
      const inverses = new Map<string, AnyAction[]>();
      let seq = 0;
      for (const r of logRes.rows) {
        const commit: Commit = {
          seq: Number(r.seq),
          canvasId,
          actorSessionId: r.actor,
          groupId: r.group_id,
          undoable: r.undoable,
          undoOf: r.undo_of,
          redoOf: r.redo_of,
          actions: r.actions as AnyAction[],
        };
        seq = commit.seq;
        log.push(commit);
        for (const a of commit.actions) applyAction(state, a);
        applyCommitToIndex(undoIndex, commit);
        if (r.inverse) inverses.set(commit.groupId!, r.inverse as AnyAction[]);
      }

      // 回放过程已通过 applyAction 重算连线路径（connection.add / reroute），
      // state.connections 即权威连线集合，无需再读物化表。

      await client.query('COMMIT');
      const data: RoomData = { canvasId, state, log, seq, members };
      this.cache.set(canvasId, { data, undoIndex, inverses });
      return data;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertMember(
    canvasId: string,
    member: Omit<MemberRow, 'createdAt'>,
  ): Promise<MemberRow> {
    const createdAt = Date.now();
    await this.pool.query(
      `INSERT INTO members (canvas_id, session_id, name, role, color, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (canvas_id, session_id)
       DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, color = EXCLUDED.color`,
      [canvasId, member.sessionId, member.name, member.role, member.color, createdAt],
    );
    const rec = this.cache.get(canvasId);
    const row: MemberRow = { ...member, createdAt };
    if (rec) {
      rec.data.members.set(member.sessionId, row);
      rec.data.state.members.set(member.sessionId, {
        sessionId: member.sessionId,
        name: member.name,
        role: member.role,
        color: member.color,
      });
    }
    return row;
  }

  async appendCommit(room: RoomData, stored: StoredCommit): Promise<void> {
    const c = stored.commit;
    await this.pool.query(
      `INSERT INTO op_log
         (canvas_id, seq, group_id, actor, undoable, undo_of, redo_of, actions, inverse, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        c.canvasId,
        c.seq,
        c.groupId,
        c.actorSessionId,
        c.undoable,
        c.undoOf,
        c.redoOf,
        JSON.stringify(c.actions),
        stored.inverse ? JSON.stringify(stored.inverse) : null,
        Date.now(),
      ],
    );
    for (const action of c.actions) {
      await this.materialize(room, action, c.seq);
    }
    const entry = this.cache.get(room.canvasId)!;
    entry.data.log.push(c);
    entry.data.seq = c.seq;
    for (const action of c.actions) applyAction(entry.data.state, action);
    if (stored.inverse && c.groupId) entry.inverses.set(c.groupId, stored.inverse);
    applyCommitToIndex(entry.undoIndex, c, stored.inverse);
  }

  private async materialize(room: RoomData, action: AnyAction, seq: number): Promise<void> {
    const id = room.canvasId;
    switch (action.kind) {
      case 'shape.add':
        await this.pool.query(
          `INSERT INTO shapes (id, canvas_id, kind, x, y, w, h, z, fill, text, updated_seq)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (canvas_id, id) DO UPDATE SET
             kind=EXCLUDED.kind,x=EXCLUDED.x,y=EXCLUDED.y,w=EXCLUDED.w,h=EXCLUDED.h,
             z=EXCLUDED.z,fill=EXCLUDED.fill,text=EXCLUDED.text,deleted=FALSE,updated_seq=EXCLUDED.updated_seq`,
          [action.shape.id, id, action.shape.kind, action.shape.x, action.shape.y,
           action.shape.w, action.shape.h, action.shape.z, action.shape.fill, action.shape.text, seq],
        );
        break;
      case 'shape.update':
        for (const [key, value] of Object.entries(action.patch)) {
          const col = key === 'z' ? 'z' : key;
          await this.pool.query(
            `UPDATE shapes SET ${col} = $1, updated_seq = $2 WHERE canvas_id = $3 AND id = $4`,
            [value, seq, id, action.id],
          );
        }
        break;
      case 'shape.delete':
        await this.pool.query(
          'UPDATE shapes SET deleted = TRUE, updated_seq = $1 WHERE canvas_id = $2 AND id = $3',
          [seq, id, action.id],
        );
        await this.pool.query(
          `UPDATE connections SET deleted = TRUE, updated_seq = $1
           WHERE canvas_id = $2 AND (source_id = $3 OR target_id = $3)`,
          [seq, id, action.id],
        );
        break;
      case 'connection.add':
        await this.pool.query(
          `INSERT INTO connections (id, canvas_id, source_id, target_id, label, updated_seq)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (canvas_id, id) DO UPDATE SET
             source_id=EXCLUDED.source_id,target_id=EXCLUDED.target_id,
             label=EXCLUDED.label,deleted=FALSE,updated_seq=EXCLUDED.updated_seq`,
          [action.id, id, action.sourceId, action.targetId, action.label, seq],
        );
        break;
      case 'connection.delete':
        await this.pool.query(
          'UPDATE connections SET deleted = TRUE, updated_seq = $1 WHERE canvas_id = $2 AND id = $3',
          [seq, id, action.id],
        );
        break;
      case 'connection.reroute':
      case 'member.role':
        break;
    }
  }

  async updateMemberRole(
    room: RoomData,
    sessionId: string,
    role: Role,
    isHost: boolean,
  ): Promise<void> {
    await this.pool.query(
      'UPDATE members SET role = $1 WHERE canvas_id = $2 AND session_id = $3',
      [role, room.canvasId, sessionId],
    );
    if (isHost) {
      await this.pool.query('UPDATE canvases SET host_session_id = $1 WHERE id = $2', [
        sessionId,
        room.canvasId,
      ]);
    }
    const m = this.cache.get(room.canvasId)?.data.members.get(sessionId);
    if (m) m.role = role;
    const sm = this.cache.get(room.canvasId)?.data.state.members.get(sessionId);
    if (sm) sm.role = role;
  }

  async commitsAfter(room: RoomData, _afterSeq: number): Promise<Commit[]> {
    const res = await this.pool.query(
      `SELECT seq, group_id, actor, undoable, undo_of, redo_of, actions
       FROM op_log WHERE canvas_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [room.canvasId, _afterSeq],
    );
    return res.rows.map((r) => ({
      seq: Number(r.seq),
      canvasId: room.canvasId,
      actorSessionId: r.actor,
      groupId: r.group_id,
      undoable: r.undoable,
      undoOf: r.undo_of,
      redoOf: r.redo_of,
      actions: r.actions as AnyAction[],
    }));
  }

  async findCommit(room: RoomData, groupId: string): Promise<StoredCommit | null> {
    const res = await this.pool.query(
      'SELECT seq, group_id, actor, undoable, undo_of, redo_of, actions, inverse FROM op_log WHERE canvas_id = $1 AND group_id = $2 ORDER BY seq ASC LIMIT 1',
      [room.canvasId, groupId],
    );
    if (res.rowCount === 0) return null;
    const r = res.rows[0];
    return {
      commit: {
        seq: Number(r.seq),
        canvasId: room.canvasId,
        actorSessionId: r.actor,
        groupId: r.group_id,
        undoable: r.undoable,
        undoOf: r.undo_of,
        redoOf: r.redo_of,
        actions: r.actions as AnyAction[],
      },
      inverse: (r.inverse as AnyAction[]) ?? undefined,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
