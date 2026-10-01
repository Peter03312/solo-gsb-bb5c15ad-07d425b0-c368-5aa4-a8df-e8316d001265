# 字幕校订台（Subtitle Correction）

面向小型放映团队的**多人协作字幕校订 Web 应用**。上传 UTF-8 编码的 SRT 文件后，
字幕段按时间顺序展示，团队成员可直接在浏览器中修改每段的**起止时间**与**多行文字**；
每次保存都携带作品修订号，用于检测并发修改冲突；校订完成可一键导出标准 SRT。

- 后端：Node.js + Express
- 存储：SQLite（better-sqlite3，WAL 模式，文件位于数据卷）
- 前端：原生 HTML/CSS/JavaScript，无需构建

## 功能与约束

- 上传 UTF-8 SRT（自动识别并去除 BOM，兼容 CRLF）
- 字幕段按开始时间排序展示，支持多行文字（换行保留）
- 时间校验：
  - 时间戳格式 `HH:MM:SS,mmm`（也宽容 `HH:MM:SS.mmm`），时间非负
  - 结束时间必须晚于开始时间
  - 同一作品内字幕段不得交叠（首尾相接允许）
- **整份文件原子入库**：格式或时间不合法时拒绝整份文件，错误信息指出 1 起始的行号，数据库不留任何残片
- **乐观锁（修订号）**：每次编辑必须携带当前作品修订号 `baseRevision`
  - 修订号过期返回 `409`，并回传**最新修订号**与**目标字幕段的最新内容**，界面展示供人工合并后重试
  - 每次成功编辑后修订号 +1
- 导出标准 SRT：按时间重新从 1 编号、保留文字内换行、逗号毫秒、UTF-8 BOM
- 编辑后自动按时间重新编号

## 快速启动（Docker Compose，推荐）

需要 Docker 20.10+（含 Compose v2）。

```bash
docker compose up -d --build
```

该命令会：构建镜像 → `npm install` 安装依赖 → `node scripts/init-db.js`
初始化 SQLite 存储（建库建表，幂等）→ 启动 Web 服务。

访问地址：

- 本机访问：<http://localhost:3000>
- 局域网访问：`http://<服务器IP>:3000`

停止：

```bash
docker compose down          # 停止，保留数据卷
docker compose down -v       # 停止并删除字幕数据
```

查看日志：

```bash
docker compose logs -f
```

## 配置（环境变量）

可在项目根目录创建 `.env` 文件（Compose 会自动读取），或直接 export：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口（容器内固定监听 3000） |
| `MAX_UPLOAD_MB` | `10` | 单个 SRT 上传大小上限（MB） |
| `DATA_DIR` | `/data`（容器） / `./data`（本地） | SQLite 数据库目录 |
| `PORT` | `3000` | 本地直接运行时的监听端口 |
| `HOST` | `0.0.0.0` | 本地直接运行时的监听地址 |

`.env` 示例：

```env
HOST_PORT=8080
MAX_UPLOAD_MB=20
```

数据持久化：Compose 使用命名卷 `subtitle-data` 挂载到容器 `/data`，
数据库文件为 `/data/subtitles.sqlite`（另有 WAL 辅助文件）。

## 不使用 Docker，本地运行

要求 Node.js >= 20。

```bash
npm install
npm run init-db     # 初始化 ./data/subtitles.sqlite（幂等，可省略，启动时也会自建）
npm start
```

然后访问 <http://localhost:3000>。

> 若安装 better-sqlite3 时预编译二进制下载失败（如内网环境），可指定镜像：
>
> ```bash
> npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 npm install
> ```

## 使用说明

1. 打开首页，填写可选的作品名称，选择 `.srt` 文件，点击「上传并校订」。
   - 文件不合法时，错误框会显示原因与**行号**，整份文件不会入库，修正后重新上传即可。
2. 进入作品页，字幕按时间排列。每条可编辑：
   - 两个时间输入框（`HH:MM:SS,mmm`）
   - 多行文本框（直接回车换行）
3. 点击「保存（修订号 N）」：
   - 成功后顶部修订号与按钮上的 N 同时 +1。
   - 若期间**别人已保存过**，会收到修订号过期提示，该字幕段下方展示服务器上的最新版本，
     请把你的修改与最新内容人工合并后再次点击保存。
   - 时间与其它段交叠、结束不晚于开始等情况会被拒绝，修订号不变。
4. 点击「导出标准 SRT」下载 `<作品名>.srt`，段落按时间重新编号，文字换行原样保留。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/works` | 作品列表（含修订号、字幕段数） |
| `POST` | `/api/works` | multipart 上传 `file`（.srt）与可选 `title`，新建作品 |
| `GET` | `/api/works/:id` | 作品详情 + 全部字幕段 |
| `PATCH` | `/api/works/:id/cues/:cueId` | 编辑字幕段，JSON：`baseRevision`、`start?`、`end?`、`text?` |
| `GET` | `/api/works/:id/export` | 导出标准 SRT 文件 |
| `DELETE` | `/api/works/:id` | 删除作品 |

`PATCH` 冲突响应（HTTP 409）示例：

```json
{
  "error": "修订号已过期：您基于 1，当前为 2，请比对后重试",
  "latestRevision": 2,
  "cue": {
    "id": 1, "idx": 1,
    "start": "00:00:01,200", "end": "00:00:03,000",
    "startMs": 1200, "endMs": 3000,
    "text": "服务器上的最新文字"
  }
}
```

## 测试

```bash
npm test
```

覆盖 SRT 解析/生成（行号定位、交叠、时间约束、重新编号、换行保留、round-trip）
与 API 全流程（非法文件不入库、修订号冲突 409、交叠拒绝、导出）。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── scripts/
│   └── init-db.js          # 存储初始化（建库建表，幂等）
├── src/
│   ├── config.js           # 环境变量配置
│   ├── db.js               # SQLite 连接与表结构
│   ├── srt.js              # SRT 解析/校验/生成
│   ├── app.js              # Express 应用与 API
│   └── server.js           # 启动入口
├── public/                 # 浏览器界面（无构建）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/                   # node:test 测试
```
