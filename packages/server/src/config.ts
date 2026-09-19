export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? null,
  staticDir: process.env.STATIC_DIR ?? null,
  logWindow: Number(process.env.LOG_WINDOW ?? 2000),
};
