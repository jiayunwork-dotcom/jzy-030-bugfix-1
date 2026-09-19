-- PostgreSQL 16 schema：画布、成员、图元、连线、操作日志（图元/连线为日志的物化视图）
CREATE TABLE IF NOT EXISTS canvases (
  id          TEXT PRIMARY KEY,
  created_at  BIGINT NOT NULL,
  host_session_id TEXT
);

CREATE TABLE IF NOT EXISTS members (
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('host', 'editor', 'viewer')),
  color       TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (canvas_id, session_id)
);

CREATE TABLE IF NOT EXISTS shapes (
  id          TEXT NOT NULL,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('rect', 'ellipse', 'sticky')),
  x           DOUBLE PRECISION NOT NULL,
  y           DOUBLE PRECISION NOT NULL,
  w           DOUBLE PRECISION NOT NULL,
  h           DOUBLE PRECISION NOT NULL,
  z           DOUBLE PRECISION NOT NULL,
  fill        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_seq BIGINT NOT NULL,
  PRIMARY KEY (canvas_id, id)
);

CREATE TABLE IF NOT EXISTS connections (
  id          TEXT NOT NULL,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_seq BIGINT NOT NULL,
  PRIMARY KEY (canvas_id, id)
);

-- 每画布独立定序；seq 由应用按画布显式指定，inverse 存撤销所需逆动作 JSON
CREATE TABLE IF NOT EXISTS op_log (
  seq         BIGINT NOT NULL,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  group_id    TEXT,
  actor       TEXT NOT NULL,
  undoable    BOOLEAN NOT NULL,
  undo_of     TEXT,
  redo_of     TEXT,
  actions     JSONB NOT NULL,
  inverse     JSONB,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (canvas_id, seq)
);

CREATE INDEX IF NOT EXISTS op_log_canvas_seq ON op_log(canvas_id, seq);
CREATE INDEX IF NOT EXISTS op_log_group ON op_log(canvas_id, group_id);
