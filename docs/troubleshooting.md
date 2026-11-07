# 排错

先做三件事，能解决八成问题：

1. **重启 DSH**（让 profile 重新加载）；
2. **刷新页面**（浏览器半侧不随宿主热重载更新）；
3. 打开 `http://127.0.0.1:<当前 GUI 端口>/plugins/dsh-plan-mode/state`，看它返回什么。

| 返回 | 含义 |
|---|---|
| `{"enabled":...,"build":"0.4.1"}` | 宿主半侧已加载，路由正常 |
| `404` / 连接被拒 | 插件没加载，或端口不对（端口看浏览器地址栏） |
| `build` 不是你预期的版本 | 文件没同步过去，或 profile 没重载 |

---

## 胶囊没出现

**输入框右侧、模型选择器旁边空的。**

1. `package.json` 里必须有 `dsh.client.platform: 'web'` 和 `dsh.client.inject` 数组 —— 少了 `dsh` 字段，DSH 不会去加载浏览器半侧。
2. 浏览器控制台有没有报 `window.__ModuleLoader__ is not defined`：有的话是页面版本太旧或加载顺序问题，硬刷新（`Ctrl+Shift+R`）。
3. 控制台有没有 `require('react')` 相关的错：说明 `dsh.client.inject` 里少了对应的 UI 包，浏览器拿不到共享的 React。
4. 看 Network 面板里有没有 `client.js` 的请求；没有说明 manifest 没被识别，检查 `package.json` 是否被改坏了。

## 胶囊点了没反应 / 刷新后又变回关

- 状态读写走 HTTP。看 Network 面板里 `POST /plugins/dsh-plan-mode/state` 的返回；`405` 说明方法不对（用了 GET 之外的动词以外的方式），`404` 说明宿主半侧没加载。
- 状态文件写不进去（只读磁盘、权限问题）时宿主只 warn，界面会在下次刷新时回退。看宿主日志里有没有 `[plan-mode] cannot persist state`。

## 每轮都提示「规划阶段未产出大纲」

这行提示表示规划失败但已降级。具体原因看提示里的 `原因：`，或者拉宿主日志里的 `[plan-mode] skipped this turn: ...`。

| 原因关键字 | 处理 |
|---|---|
| `401` / `unauthorized` | 规划器 provider 没登录或凭据过期（Codex 连接插件需要重新登录） |
| `quota` / `rate limit` / `insufficient` | 订阅额度用尽或触发限流；换 provider 或等额度恢复 |
| `timed out` / `aborted` | 调大 `timeoutMs`，或调小 `maxTokens` |
| `no text` | 模型只回了 reasoning 没回正文；换模型或提高 `maxTokens` |
| `model not found` / `unknown provider` | `provider` / `model` 名字写错了，和 DSH 里注册的对不上 |

不想看到这条提示：`notifyOnFailure: false`。

## 想单独验证规划器能不能用

```powershell
curl.exe -X POST http://127.0.0.1:<端口>/plugins/dsh-plan-mode/selftest `
  -H "content-type: application/json" -d '{\"task\":\"帮我规划一个周报模板\"}'
```

返回里看三样：

- `request.provider` / `request.model`：实际送到适配器的名字；
- `ms`：耗时，超时问题一眼看出来；
- `ok:false` 时的 `error`：和上面那张表对照。

不传 `task` 会用一个内置的固定任务。

## 附件没被读到

1. 先用 `selftest` 的 `paths` 参数单独测提取：

   ```powershell
   curl.exe -X POST http://127.0.0.1:<端口>/plugins/dsh-plan-mode/selftest `
     -H "content-type: application/json" -d '{\"paths\":[\"C:/tmp/报告.docx\"]}'
   ```

   返回 `extractions[0].error` 会直接告诉你缺哪个 Python 库。

2. `.docx/.xlsx/.pptx/.pdf` 需要 Python 环境：
   - `attachments.pythonPath` 留空时，先找 DSH 自带的 python，再退回 PATH 上的 `python`；
   - 缺库时装：`python -m pip install python-docx openpyxl python-pptx pypdf`。
3. `.pdf` 是扫描件（没有文本层）时提取结果为空，属于预期 —— 这种要么先 OCR，要么改成截图发。
4. 路径里有中文/空格时，确保走的是 `paths` 数组而不是拼字符串。

## 图片没有传给规划器

- 模型不支持图片输入时，插件会自动去掉图片重试一次，并在输入末尾加 `[图片未能传给规划器，仅有文字可用]`。看到这行就是回退了。
- 想从一开始就不发图片：`attachments.images: false`。

## 长输入的精简看起来把细节丢了

- 精简只在估算超过 `condense.minTokens` 时触发，短输入不会被压。
- 觉得压得太狠：调大 `condense.maxChars`，或直接 `condense.enabled: false`。
- 附件正文**从不参与精简**，如果丢了细节，问题在 `attachments.maxChars`（默认 30000 字符截断）。

## 中文输入明明不长却被精简了

token 是估算的：CJK 约 1 字 1 token。8000 字的输入正好在默认阈值上。把 `condense.minTokens` 调大，比如 `20000`。

## 大纲质量不稳定

- `reasoningEffort: high` + `maxTokens: 10000` 是默认；换更小的模型会明显变差。
- 规划器看不到你的工作区，不知道仓库里有什么。需要在规划前读代码的任务，这个插件帮不上，应该用子代理版本。
- 想改风格/格式：改 `lib/index.js` 的 `SYSTEM_PROMPT`，然后跑 `scripts/install.ps1` 同步、刷新页面。

## 改了 `cordis.patch.yml` 没生效

- YAML 缩进错会导致整段被忽略，注意 `- insert:` 是顶层数组元素，`- id:` 在它下面缩进 4 格。
- `name` 必须和 `package.json` 的 `name` 完全一致（`dsh-plan-mode`）。
- `id` 随便取，但不要和历史条目重复。
- 最稳的办法：重启 DSH。

## 卸载后胶囊还在

浏览器缓存了旧的 `client.js`。硬刷新；还不行就重启 DSH 后再刷新。
