# dsh-http

DSH 结构化 HTTP 请求工具插件。注册一个 `http_request` 工具，基于 Node 内置 `fetch`，把每次请求的结果规范化为一个结构化 JSON 对象，供模型与 Code Mode 程序化调用。**零依赖、纯 ESM、无构建**。

## 简介

- 工具名：`http_request`
- 能力：任意 `http/https` 请求（GET/POST/PUT/PATCH/DELETE/HEAD）、自定义请求头、原始 `body`、JSON 自动序列化、Bearer/Basic 认证便捷参数、超时与响应体截断。
- 行为：**永不抛异常**。网络错误、超时、参数错误都折叠为 `{ ok: false, error: { stage, message } }`；成功返回 `{ ok: true, status, statusText, durationMs, sizeBytes, ... }`。

## 安装

```sh
dsh plugin --profile <name> add file:./plugins/dsh-http
# 或发布后：
dsh plugin --profile <name> add dsh-http
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `url` | string | ✅ | — | 目标 URL，仅允许 `http`/`https` |
| `method` | enum | — | `GET` | `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD` |
| `headers` | object | — | — | 额外请求头，key → string |
| `body` | string | — | — | 原始请求体；与 `json` 互斥 |
| `json` | JSON | — | — | 任意 JSON 值，自动 `JSON.stringify` 并置 `content-type: application/json`；与 `body` 互斥 |
| `timeoutMs` | number | — | `10000` | 请求超时（毫秒） |
| `maxBodyChars` | number | — | `4000` | 响应体返回上限（字符数） |
| `auth` | object | — | — | 认证便捷参数，见下 |

`body` 与 `json` 同时提供会返回 `{ ok: false, error: { stage: 'request', message: ... } }`。

## 输出字段

成功（`ok: true`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | number | HTTP 状态码 |
| `statusText` | string | 状态文本 |
| `durationMs` | number | 往返耗时（毫秒） |
| `sizeBytes` | number | 响应体字节数 |
| `contentType` | string | 响应 `content-type`，存在时给出 |
| `headers` | object | 仅存在的响应头：`content-type`/`content-length`/`location`/`server` |
| `redirectTo` | string | 3xx 时标注 `location` 跳转目标 |
| `json` | object | 响应体 JSON 解析成功时给出；受 `maxBodyChars` 截断则为 `null` 且 `truncated: true` |
| `text` | string | 非 JSON 响应体的（截断后）文本 |
| `truncated` | boolean | 响应体是否被截断 |

失败（`ok: false`）：`{ ok: false, error: { stage: 'request', message } }`。

## 认证用法

`auth` 参数在内存中生成 `Authorization` 头（不落盘、不进日志参数）：

```jsonc
// Bearer
{ "auth": { "type": "bearer", "token": "<token>" } }
// Basic
{ "auth": { "type": "basic", "username": "user", "password": "pass" } }
```

`token` / `username` / `password` 缺失时返回 `{ ok: false, error: { stage: 'request', message: ... } }`。

## 安全与内网访问风险提示

> ⚠️ 本工具是**本地个人工具**，**不内置 SSRF 拦截**。唯一的安全校验是 URL scheme 必须是 `http`/`https`。
>
> 这意味着它可以访问 `http://localhost`、`http://127.0.0.1`、`http://10.x`、`http://192.168.x`、`http://172.16–31.x`、`http://169.254.x` 等内网/回环地址。如果模型（或共享给模型的 Code Mode 程序）被诱导发起请求，可能扫描内网、访问本机服务或向云元数据端点（如 `169.254.169.254`）发起请求。
>
> **不要在不可信的 prompt 或不可信的多租户环境中使用本插件**；如确有内网隔离需求，请在插件上游叠加 `tools/pre-execute` 策略进行 URL 门禁。

## License

MIT
