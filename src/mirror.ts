import { basename } from 'node:path'
import { channelName, renderActivity, renderAgents, renderDone, renderPrompt, renderText } from './render.ts'
import type { Agent, Tool } from './render.ts'
import type { Dialog } from './tmux.ts'
import type { TranscriptEvent } from './transcript.ts'

export type Button = { id: string; label: string } // id = customId, ≤100 chars
export type Action =
  | { type: 'create_channel'; name: string; topic: string }
  | { type: 'rename_channel'; name: string }
  | { type: 'send'; ref: string; content?: string; embed?: { title: string; description: string }; buttons?: Button[]; ping?: boolean }
  | { type: 'edit'; ref: string; content?: string; embed?: { title: string; description: string }; buttons?: Button[] } // buttons: [] removes them
  | { type: 'end_channel'; archive: boolean }
  | { type: 'paste'; text: string; replyTo: string } // replyTo = Discord message id to react ✅ on success
  | { type: 'keys'; keys: string[]; replyTo?: string }
  | { type: 'reply'; replyTo: string; content: string } // short bot reply to a user message or button (index decides reply vs ephemeral)

export type State = {
  key: string // `${pid}|${procStart}`
  sessionId: string
  folder: string // basename(cwd)
  cwd: string
  userId: string
  pane: string | null // null => read-only
  status: string
  titled: boolean
  channel: string // current channel name
  seq: number // ref counter
  tools: Tool[] // current activity stretch
  activityRefs: string[] // one ref per renderActivity chunk of the current stretch
  agents: Agent[] // current subagent panel
  agentsRef: string | null
  agentIds: string[] // every Agent tool_use id ever seen this session (so tool_end/agent_end map to agents)
  rendered: Record<string, string> // last content sent per activity/agents ref, to skip no-op edits
  card: { ref: string; hash: string | null; dialog: Dialog | null; answered: string | null } | null
  pendingEcho: string[] // normalized texts pasted from Discord, awaiting their transcript echo (cap 20)
  archiveOnEnd: boolean
}
export type Input =
  | { kind: 'events'; events: TranscriptEvent[] }
  | { kind: 'status'; status: string; screen: string | null } // screen captured only when status === 'waiting' and pane != null
  | { kind: 'session_changed'; sessionId: string }
  | { kind: 'ended' }
  | { kind: 'message'; id: string; text: string }
  | { kind: 'button'; id: string; n: number; hash: string; status: string; screen: string | null } // fresh status+capture taken at click time

const TOPIC = /^ccds\|(\d+)\|([^|]+)(?:\|ended:(\d+))?$/

export function newMirror(
  s: { pid: number; procStart: string; sessionId: string; cwd: string; name: string; pane: string | null; status: string },
  userId: string,
): { state: State; actions: Action[] } {
  const folder = basename(s.cwd)
  const channel = channelName(folder, s.name)
  const state: State = {
    key: `${s.pid}|${s.procStart}`, sessionId: s.sessionId, folder, cwd: s.cwd, userId, pane: s.pane, status: s.status,
    titled: false, channel, seq: 0, tools: [], activityRefs: [], agents: [], agentsRef: null, agentIds: [], rendered: {},
    card: null, pendingEcho: [], archiveOnEnd: false,
  }
  return { state, actions: [{ type: 'create_channel', name: channel, topic: topicFor(s.pid, s.procStart) }] }
}

export function step(state: State, input: Input): { state: State; actions: Action[] } {
  // Copy every array this step may change; elements are replaced, never mutated.
  const s: State = {
    ...state, tools: [...state.tools], activityRefs: [...state.activityRefs], agents: [...state.agents],
    agentIds: [...state.agentIds], rendered: { ...state.rendered }, pendingEcho: [...state.pendingEcho],
  }
  const actions: Action[] = []
  const ref = () => `r${++s.seq}`
  const sendAll = (chunks: string[]) => chunks.forEach((content) => actions.push({ type: 'send', ref: ref(), content }))
  const closeStretch = () => {
    s.activityRefs.forEach((r) => delete s.rendered[r])
    s.tools = []
    s.activityRefs = []
  }
  const renderTools = () => {
    renderActivity(s.tools, s.cwd).forEach((content, i) => {
      const r = s.activityRefs[i]
      if (!r) {
        s.activityRefs.push(ref())
        actions.push({ type: 'send', ref: s.activityRefs[i], content })
      } else if (s.rendered[r] !== content) {
        actions.push({ type: 'edit', ref: r, content })
      }
      s.rendered[s.activityRefs[i]] = content
    })
  }
  const editPanel = () => {
    const content = renderAgents(s.agents)
    if (!s.agentsRef || s.rendered[s.agentsRef] === content) return
    actions.push({ type: 'edit', ref: s.agentsRef, content })
    s.rendered[s.agentsRef] = content
  }
  const setAgent = (id: string, patch: Partial<Agent>) => {
    s.agents = s.agents.map((a): Agent => (a.id === id ? { ...a, ...patch } : a))
    editPanel()
  }
  const closeCard = (content: string) => {
    if (s.card) actions.push({ type: 'edit', ref: s.card.ref, content, buttons: [] })
    s.card = null
  }

  switch (input.kind) {
    case 'events':
      for (const e of input.events) {
        switch (e.kind) {
          case 'prompt': {
            const i = s.pendingEcho.indexOf(e.text.trim().replace(/\r\n/g, '\n'))
            if (i !== -1) {
              s.pendingEcho.splice(i, 1)
              break
            }
            closeStretch()
            sendAll(renderPrompt(e.text))
            break
          }
          case 'text':
            closeStretch()
            sendAll(renderText(e.text))
            break
          case 'tool_start':
            s.tools.push({ id: e.id, name: e.name, input: e.input, state: 'running' })
            renderTools()
            break
          case 'tool_end':
            if (s.agentIds.includes(e.id)) {
              setAgent(e.id, { state: e.ok ? 'completed' : 'failed' })
            } else if (s.tools.some((t) => t.id === e.id)) {
              s.tools = s.tools.map((t): Tool => (t.id === e.id ? { ...t, state: e.ok ? 'ok' : 'error' } : t))
              renderTools()
            }
            break
          case 'agent_start': {
            if (!s.agentIds.includes(e.id)) s.agentIds.push(e.id)
            const agent: Agent = { id: e.id, agentType: e.agentType, description: e.description, state: 'running' }
            if (s.agentsRef && s.agents.some((a) => a.state === 'running')) {
              s.agents.push(agent)
              editPanel()
            } else {
              s.agents = [agent]
              s.agentsRef = ref()
              s.rendered[s.agentsRef] = renderAgents(s.agents)
              actions.push({ type: 'send', ref: s.agentsRef, content: s.rendered[s.agentsRef] })
            }
            break
          }
          case 'agent_end':
            if (s.agentIds.includes(e.id)) {
              setAgent(e.id, e.durationMs === undefined ? { state: e.status } : { state: e.status, durationMs: e.durationMs })
            }
            break
          case 'turn_end':
            // Some completions carry no id, so with nothing pending every running agent is done.
            if (e.pendingAgents === 0) {
              s.agents = s.agents.map((a): Agent => (a.state === 'running' ? { ...a, state: 'completed' } : a))
              editPanel()
            }
            closeStretch()
            actions.push({ type: 'send', ref: ref(), content: renderDone(e.durationMs, e.pendingAgents, s.userId), ping: true })
            break
          case 'title': {
            if (s.titled) break
            s.titled = true
            const name = channelName(s.folder, e.title)
            if (name !== s.channel) {
              s.channel = name
              actions.push({ type: 'rename_channel', name })
            }
            break
          }
        }
      }
      break
    case 'session_changed':
      closeCard('-# 🔄 session restarted')
      actions.push({ type: 'send', ref: ref(), content: '-# ── new conversation ──' })
      Object.assign(s, { sessionId: input.sessionId, tools: [], activityRefs: [], agents: [], agentsRef: null, rendered: {} })
      break
    case 'ended':
      closeCard('-# 🔚 session ended')
      actions.push({ type: 'end_channel', archive: s.archiveOnEnd })
      break
    case 'status':
      s.status = input.status
      break
    // 'message' and 'button' are handled by the inbound and cards work.
  }
  return { state: s, actions }
}

export function topicFor(pid: number, procStart: string): string {
  return `ccds|${pid}|${procStart}`
}

export function parseTopic(topic: string | null): { pid: number; procStart: string; endedAt: number | null } | null {
  const m = topic?.match(TOPIC)
  if (!m) return null
  return { pid: Number(m[1]), procStart: m[2], endedAt: m[3] === undefined ? null : Number(m[3]) }
}

export function endedTopic(topic: string, now: number): string {
  return `${topic.replace(/\|ended:\d+$/, '')}|ended:${now}`
}

export function isDue(topic: string | null, now: number, ttlMs: number): boolean {
  const endedAt = parseTopic(topic)?.endedAt ?? null
  return endedAt !== null && now - endedAt >= ttlMs
}

export function pickArchiveCategory(
  categories: { id: string; name: string; count: number }[],
  guildChannelCount: number,
): { id: string } | { create: string } | { refuse: string } {
  if (guildChannelCount >= 500) return { refuse: "Discord's 500-channel limit is reached — delete some channels first" }
  const open = categories.find((c) => /^Archive( \d+)?$/.test(c.name) && c.count < 50)
  if (open) return { id: open.id }
  const names = new Set(categories.map((c) => c.name))
  let n = 1
  while (names.has(n === 1 ? 'Archive' : `Archive ${n}`)) n++
  return { create: n === 1 ? 'Archive' : `Archive ${n}` }
}
