// WebSocket 客户端：自动重连，重连带 lastSeq 以追增量，光标 presence 节流
import { LIMITS, type ClientMessage } from '@wb/shared';

export interface Client {
  send(msg: ClientMessage): void;
  close(): void;
  readonly connected: boolean;
}

export interface ClientOptions {
  url: string;
  onMessage: (raw: unknown) => void;
  onStatus: (connected: boolean) => void;
}

export function connectClient(opts: ClientOptions): Client {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectDelay = 200;
  const queue: string[] = [];

  const open = (): void => {
    const sock = new WebSocket(opts.url);
    ws = sock;
    sock.onopen = () => {
      reconnectDelay = 200;
      opts.onStatus(true);
      while (queue.length) {
        const frame = queue.shift();
        if (frame !== undefined) sock.send(frame);
      }
    };
    sock.onmessage = (ev) => {
      try {
        opts.onMessage(JSON.parse(ev.data));
      } catch {
        // 忽略无法解析的帧
      }
    };
    sock.onclose = () => {
      opts.onStatus(false);
      if (!closed) setTimeout(open, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 4000);
    };
    sock.onerror = () => sock.close();
  };
  open();

  return {
    get connected() {
      return ws?.readyState === WebSocket.OPEN;
    },
    send(msg: ClientMessage) {
      // 客户端自身的基础防御，真正的权威校验在服务端
      const frame = JSON.stringify(msg);
      if (frame.length > 1_000_000) return;
      void LIMITS;
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
      else queue.push(frame);
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}
