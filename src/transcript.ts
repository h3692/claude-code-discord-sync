import { open } from 'node:fs/promises'

export type TranscriptEvent =
  | { kind: 'prompt'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_end'; id: string; ok: boolean }
  | { kind: 'agent_start'; id: string; agentType: string; description: string }
  | { kind: 'agent_end'; id: string; status: 'completed' | 'failed' | 'stopped'; durationMs?: number }
  | { kind: 'turn_end'; durationMs: number; pendingAgents: number }
  | { kind: 'title'; title: string }
  | { kind: 'turn_aborted' } // Codex: the turn was interrupted; nothing to ping

type AgentStatus = 'completed' | 'failed' | 'stopped'
const AGENT_STATUSES = ['completed', 'failed', 'stopped']

// Transcript lines are an undocumented format, so the parsed JSON stays loosely typed.
// Any shape we did not expect throws inside and is treated as "no events".
// since (epoch ms): drop lines written before it; lines without a timestamp (ai-title, …) always pass.
export function parseLine(line: string, since?: number): TranscriptEvent[] {
  try {
    const entry = JSON.parse(line)
    if (entry.isSidechain) return []
    if (since !== undefined && typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) < since) return []
    switch (entry.type) {
      case 'user': return parseUser(entry)
      case 'attachment': return parseQueued(entry.attachment)
      case 'assistant': return parseAssistant(entry.message.content)
      case 'system':
        if (entry.subtype !== 'turn_duration') return []
        return [{ kind: 'turn_end', durationMs: entry.durationMs ?? 0, pendingAgents: entry.pendingBackgroundAgentCount ?? 0 }]
      case 'ai-title': return [{ kind: 'title', title: entry.aiTitle }]
      // An agent's completion is logged here first; the turn that reports it can end before the user line appears.
      case 'queue-operation':
        return entry.operation === 'enqueue' && entry.content.includes('<task-notification>') ? parseNotification(entry.content) : []
      default: return []
    }
  } catch {
    return []
  }
}

function parseUser(entry: any): TranscriptEvent[] {
  if (entry.isMeta || entry.isCompactSummary) return []
  const content = entry.message.content
  if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
    // A background Agent launch returns at once; its real end arrives later as a task-notification.
    if (entry.toolUseResult?.status === 'async_launched') return []
    return content
      .filter((b) => b.type === 'tool_result')
      .map((b) => ({ kind: 'tool_end', id: b.tool_use_id, ok: !b.is_error }))
  }
  const kind = entry.origin?.kind
  const text = textOf(content)
  if (kind === 'task-notification') return parseNotification(text)
  // Slash commands carry no origin, so check them before the human-only rule.
  if (text.startsWith('<command-name>')) {
    return [{ kind: 'prompt', text: `${tag(text, 'command-name') ?? ''} ${tag(text, 'command-args') ?? ''}`.trim() }]
  }
  if (kind !== 'human' || !text.trim() || text.startsWith('[Request interrupted by user')) return []
  return [{ kind: 'prompt', text }]
}

// Prompts typed while Claude is busy, and background-agent completions, arrive as queued commands.
function parseQueued(attachment: any): TranscriptEvent[] {
  if (attachment.type !== 'queued_command' || attachment.isMeta || attachment.origin?.kind === 'peer') return []
  const text = textOf(attachment.prompt)
  if (attachment.commandMode === 'task-notification' || text.includes('<task-notification>')) return parseNotification(text)
  return text.trim() ? [{ kind: 'prompt', text }] : []
}

function parseAssistant(content: any[]): TranscriptEvent[] {
  return content.flatMap((b): TranscriptEvent[] => {
    if (b.type === 'text') return b.text.trim() ? [{ kind: 'text', text: b.text }] : []
    if (b.type !== 'tool_use') return []
    if (b.name === 'Agent' || b.name === 'Task') {
      return [{ kind: 'agent_start', id: b.id, agentType: b.input?.subagent_type ?? 'general-purpose', description: b.input?.description ?? '' }]
    }
    return [{ kind: 'tool_start', id: b.id, name: b.name, input: b.input ?? {} }]
  })
}

// Notifications without a tool-use-id (resumed agents, plain "stopped by the user" text) can't be matched, so they emit nothing.
function parseNotification(text: string): TranscriptEvent[] {
  const id = tag(text, 'tool-use-id')
  const status = tag(text, 'status')
  if (!id || !status || !AGENT_STATUSES.includes(status)) return []
  const event: TranscriptEvent = { kind: 'agent_end', id, status: status as AgentStatus }
  // The <result> body can quote any text, so take the last duration_ms (the real one sits in the trailing <usage>).
  const ms = [...text.matchAll(/<duration_ms>(\d+)<\/duration_ms>/g)].at(-1)?.[1]
  if (ms) event.durationMs = Number(ms)
  return [event]
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

function tag(text: string, name: string): string | undefined {
  return text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]
}

export async function readAppended(file: string, from: number): Promise<{ lines: string[]; next: number }> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return { lines: [], next: from }
  }
  try {
    const { size } = await handle.stat()
    if (size < from) from = 0 // truncated or replaced
    // shortcut: one read of everything appended since `from`; fine for a tail polled often, chunk it if callers start from 0 on huge files.
    const buf = Buffer.alloc(size - from)
    const { bytesRead } = await handle.read(buf, 0, buf.length, from)
    const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (end === -1) return { lines: [], next: from }
    // Split bytes on newline before decoding, so a multi-byte character is never cut in half.
    const lines: string[] = []
    let start = 0
    while (start <= end) {
      const nl = buf.indexOf(0x0a, start)
      lines.push(buf.toString('utf8', start, nl))
      start = nl + 1
    }
    return { lines, next: from + end + 1 }
  } finally {
    await handle.close()
  }
}
