# LiveUser

更新时间：2026-09-23 03:35（Asia/Shanghai）

轻量、通用的网站在线统计服务。

- **当前在线人数**：由 Go WebSocket 服务统计当前连接数。
- **今日浏览量**：由 Cloudflare Worker + D1 统计。每次页面加载或刷新都会增加 1，不做访客去重。
- 默认按接入页面域名区分网站，也可以显式设置 `siteId` 合并统计分区。

## 架构

```text
网站页面
  ├─ WebSocket ──────> Go 服务       ──> count
  └─ POST /v1/visit ─> Worker + D1 ──> 浏览量
```

Go 服务只在内存中维护当前在线连接数，重启后当前在线人数归零。今日浏览量使用 D1 保存聚合计数，不保存 IP、User-Agent、Referer 或访客标识。

## 快速开始

### 1. 启动 Go 服务

```bash
go run .
```

默认监听 `0.0.0.0:10086`。Go 服务只有一个命令行参数：

```bash
go run . -addr 127.0.0.1:8080
```

使用 Docker Compose：

```bash
docker compose up -d
```

Compose 默认只把端口绑定到宿主机 `127.0.0.1:10086`，HTTPS/WSS 由反向代理提供。

### 2. 部署 Worker + D1

在 Cloudflare Dashboard 中连接本仓库并设置：

| 配置项 | 值 |
| --- | --- |
| 构建命令 | 留空 |
| 部署命令 | 保持默认 |
| 非生产分支部署命令 | 保持默认 `npx wrangler versions upload` |
| 环境变量或密钥 | 无需配置 |

首次访问 `/v1/visit` 时，Worker 会自动创建缺失的 D1 表和索引，Fork 用户不需要手动执行迁移，也不需要提交 `database_id`。首次部署时 Cloudflare 会按 `wrangler.jsonc` 自动创建并绑定 D1；若构建令牌没有 D1 权限，需要为该构建选择或创建带 `D1 Edit` 权限的令牌。

推送 `main` 会自动构建并发布 GHCR 镜像；也可以在 GitHub Actions 中手动执行 `workflow_dispatch`。

本地开发：

```bash
npm ci --legacy-peer-deps
npm run worker:dev
```

### 3. 接入网站

```html
<span id="liveuser">加载中...</span>
<script src="https://stats.example.com/liveuser.js"></script>
```

默认显示为“在线 N · 浏览量 M”。页面每次加载或刷新都会记录一次浏览量，和 Umami 的浏览量口径类似。页面域名会自动成为统计分区；需要把多个域名合并时再设置 `siteId`。

## 可选参数

`/liveuser.js` 支持以下 URL 参数：

- `serverUrl`：WebSocket 与 `/v1/visit` 的共用服务基址，默认使用提供脚本的站点；反向代理需将 WebSocket 路由到 Go，将 `/v1/visit` 路由到 Worker。
- `siteId`：统计分区，默认使用当前页面域名；显式设置时用于自定义分区，省略时由对应服务的请求 `Origin` 推导。
- `displayElementId`：显示元素 ID，默认 `liveuser`。
- `reconnectDelay`：重连基础延迟，默认 `5000` ms，另加随机等待。
- `debug`：是否输出调试日志，默认 `false`。

## 接口

WebSocket 加入：

```json
{"type":"join","siteId":"example.com"}
```

`siteId` 可省略；省略时服务端使用握手 `Origin` 的域名。服务端广播：

```json
{"type":"update","siteId":"example.com","count":10,"timestamp":1750000000}
```

`count` 表示当前在线连接数。

请求体中的 `siteId` 可省略；省略时 Worker 使用请求 `Origin` 的域名。显式传入 `siteId` 时不要求 `Origin`。

记录一次浏览量：

```http
POST /v1/visit
Content-Type: application/json
Origin: https://example.com

{"siteId":"example.com"}
```

响应：

```json
{"type":"visit","siteId":"example.com","pv":56,"date":"2026-09-23","timestamp":1750000000}
```

`pv` 是接口字段名，含义为浏览量。读取当前浏览量而不增加：

```http
GET /v1/visit?siteId=example.com
Origin: https://example.com
```

## 配置

Go：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-addr` | `0.0.0.0:10086` | HTTP/WebSocket 监听地址 |

Go 默认无需额外配置；只有修改监听地址时才传 `-addr`。WebSocket 按上游接受任意 Origin。

Worker 只需要 D1 binding `DB`，不需要额外环境变量或密钥。

## 隐私

- 浏览器不生成访客标识；WebSocket 和 Worker 都不接收访客标识。
- Go 只接收 `siteId`；不读取或保存 IP、User-Agent、Referer。
- Worker 只保存聚合浏览量计数，不保存访客身份、页面路径或行为数据。
- 今日数据保留当天和前一天，共 2 天；Cloudflare D1 Time Travel 仍由平台控制，不保证立即物理删除。

## 开发检查

```bash
gofmt -l .
go test ./...
go vet ./...
go build .

npm ci --legacy-peer-deps
npm run worker:check
npm run worker:test
npm run worker:deploy:check
```

## 来源与致谢

本项目源自 Mingyu（[@ymyuuu](https://github.com/ymyuuu)）的 [LiveUser](https://github.com/ymyuuu/LiveUser)，继续使用 MIT License。
