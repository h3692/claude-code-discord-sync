import { BORDER } from './tmux.ts'

export type ToolState = 'running' | 'ok' | 'error'
export type Tool = { id: string; name: string; input: Record<string, unknown>; state: ToolState }
export type AgentState = 'running' | 'completed' | 'failed' | 'stopped'
export type Agent = { id: string; agentType: string; description: string; state: AgentState; durationMs?: number }

export const ACTIVITY_LINES_PER_MESSAGE = 15
const MESSAGE_MAX = 2000
const EMBED_MAX = 4096
// Leaves room in a message for a reopened fence and its closing ``` around a line.
const LINE_MAX = 1900

const TOOL_GLYPHS = { running: '⏳', ok: '✅', error: '❌' }
const AGENT_GLYPHS = { running: '⏳', completed: '✅', failed: '❌', stopped: '⏹️' }
const TOOL_LABELS: Record<string, string> = {
  Read: '📄 Read', Write: '📝 Write', Edit: '✏️ Edit', MultiEdit: '✏️ Edit', NotebookEdit: '✏️ Edit',
  Bash: '▶️ Run', Grep: '🔍 Search', Glob: '🔍 Find', WebFetch: '🌐 Fetch', WebSearch: '🌐 Search web',
  Skill: '🧩 Skill', TodoWrite: '📋 Todos',
}

export function toolLine(t: Tool, cwd: string): string {
  const label = TOOL_LABELS[t.name]
    ?? (t.name.startsWith('mcp__') ? `🔌 ${truncate(t.name.split('__').at(-1) ?? '', 30)}` : `🔧 ${truncate(t.name, 30)}`)
  // Strip what would break inline code: backticks and line breaks.
  const target = truncate(String(toolTarget(t, cwd)).replace(/`/g, "'").replace(/\s+/g, ' ').trim(), 80)
  return `-# ${label}${target ? ` \`${target}\`` : ''} ${TOOL_GLYPHS[t.state]}`
}

// Inputs come straight from the transcript, so fields may be missing.
function toolTarget(t: Tool, cwd: string): unknown {
  const input = t.input as Record<string, any>
  const rel = (p: string) => (p.startsWith(cwd + '/') || p.startsWith(cwd + '\\') ? p.slice(cwd.length + 1) : p)
  switch (t.name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return rel(String(input.file_path ?? input.notebook_path ?? ''))
    case 'Bash': return input.description || String(input.command ?? '').split('\n')[0]
    case 'Grep': return `"${input.pattern ?? ''}"${input.path ? ` in ${rel(String(input.path))}` : ''}`
    case 'Glob': return input.pattern ?? ''
    case 'WebFetch':
      try {
        return new URL(input.url).hostname
      } catch {
        return input.url ?? ''
      }
    case 'WebSearch': return `"${input.query ?? ''}"`
    case 'Skill': return input.skill ?? ''
    default: return ''
  }
}

export function renderActivity(tools: Tool[], cwd: string): string[] {
  const chunks: string[] = []
  for (let i = 0; i < tools.length; i += ACTIVITY_LINES_PER_MESSAGE) {
    chunks.push(tools.slice(i, i + ACTIVITY_LINES_PER_MESSAGE).map((t) => toolLine(t, cwd)).join('\n'))
  }
  if (chunks.length) chunks[0] = `-# ⚙️ ${tools.some((t) => t.state === 'running') ? 'Working…' : 'Done'}\n${chunks[0]}`
  return chunks
}

export function renderAgents(agents: Agent[]): string {
  const running = agents.filter((a) => a.state === 'running').length
  const done = agents.length - running
  const header = ['**🤖 Subagents**', running && `${running} running`, done && `${done} done`].filter(Boolean).join(' · ')
  const line = (a: Agent) =>
    `${AGENT_GLYPHS[a.state]} **${a.agentType}** ${truncate(a.description.replace(/\s+/g, ' '), 100)}`.trimEnd()
    + (a.durationMs !== undefined ? ` · ${formatDuration(a.durationMs)}` : '')
  // Drop the oldest finished agents first, then the oldest running ones, until it fits.
  const kept = [...agents]
  let dropped = 0
  const text = () => [header, ...kept.map(line), ...(dropped ? [`… and ${dropped} more`] : [])].join('\n')
  while (text().length > MESSAGE_MAX) {
    const i = kept.findIndex((a) => a.state !== 'running')
    kept.splice(i === -1 ? 0 : i, 1)
    dropped++
  }
  return text()
}

export function renderText(text: string): string[] {
  if (!text.trim()) return []
  return chunk(convertTables(text.split('\n')).flatMap(hardSplit))
}

export function renderPrompt(text: string): string[] {
  if (!text.trim()) return []
  return chunk(['-# 🧑 from terminal', ...text.split('\n').flatMap(hardSplit).map((l) => (l ? `> ${l}` : '>'))])
}

export function renderDone(durationMs: number, pendingAgents: number, userId: string): string {
  const pending = pendingAgents > 0
    ? ` · ${pendingAgents} background agent${pendingAgents === 1 ? '' : 's'} still running`
    : ''
  return `✅ Done in ${formatDuration(durationMs)} <@${userId}>${pending}`
}

export function renderCard(screen: string): { title: string; description: string } {
  // Start below the prompt's top border, the same region its hash covers, so earlier chat stays out.
  const lines = screen.replace(/\n$/, '').split('\n').map((l) => l.trimEnd())
  const top = lines.findIndex((l) => BORDER.test(l))
  let body = lines.slice(top + 1).join('\n')
  if (`\`\`\`\n${body}\n\`\`\``.length > EMBED_MAX) {
    // Keep the bottom, where the options are, starting at a whole line.
    const tail = body.slice(-(EMBED_MAX - '```\n…\n\n```'.length))
    const nl = tail.indexOf('\n')
    body = `…\n${nl === -1 ? tail : tail.slice(nl + 1)}`
  }
  return { title: '🟡 Claude needs you', description: `\`\`\`\n${body}\n\`\`\`` }
}

export function renderEnded(deleteAfterMs: number): string {
  return `-# 🔚 Session ended · this channel is deleted in ${formatDuration(deleteAfterMs)} · type \`!archive\` to keep it`
}

export function channelName(folder: string, label: string): string {
  const slug = (s: string) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug(slug(`${folder}-${label}`.toLowerCase()).slice(0, 100)) || 'session'
}

export function formatDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`
  const m = Math.floor((s % 3600) / 60)
  return m ? `${Math.floor(s / 3600)}h ${m}m` : `${Math.floor(s / 3600)}h`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  // Never cut a surrogate pair (an emoji) in half.
  const cut = /[\uD800-\uDBFF]/.test(s[max - 2]) ? max - 2 : max - 1
  return s.slice(0, cut) + '…'
}

function hardSplit(line: string): string[] {
  const pieces: string[] = []
  while (line.length > LINE_MAX) {
    const cut = /[\uD800-\uDBFF]/.test(line[LINE_MAX - 1]) ? LINE_MAX - 1 : LINE_MAX
    pieces.push(line.slice(0, cut))
    line = line.slice(cut)
  }
  pieces.push(line)
  return pieces
}

// Discord does not render markdown tables, so they become aligned text in a code block.
function convertTables(lines: string[]): string[] {
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
  const isSeparator = (l: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l)
  const cells = (l: string) => l.trim().slice(1, -1).split('|').map((c) => c.trim().replace(/\*\*|`/g, ''))
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) inFence = !inFence
    if (inFence || !isRow(lines[i]) || !isSeparator(lines[i + 1] ?? '')) {
      out.push(lines[i])
      continue
    }
    const rows = [cells(lines[i])]
    i += 2
    while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]))
    i--
    const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)))
    const format = (r: string[]) => widths.map((w, c) => (r[c] ?? '').padEnd(w)).join(' | ').trimEnd()
    out.push('```', format(rows[0]), widths.map((w) => '-'.repeat(w)).join('-+-'), ...rows.slice(1).map(format), '```')
  }
  return out
}

function isFence(line: string): boolean {
  return line.trimStart().startsWith('```')
}

// Packs lines into messages; a split inside a code block closes it and reopens it with the same language.
function chunk(lines: string[]): string[] {
  const chunks: string[] = []
  let current: string | undefined
  let fence = '' // the fence to reopen while inside a code block
  for (const line of lines) {
    const next = isFence(line) ? (fence ? '' : `\`\`\`${line.trimStart().match(/^```([\w+#.-]{0,30})/)?.[1] ?? ''}`) : fence
    if (current !== undefined && `${current}\n${line}${next ? '\n```' : ''}`.length > MESSAGE_MAX) {
      chunks.push(fence ? `${current}\n\`\`\`` : current)
      current = fence ? `${fence}\n${line}` : line
    } else {
      current = current === undefined ? line : `${current}\n${line}`
    }
    fence = next
  }
  if (current !== undefined) chunks.push(current)
  return chunks.filter((c) => c.trim())
}
