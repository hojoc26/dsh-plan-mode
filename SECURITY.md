# 安全说明

## 这个插件能做什么

- 读取你本轮输入的文字和附件（附件会转成文本送进模型）。
- 用你配置的 provider 发两次模型请求：一次可选的精简、一次规划。
- 在本机回环地址上注册三条 HTTP 路由。
- 在 `~/.dsh/plan-mode.json` 存一个布尔开关。

它**不能**执行命令、不能写工作区文件（除了那个开关文件）、不能读环境变量里的密钥。

## 密钥

插件不读、不存、不转发任何 API key 或 token。鉴权全部由 DSH 的 provider 层负责，配置里只出现 provider 和 model 的名字。

如果你在 profile 里给 provider 配了 key，那是 DSH 的事，与本插件无关。**不要**把含密钥的 `cordis.patch.yml`、`.env` 或凭据文件提交到本仓库或任何公开仓库。

## 网络暴露面

三条路由跟随 DSH Web GUI 的端口，只绑定本机回环地址，**没有鉴权**，信任边界与 DSH Web 完全相同：

| 路由 | 风险 |
|---|---|
| `GET/POST /plugins/dsh-plan-mode/state` | 可被本机任意进程翻转开关 |
| `POST /plugins/dsh-plan-mode/selftest` | 会消耗你的模型额度；`paths` 参数可读任意本机文件的文本内容 |
| `GET /plugins/dsh-plan-mode/agents` | 泄露代理 id |

因此：

- **不要把 DSH Web 端口暴露到公网**（含反向代理、内网穿透、`0.0.0.0` 监听）。
- 需要时用 SSH 隧道或 DSH 自带的本机回环访问。
- `selftest` 的跨站请求会被浏览器预检拦下（服务端不响应 `OPTIONS`，且不返回 CORS 头），但这不构成鉴权——同一台机器上的任何进程都能直接调。

## 数据流

```
你的输入 ─┬─> 精简模型（默认 deepseek-flash）
          └─> 规划模型（默认 openai-codex / gpt-6.1-sol）
                      └─> 大纲文本注入本轮对话 ─> 主模型
```

也就是说：**你发给主模型的内容，也会发给规划模型**。如果输入里有不该给第三方模型看的东西，先关掉开关。

## 报告问题

发现安全问题请走 GitHub 的私密渠道（仓库 Security 标签下的 *Report a vulnerability*），不要开公开 issue。
