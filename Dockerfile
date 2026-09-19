# 多阶段构建：先构建前端静态产物，再构建后端并由其托管页面
FROM node:20-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm install
COPY packages/shared packages/shared
RUN npm run build -w @wb/shared
COPY packages/web packages/web
RUN npm run build -w @wb/web
COPY packages/server packages/server
RUN npm run build -w @wb/server

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm install --omit=dev || npm install
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist /app/web-dist
# 修正 shared 在生产容器内的入口指向 dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
EXPOSE 8080
CMD ["node", "packages/server/dist/index.js"]
