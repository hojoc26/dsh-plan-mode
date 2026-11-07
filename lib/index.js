/**
 * dsh-plan-mode — host half.
 *
 * Before the first step of a turn, ask a second model (by default an
 * `openai-codex` model backed by the ChatGPT/Codex subscription) to turn the
 * user's request into a short execution outline, then inject that outline as a
 * durable `user` message into the step that is about to enter the loop.
 *
 * Design constraints:
 *  - planning is optional: any failure falls through to the untouched decision,
 *    so the planner can never become a single point of failure;
 *  - exactly one planning call per turn (only `step === 1`);
 *  - sub-agents are skipped, so delegation does not multiply quota usage;
 *  - the direct `ctx.llm.stream()` call never enters the agent loop, so it
 *    cannot recurse and does not switch the conversation's routed model.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'

export const name = 'dsh-plan-mode'

/**
 * Cordis resolves `ctx.<service>` strictly: reading a service the plugin never
 * declared throws instead of returning undefined.
 */
export const inject = ['llm', 'agents']

const ROUTE = '/plugins/dsh-plan-mode/state'
const STATE_FILE_NAME = 'plan-mode.json'
/** Bumped whenever the host half changes, so a reload can be proven from outside. */
const BUILD = '0.4.1'

const DEFAULTS = {
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxTokens: 10_000,
  timeoutMs: 180_000,
  notifyOnFailure: true,
  /**
   * Inputs shorter than this many characters are not planned. Zero means
   * "plan whenever the switch is on"; a larger value is the cheap way to keep
   * small talk and one-liners off the quota.
   */
  minChars: 0,
  /**
   * Cheap pre-pass: the raw user message is condensed by the main (DeepSeek)
   * route before it reaches the planner. Long inputs only; any failure falls
   * back to the raw text.
   */
  condense: {
    enabled: true,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    /** Text is condensed only above this estimated token count. */
    minTokens: 8_000,
    maxChars: 6_000,
    maxInputChars: 60_000,
    maxTokens: 1_200,
    timeoutMs: 60_000,
  },
  /**
   * Attachment reading. Files are extracted to text (Office via the bundled
   * Python runtime, plain text read directly); images are forwarded to the
   * planner when the routed model accepts image input.
   */
  attachments: {
    enabled: true,
    images: true,
    maxChars: 30_000,
    timeoutMs: 30_000,
    pythonPath: '',
  },
}

const SYSTEM_PROMPT = `你是一个任务规划器：只做规划，不执行任务。你写的东西会给另一个模型当参考，所以目标是"让它少走弯路"，不是替它把活干完。

先判断这条请求属于哪一类，再按对应格式输出。

A. 问答/确认/解释类（在问事实、原因、是否、区别、该怎么做才对）：
   不要列执行步骤，不要要求用户补充材料（除非信息真的不足以判断，且最多问一个问题）。
   - 结论：一句话直接回答
   - 依据：2–4 条关键理由
   - 不确定处：哪些无法从现有信息确认
   总长 200 字以内。

B. 动手/交付类（要改代码、查资料、写文档、跑命令、做多步操作）：
   - 一句话点明任务类型
   - 编号步骤 3–8 个，每步写「做什么 → 产出什么」，可执行、可验证
   - 开工前必须弄清的关键信息或约束（缺什么、依赖什么、不能动什么）
   - 验收标准：怎样算做完
   - 1–3 个主要风险或容易返工的地方
   通常 400–800 字，确实复杂的可以更长，但不要注水。

通用要求：纯文本，不要代码块，不要客套话，不要复述原文；不确定就写「待确认」，不要编造；不要写「认真分析」「注意质量」这类空话。

C. 输入里带有附件时（以「[图片附件]」「[文件附件]」开头的行，或「--- 内容开始 ---」之间的提取正文，或直接给图片），额外输出两段：

   - 附件解构：类型与整体结构（章节层级、表格行列、图片位置、字段名、页数/slide 数/工作表），关键内容要点，以及大致的规模数字。
   - 还原方案：按什么顺序重建这份附件；用什么工具或库（如 python-docx / openpyxl / python-pptx / pypdf / LibreOffice）；哪些结构、样式、字段必须原样保留；哪些内容丢失、需要推断或无法恢复。

   还原要贴近原始结构，不要退化成"写一份摘要"。无法还原的部分明确标注，不要编造不存在的细节。`

const CONDENSE_PROMPT = `你是一个输入精简器。把用户下面的原始请求压缩成一条更紧凑的请求，供后续规划使用。

必须保留：意图、约束条件、数字与单位、文件名/路径/命令/代码标识符、专有名词、否定与例外、先后顺序。
必须原样保留：以「[图片附件]」「[文件附件]」开头的附件引用行，一行都不能删。
可以删掉：寒暄、重复、情绪表达、被自己推翻的旧说法、与请求无关的背景。
不要：新增需求、改变原意、替用户回答问题、把具体细节概括成模糊说法。

输出只有精简后的请求正文：不要前缀、不要解释、不要 Markdown。长度不超过原文的三分之二。`

/** Fixed prompt used by the self-test route; it never touches a real session. */
const SAMPLE_TASK = '为一个 Node.js 命令行工具补单元测试：验证成功路径输出正确、失败路径返回非零退出码且不抛出未捕获异常。请给出执行步骤。'

function stateFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, STATE_FILE_NAME)
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
    return { enabled: parsed?.enabled === true }
  } catch {
    return { enabled: false }
  }
}

function saveState(state) {
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.warn(`[plan-mode] cannot persist state: ${error?.message ?? error}`)
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > limit || chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * Split the incoming batch into the user's own text and attachment references.
 * DSH injects its runtime context, skill catalog and time stamps as
 * `role: 'user'` messages too, so filtering on the role alone would fold
 * kilobytes of system text into the "input". Only `source.kind === 'user'`
 * counts as input.
 */
function readTask(messages) {
  const parts = []
  const attachments = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user') continue
    const source = message?.source
    if (source !== undefined && source?.kind !== 'user') continue
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        parts.push(block.text)
      } else if (block?.type === 'image' || block?.type === 'file') {
        attachments.push(block)
      }
    }
  }
  return { text: parts.join('\n\n').trim(), attachments }
}

/** One-line reference for an attachment: used when its content cannot be read. */
function describeAttachment(block) {
  const ref = block.attachment ?? block.ref ?? block
  const kind = block.type === 'image' ? '图片' : '文件'
  const name = typeof ref?.name === 'string' && ref.name.length > 0 ? ref.name : '(未命名)'
  const bits = []
  if (typeof ref?.mediaType === 'string' && ref.mediaType.length > 0) bits.push(ref.mediaType)
  if (Number.isFinite(ref?.bytes)) bits.push(`${ref.bytes} 字节`)
  const meta = bits.length > 0 ? `（${bits.join('，')}）` : ''
  return `[${kind}附件] ${name}${meta}`
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.csv', '.tsv', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat',
  '.sql', '.html', '.htm', '.css', '.xml', '.ini', '.toml', '.conf', '.env', '.gitignore',
])

/** Office/PDF text extraction, run through the bundled Python runtime. */
const PY_EXTRACT = `
import sys, os
path = sys.argv[1]
ext = os.path.splitext(path)[1].lower()
out = []
add = out.append
try:
    if ext == '.docx':
        import docx
        d = docx.Document(path)
        for p in d.paragraphs:
            t = p.text.strip()
            if t: add(t)
        for t in d.tables:
            for row in t.rows:
                add(' | '.join(c.text.strip() for c in row.cells))
    elif ext == '.xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        for ws in wb.worksheets:
            add('## sheet %s' % ws.title)
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i >= 500: break
                add(' | '.join('' if v is None else str(v) for v in row))
    elif ext == '.pptx':
        from pptx import Presentation
        prs = Presentation(path)
        for i, s in enumerate(prs.slides, 1):
            add('## slide %d' % i)
            for sh in s.shapes:
                if getattr(sh, 'has_text_frame', False) and sh.text_frame.text.strip():
                    add(sh.text_frame.text.strip())
    elif ext == '.pdf':
        from pypdf import PdfReader
        r = PdfReader(path)
        for i, page in enumerate(r.pages, 1):
            add('## page %d' % i)
            add((page.extract_text() or '').strip())
    else:
        sys.exit(3)
except SystemExit:
    raise
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(2)
sys.stdout.write('\\n'.join(out)[:200000])
`

function resolvePython(cfg) {
  const explicit = cfg.attachments.pythonPath
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  const bundled = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  return existsSync(bundled) ? bundled : 'python'
}

function runPython(python, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(python, args, { windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      reject(new Error('attachment extraction timed out'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { if (out.length < 500_000) out += chunk })
    child.stderr.on('data', (chunk) => { if (err.length < 4_000) err += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error((err || `extractor exited with ${code}`).trim().slice(0, 400)))
    })
    child.stdin.end()
  })
}

/** Resolve the durable attachment reference to its readable host copy. */
function resolveAttachmentPath(ctx, ref) {
  let attachments
  try {
    attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  } catch {
    return undefined
  }
  try {
    return attachments?.fileHostPath?.(ref) ?? attachments?.imageHostPath?.(ref)
  } catch {
    return undefined
  }
}

/**
 * Turn one attachment block into planner input. Images are forwarded as image
 * blocks when the routed model accepts them; files are extracted to text.
 */
async function attachmentSection(ctx, block, cfg, signal) {
  const ref = block.attachment ?? block.ref ?? block
  const label = describeAttachment(block)

  if (block.type === 'image') {
    return { label, image: cfg.attachments.images ? block : undefined, text: undefined }
  }

  const path = resolveAttachmentPath(ctx, ref)
  if (path === undefined) return { label, text: `${label}\n[无法定位附件的落盘副本，内容未读取]` }

  const ext = extname(path).toLowerCase()
  try {
    let text
    if (TEXT_EXTENSIONS.has(ext)) {
      text = readFileSync(path, 'utf8').slice(0, cfg.attachments.maxChars)
    } else {
      text = (await runPython(resolvePython(cfg), ['-X', 'utf8', '-c', PY_EXTRACT, path], cfg.attachments.timeoutMs))
        .slice(0, cfg.attachments.maxChars)
    }
    const body = text.trim()
    return {
      label,
      text: body.length === 0
        ? `${label}\n[文件为空，或该格式没有可提取的文本]`
        : `${label}\n--- 内容开始 ---\n${body}\n--- 内容结束 ---`,
    }
  } catch (error) {
    return { label, text: `${label}\n[内容提取失败：${error?.message ?? error}]` }
  }
}

/**
 * Rough token estimate. CJK text is about one token per character, other text
 * about four characters per token. DSH's own meter uses a flat 4 chars/token,
 * which badly underestimates Chinese, so CJK is counted separately here.
 */
function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other / 4)
}

function isRootAgent(ctx, agent) {
  const roots = ctx.agents?.roots?.()
  if (!Array.isArray(roots)) return true
  // Compare by id: reference identity is an implementation detail of the registry.
  return roots.some((root) => root === agent || (root?.id !== undefined && root.id === agent?.id))
}

/** Drain one stream into text, surfacing terminal failures as throws. */
async function drain(stream, label) {
  let streamed = ''
  const closedBlocks = []
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') streamed += chunk.text
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') closedBlocks.push(chunk.block.text)
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    throw new Error(finish.failure?.message ?? `${label} ${finish.kind}`)
  }
  return { text: (streamed.trim().length > 0 ? streamed : closedBlocks.join('\n')).trim(), finish }
}

/**
 * Cheap DeepSeek pre-pass. Long input only; on any failure the caller keeps the
 * raw text, so this can never block a turn.
 */
async function condense(ctx, cfg, task, signal) {
  const c = cfg.condense
  if (!c.enabled) return { brief: task, condensed: false }

  const input = task.length > c.maxInputChars
    ? `${task.slice(0, c.maxInputChars)}\n\n[输入过长，已截断]`
    : task

  const timeout = AbortSignal.timeout(Math.max(5_000, c.timeoutMs))
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  const { text } = await drain(ctx.llm.stream({
    provider: c.provider,
    model: c.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: CONDENSE_PROMPT }] },
      { role: 'user', content: [{ type: 'text', text: input }] },
    ],
    maxTokens: c.maxTokens,
    purpose: 'planner-condense',
    signal: combined,
  }), 'condenser request')

  if (text.length === 0) throw new Error('condenser produced no text')
  return { brief: text.slice(0, c.maxChars), condensed: true }
}

function buildRequest(cfg, task, signal, images = []) {
  const timeout = AbortSignal.timeout(Math.max(5_000, cfg.timeoutMs))
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

  const options = {
    provider: cfg.provider,
    model: cfg.model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
      { role: 'user', content: [{ type: 'text', text: task }, ...images] },
    ],
    maxTokens: cfg.maxTokens,
    purpose: 'planner',
    signal: combined,
  }
  if (typeof cfg.reasoningEffort === 'string' && cfg.reasoningEffort.length > 0) {
    options.reasoningEffort = cfg.reasoningEffort
  }
  return options
}

async function planOnce(ctx, cfg, task, signal, images = []) {
  const options = buildRequest(cfg, task, signal, images)
  const { text, finish } = await drain(ctx.llm.stream(options), 'planner request')
  if (text.length === 0) throw new Error('planner produced no text')

  // Echo the exact fields handed to the adapter: the header above the plan is
  // only a label, this is what the request actually carried.
  return {
    text,
    request: {
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort ?? null,
      maxTokens: options.maxTokens,
      finish: finish?.kind ?? null,
    },
  }
}

function framePlan(cfg, plan, condensed) {
  return [
    `【规划阶段 · 由 ${cfg.provider}/${cfg.model} 生成，逐轮自动触发】${
      condensed ? `（输入已由 ${cfg.condense.provider}/${cfg.condense.model} 精简）` : ''
    }`,
    '以下是针对本轮任务的执行大纲，供你参考：它既不是用户的新指令，也不要求逐字照做。',
    '按大纲推进；发现大纲与实际情况不符时，以事实为准并说明原因。',
    '',
    plan,
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  // Shallow merge would let a partial `condense` block drop provider/model.
  cfg.condense = { ...DEFAULTS.condense, ...(config?.condense ?? {}) }
  const state = loadState()

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (req.method === 'GET') return send(res, 200, { ...state, build: BUILD })
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req)
        if (typeof body?.enabled === 'boolean') {
          state.enabled = body.enabled
          saveState(state)
        }
        return send(res, 200, { ...state, build: BUILD })
      },
    }), 'plan-mode: state route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-plan-mode/selftest',
      handler: async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        const body = await readJsonBody(req, 64 * 1024)
        const task = typeof body?.task === 'string' && body.task.trim().length > 0 ? body.task : SAMPLE_TASK
        // Diagnostic hole: extract the given absolute paths exactly as an
        // attachment would be extracted, so extraction can be tested without a
        // real upload. Read-only, bounded, localhost only.
        const extractions = []
        for (const target of Array.isArray(body?.paths) ? body.paths.slice(0, 8) : []) {
          if (typeof target !== 'string' || target.length === 0) continue
          try {
            const ext = extname(target).toLowerCase()
            const extracted = TEXT_EXTENSIONS.has(ext)
              ? readFileSync(target, 'utf8').slice(0, cfg.attachments.maxChars)
              : (await runPython(resolvePython(cfg), ['-X', 'utf8', '-c', PY_EXTRACT, target], cfg.attachments.timeoutMs))
                  .slice(0, cfg.attachments.maxChars)
            extractions.push({ path: target, chars: extracted.length, head: extracted.slice(0, 400) })
          } catch (error) {
            extractions.push({ path: target, error: String(error?.message ?? error) })
          }
        }
        const started = Date.now()
        try {
          const tokens = estimateTokens(task)
          let brief = task
          let condensed = false
          if (tokens > cfg.condense.minTokens) {
            try {
              const pre = await condense(ctx, cfg, task, undefined)
              brief = pre.brief
              condensed = pre.condensed
            } catch (error) {
              console.warn(`[plan-mode] selftest condense failed, using raw input: ${error?.message ?? error}`)
            }
          }
          const result = await planOnce(ctx, cfg, brief, undefined)
          return send(res, 200, {
            ok: true,
            build: BUILD,
            ms: Date.now() - started,
            tokens,
            condensed,
            inputChars: task.length,
            briefChars: brief.length,
            brief,
            extractions,
            request: result.request,
            chars: result.text.length,
            text: result.text,
          })
        } catch (error) {
          return send(res, 200, { ok: false, build: BUILD, ms: Date.now() - started, error: error?.message ?? String(error) })
        }
      },
    }), 'plan-mode: selftest route')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-plan-mode/agents',
      handler: async (req, res) => {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        const roots = ctx.agents.roots()
        const all = ctx.agents.list()
        return send(res, 200, {
          build: BUILD,
          roots: roots.map((agent) => agent.id),
          all: all.map((agent) => ({ id: agent.id, root: isRootAgent(ctx, agent) })),
        })
      },
    }), 'plan-mode: agents route')
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (!state.enabled) return decision
      if (decision.kind !== 'enter' || payload.step !== 1) return decision
      if (!isRootAgent(ctx, payload.agent)) return decision

      const { text, attachments } = readTask(decision.messages)
      const hasAttachments = attachments.length > 0
      // Nothing to analyze: no text and no attachment.
      if (text.length === 0 && !hasAttachments) return decision

      // Short inputs are skipped unless an attachment gives the planner
      // something concrete to describe.
      const minChars = Number(cfg.minChars)
      if (Number.isFinite(minChars) && minChars > 0 && text.length < minChars && !hasAttachments) {
        return decision
      }

      // Attachments are always reduced to text (or forwarded as images); their
      // extracted body stays verbatim so the plan can describe the structure.
      const sections = []
      const images = []
      for (const block of attachments) {
        const section = await attachmentSection(ctx, block, cfg, payload.signal)
        if (section.image !== undefined) images.push(section.image)
        if (section.text !== undefined) sections.push(section.text)
      }

      let briefText = text
      let condensed = false
      const tokens = estimateTokens(text)
      if (cfg.condense.enabled && tokens > cfg.condense.minTokens) {
        try {
          const pre = await condense(ctx, cfg, text, payload.signal)
          briefText = pre.brief
          condensed = pre.condensed
        } catch (error) {
          // Keep the raw request: condensing is an optimization, not a gate.
          console.warn(`[plan-mode] condense failed, planning from raw input: ${error?.message ?? error}`)
        }
      }

      const composed = [briefText, ...sections].filter((part) => part.length > 0).join('\n\n')
        || '（用户只发了图片，内容见附图）'

      let plan
      try {
        plan = (await planOnce(ctx, cfg, composed, payload.signal, images)).text
      } catch (error) {
        if (images.length === 0) throw error
        // The route may not accept image input: retry once, text only.
        console.warn(`[plan-mode] image request rejected, retrying text-only: ${error?.message ?? error}`)
        const retry = await planOnce(
          ctx,
          cfg,
          `${composed}\n\n[图片未能传给规划器，仅有文字可用]`,
          payload.signal,
          [],
        )
        plan = retry.text
      }
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: framePlan(cfg, plan, condensed) }],
            source: { kind: 'plan-mode' },
          },
        ],
      }
    } catch (error) {
      // Fail open: an optional planning pass must never take the turn down.
      const reason = error?.message ?? String(error)
      console.warn(`[plan-mode] skipped this turn: ${reason}`)
      if (cfg.notifyOnFailure === false) return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: randomUUID(),
            role: 'user',
            content: [{
              type: 'text',
              text: `【规划阶段未产出大纲，本轮已按原样继续】\n原因：${reason}`,
            }],
            source: { kind: 'plan-mode' },
          },
        ],
      }
    }
  })
}
