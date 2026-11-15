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
