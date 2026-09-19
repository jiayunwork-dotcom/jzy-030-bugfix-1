import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type ClientOp,
  type Pt,
  type Shape,
  type ServerMessage,
  type ShapeKind,
} from '@wb/shared';
import { boardReducer, initialBoardState, viewConnections, type BoardState } from '../state/reducer.js';
import { connectClient, type Client } from '../net/client.js';

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export interface BoardApi {
  state: BoardState;
  connected: boolean;
  addShape(kind: ShapeKind): void;
  deleteSelected(): void;
  updateShape(id: string, patch: Partial<Pick<Shape, 'fill' | 'text' | 'z' | 'w' | 'h'>>): void;
  connectSelected(sourceId: string, targetId: string): void;
  deleteConnection(id: string): void;
  setRole(sessionId: string, role: 'editor' | 'viewer'): void;
  undo(): void;
  redo(): void;
  setSelection(ids: string[]): void;
  bindPointer(shape: Shape): {
    onPointerDown(e: React.PointerEvent): void;
    onPointerMove(e: React.PointerEvent): void;
    onPointerUp(e: React.PointerEvent): void;
  };
  sendCursor(p: Pt): void;
}

export function useBoard(canvasId: string, name: string): BoardApi {
  const [state, dispatch] = useReducer(boardReducer, canvasId, initialBoardState);
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<Client | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastSeqRef = useRef<number>(0);
  const sessionRef = useRef<string>(localStorage.getItem('wb.session') ?? '');
  const presenceTimer = useRef<number | null>(null);
  const pendingCursor = useRef<Pt | null>(null);

  if (!sessionRef.current) {
    sessionRef.current = crypto.randomUUID();
    localStorage.setItem('wb.session', sessionRef.current);
  }

  const send = useCallback((msg: Parameters<Client['send']>[0]) => {
    clientRef.current?.send(msg);
  }, []);

  const join = useCallback(() => {
    clientRef.current?.send({
      kind: 'join',
      canvasId,
      name,
      sessionId: sessionRef.current,
      lastSeq: lastSeqRef.current,
    });
  }, [canvasId, name]);

  useEffect(() => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const client = connectClient({
      url,
      onStatus: setConnected,
      onMessage: (raw) => {
        const msg = raw as ServerMessage;
        switch (msg.kind) {
          case 'snapshot':
            lastSeqRef.current = msg.seq;
            dispatch({
              kind: 'snapshot',
              canvasId: msg.canvasId,
              seq: msg.seq,
              shapes: msg.shapes,
              connections: msg.connections,
              you: msg.you,
              undoDepth: msg.undoDepth,
              redoDepth: msg.redoDepth,
            });
            break;
          case 'commit':
            lastSeqRef.current = Math.max(lastSeqRef.current, msg.commit.seq);
            dispatch({ kind: 'commit', commit: msg.commit });
            break;
          case 'delta':
            lastSeqRef.current = msg.seq;
            dispatch({
              kind: 'delta',
              seq: msg.seq,
              commits: msg.commits,
              you: msg.you,
              undoDepth: msg.undoDepth,
              redoDepth: msg.redoDepth,
            });
            break;
          case 'presence':
            dispatch({ kind: 'presence', peers: msg.peers });
            break;
          case 'stack':
            dispatch({ kind: 'stack', undoDepth: msg.undoDepth, redoDepth: msg.redoDepth });
            break;
          case 'error':
          case 'kick':
            dispatch({ kind: 'error', reason: msg.reason });
            break;
        }
      },
    });
    clientRef.current = client;
    join();
    return () => client.close();
  }, [join]);

  // 断线重连成功后自动重新 join（带 lastSeq，由服务端决定发快照还是增量）
  const prevConnected = useRef(false);
  useEffect(() => {
    if (connected && !prevConnected.current) join();
    prevConnected.current = connected;
  }, [connected, join]);

  useEffect(() => {
    if (!state.notice) return;
    const t = window.setTimeout(() => dispatch({ kind: 'notice-clear' }), 4000);
    return () => window.clearTimeout(t);
  }, [state.notice]);

  const flushPresence = useCallback(() => {
    if (presenceTimer.current) return;
    presenceTimer.current = window.setTimeout(() => {
      presenceTimer.current = null;
      send({
        kind: 'presence',
        cursor: pendingCursor.current,
        selection: stateRef.current.selection,
      });
    }, 40);
  }, [send]);

  const sendCursor = useCallback(
    (p: Pt) => {
      pendingCursor.current = p;
      flushPresence();
    },
    [flushPresence],
  );

  const sendOp = useCallback(
    (op: ClientOp) => send({ kind: 'op', clientId: uid('c'), op }),
    [send],
  );

  const addShape = useCallback(
    (kind: ShapeKind) => {
      sendOp({
        t: 'shape.add',
        draft: {
          id: uid('s'),
          kind,
          x: 120 + Math.floor(Math.random() * 240),
          y: 120 + Math.floor(Math.random() * 200),
          w: kind === 'sticky' ? 160 : 140,
          h: kind === 'sticky' ? 120 : 100,
          text: kind === 'sticky' ? '便签' : '',
        },
      });
    },
    [sendOp],
  );

  const updateShape = useCallback<BoardApi['updateShape']>(
    (id, patch) => sendOp({ t: 'shape.update', id, patch }),
    [sendOp],
  );

  const deleteSelected = useCallback(() => {
    for (const id of stateRef.current.selection) sendOp({ t: 'shape.delete', id });
  }, [sendOp]);

  const connectSelected = useCallback(
    (sourceId: string, targetId: string) =>
      sendOp({ t: 'connection.add', id: uid('l'), sourceId, targetId }),
    [sendOp],
  );

  const deleteConnection = useCallback(
    (id: string) => sendOp({ t: 'connection.delete', id }),
    [sendOp],
  );

  const setRole = useCallback(
    (sessionId: string, role: 'editor' | 'viewer') => sendOp({ t: 'setRole', sessionId, role }),
    [sendOp],
  );

  const undo = useCallback(() => send({ kind: 'undo' }), [send]);
  const redo = useCallback(() => send({ kind: 'redo' }), [send]);

  const setSelection = useCallback(
    (ids: string[]) => {
      dispatch({ kind: 'select', ids });
      flushPresence();
    },
    [flushPresence],
  );

  const dragMoved = useRef(false);
  const bindPointer = useCallback(
    (shape: Shape) => ({
      onPointerDown(e: React.PointerEvent) {
        if (stateRef.current.you?.role === 'viewer') return;
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        dragMoved.current = false;
        dispatch({ kind: 'drag.start', shapeId: shape.id, pointer: { x: e.clientX, y: e.clientY } });
        dispatch({ kind: 'select', ids: [shape.id] });
      },
      onPointerMove(e: React.PointerEvent) {
        sendCursor({ x: e.clientX, y: e.clientY });
        if (stateRef.current.drag) {
          dragMoved.current = true;
          dispatch({ kind: 'drag.move', pointer: { x: e.clientX, y: e.clientY } });
        }
      },
      onPointerUp() {
        const drag = stateRef.current.drag;
        if (!drag) return;
        if (!dragMoved.current) {
          dispatch({ kind: 'drag.cancel' });
          return;
        }
        const current = stateRef.current.shapes.get(drag.shapeId);
        if (current) {
          // 只在松手时提交位置；拖动期间绝不广播脏位置
          sendOp({ t: 'shape.update', id: drag.shapeId, patch: { x: current.x, y: current.y } });
        }
        dispatch({ kind: 'drag.commit' });
      },
    }),
    [sendCursor, sendOp],
  );

  return {
    state,
    connected,
    addShape,
    deleteSelected,
    updateShape,
    connectSelected,
    deleteConnection,
    setRole,
    undo,
    redo,
    setSelection,
    bindPointer,
    sendCursor,
  };
}

export { viewConnections };
