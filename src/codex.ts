import { hashBody, type Dialog } from './tmux.ts'
import type { TranscriptEvent } from './transcript.ts'

export type CodexMeta = {
  id: string
  cwd: string
  originator: string
  threadSource: string
  historyMode: string
  forkedFromId: string | null
}

// Rollout lines are an undocumented format, so the parsed JSON stays loosely typed, as in transcript.ts.
// Only event_msg lines are read; response_item, turn_context, token_count and the rest repeat or add nothing we show.
// since (epoch ms): drop lines written before it.
export function parseCodexLine(line: string, since?: number): TranscriptEvent[] {
  try {
    const entry = JSON.parse(line)
    if (entry.type !== 'event_msg') return []
    if (since !== undefined && typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) < since) return []
    const payload = entry.payload
    switch (payload.type) {
      case 'item_completed': return parseItem(payload.item)
      case 'task_complete': return [{ kind: 'turn_end', durationMs: payload.duration_ms ?? 0, pendingAgents: 0 }]
      // turn_aborted needs no ping; closing still-running sub-agent rows is the mirror's job, the parser keeps no state.
      default: return []
    }
  } catch {
    return []
  }
}

function parseItem(item: any): TranscriptEvent[] {
  switch (item.type) {
    case 'UserMessage': {
      const text = textOf(item.content, 'text')
      return !text.trim() || text.startsWith('<send_user_message_question_reply>') ? [] : [{ kind: 'prompt', text }]
    }
    case 'AgentMessage': {
      const text = textOf(item.content, 'Text')
      return text.trim() ? [{ kind: 'text', text }] : []
    }
    case 'CommandExecution':
      return tool(item.id, 'Bash', { command: commandOf(item.command) }, item.status === 'completed' && item.exit_code === 0)
    case 'FileChange':
      return Object.entries(item.changes).flatMap(([path, change]: [string, any]) =>
        tool(`${item.id}:${path}`, change.type === 'add' ? 'Write' : 'Edit', { file_path: path }, item.status === 'completed'))
    case 'McpToolCall':
      return tool(item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {}, item.status === 'completed')
    case 'Extension':
      return item.kind === 'web.search' ? tool(item.id, 'WebSearch', { query: item.query }, true) : []
    // agent_thread_id is the one id shared by an agent's started and finished items; rollouts carry no role, only a path.
    case 'SubAgentActivity':
      if (item.kind === 'started') return [{ kind: 'agent_start', id: item.agent_thread_id, agentType: 'subagent', description: item.agent_path ?? '' }]
      if (item.kind === 'completed') return [{ kind: 'agent_end', id: item.agent_thread_id, status: 'completed' }]
      if (item.kind === 'interrupted') return [{ kind: 'agent_end', id: item.agent_thread_id, status: 'stopped' }]
      return []
    default: return []
  }
}

// Codex logs a finished tool as one item, so its start and end arrive together.
function tool(id: string, name: string, input: Record<string, unknown>, ok: boolean): TranscriptEvent[] {
  return [{ kind: 'tool_start', id, name, input }, { kind: 'tool_end', id, ok }]
}

// Commands arrive wrapped as [shell, '-lc', script]; show the script itself.
function commandOf(command: unknown): string {
  if (!Array.isArray(command)) return String(command)
  return command.length === 3 && /^-l?c$/.test(command[1]) ? command[2] : command.join(' ')
}

function textOf(content: any[], type: string): string {
  return content.filter((b) => b.type === type).map((b) => b.text).join('\n')
}

// Line 0 of a rollout; null for anything else.
export function readCodexMeta(firstLine: string): CodexMeta | null {
  try {
    const entry = JSON.parse(firstLine)
    const p = entry.payload
    if (entry.type !== 'session_meta' || typeof p.id !== 'string') return null
    return { id: p.id, cwd: p.cwd, originator: p.originator, threadSource: p.thread_source, historyMode: p.history_mode, forkedFromId: p.forked_from_id ?? null }
  } catch {
    return null
  }
}

// Approval overlays draw this footer on the last row; the titles are the ones Codex's approval views use.
const APPROVAL_FOOTER = '  Press enter to confirm or esc to cancel'
const APPROVAL_TITLES = new Set([
  'Would you like to run the following command?', 'Would you like to make the following edits?',
  'Would you like to grant these permissions?', 'Would you like to send input to the existing terminal?',
])
const APPROVAL_TITLE = /^(Do you want to approve network access to .+|\S.* needs your approval\.)$/
const CODEX_OPTION = /^(›| ) (\d+)\. (.+)$/
// The key hint after a label: (y), (p), (a), (esc).
const SHORTCUT = /\s+\((?:[a-z]|esc)\)$/
// Below the composer: `  <model> <effort> · <cwd>[ · <title>]`, then a hint row that is blank while drafting or in a popup.
const STATUS = /^  \S.* · \S/
const HINT = /^ *(← for agents · )?(\? for shortcuts|tab to queue message)?( +⚠ \d+ warnings? · f2 to view)? *$/

// Decides whether the app may type into a Codex pane, so anything not positively recognised is unknown.
export function codexScreen(screen: string): { state: 'waiting' | 'idle' | 'unknown'; dialog: Dialog | null } {
  const lines = screen.replace(/\n$/, '').split('\n')
  return approval(lines) ?? (idle(lines) ? { state: 'idle', dialog: null } : { state: 'unknown', dialog: null })
}

function approval(lines: string[]): { state: 'waiting'; dialog: Dialog | null } | null {
  const end = lines.findLastIndex((l) => l.trim())
  if (end < 0 || lines[end].trimEnd() !== APPROVAL_FOOTER) return null
  const title = lines.findLastIndex((l, i) => i < end && (APPROVAL_TITLES.has(l.trim()) || APPROVAL_TITLE.test(l.trim())))
  if (title < 0 || lines.slice(title + 1, end).filter((l) => /^› \d+\. /.test(l)).length !== 1) return null

  // Complete or nothing: the list right above the footer must be options 1..N, one row each.
  let last = end - 1
  while (last > title && !lines[last].trim()) last--
  let first = last
  while (first - 1 > title && CODEX_OPTION.test(lines[first - 1])) first--
  const options: { n: number; label: string }[] = []
  let cursor = 0
  for (let i = first; i <= last; i++) {
    const m = CODEX_OPTION.exec(lines[i])
    if (!m || Number(m[2]) !== options.length + 1) return { state: 'waiting', dialog: null }
    if (m[1] === '›') cursor = Number(m[2])
    options.push({ n: Number(m[2]), label: m[3].trimEnd().replace(SHORTCUT, '') })
  }
  if (options.length < 2 || !cursor) return { state: 'waiting', dialog: null }
  // Title, command or destination, and options, so a different request gets a different hash and cursor moves don't.
  const hash = hashBody(lines.slice(title, last + 1).map((l) => l.replace(/^›/, '')))
  return { state: 'waiting', dialog: { question: lines[title].trim(), options, hash, cursor } }
}

// Bottom up: hint row, status row, a blank row, the composer (`› ` then indented continuation rows), two blank rows.
// The two blank rows are what tell a draft from a popup, which sits right above the composer when the hint row is blank.
function idle(lines: string[]): boolean {
  const n = lines.length
  if (n < 6 || !HINT.test(lines[n - 1]) || !STATUS.test(lines[n - 2]) || HINT.test(lines[n - 2]) || lines[n - 3].trim()) return false
  let top = n - 4
  while (top >= 0 && lines[top].startsWith('  ') && lines[top].trim()) top--
  return top >= 2 && lines[top].startsWith('› ') && !lines[top - 1].trim() && !lines[top - 2].trim()
}
