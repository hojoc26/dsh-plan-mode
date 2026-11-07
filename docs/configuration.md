# 配置详解

所有配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（或者你正在用的那个 profile）的 `insert` 条目里：

```yaml
- insert:
    - id: plan-mode
      name: 'dsh-plan-mode'
      config:
        provider: openai-codex
        model: gpt-6.1-sol
```

三条规则记住就够：

1. **没写的键用默认值**，不用把整张表抄一遍。
2. `condense` 和 `attachments` 是**浅合并**的：只写 `condense.enabled: false`，其余精简参数保持默认。这一点是刻意的，免得漏写 `provider` 就没法精简。
3. 改完要**重新加载 profile + 刷新页面**才生效。

## 顶层

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | string | `openai-codex` | 规划器 provider，必须是 DSH 里已注册的名字 |
| `model` | string | `gpt-6.1-sol` | 规划器模型 id |
| `reasoningEffort` | string | `high` | 透传给适配器；留空字符串 = 不传该字段 |
| `maxTokens` | number | `10000` | 大纲输出 token 上限。大纲被截断时调大 |
| `timeoutMs` | number | `180000` | 单次规划请求超时（毫秒），下限被夹到 5000 |
| `minChars` | number | `0` | 你亲手输入的字符数短于此值则跳过规划；带附件时不跳过 |
| `notifyOnFailure` | boolean | `true` | 规划失败时是否插一条「本轮已按原样继续」的提示 |

## condense（长输入精简）

目的：输入很长时，先让便宜的模型压成一条紧凑请求，再交给贵的规划器。**只在估算 token 超过 `minTokens` 时触发**，短输入零额外调用。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `provider` | string | `deepseek-account` | 精简器 provider |
| `model` | string | `deepseek-flash` | 精简器模型 |
| `minTokens` | number | `8000` | 估算超过此值才精简 |
| `maxChars` | number | `6000` | 精简结果字符上限 |
| `maxInputChars` | number | `60000` | 送进精简器的输入上限，超出直接截断 |
| `maxTokens` | number | `1200` | 精简输出 token 上限 |
| `timeoutMs` | number | `60000` | 精简超时；失败自动回退原文 |

精简器被要求保留：意图、约束、数字与单位、文件名/路径/命令/标识符、专有名词、否定与例外、顺序；**附件引用行一行都不能删**。可以删寒暄、重复、情绪、被推翻的旧说法。

## attachments（附件）

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关掉后附件只留一行文件名引用 |
| `images` | boolean | `true` | 图片是否作为 image 块转给规划器 |
| `maxChars` | number | `30000` | 单个附件提取结果上限 |
| `timeoutMs` | number | `30000` | 单个附件提取超时 |
| `pythonPath` | string | `''` | 留空：优先 `$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`，找不到再退回 `python` |

提取顺序：`.docx/.xlsx/.pptx/.pdf` 走 Python 提取脚本；其余文本类扩展名直接读文件。**附件内容不参与精简**，避免结构细节被压掉。

## 估算 token 的方式

自己实现，因为 DSH 自带的计量按固定 4 字符/token，会严重低估中文：

- CJK 字符（码点 ≥ `0x2e80`）≈ 1 token / 字；
- 其余 ≈ 4 字符 / token；
- 两者相加向上取整。

所以 8000 token 的中文输入大约是 8000 字，不是 32000 字。

## 常见配法

### 换成别的规划模型

```yaml
- insert:
    - id: plan-mode
      name: 'dsh-plan-mode'
      config:
        provider: string-ai      # 你 patch 里自己注册的 provider
        model: gpt-6-astra
        reasoningEffort: medium
```

### 只给长任务规划，闲聊不花钱

```yaml
config:
  minChars: 60          # 少于 60 字直接跳过
```

### 完全关掉精简（每次都送原文）

```yaml
config:
  condense:
    enabled: false
```

### 精简更激进

```yaml
config:
  condense:
    minTokens: 4000
    maxChars: 3000
```

### 不支持图片输入的模型

```yaml
config:
  attachments:
    images: false       # 图片只留一行引用，不转给规划器
```

### 大纲太短 / 太长

- 太短、没覆盖到细节：调大 `maxTokens`（如 `16000`），或把 `reasoningEffort` 提到 `high`。
- 太长、注水：调小 `maxTokens`，或直接改 `lib/index.js` 里的 `SYSTEM_PROMPT`。

> 改 `SYSTEM_PROMPT` 属于改代码：改完要同步到 profile 的 `node_modules/dsh-plan-mode/lib/index.js` 并刷新页面。`scripts/install.ps1` 会自动同步。

## 改配置后没生效？

按这个顺序排查：

1. `cordis.patch.yml` 缩进对不对（YAML 对缩进敏感，`insert` 是顶层数组元素）。
2. profile 真的重载了吗——重启 DSH 最稳。
3. 页面刷新了吗——浏览器半侧不随宿主热重载更新。
4. 用 `/plugins/dsh-plan-mode/state` 的 `build` 字段确认宿主半侧是新代码。

细节见[排错](troubleshooting.md)。
