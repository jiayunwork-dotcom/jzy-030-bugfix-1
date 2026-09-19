# 多人实时协作白板

浏览器里多人在同一张画布上拖动图形、拉连接线、写便签，彼此实时一致。

- **前端**：React 18 + TypeScript + Vite，SVG 渲染画布、协作者光标与选中框
- **后端**：Node.js 20 + `ws`，负责定序、广播、快照/增量、操作日志、权限判定
- **持久化**：PostgreSQL 16（op_log 为真源，shapes/connections 为物化视图）
- **实时一致性**：服务端单提交日志 + 属性级合并 + 确定性连线路由

## 一条命令启动（前端 + 后端 + 数据库）

```bash
docker compose up --build
```

打开 http://localhost:8080 即一块可协作画布。把地址栏 URL（含 `#canvas-xxxx`）发给另一个浏览器窗口/同事即可进入同一张画布。

## 本地开发（无 Docker，内存存储）

```bash
npm install
npm run dev:server   # :8080，内存存储（不依赖数据库）
npm run dev:web      # :5173，自动代理 /ws 到 8080
```

使用 PostgreSQL：

```bash
DATABASE_URL=postgres://whiteboard:whiteboard@localhost:5432/whiteboard npm run dev:server
```

## 自动化测试

```bash
npm test
```

锁定的关键行为（共 24 个用例）：

1. 降级时进行中的拖动**立即回滚**且**不广播脏位置**
2. 只读写操作被拒（含可读原因）、非房主不能改角色
3. 同图元不同属性并发改动都保留（属性级合并，非整体覆盖）
4. 同属性并发按服务端接收顺序定序，所有客户端收敛
5. 断线重连：带 `lastSeq` 追增量；落后太多给完整快照
6. 撤销按人隔离，只回退本人那一步涉及的属性，他人改动保留
7. 撤销/重做栈由服务端操作日志维护，重连后续接
8. 图元移动后连线端点贴合最近锚点、路径确定可复现不抖动
9. 删除图元时挂接连线级联删除，不留悬空端点
10. 锚到不存在图元 / 自连 / 坐标越界 / 非法尺寸被拒并说明原因

## 架构与模块划分

```
packages/shared
  src/types.ts       领域模型、协议、applyCommit（前后端共用同一套提交语义）
  src/geometry.ts    连线路由：锚点贴合 + Liang–Barsky 避障 + 确定性通道布线
  src/constants.ts   坐标/尺寸边界、颜色表

packages/server
  src/hub.ts         连接与广播、房间生命周期、串行定序队列、房主迁移
  src/engine.ts      定序合并引擎：属性级 patch、逆动作、按会话隔离的撤销/重做索引（纯函数）
  src/permissions.ts 权限与角色（host/editor/viewer）
  src/snapshot.ts    快照与增量（resolveCatchup 决定全量还是补发）
  src/store/types.ts 持久化接口
  src/store/memory.ts 内存实现（权威态由日志重放；测试/无 DB 使用）
  src/store/pg.ts    PostgreSQL 实现 + 启动回放重建
  src/store/schema.sql
  src/ws.ts          ws 传输适配
  src/index.ts       HTTP（静态托管 /health）+ WebSocket 入口

packages/web
  src/state/reducer.ts  协作者状态层（纯 reducer）：提交应用 + 本地拖动乐观态 + 降级即时回滚
  src/net/client.ts     WebSocket 客户端（自动重连、lastSeq、消息排队）
  src/hooks/useBoard.ts 协作 Hook（op/presence/undo/redo、拖拽提交时机）
  src/components/Board.tsx 画布、图元、连线、便签、协作者光标/选中框、成员面板、工具栏
```

## 关键设计

### 降级即时性
拖动期间只在本地做乐观渲染，**绝不发送位置**，松手才提交一次 `shape.update`。
被降级者在收到 `member.role → viewer` 提交的**同一帧**由 reducer 终止拖动并把图元还原到拖动开始时记录的权威几何；由于半截位置从未上送，服务端与其他人都不会看到脏位置。此后任何写操作在 `permissions` 层被拒，画面以服务端权威状态为准。

### 并发收敛
- 每个图元更新是**属性级 patch**（如 `{x,y}` 与 `{fill}` 互不覆盖），不同属性的并发改动天然都保留。
- 同一属性的并发写按服务端**接收顺序串行定序**，后到者直接基于新基线赋值，所有客户端重放同一条提交日志，最终一致。

### 断线重连
重连带 `sessionId + lastSeq`：`lastSeq` 连续则只补发 `(lastSeq, seq]` 的 delta；落后或无法衔接则给完整快照。客户端从不依赖本地缓存拼接画面。

### 撤销/重做
- 每个可撤销操作在定序时生成**逆动作**并持久化在 op_log，栈按 `sessionId` 隔离。
- 撤销是一个正常定序提交（`undoOf`），只包含该用户那一步的逆动作；别人对同图元其它属性的改动不在逆动作内，故被保留。
- 新编辑会杀死此前的 redo 分支；撤销栈随会话由服务端日志维护，重连后续接。

### 连线路由
端点 = 各自图元边界上离对端最近的点（矩形精确求最近点，椭圆沿方向求交）。直连若穿过障碍，则在障碍整体的左/右/上/下外侧确定性通道中选包围盒最小且不穿障者，平局固定次序；全部几何量化到 0.01，刷新与两端计算逐点一致。删除图元时 `shape.delete` 级联删除所有挂接连线，其逆动作会在撤销时一并恢复。
