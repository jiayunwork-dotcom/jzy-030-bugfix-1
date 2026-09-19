import { useMemo, useState } from 'react';
import { Board } from './components/Board.js';
import { useBoard } from './hooks/useBoard.js';

function defaultCanvasId(): string {
  const fromHash = location.hash.replace(/^#/, '');
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(fromHash)) return fromHash;
  const id = `canvas-${Math.random().toString(36).slice(2, 8)}`;
  history.replaceState(null, '', `#${id}`);
  return id;
}

export function App(): JSX.Element {
  const [name, setName] = useState(() => sessionStorage.getItem('wb.name') ?? '');
  const [submittedName, setSubmittedName] = useState(
    () => sessionStorage.getItem('wb.name') ?? `用户${Math.floor(Math.random() * 1000)}`,
  );
  const canvasId = useMemo(defaultCanvasId, []);
  const board = useBoard(canvasId, submittedName);

  return (
    <>
      <div className="join-bar">
        <label>
          你的名字：
          <input
            value={name}
            placeholder={submittedName}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button
          onClick={() => {
            const v = name.trim() || submittedName;
            sessionStorage.setItem('wb.name', v);
            setSubmittedName(v);
          }}
        >
          确定
        </button>
        <span className="canvas-link">
          邀请链接：复制地址栏 URL（含 <b>#{canvasId}</b>）发给协作者
        </span>
      </div>
      <Board board={board} />
    </>
  );
}
