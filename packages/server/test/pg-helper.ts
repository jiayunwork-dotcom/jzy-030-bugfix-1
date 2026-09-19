// 回归测试专用：在本机直接拉起一个真实 PostgreSQL 集群（无需 Docker / root），
// 让并发加入的链路真正走到唯一索引与事务提交。
// 若当前平台缺少对应的预编译二进制（如离线 CI），调用方应跳过相关用例。
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);

export const PG_USER = 'whiteboard';
export const PG_PASSWORD = 'whiteboard';
export const PG_DB = 'whiteboard';

export interface EmbeddedCluster {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function embeddedPgAvailable(): boolean {
  // 主包 + 当前平台的预编译二进制（optionalDependency，离线/异构 CI 可能缺失）都要在
  try {
    require.resolve('embedded-postgres');
  } catch {
    return false;
  }
  const platformBin =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? '@embedded-postgres/darwin-arm64'
        : '@embedded-postgres/darwin-x64'
      : process.platform === 'win32'
        ? '@embedded-postgres/windows-x64'
        : `@embedded-postgres/linux-${process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : process.arch === 'ia32' ? 'ia32' : 'ppc64'}`;
  try {
    require.resolve(platformBin);
    return true;
  } catch {
    return false;
  }
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

export async function startEmbeddedPostgres(label: string): Promise<EmbeddedCluster> {
  const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as typeof import('embedded-postgres');
  const port = await getFreePort();
  const dir = join(tmpdir(), `wb-pg-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const cluster = new EmbeddedPostgres({
    databaseDir: dir,
    user: PG_USER,
    password: PG_PASSWORD,
    port,
    persistent: false,
    // 测试不关心 postgres 自身日志；静默避免污染 TAP 输出
    onLog: () => {},
    onError: () => {},
  });
  await cluster.initialise();
  await cluster.start();
  try {
    await cluster.createDatabase(PG_DB);
  } catch (err) {
    // 库已存在等情况直接忽略
    void err;
  }
  return {
    port,
    url: `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${PG_DB}`,
    stop: async () => {
      try {
        await cluster.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
