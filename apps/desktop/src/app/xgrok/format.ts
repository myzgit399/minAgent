/**
 * grok-build output formatting shared by the xGrok tab.
 *
 * The engine emits one JSON event per wire line (`StreamingJson`), with streamed
 * text arriving in many small `{"type":"text","data":"..."}` chunks. Rendering
 * one row per chunk would stack single words vertically, so consecutive text /
 * thought chunks are folded into one block and the colouring follows grok's TUI:
 * thoughts dim, tools neutral, results bright, errors red.
 */

/** `/` commands offered in the xGrok composer (the tab or the engine handles them). */
export const SLASH_COMMANDS = [
  '/help',
  '/new',
  '/clear',
  '/model',
  '/effort',
  '/proxy',
  '/cwd',
  '/cancel',
  '/status',
  '/context',
  '/compact',
  '/resume',
  '/tasks',
  '/agents',
  '/memory',
  '/plan',
  '/export'
] as const

export type LineKind = 'text' | 'thought' | 'tool' | 'result' | 'error'

export interface DisplayLine {
  key: number
  text: string
  kind: LineKind
}

interface Parsed {
  text: string
  kind: LineKind
  /** True for stream chunks that may be glued to the previous row. */
  stream: boolean
}

const ERROR_LEVEL_RE = /"(?:level|type)"\s*:\s*"error"/i

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Classify a non-JSON capability line (rare: only engine chatter). */
function plainKind(text: string): LineKind {
  if (ERROR_LEVEL_RE.test(text)) return 'error'
  if (/thought|thinking/i.test(text)) return 'thought'
  if (/tool_use|tool_call/i.test(text)) return 'tool'
  return 'text'
}

function parseOne(raw: string): Parsed {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { text: raw, kind: plainKind(raw), stream: false }
  }
  if (!parsed || typeof parsed !== 'object') return { text: raw, kind: plainKind(raw), stream: false }

  const type = str(parsed.type ?? parsed.kind)
  switch (type) {
    case 'text':
    case 'assistant':
    case 'agent_message_chunk': {
      // `data` is the streaming field; older shapes used text/content.
      const body = str(parsed.data) || str(parsed.text) || str(parsed.content)
      return { text: body || raw, kind: 'text', stream: Boolean(body) }
    }
    case 'thought':
    case 'thinking':
    case 'agent_thought_chunk': {
      const body = str(parsed.data) || str(parsed.text) || str(parsed.content)
      return { text: body || raw, kind: 'thought', stream: Boolean(body) }
    }
    case 'tool_call':
    case 'tool_use':
    case 'tool_result': {
      const name = str(parsed.name ?? parsed.tool ?? parsed.title) || 'tool'
      const origin = parsed.arguments ?? parsed.input ?? parsed.args
      let detail = ''
      if (typeof origin === 'string') detail = origin
      else if (origin) {
        try {
          detail = JSON.stringify(origin)
        } catch {
          detail = ''
        }
      }
      if (!detail) detail = str(parsed.data) || str(parsed.text)
      const mark = type === 'tool_result' ? '⇢' : '⚙'
      return { text: `${mark} ${name}${detail ? ` ${detail}` : ''}`, kind: 'tool', stream: false }
    }
    case 'available_commands':
    case 'commands': {
      // The engine announces its capability set twice per turn as a large JSON
      // blob; dumping that in the transcript is noise, so summarise it.
      const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0
      const cmds = Array.isArray(parsed.commands) ? parsed.commands.length : 0
      const bits = [tools ? `${tools} 工具` : '', cmds ? `${cmds} 命令` : ''].filter(Boolean)
      return { text: `▸ 引擎就绪${bits.length ? `（${bits.join(' · ')}）` : ''}`, kind: 'thought', stream: false }
    }
    case 'usage': {
      const u = parsed.usage ?? parsed
      const num = (v: any) => (typeof v === 'number' ? v : 0)
      const inp = num(u.input_tokens ?? u.inputTokens)
      const outT = num(u.output_tokens ?? u.outputTokens)
      const think = num(u.reasoning_tokens ?? u.reasoningTokens)
      const bits = [
        inp ? `${inp.toLocaleString('en-US')} in` : '',
        outT ? `${outT.toLocaleString('en-US')} out` : '',
        think ? `${think.toLocaleString('en-US')} 思考` : ''
      ].filter(Boolean)
      return { text: bits.length ? `▸ ${bits.join(' · ')}` : '', kind: 'result', stream: false }
    }
    case 'plan': {
      const steps = Array.isArray(parsed.steps) ? parsed.steps : []
      const body = steps.length
        ? `\n${steps.map((s: any, i: number) => `  ${i + 1}. ${str(s?.title) || str(s?.text) || String(s)}`).join('\n')}`
        : ''
      return { text: `◇ ${str(parsed.text) || str(parsed.message) || 'plan'}${body}`, kind: 'result', stream: false }
    }
    case 'error':
      return { text: `✖ ${str(parsed.message) || str(parsed.error) || str(parsed.data) || raw}`, kind: 'error', stream: false }
    case 'end':
    case 'xgrok_done': {
      const sid = str(parsed.sessionId ?? parsed.session_id)
      const ok = parsed.ok !== false
      if (!ok) return { text: `✖ 本轮失败：${str(parsed.error) || '未知错误'}`, kind: 'error', stream: false }
      return { text: `⏹ 本轮结束${sid ? ` · session ${sid}` : ''}`, kind: 'result', stream: false }
    }
    case 'session':
    case 'init':
    case 'result': {
      const sid = str(parsed.sessionId ?? parsed.session_id)
      return { text: sid ? `▸ session ${sid}` : raw, kind: 'result', stream: false }
    }
    default: {
      const body = str(parsed.text) || str(parsed.message) || str(parsed.content) || str(parsed.data) || raw
      return { text: body, kind: type && body !== raw ? (type as LineKind) : plainKind(raw), stream: false }
    }
  }
}

/** Fold a raw transcript into display rows, merging consecutive stream chunks. */
export function formatLines(raws: { id: number; text: string }[]): DisplayLine[] {
  const out: Array<DisplayLine & { stream: boolean }> = []
  // The engine re-announces its capability set every turn; keep the first row.
  const seenReady = new Set<string>()
  for (const raw of raws) {
    const one = parseOne(raw.text)
    if (!one.text) continue
    if (one.text.startsWith('▸ 引擎就绪')) {
      if (seenReady.has(one.text)) continue
      seenReady.add(one.text)
    }
    const last = out[out.length - 1]
    if (last && last.kind === one.kind) {
      // Stream chunks glue together; a repeated whole line is the engine saying
      // the same thing twice (it announces its capability set per turn twice).
      if (one.stream && last.stream) {
        last.text += one.text
        continue
      }
      if (!one.stream && last.text === one.text) continue
    }
    out.push({ key: raw.id, text: one.text, kind: one.kind, stream: one.stream })
  }
  return out.map(({ key, text, kind }) => ({ key, text, kind }))
}
