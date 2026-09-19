// 测试工具：不经过真实网络，直接把 Hub 与内存连接对接，驱动协作场景
import type { ClientMessage, ServerMessage } from '@wb/shared';
import { Hub, type Connection } from '../src/hub.js';

export class FakeConn implements Connection {
  messages: ServerMessage[] = [];
  private waiters: Array<(m: ServerMessage) => void> = [];
  closed = false;
  closeReason: string | null = null;

  constructor(public hub: Hub) {}

  send(msg: ServerMessage): void {
    if (msg.kind === 'kick') {
      this.closed = true;
      this.closeReason = msg.reason;
    }
    this.messages.push(msg);
    const w = this.waiters.shift();
    if (w) w(msg);
  }

  close(): void {
    this.closed = true;
  }

  sendRaw(msg: ClientMessage): void {
    if (this.closed) throw new Error('connection closed');
    this.hub.handleMessage(this, msg as never);
  }

  /** 等到满足谓词的消息出现（或已存在） */
  async waitFor(
    pred: (m: ServerMessage) => boolean,
    timeout = 1000,
  ): Promise<ServerMessage> {
    const found = this.messages.find(pred);
    if (found) return found;
    return await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timeout')), timeout);
      const check = (m: ServerMessage): void => {
        if (pred(m)) {
          clearTimeout(timer);
          resolve(m);
          return;
        }
        this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  /** 排空当前已收到的消息 */
  drain(): ServerMessage[] {
    const out = this.messages;
    this.messages = [];
    return out;
  }

  commits(): import('@wb/shared').Commit[] {
    return this.drain()
      .filter((m): m is Extract<ServerMessage, { kind: 'commit' }> => m.kind === 'commit')
      .map((m) => m.commit);
  }
}

export function newPair(hub: Hub): [FakeConn, FakeConn] {
  return [new FakeConn(hub), new FakeConn(hub)];
}

/** 微任务/定时器排干（让 Hub 的定序 Promise 链跑完） */
export async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function joinAs(
  conn: FakeConn,
  canvasId: string,
  name: string,
  sessionId?: string,
  lastSeq?: number,
): Promise<void> {
  conn.sendRaw({ kind: 'join', canvasId, name, sessionId, lastSeq });
  await flush();
}

export async function op(
  conn: FakeConn,
  opBody: import('@wb/shared').ClientOp,
): Promise<void> {
  conn.sendRaw({ kind: 'op', clientId: `c${Math.random()}`, op: opBody });
  await flush();
}
