import { useEffect, useMemo, useRef, useState } from 'react';
import {
  pointsToSvgPath,
  type Shape,
  type Connection,
  type Peer,
  type Pt,
  type Role,
  FILL_COLORS,
} from '@wb/shared';
import type { BoardApi } from '../hooks/useBoard.js';
import { viewConnections } from '../state/reducer.js';

export function Board({ board }: { board: BoardApi }): JSX.Element {
  const { state } = board;
  const [connectMode, setConnectMode] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const ordered = useMemo(
    () => [...state.shapes.values()].sort((a, b) => a.z - b.z),
    [state.shapes],
  );
  const connections = viewConnections(state);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        board.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        board.redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        board.deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [board]);

  const svgPoint = (clientX: number, clientY: number): Pt => ({ x: clientX, y: clientY });

  return (
    <div className="board-shell">
      <Toolbar board={board} onConnect={() => setConnectMode(state.selection[0] ?? null)} />
      <svg
        ref={svgRef}
        className="canvas"
        onPointerMove={(e) => board.sendCursor(svgPoint(e.clientX, e.clientY))}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            board.setSelection([]);
            setConnectMode(null);
          }
        }}
      >
        <g className="connections">
          {connections.map((c) => (
            <ConnectionView key={c.id} conn={c} board={board} />
          ))}
        </g>
        <g className="shapes">
          {ordered.map((shape) => (
            <ShapeView
              key={shape.id}
              shape={shape}
              board={board}
              connectMode={connectMode}
              onConnectTarget={(targetId) => {
                if (connectMode && connectMode !== targetId) {
                  board.connectSelected(connectMode, targetId);
                }
                setConnectMode(null);
              }}
            />
          ))}
        </g>
        <g className="presence">
          {state.peers
            .filter((p) => p.sessionId !== state.you?.sessionId)
            .map((peer) => (
              <PresenceView key={peer.sessionId} peer={peer} shapes={state.shapes} />
            ))}
        </g>
      </svg>
      <MembersPanel board={board} />
      {state.notice && <div className="notice">{state.notice}</div>}
      <div className="status">
        {board.connected ? '已连接' : '连接中…'} · 画布 {state.canvasId} · 你是
        {roleText(state.you?.role)}
        {connectMode && <span className="hint"> · 点击另一个图元完成连线，或点空白取消</span>}
      </div>
    </div>
  );
}

function roleText(role?: Role): string {
  if (role === 'host') return '房主';
  if (role === 'editor') return '可编辑';
  return '只读';
}

function Toolbar({ board, onConnect }: { board: BoardApi; onConnect: () => void }): JSX.Element {
  const readonly = board.state.you?.role === 'viewer';
  const selected = board.state.selection[0];
  const shape = selected ? board.state.shapes.get(selected) : undefined;
  return (
    <div className="toolbar">
      <button disabled={readonly} onClick={() => board.addShape('rect')}>矩形</button>
      <button disabled={readonly} onClick={() => board.addShape('ellipse')}>圆形</button>
      <button disabled={readonly} onClick={() => board.addShape('sticky')}>便签</button>
      <span className="sep" />
      <button
        disabled={readonly || !selected}
        onClick={onConnect}
        title="选中一个图元后点击，再点目标图元"
      >
        连线
      </button>
      <button disabled={readonly || !selected} onClick={() => board.deleteSelected()}>
        删除
      </button>
      <span className="sep" />
      <button
        disabled={readonly || !shape}
        title="上移一层"
        onClick={() => shape && board.updateShape(shape.id, { z: shape.z + 1 })}
      >
        ↑层
      </button>
      <button
        disabled={readonly || !shape}
        title="下移一层"
        onClick={() => shape && board.updateShape(shape.id, { z: Math.max(0, shape.z - 1) })}
      >
        ↓层
      </button>
      <span className="sep" />
      <select
        disabled={readonly || !shape}
        value={shape?.fill ?? ''}
        onChange={(e) => shape && board.updateShape(shape.id, { fill: e.target.value })}
      >
        <option value="" disabled>
          颜色
        </option>
        {[...FILL_COLORS].map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <span className="sep" />
      <button onClick={board.undo} disabled={board.state.undoDepth === 0}>
        撤销({board.state.undoDepth})
      </button>
      <button onClick={board.redo} disabled={board.state.redoDepth === 0}>
        重做({board.state.redoDepth})
      </button>
    </div>
  );
}

function ShapeView({
  shape,
  board,
  connectMode,
  onConnectTarget,
}: {
  shape: Shape;
  board: BoardApi;
  connectMode: string | null;
  onConnectTarget: (id: string) => void;
}): JSX.Element {
  const selected = board.state.selection.includes(shape.id);
  const readonly = board.state.you?.role === 'viewer';
  const handlers = readonly ? {} : board.bindPointer(shape);
  const interactive = connectMode
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          e.stopPropagation();
          onConnectTarget(shape.id);
        },
      }
    : handlers;
  return (
    <g
      className={`shape-group ${connectMode ? 'connect-target' : ''} ${
        board.state.drag?.shapeId === shape.id ? 'dragging' : ''
      }`}
      {...interactive}
    >
      {shape.kind === 'ellipse' ? (
        <ellipse
          cx={shape.x + shape.w / 2}
          cy={shape.y + shape.h / 2}
          rx={shape.w / 2}
          ry={shape.h / 2}
          fill={shape.fill}
          stroke="#334155"
          strokeWidth={1.5}
          pointerEvents="all"
        />
      ) : (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.kind === 'sticky' ? 6 : 3}
          fill={shape.fill}
          stroke="#334155"
          strokeWidth={1.5}
          pointerEvents="all"
        />
      )}
      {shape.kind === 'sticky' ? (
        <StickyText shape={shape} board={board} />
      ) : (
        shape.text && (
          <text x={shape.x + 8} y={shape.y + 22} className="shape-label">
            {shape.text}
          </text>
        )
      )}
      {selected && (
        <rect
          x={shape.x - 4}
          y={shape.y - 4}
          width={shape.w + 8}
          height={shape.h + 8}
          fill="none"
          stroke="#2563eb"
          strokeDasharray="6 4"
          className="selection-box"
          pointerEvents="none"
        />
      )}
    </g>
  );
}

function StickyText({ shape, board }: { shape: Shape; board: BoardApi }): JSX.Element {
  const readonly = board.state.you?.role === 'viewer';
  return (
    <foreignObject x={shape.x + 6} y={shape.y + 6} width={shape.w - 12} height={shape.h - 12}>
      <textarea
        className="sticky-text"
        defaultValue={shape.text}
        readOnly={readonly}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== shape.text) board.updateShape(shape.id, { text: v });
        }}
      />
    </foreignObject>
  );
}

function ConnectionView({ conn, board }: { conn: Connection; board: BoardApi }): JSX.Element {
  const d = pointsToSvgPath(conn.path);
  return (
    <g className="connection">
      <path d={d} className="connection-hit" onClick={() => board.deleteConnection(conn.id)} />
      <path d={d} className="connection-line" />
      {conn.label && (
        <text x={conn.path[0]?.x} y={(conn.path[0]?.y ?? 0) - 6} className="conn-label">
          {conn.label}
        </text>
      )}
    </g>
  );
}

function PresenceView({ peer, shapes }: { peer: Peer; shapes: Map<string, Shape> }): JSX.Element {
  return (
    <g pointerEvents="none">
      {peer.cursor && (
        <g transform={`translate(${peer.cursor.x},${peer.cursor.y})`}>
          <path
            d="M0 0 L0 14 L4 10 L7 16 L9.5 15 L6.5 9 L12 9 Z"
            fill={peer.color}
            stroke="white"
            strokeWidth={1}
          />
          <text x={12} y={12} fontSize={11} fill={peer.color}>
            {peer.name}
          </text>
        </g>
      )}
      {peer.selection.map((id) => {
        const s = shapes.get(id);
        if (!s) return null;
        return (
          <rect
            key={id}
            x={s.x - 5}
            y={s.y - 5}
            width={s.w + 10}
            height={s.h + 10}
            fill="none"
            stroke={peer.color}
            strokeWidth={2}
            strokeDasharray="8 4"
            rx={4}
          />
        );
      })}
    </g>
  );
}

function MembersPanel({ board }: { board: BoardApi }): JSX.Element {
  const me = board.state.you;
  const isHost = me?.role === 'host';
  return (
    <div className="members">
      <div className="members-title">成员（{board.state.peers.length}）</div>
      {board.state.peers.map((p) => (
        <div key={p.sessionId} className="member">
          <span className="dot" style={{ background: p.color }} />
          <span className="member-name">
            {p.name}
            {p.sessionId === me?.sessionId && '（我）'}
          </span>
          <span className="member-role">{roleText(p.role)}</span>
          {isHost && p.sessionId !== me?.sessionId && (
            <button
              className="mini"
              onClick={() =>
                board.setRole(p.sessionId, p.role === 'viewer' ? 'editor' : 'viewer')
              }
            >
              {p.role === 'viewer' ? '设为可编辑' : '设为只读'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
