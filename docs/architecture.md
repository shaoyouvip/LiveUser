# LiveUser 架构

更新时间：2026-09-23 03:35（Asia/Shanghai）

## 目标

LiveUser 是通用、独立部署的在线统计服务。它不绑定某个网站、直播间或业务，任何网站都可以通过脚本调用；默认按页面域名区分统计分区。

服务提供两个指标：

- `count`：Go WebSocket 服务中某个 `siteId` 当前已加入的连接数。
- 浏览量：Cloudflare Worker + D1 中某个 `siteId` 当天的浏览量；接口响应字段名为 `pv`。每次页面加载或刷新增加 1，不做访客去重。

## 架构

```text
浏览器页面
  ├─ WebSocket ───────> Go 服务
  │                        └─ 内存中的在线连接数
  ├─ POST /v1/visit ──> Worker + D1
  │                        └─ 当天浏览量 + 1
  └─ GET /v1/visit ───> Worker + D1
                           └─ 读取当前浏览量，不增加
```

Go 服务不持久化在线人数，重启后当前在线连接数从零开始。Worker/D1 只保存聚合浏览量计数，不保存原始访客标识。

## 统计分区

`siteId` 是统计分区键，不是权限边界。

- 前端默认使用当前页面域名，例如 `blog.example.com`。
- 调用方可以通过脚本参数 `siteId` 显式覆盖，用于合并多个域名或自定义分区。
- WebSocket 未传 `siteId` 时，Go 从握手 `Origin` 的域名推导。
- Worker 未传 `siteId` 时，从请求 `Origin` 的域名推导；显式传入 `siteId` 时不要求 `Origin`。
- `siteId` 统一转小写并校验长度和字符。

## WebSocket 协议

加入消息：

```json
{"type":"join","siteId":"example.com"}
```

其中 `siteId` 可省略。服务端广播：

```json
{"type":"update","siteId":"example.com","count":10,"timestamp":1750000000}
```

`count` 表示当前在线连接数。Go 只统计已完成加入的连接，连接断开后立即减少，空站点记录同步删除。消息包含心跳、读写超时、1 KiB 大小限制和断线清理。

## 今日浏览量接口

每次页面加载或刷新发送一次。请求体中的 `siteId` 可省略；省略时 Worker 使用请求 `Origin` 的域名。显式传入 `siteId` 时不要求 `Origin`。

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

`pv` 是接口字段名，含义为浏览量。页面停留期间读取最新数值，不增加浏览量：

```http
GET /v1/visit?siteId=example.com
Origin: https://example.com
```

Worker 请求体限制为 1 KiB，拒绝非法 JSON 和非法 `siteId`。日期按 `Asia/Shanghai` 切换。`POST` 每次都执行计数递增，因此刷新页面也会继续叠加。前端使用 `keepalive` 发送浏览量请求，避免刷新或离开页面时中止尚未完成的计数。

## 隐私与保留

- 浏览器不生成访客标识；WebSocket 和 Worker 都不接收访客标识。
- Go 只接收 `siteId`；不读取或保存 IP、User-Agent、Referer。
- D1 表 `daily_pageviews` 只存 `site_id`、`visit_date`、`pv`、`updated_at`。
- 业务保留窗口固定为 2 天，Cron 每小时清理旧数据；Cloudflare D1 Time Travel 仍由平台控制。
- 文档不承诺即时物理删除。

## 配置

Go 服务按上游只保留一个命令行参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-addr` | `0.0.0.0:10086` | HTTP/WebSocket 监听地址 |

Go 默认无需额外配置；只有修改监听地址时才传 `-addr`。WebSocket 按上游接受任意 Origin。

Worker 必需配置：

| 配置 | 说明 |
| --- | --- |
| `DB` | D1 binding，在 `wrangler.jsonc` 中配置 |

Worker 接受任意合法网站 Origin，CORS 回显请求 Origin。浏览量接口不需要环境变量或密钥。

Worker 在访问 D1 前会自动执行幂等的表结构初始化；同一运行时实例只初始化一次，初始化失败不会缓存，后续请求会重试。公开的迁移文件保持幂等，仅供本地开发或手工排查。

## 部署

- Go 使用 Docker 镜像运行，容器内默认监听 `0.0.0.0:10086`。
- Compose 示例只发布 `127.0.0.1:10086`，由反向代理提供 HTTPS/WSS。
- 推送 `main` 会自动构建并发布 GHCR 镜像；也可手动执行 `workflow_dispatch`。
- 反向代理必须支持 WebSocket Upgrade，并将 `/v1/visit` 路由到 Worker。
- `serverUrl` 同时决定 WebSocket 与 `/v1/visit` 的地址；跨域接入时，目标基址必须同时具备这两条路由。
- Worker 通过 Cloudflare Workers 构建从 Git 部署：构建命令留空，部署命令保持默认。
- 部署只发布 Worker；首次访问 `/v1/visit` 时会自动创建缺失的 `daily_pageviews` 表和索引，不需要手动执行迁移。
- 不把生产域名、D1 `database_id`、密钥或服务器信息写入公开仓库。

## 验证

本地至少检查：

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

目标环境还需要实测 WebSocket 连接/断开、广播、重连、浏览量连续递增、上海跨日、Cron 清理、反向代理 WSS 和容器启动。本地 mock 通过不代表线上验收完成。
