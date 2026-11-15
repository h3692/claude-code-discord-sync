import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, Message, MessageFlags,
} from 'discord.js'
import type { ButtonInteraction, CategoryChannel, Guild, TextChannel } from 'discord.js'
import { appName, configDirFor, powershell, run } from './config.ts'
import { codexScreen, header as rolloutHeader, listCodexSessions, parseCodexLine } from './codex.ts'
import type { CodexMeta } from './codex.ts'
import { dropEcho, endedTopic, isDue, newMirror, parseTopic, pickArchiveCategory, SHELL, step, topicFor } from './mirror.ts'
import type { Action, Button, Input, State } from './mirror.ts'
import { renderEnded } from './render.ts'
import { listSessions, readStatus } from './sessions.ts'
import type { Session } from './sessions.ts'
import { capture, checkPane, parseDialog, pasteText, sanitizePaste, sendKeys } from './tmux.ts'
import type { Dialog } from './tmux.ts'
import { parseLine, readAppended } from './transcript.ts'
import type { TranscriptEvent } from './transcript.ts'

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), ...parts)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, owned by someone else
  }
}

// v1 (`node src/index.ts`), dev (`src/cli.ts start`), installed (`.../claude-code-discord-sync/dist/cli.js start`, the bin shim).
export function isWatcherCommand(command: string): boolean {
  return /(?:src[\\/]cli\.ts|claude-code-discord-sync[\\/]dist[\\/]cli\.js|(?:^|[\\/\s])claude-code-discord-sync)"?\s+start(?=\s|$)|src[\\/]index\.ts/.test(command)
}

// The command line of a pid: empty from PowerShell once it is gone, while ps exits 1.
export function commandLine(pid: number): string {
  if (process.platform === 'win32') return run(powershell(`(Get-CimInstance Win32_Process -Filter ('ProcessId=' + ${pid})).CommandLine`))
  return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
}

// A live pid holds the lock only while it still runs this watcher: after a reboot the pid may belong to anything.
function isWatcher(pid: number): boolean {
  try {
    return isWatcherCommand(commandLine(pid))
  } catch (e) {
    // ps exits 1 for a pid that is gone; if ps or PowerShell can't run at all, the live pid is the best we have.
    return process.platform === 'win32' || typeof (e as { status?: unknown }).status !== 'number'
  }
}

export function lockDirFor(platform: string, env: Record<string, string | undefined>, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  return configDirFor(platform, env, home)
}

// shortcut: two watchers starting in the same instant over a stale lock can both win; fine for a LaunchAgent.
export function acquireLock(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const pid = Number(readFileSync(path, 'utf8').trim())
  // pid 0 or negative would signal a whole process group.
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) && isWatcher(pid)) return false
  writeFileSync(path, String(process.pid))
  return true
}

// Maps refs to sent messages; edits wait for their send, one in flight per ref, latest pending wins.
export class Outbox<M> {
  #messages = new Map<string, Promise<M | null>>()
  #pending = new Map<string, { payload: any; fn: (m: M, payload: any) => Promise<unknown> }>()
  #busy = new Set<string>()

  send(ref: string, fn: () => Promise<M>): Promise<void> {
    const message = fn().catch((e) => {
      log(`send ${ref} failed:`, (e as Error).message)
      return null
    })
    this.#messages.set(ref, message)
    return message.then(() => {})
  }

  edit<P>(ref: string, payload: P, fn: (m: M, payload: P) => Promise<unknown>): void {
    this.#pending.set(ref, { payload, fn })
    if (this.#busy.has(ref)) return
    this.#busy.add(ref)
    void this.#drain(ref)
  }

  async #drain(ref: string): Promise<void> {
    const message = await this.#messages.get(ref)
    for (let next = this.#pending.get(ref); next; next = this.#pending.get(ref)) {
      this.#pending.delete(ref)
      if (message) await next.fn(message, next.payload).catch((e) => log(`edit ${ref} failed:`, (e as Error).message))
    }
    this.#busy.delete(ref)
  }
}

// Runs tasks with the same key one after another; a failing task is logged and does not block the next.
export function serialQueue(): (key: string, fn: () => Promise<unknown>) => Promise<void> {
  const tails = new Map<string, Promise<void>>()
  return (key, fn) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(fn).then(() => {}, (e) => log(`task ${key} failed:`, (e as Error).message))
    tails.set(key, next)
    void next.then(() => tails.get(key) === next && tails.delete(key))
    return next
  }
}

type Typing = Extract<Action, { type: 'paste' | 'keys' }>

// Decided right before typing, on a status read that moment: the mirror's view may be a poll old.
export function typingRefusal(a: Typing, status: string | null, freshHash: string | null): string | null {
  if (status === null) return 'the session is gone'
  if (a.type === 'paste' && !a.allowWaiting && status === 'waiting') return 'a prompt opened — use the buttons, `!keys` or `!type`'
  if (a.type === 'keys' && a.hash && (status !== 'waiting' || freshHash !== a.hash)) return 'the prompt changed — check the new card'
  return null
}

// Typing into Codex, every step in order. Anything it can't recognise as its prompt might be a list where Enter
// picks the highlighted item, or the shell mode a leading `!` turns on, so each check refuses rather than guesses.
// !type (allowWaiting) goes through here too: Codex's approvals take no free text.
export async function typeCodex(text: string, ambiguous: boolean, io: {
  state: () => Promise<string | null>; checkPane: () => Promise<string | null>; paste: () => Promise<void>; enter: () => Promise<void>
}): Promise<string | null> {
  if (ambiguous) return 'two Codex sessions share this folder; reply in the terminal'
  if (sanitizePaste(text).split('\n').some((l) => SHELL.test(l.replace(/^[\s\p{Cf}]+/u, '')))) {
    return 'a line starts with `!`, which Codex would run as a shell command'
  }
  const first = await io.state()
  if (first !== 'idle') return first === 'waiting' ? 'a prompt is open — use the buttons or `!keys`' : "can't confirm Codex is at its prompt"
  const pane = await io.checkPane()
  if (pane) return pane
  await io.paste()
  // The paste itself can open a popup (`@word`, `/`), where Enter would pick an item instead of sending.
  if ((await io.state()) !== 'idle') return "pasted but not sent — Codex isn't at its prompt; check the terminal"
  await io.enter()
  return null
}

const UNRECORDED = "-# 📭 This Codex thread doesn't record its output; only approvals and typing work here."
const SHARED = '-# ⚠️ Another Codex session is open in this folder, so what shows here may be from either one. Typing is refused; approvals still work.'

// Where a newly matched rollout is read from: a fork starts with its parent's history, so only from its end.
export function codexStart(meta: CodexMeta | null, offset: number, size: number): { offset: number; notice: string | null } {
  return { offset: meta?.forkedFromId ? size : offset, notice: meta && meta.historyMode !== 'paginated' ? UNRECORDED : null }
}

export const CATEGORY = { claude: 'Claude Sessions', codex: 'Codex Sessions' } as const

// A transcript born moments ago is read from the start; an older one (resume, -c) only from its current end.
export function startOffset(birthtimeMs: number, size: number, now: number): number {
  return birthtimeMs >= now - 15_000 ? 0 : size
}

// A preview question gets its Enter only while the digit has visibly moved the highlight on that same question.
export function shouldConfirm(fresh: Dialog | null, hash: string, n: number): boolean {
  return !!fresh?.confirm && fresh.hash === hash && fresh.cursor === n
}

// Resuming appends the old conversation under the new session id; lines older than its first sight are history.
export function freshEvents(lines: string[], seenAt: number, parse = parseLine): TranscriptEvent[] {
  return lines.flatMap((line) => parse(line, seenAt - 5000))
}

// Claude Code rewrites registry entries in place, so one unreadable poll is not an end; two in a row are.
export function missCount(misses: number, seen: boolean): { misses: number; ended: boolean } {
  return seen ? { misses: 0, ended: false } : { misses: misses + 1, ended: misses + 1 >= 2 }
}

// A refused keystroke must not leave the card marked answered. A button resets its card only while that card
// still shows the prompt it was clicked on (never a newer one), and edits it out of "⏳ Sending".
export function unanswer(state: State, a: Extract<Typing, { type: 'keys' }>, reason: string): { state: State; edit: Action | null } {
  const card = state.card
  if (!card) return { state, edit: null }
  if (!a.hash) return { state: { ...state, card: { ...card, answered: null } }, edit: null }
  if (card.hash !== a.hash) return { state, edit: null }
  const edit: Action = {
    type: 'edit', ref: card.ref, content: `⚠️ Not sent — ${reason}`, embed: { title: '⚠️ Not sent', description: card.dialog?.question ?? 'prompt' }, buttons: [],
  }
  return { state: { ...state, card: null }, edit }
}

type Entry = {
  state: State
  pid: number
  procStart: string
  channel: TextChannel | null
  outbox: Outbox<Message>
  transcript: string | null
  offset: number
  // Where reading starts once the transcript is known: its end, or by file age (new session, /clear, /resume).
  from: 'eof' | 'birth'
  seenAt: number // when the current session id was first seen
  misses: number // consecutive polls without a registry entry
  ambiguous: boolean // Codex: another terminal Codex shares the folder, as of the last poll
}

const NO_MENTIONS = { parse: [] as [] }

function color(title: string): number {
  if (title.startsWith('🟡')) return 0xF5A623
  if (title.startsWith('✅')) return 0x2ECC71
  return 0x95A5A6
}

function rows(buttons: Button[]): ActionRowBuilder<ButtonBuilder>[] {
  const out: ActionRowBuilder<ButtonBuilder>[] = []
  for (let i = 0; i < buttons.length; i += 5) {
    out.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5).map((b) =>
      new ButtonBuilder().setCustomId(b.id).setLabel(b.label).setStyle(ButtonStyle.Secondary))))
  }
  return out
}

function payload(a: Extract<Action, { type: 'send' | 'edit' }>) {
  return {
    content: a.content,
    embeds: a.embed && [new EmbedBuilder().setTitle(a.embed.title).setDescription(a.embed.description).setColor(color(a.embed.title))],
    components: a.buttons && rows(a.buttons),
  }
}

export type Settings = { token: string; guildId: string; userId: string; claudeDir: string; codexHome: string; ttl: number }

// Why Discord can't type into a session, for its channel; null when it can.
export function readOnlyReason(s: { interactive: boolean; pane: string | null }, platform: string, env: Record<string, string | undefined>): string | null {
  if (!s.interactive) return 'it is a background session'
  if (!s.pane) return 'it is not running inside tmux'
  if (platform === 'win32' && env.CCDS_WINDOWS_TYPING !== '1') return 'typing on Windows is off (set CCDS_WINDOWS_TYPING=1)'
  return null
}

export function main({ token, guildId, userId, claudeDir, codexHome, ttl }: Settings): void {
  const sessionsDir = join(claudeDir, 'sessions')
  const projectsDir = join(claudeDir, 'projects')

  const lockDir = lockDirFor(process.platform, process.env, homedir())
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, `${appName(process.env)}.lock`)
  if (!acquireLock(lockPath)) {
    console.error(`Another instance is running (lock ${lockPath})`)
    process.exit(1)
  }
  process.on('exit', () => {
    try {
      if (readFileSync(lockPath, 'utf8') === String(process.pid)) rmSync(lockPath)
    } catch {}
  })
  process.on('unhandledRejection', (e) => log('unhandled rejection:', (e as Error)?.message ?? e))
  process.on('uncaughtException', (e) => log('uncaught exception:', e.message))

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: NO_MENTIONS,
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void client.destroy().finally(() => process.exit(0)))
  }

  let guild: Guild
  let claudeCat: CategoryChannel
  // Made at the first Codex channel, so a Claude-only setup never gets an empty category.
  let codexCat: Promise<CategoryChannel> | undefined
  let endedCat: CategoryChannel
  const codexCategory = () => (codexCat ??= ensureCategory(CATEGORY.codex).catch((err) => {
    codexCat = undefined
    throw err
  }))
  let codexSessions: Session[] = []
  const mirrors = new Map<string, Entry>()
  const queue = serialQueue() // per session key (or channel id for channels without a mirror)
  const paneQueue = serialQueue()
  // Messages and button clicks that actions may reply to, by id.
  const sources = new Map<string, Message | ButtonInteraction>()
  const remember = (id: string, source: Message | ButtonInteraction) => {
    sources.set(id, source)
    setTimeout(() => sources.delete(id), 10 * 60_000).unref()
  }

  async function reply(id: string, content: string): Promise<void> {
    const source = sources.get(id)
    if (source instanceof Message) await source.reply({ content, allowedMentions: { parse: [], repliedUser: false } })
    else if (source) await source.followUp({ content, flags: MessageFlags.Ephemeral })
  }

  // Returns the refusal reason, or null once archived.
  async function archiveChannel(channel: TextChannel): Promise<string | null> {
    const categories = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((c) => ({ id: c.id, name: c.name, count: (c as CategoryChannel).children.cache.size }))
    const pick = pickArchiveCategory(categories, guild.channels.cache.size)
    if ('refuse' in pick) return pick.refuse
    const parent = 'id' in pick ? pick.id : (await guild.channels.create({ name: pick.create, type: ChannelType.GuildCategory })).id
    const t = parseTopic(channel.topic)
    // A topic without `ended:` is never swept.
    await channel.edit({ parent, topic: t ? topicFor(t.pid, t.procStart) : channel.topic, lockPermissions: false })
    await channel.send('📦 Archived.')
    return null
  }

  async function endChannel(channel: TextChannel, archive: boolean): Promise<void> {
    if (archive) {
      const refusal = await archiveChannel(channel)
      if (!refusal) return
      await channel.send(`⚠️ Not archived: ${refusal}`)
    }
    const topic = endedTopic(channel.topic ?? '', Date.now())
    // The move can fail (e.g. 50 channels in Ended Sessions); the ended stamp alone still gets it swept.
    await channel.edit({ parent: endedCat.id, topic, lockPermissions: false }).catch((err) => {
      log('move to Ended Sessions failed:', err.message)
      return channel.setTopic(topic).catch((err2) => log('ended topic failed:', err2.message))
    })
    await channel.send(renderEnded(ttl))
  }

  async function execute(e: Entry, actions: Action[]): Promise<void> {
    for (const a of actions) {
      switch (a.type) {
        case 'create_channel':
          // Everything else for this session waits on the channel, so retry a transient failure (~30s total).
          for (let i = 0; !e.channel; i++) {
            try {
              const parent = e.state.provider === 'codex' ? (await codexCategory()).id : claudeCat.id
              e.channel = await guild.channels.create({ name: a.name, type: ChannelType.GuildText, parent, topic: a.topic })
            } catch (err) {
              if (i >= 4) {
                // Dropped so the next poll tracks the session afresh and tries again.
                if (mirrors.get(e.state.key) === e) mirrors.delete(e.state.key)
                log(`create channel ${a.name} failed, retrying on the next poll:`, (err as Error).message)
                return
              }
              log(`create channel failed (attempt ${i + 1}):`, (err as Error).message)
              await new Promise((r) => setTimeout(r, 2000 * 2 ** i))
            }
          }
          log(`created channel ${a.name} for ${e.pid}`)
          break
        case 'rename_channel':
          // Rate-limited to ~2 per 10 minutes, so never block the queue on it.
          e.channel?.setName(a.name).catch((err) => log('rename failed:', err.message))
          break
        case 'set_topic':
          // Rate-limited like renames.
          e.channel?.setTopic(a.topic).catch((err) => log('set topic failed:', err.message))
          break
        case 'send': {
          if (!a.content && !a.embed) break
          const channel = e.channel
          const p = { ...payload(a), allowedMentions: a.ping ? { users: [userId] } : NO_MENTIONS }
          await e.outbox.send(a.ref, () => (channel ? channel.send(p) : Promise.reject(new Error('no channel'))))
          break
        }
        case 'edit':
          e.outbox.edit(a.ref, { ...payload(a), allowedMentions: NO_MENTIONS }, (m, p) => m.edit(p))
          break
        case 'end_channel':
          if (e.channel) await endChannel(e.channel, a.archive)
          log(`session ${e.pid} ended`)
          break
        case 'reply':
          await reply(a.replyTo, a.content)
          break
      }
    }
  }

  // The digit alone first; Enter only if a fresh capture shows it landed on the question the button was for.
  async function confirmKeys(pane: string, digit: string, hash: string): Promise<string | null> {
    await sendKeys(pane, [digit])
    await new Promise((r) => setTimeout(r, 300))
    const screen = await capture(pane).catch(() => null)
    if (!shouldConfirm(screen ? parseDialog(screen) : null, hash, Number(digit))) {
      return "the highlight moved but the answer wasn't confirmed — check the terminal, or send `!keys Enter`"
    }
    await sendKeys(pane, ['Enter'])
    return null
  }

  // Status and screen read fresh. Claude: its registry entry, and a capture while a prompt is open.
  // Codex has no registry: one capture gives both, so they always agree, and an unreadable pane is unknown.
  async function readScreen(e: Entry): Promise<{ status: string | null; screen: string | null; dialog: Dialog | null }> {
    const pane = e.state.pane
    if (e.state.provider === 'codex') {
      const screen = pane ? await capture(pane).catch(() => null) : null
      const { state, dialog } = codexScreen(screen ?? '')
      return { status: state, screen, dialog }
    }
    const status = await readStatus(sessionsDir, e.pid)
    const screen = status === 'waiting' && pane ? await capture(pane).catch(() => null) : null
    return { status, screen, dialog: screen ? parseDialog(screen) : null }
  }

  // Keystrokes skip the send queue (rate-limited sends must not delay them) and run in order per pane.
  // origin: the button click that produced the action, so a refused keystroke can still be reported.
  function typeInto(e: Entry, a: Typing, origin?: string): void {
    const pane = e.state.pane
    if (!pane) return
    const target = a.replyTo ?? origin
    void paneQueue(pane, async () => {
      const codex = e.state.provider === 'codex'
      let reason: string | null
      if (codex && a.type === 'paste') {
        reason = await typeCodex(a.text, e.ambiguous, {
          state: async () => (await readScreen(e)).status,
          checkPane: () => checkPane(pane, e.pid, e.procStart),
          paste: async () => {
            await pasteText(pane, a.text, undefined, false)
            // Codex redraws after the paste; a capture before that would miss a popup the paste opened.
            await new Promise((r) => setTimeout(r, 300))
          },
          enter: () => sendKeys(pane, ['Enter']),
        }).catch((err) => err.message)
      } else {
        const { status, dialog } = await readScreen(e)
        reason = typingRefusal(a, status, dialog?.hash ?? null)
          ?? await checkPane(pane, e.pid, e.procStart)
          ?? await (a.type === 'paste' ? pasteText(pane, a.text)
            // Codex: never an Enter after a button's digit, which would answer the next queued approval.
            : codex ? sendKeys(pane, a.hash ? a.keys.slice(0, 1) : a.keys)
            : a.hash && a.keys[1] === 'Enter' ? confirmKeys(pane, a.keys[0], a.hash) : sendKeys(pane, a.keys))
            .then((r) => r ?? null, (err) => err.message)
      }
      if (reason) {
        log(`not sent to ${pane}: ${reason}`)
        // The next poll re-posts a reset card; an unsent paste must not swallow a later identical terminal prompt.
        if (a.type === 'keys') {
          const { state, edit } = unanswer(e.state, a, reason)
          e.state = state
          // Queued behind the "⏳ Sending" edit, so it lands after it.
          if (edit) void queue(state.key, () => execute(e, [edit]))
        }
        if (a.type === 'paste') e.state = dropEcho(e.state, a.text)
        if (target) await reply(target, `⚠️ Not sent: ${reason}`)
        return
      }
      const source = target && sources.get(target)
      if (source instanceof Message) await source.react('✅')
    })
  }

  function apply(e: Entry, input: Input): void {
    const { state, actions } = step(e.state, input)
    e.state = state
    const rest: Action[] = []
    for (const a of actions) {
      if (a.type === 'paste' || a.type === 'keys') typeInto(e, a, input.kind === 'button' ? input.id : undefined)
      else rest.push(a)
    }
    if (rest.length) void queue(state.key, () => execute(e, rest))
  }

  function track(s: Session, channel: TextChannel | null, from: Entry['from'], archiveOnEnd = false): Entry {
    // Non-interactive (background) sessions are mirrored read-only.
    const readOnly = readOnlyReason(s, process.platform, process.env)
    const { state, actions } = newMirror({ ...s, pane: s.interactive ? s.pane : null, archiveOnEnd, readOnly, provider: s.provider }, userId)
    const e: Entry = {
      state, pid: s.pid, procStart: s.procStart, channel, outbox: new Outbox(), transcript: null, offset: 0, from, seenAt: Date.now(), misses: 0,
      ambiguous: false,
    }
    mirrors.set(state.key, e)
    // An existing channel replaces create_channel; its current name stops a needless rename.
    if (channel && state.lock && !channel.name.startsWith(state.lock)) {
      // Channels made before read-only marking existed get the lock and the explanation now.
      e.state = { ...state, channel: state.lock + channel.name }
      void queue(state.key, () => execute(e, [{ type: 'rename_channel', name: e.state.channel }, ...actions.filter((a) => a.type === 'send')]))
    } else if (channel) e.state = { ...state, channel: channel.name }
    else void queue(state.key, () => execute(e, actions))
    return e
  }

  // Codex discovery returns its previous list on failure; a bug in it must not stop Claude mirroring either.
  async function listAll(): Promise<Session[]> {
    const claude = await listSessions(sessionsDir, projectsDir)
    codexSessions = await listCodexSessions(codexHome, codexSessions, log).catch((err) => {
      log('codex discovery failed:', (err as Error).message)
      return codexSessions
    })
    return [...claude, ...codexSessions]
  }

  let lastSweep = 0
  async function tick(startup: boolean): Promise<void> {
    const sessions = await listAll()
    const now = Date.now()
    const live = new Set(sessions.map((s) => `${s.pid}|${s.procStart}`))
    for (const [key, e] of mirrors) {
      const { misses, ended } = missCount(e.misses, live.has(key))
      e.misses = misses
      if (!ended) continue
      mirrors.delete(key)
      apply(e, { kind: 'ended' })
    }
    for (const s of sessions) {
      // Sessions already running at startup start at the end of their transcript: no history replay.
      const e = mirrors.get(`${s.pid}|${s.procStart}`) ?? track(s, null, startup && s.transcript ? 'eof' : 'birth')
      // A Codex session that loses its rollout match keeps reading the one it had.
      if (s.sessionId && s.sessionId !== e.state.sessionId) {
        // A pending Codex session ('') keeps the time its TUI was first seen, so a resumed thread's history stays out.
        if (e.state.sessionId) {
          e.transcript = null
          e.from = 'birth'
          e.seenAt = now
        }
        apply(e, { kind: 'session_changed', sessionId: s.sessionId })
      }
      if (s.ambiguous && !e.ambiguous) apply(e, { kind: 'notice', text: SHARED })
      e.ambiguous = !!s.ambiguous
      if (s.transcript && s.transcript !== e.transcript) {
        const st = await stat(s.transcript).catch(() => null)
        e.transcript = s.transcript
        e.offset = !st ? 0 : e.from === 'eof' ? st.size : startOffset(st.birthtimeMs, st.size, now)
        if (s.provider === 'codex') {
          const { offset, notice } = codexStart(await rolloutHeader(s.transcript), e.offset, st?.size ?? 0)
          e.offset = offset
          if (notice) apply(e, { kind: 'notice', text: notice })
        }
      }
      if (e.transcript) {
        const { lines, next } = await readAppended(e.transcript, e.offset)
        e.offset = next
        const events = freshEvents(lines, e.seenAt, s.provider === 'codex' ? parseCodexLine : parseLine)
        if (events.length) apply(e, { kind: 'events', events })
      }
      if (s.provider === 'codex') {
        // While a card is open every poll counts toward closing it.
        if (s.status !== e.state.status || s.status === 'waiting' || e.state.card) {
          const { status, screen } = await readScreen(e)
          apply(e, { kind: 'status', status: status ?? '', screen: status === 'waiting' ? screen : null })
        }
      } else if (s.status !== e.state.status || s.status === 'waiting') {
        const screen = s.status === 'waiting' && e.state.pane ? await capture(e.state.pane).catch(() => null) : null
        // The prompt may have closed while we captured (e.g. just answered); a stale screen would ping a bogus card.
        if (screen !== null && (await readStatus(sessionsDir, e.pid)) !== 'waiting') continue
        apply(e, { kind: 'status', status: s.status, screen })
      }
    }
    if (now - lastSweep >= 60_000) {
      lastSweep = now
      for (const c of guild.channels.cache.values()) {
        // Any channel stamped ended, so one whose move to Ended Sessions failed is swept too; archived ones carry no stamp.
        if (c.type === ChannelType.GuildText && isDue(c.topic, now, ttl)) {
          await c.delete().then(() => log(`deleted ended channel ${c.name}`), (err) => log('delete failed:', err.message))
        }
      }
    }
  }

  // Never overlaps: the next tick is scheduled only after this one finished.
  async function poll(startup: boolean): Promise<void> {
    let ok = true
    try {
      await tick(startup)
    } catch (e) {
      ok = false
      log('poll failed:', (e as Error).message)
    }
    setTimeout(() => void poll(startup && !ok), 1000)
  }

  async function ensureCategory(name: string): Promise<CategoryChannel> {
    const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name)
    return (found as CategoryChannel | undefined) ?? guild.channels.create({ name, type: ChannelType.GuildCategory })
  }

  async function start(): Promise<void> {
    guild = await client.guilds.fetch(guildId)
    await guild.channels.fetch()
    claudeCat = await ensureCategory(CATEGORY.claude)
    endedCat = await ensureCategory('Ended Sessions')
    const found = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === CATEGORY.codex) as CategoryChannel | undefined
    if (found) codexCat = Promise.resolve(found)
    const live = [claudeCat.id, found?.id]
    const sessions = await listAll()
    for (const c of guild.channels.cache.values()) {
      if (!live.includes(c.parentId ?? '') || c.type !== ChannelType.GuildText) continue
      const t = parseTopic(c.topic)
      // Already ended (its move to Ended Sessions failed); the sweep deletes it.
      if (!t || t.endedAt !== null) continue
      const key = `${t.pid}|${t.procStart}`
      const s = sessions.find((x) => `${x.pid}|${x.procStart}` === key)
      // A session whose transcript doesn't exist yet must not skip its first turn.
      if (s && !mirrors.has(key)) track(s, c, s.transcript ? 'eof' : 'birth', t.archive)
      else void queue(c.id, () => endChannel(c, t.archive))
    }
    log(`ready: ${mirrors.size} session(s) reattached`)
    void poll(true)
  }

  client.once(Events.ClientReady, () => {
    start().catch((e) => {
      log('startup failed:', (e as Error).message)
      process.exit(1)
    })
  })

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot || message.guildId !== guildId || message.author.id !== userId) return
    const e = [...mirrors.values()].find((x) => x.channel?.id === message.channelId)
    if (e) {
      remember(message.id, message)
      log(`message for ${e.pid} (${message.content.length} chars)`)
      apply(e, { kind: 'message', id: message.id, text: message.content })
      return
    }
    const channel = message.channel
    // An ended channel may sit outside Ended Sessions if that category was full; its topic still says ended.
    if (channel.type !== ChannelType.GuildText) return
    if (channel.parentId !== endedCat?.id && parseTopic(channel.topic)?.endedAt == null) return
    if (message.content.trim().toLowerCase() === '!archive') {
      void queue(channel.id, async () => {
        const refusal = await archiveChannel(channel)
        if (refusal) await message.reply({ content: `⚠️ ${refusal}`, allowedMentions: { parse: [], repliedUser: false } })
      })
    } else {
      message.reply({ content: '🔚 This session has ended.', allowedMentions: { parse: [], repliedUser: false } })
        .catch((err) => log('reply failed:', err.message))
    }
  })

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton() || interaction.guildId !== guildId) return
    const m = /^ccds:(\d+):([0-9a-f]+)$/.exec(interaction.customId)
    if (!m) return
    const run = async () => {
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: 'Not yours.', flags: MessageFlags.Ephemeral })
        return
      }
      // Discord wants an answer within 3 seconds; the fresh status check comes after.
      await interaction.deferUpdate()
      const e = [...mirrors.values()].find((x) => x.channel?.id === interaction.channelId)
      if (!e) {
        await interaction.followUp({ content: 'That session has ended.', flags: MessageFlags.Ephemeral })
        return
      }
      let status: string
      let screen: string | null
      // Codex has no registry: one capture now gives both.
      if (e.state.provider === 'codex') {
        const fresh = await readScreen(e)
        status = fresh.status ?? ''
        screen = fresh.screen
      } else {
        const s = (await listSessions(sessionsDir, projectsDir)).find((x) => `${x.pid}|${x.procStart}` === e.state.key)
        status = s?.status ?? ''
        screen = status === 'waiting' && e.state.pane ? await capture(e.state.pane).catch(() => null) : null
      }
      remember(interaction.id, interaction)
      apply(e, { kind: 'button', id: interaction.id, n: Number(m[1]), hash: m[2], status, screen })
    }
    run().catch((err) => log('button failed:', err.message))
  })

  client.login(token).catch((e) => {
    log('login failed:', (e as Error).message)
    process.exit(1)
  })
}
