// WebSocket 传输：把 ws 连接适配为 Hub 所需的传输无关 Connection
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { ServerMessage } from '@wb/shared';
import { Hub, type Connection } from './hub.js';

export function attachWebSocket(server: Server, hub: Hub): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      send(msg: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.close();
      },
    };
    ws.on('message', (data) => {
      try {
        hub.handleMessage(conn, data.toString());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('handle message failed', err);
      }
    });
    const cleanup = () => hub.handleClose(conn);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return wss;
}
