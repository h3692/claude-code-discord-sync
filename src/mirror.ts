import { basename } from 'node:path'
import { codexScreen } from './codex.ts'
import { channelName, renderActivity, renderAgents, renderCard, renderDone, renderPrompt, renderReadOnly, renderText } from './render.ts'
import type { Agent, Tool } from './render.ts'
import { parseDialog, parseKeys, sanitizePaste, screenHash } from './tmux.ts'
import type { Dialog } from './tmux.ts'
import type { TranscriptEvent } from './transcript.ts'

export type Button = { id: string; label: string } // id = customId, ≤100 chars
export type Action =
  | { type: 'create_channel'; name: string; topic: string }
  | { type: 'rename_channel'; name: string }
  | { type: 'send'; ref: string; content?: string; embed?: { title: string; description: string }; buttons?: Button[]; ping?: boolean }
  | { type: 'edit'; ref: string; content?: string; embed?: { title: string; description: string }; buttons?: Button[] } // buttons: [] removes them
  | { type: 'end_channel'; archive: boolean }
  | { type: 'paste'; text: string; replyTo: string; allowWaiting?: true } // replyTo = Discord message id to react ✅ on success; allowWaiting: from !type
  | { type: 'keys'; keys: string[]; replyTo?: string; hash?: string } // hash: the dialog a button click was validated against
  | { type: 'reply'; replyTo: string; content: string } // short bot reply to a user message or button (index decides reply vs ephemeral)
  | { type: 'set_topic'; topic: string }

export type State = {
  key: string // `${pid}|${procStart}`
  provider: 'claude' | 'codex'
  sessionId: string // '' for a Codex session whose rollout doesn't exist yet
  folder: string // basename(cwd)
  lock: string // channel name prefix marking a session Discord can't type into, kept across renames
  cwd: string
  userId: string
  pane: string | null // null => read-only
  status: string
  quiet: number // Codex: consecutive idle polls, so a card closes only once the prompt has stayed gone
  titled: boolean
  channel: string // current channel name
  seq: number // ref counter
  tools: Tool[] // current activity stretch
  activityRefs: string[] // one ref per renderActivity chunk of the current stretch
  agents: Agent[] // current subagent panel
  agentsRef: string | null
  agentIds: string[] // every Agent tool_use id ever seen this session (so tool_end/agent_end map to agents)
  rendered: Record<string, string> // last content sent per activity/agents ref, to skip no-op edits
  // screenHash: tells unreadable prompts apart; repeats: consecutive polls still showing the answered prompt
  card: { ref: string; hash: string | null; screenHash: string | null; dialog: Dialog | null; answered: string | null; repeats: number } | null
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
  | { kind: 'notice'; text: string }

const TOPIC = /^ccds\|(\d+)\|([^|]+)(\|archive)?(?:\|ended:(\d+))?$/
const EMBED_MAX = 4096
const HINT = "\n-# Can't read the options reliably — reply with `!keys 2`, `!keys Down Enter` or `!type your answer`"
const NO_TMUX = "Claude is waiting for you, but this session isn't in tmux — answer at the terminal."
const NO_SCREEN = "Claude is waiting for you, but the screen couldn't be read — answer at the terminal, or try `!keys`."
const CLOSED = 'That prompt is no longer open.'
const RETRY = "\n⚠️ That question is still open — try again, or send `!keys Enter`"
const READ_ONLY = "👀 Read-only: this session isn't running in tmux."
const BAD_KEYS = '⌨️ Allowed keys: digits 0-9, Up, Down, Left, Right, Enter, Escape, Tab, BTab, Space, BSpace (max 20). Example: `!keys Down Enter`'

// Claude Code records a pasted prompt as the sanitized paste, trimmed; both sides of the echo match use this.
// Leading format characters (zero-width space, BOM, …) are dropped too, so they can't hide a leading `!`;
// ones inside the text are kept, since emoji sequences and some scripts need joiners.
const normalize = (text: string) => sanitizePaste(text).replace(/^[\s\p{Cf}]+/u, '').trim()
// Fullwidth and small exclamation marks count as `!`.
export const SHELL = /^[!！﹗]/
// Polls after an answer that may still show the old screen; the same prompt past that was asked again.
const REPEATS = 3

export function newMirror(
  s: {
    pid: number; procStart: string; sessionId: string; cwd: string; name: string; pane: string | null; status: string; archiveOnEnd?: boolean; readOnly?: string | null
    provider?: 'claude' | 'codex'
  },
  userId: string,
): { state: State; actions: Action[] } {
  const folder = basename(s.cwd)
  // Session names often already start with the folder.
  const prefix = channelName(folder, '') + '-'
  const full = channelName(folder, s.name)
  const lock = s.readOnly ? '🔒-' : ''
  const channel = lock + (full.startsWith(prefix + prefix) ? full.slice(prefix.length) : full)
  const state: State = {
    key: `${s.pid}|${s.procStart}`, provider: s.provider ?? 'claude', sessionId: s.sessionId, folder, lock, cwd: s.cwd, userId, pane: s.pane,
    status: s.status, quiet: 0, titled: false, channel, seq: 0, tools: [], activityRefs: [], agents: [], agentsRef: null, agentIds: [], rendered: {},
    card: null, pendingEcho: [], archiveOnEnd: s.archiveOnEnd ?? false,
  }
  const actions: Action[] = [{ type: 'create_channel', name: channel, topic: topicFor(s.pid, s.procStart, state.archiveOnEnd) }]
  if (s.readOnly) actions.push({ type: 'send', ref: `r${++state.seq}`, content: renderReadOnly(s.readOnly) })
  return { state, actions }
}

// For a paste that index refused, so its echo doesn't swallow a later identical terminal prompt.
export function dropEcho(state: State, text: string): State {
  const i = state.pendingEcho.indexOf(normalize(text))
  return i === -1 ? state : { ...state, pendingEcho: state.pendingEcho.filter((_, j) => j !== i) }
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
  // Each provider draws its prompts its own way; Codex's parser never sets confirm.
  const dialogOf = (screen: string) => (s.provider === 'codex' ? codexScreen(screen).dialog : parseDialog(screen))
  // Replaces the embed too, so the old prompt no longer looks answerable.
  const closeCard = (content: string, title: string) => {
    if (s.card) actions.push({ type: 'edit', ref: s.card.ref, content, embed: { title, description: s.card.dialog?.question ?? 'prompt' }, buttons: [] })
    s.card = null
  }

  switch (input.kind) {
    case 'events':
      for (const e of input.events) {
        switch (e.kind) {
          case 'prompt': {
            const i = s.pendingEcho.indexOf(normalize(e.text))
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
          case 'turn_end': {
            // Some completions carry no id, so with nothing pending every running agent is done.
            if (e.pendingAgents === 0) {
              s.agents = s.agents.map((a): Agent => (a.state === 'running' ? { ...a, state: 'completed' } : a))
              editPanel()
            }
            closeStretch()
            // Claude Code's count can lag finished agents; agents started before we attached are only known to it.
            const running = s.agents.filter((a) => a.state === 'running').length
            const pending = s.agentIds.length ? Math.min(e.pendingAgents, running) : e.pendingAgents
            // A locked channel can't be acted on, so it never pings.
            actions.push(s.lock
              ? { type: 'send', ref: ref(), content: renderDone(e.durationMs, pending, null) }
              : { type: 'send', ref: ref(), content: renderDone(e.durationMs, pending, s.userId), ping: true })
            break
          }
          case 'turn_aborted':
            s.agents = s.agents.map((a): Agent => (a.state === 'running' ? { ...a, state: 'stopped' } : a))
            editPanel()
            closeStretch()
            break
          case 'title': {
            if (s.titled) break
            s.titled = true
            const name = s.lock + channelName(s.folder, e.title)
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
      // A pending Codex session's rollout appears at its first message: the same conversation, not a new one.
      if (!s.sessionId) {
        s.sessionId = input.sessionId
        break
      }
      closeCard('-# 🔄 session restarted', '🔄 Session restarted')
      actions.push({ type: 'send', ref: ref(), content: '-# ── new conversation ──' })
      Object.assign(s, { sessionId: input.sessionId, tools: [], activityRefs: [], agents: [], agentsRef: null, rendered: {} })
      break
    case 'ended':
      closeCard('-# 🔚 session ended', '🔚 Session ended')
      actions.push({ type: 'end_channel', archive: s.archiveOnEnd })
      break
    case 'status': {
      s.status = input.status
      if (input.status !== 'waiting') {
        // Codex: an unreadable screen proves nothing, and a queued approval can follow a single idle capture.
        s.quiet = input.status === 'idle' ? s.quiet + 1 : 0
        if (s.provider === 'codex' && s.quiet < 2) break
        if (s.card) closeCard(s.card.answered ? `✅ ${s.card.answered} — via Discord` : '✅ answered in terminal', '✅ Answered')
        break
      }
      s.quiet = 0
      const parsed = input.screen ? dialogOf(input.screen) : null
      // Discord allows 5 rows of 5 buttons.
      const dialog = parsed && parsed.options.length <= 25 ? parsed : null
      const buttons = (dialog?.options ?? []).map(({ n, label }): Button => {
        const text = `${n}. ${label}`
        const cut = /[\uD800-\uDBFF]/.test(text[78]) ? 78 : 79
        return { id: `ccds:${n}:${dialog!.hash}`, label: text.length > 80 ? text.slice(0, cut) + '…' : text }
      })
      const agent = s.provider === 'codex' ? 'Codex' : 'Claude'
      let embed = { title: renderCard('', agent).title, description: s.pane ? NO_SCREEN : NO_TMUX }
      if (input.screen) embed = renderCard(input.screen, agent)
      if (input.screen && !dialog) {
        const over = embed.description.length + HINT.length - EMBED_MAX
        if (over > 0) {
          // Drop whole lines from the top of the fenced screen to make room for the hint.
          const body = embed.description.slice(4, -4)
          const nl = body.indexOf('\n', over + 2)
          embed.description = `\`\`\`\n…${nl === -1 ? '' : body.slice(nl)}\n\`\`\``
        }
        embed.description += HINT
      }
      const shown = input.screen ? screenHash(input.screen) : null
      let retry = false
      if (s.card) {
        // A readable prompt is compared by its dialog hash, an unreadable one by its screen; a failed capture tells nothing.
        const same = dialog ? dialog.hash === s.card.hash : shown !== null && shown === s.card.screenHash
        const changed = !same && (dialog !== null || shown !== null)
        const repeats = s.card.answered && same ? s.card.repeats + 1 : 0
        if (s.card.answered && (changed || repeats >= REPEATS)) {
          // A new prompt after an answer from Discord gets its own card and ping.
          retry = !changed
          closeCard(`✅ ${s.card.answered} — via Discord`, '✅ Answered')
        } else if (changed) {
          // Buttons are replaced too, so an unreadable prompt doesn't keep the old prompt's.
          s.card = { ref: s.card.ref, hash: dialog?.hash ?? null, screenHash: shown, dialog, answered: null, repeats: 0 }
          actions.push({ type: 'edit', ref: s.card.ref, content: `<@${s.userId}>`, embed, buttons })
        } else {
          s.card = { ...s.card, repeats }
        }
      }
      if (!s.card) {
        s.card = { ref: ref(), hash: dialog?.hash ?? null, screenHash: shown, dialog, answered: null, repeats: 0 }
        actions.push(s.lock
          ? { type: 'send', ref: s.card.ref, embed, buttons }
          : { type: 'send', ref: s.card.ref, content: `<@${s.userId}>${retry ? RETRY : ''}`, embed, buttons, ping: true })
      }
      break
    }
    case 'button': {
      const dialog = input.screen ? dialogOf(input.screen) : null
      const option = dialog?.options.find((o) => o.n === input.n)
      if (!s.card || input.status !== 'waiting' || !dialog || dialog.hash !== input.hash || !option) {
        actions.push({ type: 'reply', replyTo: input.id, content: CLOSED })
      } else if (s.card.answered !== null && s.card.hash === input.hash) {
        actions.push({ type: 'reply', replyTo: input.id, content: 'Already sent.' })
      } else {
        s.card = { ref: s.card.ref, hash: dialog.hash, screenHash: screenHash(input.screen!), dialog, answered: option.label, repeats: 0 }
        // Codex: a digit picks and accepts, and the next queued approval shows at once, so an Enter would answer that one too.
        const confirm = dialog.confirm && s.provider !== 'codex'
        actions.push({ type: 'keys', keys: confirm ? [String(option.n), 'Enter'] : [String(option.n)], hash: dialog.hash })
        actions.push({
          type: 'edit', ref: s.card.ref, content: `⏳ sending ${option.n}. ${option.label}…`,
          embed: { title: '⏳ Sending', description: dialog.question }, buttons: [],
        })
      }
      break
    }
    case 'notice':
      actions.push({ type: 'send', ref: ref(), content: input.text })
      break
    case 'message': {
      // Normalized up front so the `!` checks see what the paste would actually type.
      const text = normalize(input.text)
      const reply = (content: string) => actions.push({ type: 'reply', replyTo: input.id, content })
      const paste = (t: string, allowWaiting = false) => {
        actions.push(allowWaiting ? { type: 'paste', text: t, replyTo: input.id, allowWaiting } : { type: 'paste', text: t, replyTo: input.id })
        s.pendingEcho = [...s.pendingEcho, t].slice(-20)
      }
      if (!text) break
      if (SHELL.test(text)) {
        const [, cmd, args = ''] = text.match(/^!(\w+)(?:\s[\s\p{Cf}]*([\s\S]*))?$/u) ?? []
        switch (cmd?.toLowerCase()) {
          case 'keys': {
            const keys = parseKeys(args)
            if (!keys) reply(BAD_KEYS)
            else if (!s.pane) reply(READ_ONLY)
            else {
              actions.push({ type: 'keys', keys, replyTo: input.id })
              // Only a digit or Enter answers a prompt; arrows just move the cursor.
              if (s.card && keys.some((k) => /^\d$/.test(k) || k === 'Enter')) s.card = { ...s.card, answered: `\`!keys ${args.trim()}\``, repeats: 0 }
            }
            break
          }
          case 'type':
            if (!s.pane) reply(READ_ONLY)
            else if (!args) reply('✍️ Usage: `!type your answer`')
            else if (SHELL.test(args)) reply('🚫 That text starts with `!`, which Claude Code would run as a shell command — not sent.')
            else paste(args, true)
            break
          case 'archive':
            if (!s.archiveOnEnd) {
              const i = s.key.indexOf('|') // key = `${pid}|${procStart}`
              actions.push({ type: 'set_topic', topic: topicFor(Number(s.key.slice(0, i)), s.key.slice(i + 1), true) })
            }
            s.archiveOnEnd = true
            reply('📦 This channel will be archived when the session ends.')
            break
          default:
            reply("🚫 Messages starting with `!` aren't sent — Claude Code would run them as shell commands. Commands: `!keys`, `!type`, `!archive`.")
        }
      } else if (!s.pane) reply(READ_ONLY)
      else if (s.status === 'waiting') reply('🟡 A prompt is open — tap a button, or use `!keys` / `!type`.')
      else paste(text)
      break
    }
  }
  return { state: s, actions }
}

export function topicFor(pid: number, procStart: string, archive = false): string {
  return `ccds|${pid}|${procStart}${archive ? '|archive' : ''}`
}

export function parseTopic(topic: string | null): { pid: number; procStart: string; archive: boolean; endedAt: number | null } | null {
  const m = topic?.match(TOPIC)
  if (!m) return null
  return { pid: Number(m[1]), procStart: m[2], archive: m[3] !== undefined, endedAt: m[4] === undefined ? null : Number(m[4]) }
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
