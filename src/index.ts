import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, Message, MessageFlags,
} from 'discord.js'
import type { ButtonInteraction, CategoryChannel, Guild, TextChannel } from 'discord.js'
import { dropEcho, endedTopic, isDue, newMirror, parseTopic, pickArchiveCategory, step, topicFor } from './mirror.ts'
import type { Action, Button, Input, State } from './mirror.ts'
import { renderEnded } from './render.ts'
import { listSessions, readStatus } from './sessions.ts'
import type { Session } from './sessions.ts'
import { capture, checkPane, parseDialog, pasteText, sendKeys } from './tmux.ts'
import { parseLine, readAppended } from './transcript.ts'

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), ...parts)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, owned by someone else
  }
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
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return false
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

// A transcript born moments ago is read from the start; an older one (resume, -c) only from its current end.
export function startOffset(birthtimeMs: number, size: number, now: number): number {
  return birthtimeMs >= now - 15_000 ? 0 : size
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

function main(): void {
  for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_USER_ID']) {
    if (!process.env[name]) {
      console.error(`Missing required environment variable ${name}`)
      process.exit(1)
    }
  }
  const token = process.env.DISCORD_BOT_TOKEN!
  const guildId = process.env.DISCORD_GUILD_ID!
  const userId = process.env.DISCORD_USER_ID!
  const claudeDir = process.env.CLAUDE_DIR || join(homedir(), '.claude')
  const sessionsDir = join(claudeDir, 'sessions')
  const projectsDir = join(claudeDir, 'projects')
  const ttl = Number(process.env.CCDS_ENDED_TTL_MS) || 3_600_000

  const lockDir = join(homedir(), 'Library', 'Caches')
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, 'claude-code-discord-sync.lock')
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
  let sessionsCat: CategoryChannel
  let endedCat: CategoryChannel
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
              e.channel = await guild.channels.create({ name: a.name, type: ChannelType.GuildText, parent: sessionsCat.id, topic: a.topic })
            } catch (err) {
              if (i >= 4) throw err
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

  // Keystrokes skip the send queue (rate-limited sends must not delay them) and run in order per pane.
  // origin: the button click that produced the action, so a refused keystroke can still be reported.
  function typeInto(e: Entry, a: Typing, origin?: string): void {
    const pane = e.state.pane
    if (!pane) return
    const target = a.replyTo ?? origin
    void paneQueue(pane, async () => {
      const status = await readStatus(sessionsDir, e.pid)
      const screen = a.type === 'keys' && a.hash && status === 'waiting' ? await capture(pane).catch(() => null) : null
      const reason = typingRefusal(a, status, screen ? parseDialog(screen)?.hash ?? null : null)
        ?? await checkPane(pane, e.pid, e.procStart)
        ?? await (a.type === 'paste' ? pasteText(pane, a.text) : sendKeys(pane, a.keys)).then(() => null, (err) => err.message)
      if (reason) {
        log(`not sent to ${pane}: ${reason}`)
        // The next poll re-posts the card; an unsent paste must not swallow a later identical terminal prompt.
        if (a.type === 'keys' && a.hash) e.state = { ...e.state, card: null }
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
    const { state, actions } = newMirror({ ...s, pane: s.interactive ? s.pane : null, archiveOnEnd }, userId)
    const e: Entry = { state, pid: s.pid, procStart: s.procStart, channel, outbox: new Outbox(), transcript: null, offset: 0, from }
    mirrors.set(state.key, e)
    // An existing channel replaces create_channel; its current name stops a needless rename.
    if (channel) e.state = { ...state, channel: channel.name }
    else void queue(state.key, () => execute(e, actions))
    return e
  }

  let lastSweep = 0
  async function tick(startup: boolean): Promise<void> {
    const sessions = await listSessions(sessionsDir, projectsDir)
    const now = Date.now()
    const live = new Set(sessions.map((s) => `${s.pid}|${s.procStart}`))
    for (const [key, e] of mirrors) {
      if (live.has(key)) continue
      mirrors.delete(key)
      apply(e, { kind: 'ended' })
    }
    for (const s of sessions) {
      // Sessions already running at startup start at the end of their transcript: no history replay.
      const e = mirrors.get(`${s.pid}|${s.procStart}`) ?? track(s, null, startup && s.transcript ? 'eof' : 'birth')
      if (s.sessionId !== e.state.sessionId) {
        apply(e, { kind: 'session_changed', sessionId: s.sessionId })
        e.transcript = null
        e.from = 'birth'
      }
      if (s.transcript && s.transcript !== e.transcript) {
        const st = await stat(s.transcript).catch(() => null)
        e.transcript = s.transcript
        e.offset = !st ? 0 : e.from === 'eof' ? st.size : startOffset(st.birthtimeMs, st.size, now)
      }
      if (e.transcript) {
        const { lines, next } = await readAppended(e.transcript, e.offset)
        e.offset = next
        const events = lines.flatMap(parseLine)
        if (events.length) apply(e, { kind: 'events', events })
      }
      if (s.status !== e.state.status || s.status === 'waiting') {
        const screen = s.status === 'waiting' && e.state.pane ? await capture(e.state.pane).catch(() => null) : null
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
    sessionsCat = await ensureCategory('Claude Sessions')
    endedCat = await ensureCategory('Ended Sessions')
    const sessions = await listSessions(sessionsDir, projectsDir)
    for (const c of guild.channels.cache.values()) {
      if (c.parentId !== sessionsCat.id || c.type !== ChannelType.GuildText) continue
      const t = parseTopic(c.topic)
      // Already ended (its move to Ended Sessions failed); the sweep deletes it.
      if (!t || t.endedAt !== null) continue
      const key = `${t.pid}|${t.procStart}`
      const s = sessions.find((x) => `${x.pid}|${x.procStart}` === key)
      // A session whose transcript doesn't exist yet must not skip its first turn.
      if (s && !mirrors.has(key)) track(s, c, s.transcript ? 'eof' : 'birth', t.archive)
      else void queue(c.id, () => endChannel(c, false))
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
      const s = (await listSessions(sessionsDir, projectsDir)).find((x) => `${x.pid}|${x.procStart}` === e.state.key)
      const status = s?.status ?? ''
      const screen = status === 'waiting' && e.state.pane ? await capture(e.state.pane).catch(() => null) : null
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

if (import.meta.main) main()
