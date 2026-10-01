FROM node:20-bookworm-slim

# better-sqlite3 有预编译二进制；保留编译工具链，以便无预编译包的环境可从源码构建
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# 拷贝应用代码
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# 数据卷：SQLite 数据库（含 WAL 文件）存放位置
RUN mkdir -p /data
ENV DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 3000
VOLUME ["/data"]

# 初始化存储（幂等建表）后一键启动
CMD ["sh", "-c", "node scripts/init-db.js && node src/server.js"]
