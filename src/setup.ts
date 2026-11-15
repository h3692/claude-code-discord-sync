import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { configDirFor, promptHidden, readConfig, readToken, writeConfig, writeToken } from './config.ts'

export type Guild = { id: string; name: string; permissions: string; approximate_member_count?: number }
type User = { id: string; username: string; flags?: number }
type App = {
  id: string; owner: User; flags: number; bot_public?: boolean
  team: { owner_user_id: string; members?: { user: User }[] } | null
}
export type Io = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  tty: boolean
  ask: (question: string) => Promise<string>
  askHidden: (label: string) => Promise<string>
  open: (url: string) => void
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  hasTmux: () => boolean
  readToken: () => string | null
  writeToken: (token: string) => void
  configPath: string
}

const API = 'https://discord.com/api/v10'
const PORTAL = 'https://discord.com/developers/applications'
// VIEW_CHANNEL, SEND_MESSAGES, MANAGE_CHANNELS, READ_MESSAGE_HISTORY, EMBED_LINKS, ADD_REACTIONS
const PERMISSIONS = 85072n
const ADMINISTRATOR = 1n << 3n
const MESSAGE_CONTENT = (1 << 18) | (1 << 19)
const MESSAGE_CONTENT_LIMITED = 1 << 19
const TEAM_USER = 1024
const TOKEN = /^[\w.-]+$/
const USER_ID = /^\d{17,20}$/
const LOGO = new URL('../assets/logo.png', import.meta.url) // src/ in dev, dist/ when installed
const INSTALL: Record<string, string> = { darwin: 'brew install tmux', linux: 'sudo apt install tmux', win32: 'winget install marlocarlo.psmux' }

export const inviteUrl = (appId: string, guildId?: string): string =>
  `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${PERMISSIONS}` +
  (guildId ? `&guild_id=${guildId}&disable_guild_select=true` : '')

// Permission strings can exceed 2^53, so BigInt.
export function hasPermissions(permissions: string): boolean {
  const p = BigInt(permissions)
  return (p & ADMINISTRATOR) !== 0n || (p & PERMISSIONS) === PERMISSIONS
}

export const messageContentOn = (flags: number): boolean => (flags & MESSAGE_CONTENT) !== 0

// A team app's owner is a pseudo-user; the human is the team's owner.
export function ownerOf(app: Pick<App, 'owner' | 'team'>): { id: string; name?: string; team: boolean } {
  if (!app.team && !((app.owner.flags ?? 0) & TEAM_USER)) return { id: app.owner.id, name: app.owner.username, team: false }
  const id = app.team?.owner_user_id ?? app.owner.id
  return { id, name: app.team?.members?.find((m) => m.user.id === id)?.user.username, team: true }
}

export const pickGuild = (guilds: Guild[], configured?: string): Guild | undefined =>
  guilds.find((g) => g.id === configured) ?? (guilds.length === 1 ? guilds[0] : undefined)

export function parseYesNo(answer: string, fallback: boolean): boolean {
  const a = answer.trim().toLowerCase()
  return a.startsWith('y') ? true : a.startsWith('n') ? false : fallback
}

export function preflight(platform: string, node: string, tmux: boolean): string[] {
  const [major, minor] = node.split('.').map(Number)
  const problems: string[] = []
  if (major < 24 || (major === 24 && minor < 12)) problems.push(`Node ${node} is too old: this needs Node 24.12 or newer.`)
  if (!tmux) problems.push(`${platform === 'win32' ? 'psmux' : 'tmux'} is not installed. Install it with: ${INSTALL[platform] ?? INSTALL.linux}`)
  return problems
}

// cmd treats & as a command separator, so the URL is quoted and passed verbatim.
export const openCommand = (platform: string, url: string): [string, string[]] =>
  platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${url}"`]] : ['xdg-open', [url]]

const real: Io = {
  fetch,
  tty: process.stdin.isTTY === true,
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  },
  askHidden: (label) => promptHidden(label),
  open: (url) => {
    const [file, args] = openCommand(process.platform, url)
    spawn(file, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' })
      .on('error', () => {})
      .unref()
  },
  log: (line) => console.log(line),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hasTmux: () => {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  },
  readToken: () => readToken(),
  writeToken: (token) => writeToken(token),
  configPath: join(configDirFor(process.platform, process.env, homedir()), 'config.json'),
}

export async function setup(over: Partial<Io> = {}): Promise<void> {
  const io = { ...real, ...over }
  const config = readConfig(io.configPath)
  let token = ''
  // Errors name the request and status only; the token never goes into a message.
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await io.fetch(API + path, {
      method,
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw Object.assign(new Error(`Discord ${method} ${path} failed with ${res.status}`), { status: res.status })
    return res.json() as Promise<T>
  }
  const statusOf = (e: unknown) => (e as { status?: number }).status
  const confirm = async (question: string, fallback: boolean) => (io.tty ? parseYesNo(await io.ask(question), fallback) : fallback)
  const open = (url: string) => {
    io.log(`  ${url}`)
    io.open(url)
  }
  const poll = async <T>(check: () => Promise<T | null | undefined | false>, what: string): Promise<T> => {
    io.log(`Waiting for ${what}...`)
    for (let waited = 0; waited < 600_000; waited += 3000) {
      const found = await check()
      if (found) return found
      await io.sleep(3000)
    }
    throw new Error(`Gave up after 10 minutes waiting for ${what}. Run setup again when ready.`)
  }
  // The bot user, or null when Discord rejects the token.
  const me = async (): Promise<(User & { avatar: string | null }) | null> => {
    if (!TOKEN.test(token)) return null
    try {
      return await api('GET', '/users/@me')
    } catch (e) {
      if (statusOf(e) === 401) return null
      throw e
    }
  }

  // 1. Preflight: warn, don't abort.
  for (const problem of preflight(process.platform, process.versions.node, io.hasTmux())) io.log(`Warning: ${problem}`)

  // 2. Existing token. Discord shows a token once, so a working one is never replaced unasked.
  token = io.readToken() ?? ''
  let bot = token ? await me() : null
  if (token && !bot) io.log('The stored bot token no longer works.')
  if (bot && !(await confirm(`Keep the existing bot ${bot.username}? [Y/n] `, true))) bot = null
  const fresh = !bot

  // 3-4. Developer Portal and token.
  if (!bot && io.tty) {
    io.log('Create a bot in the Discord Developer Portal:')
    open(PORTAL)
    io.log('  1. New Application, give it a name, Create.')
    io.log('  2. Bot → Reset Token → Copy.')
  }
  while (!bot) {
    token = await io.askHidden('Paste the bot token (hidden): ')
    bot = await me()
    if (bot) break
    const why = TOKEN.test(token) ? 'Discord rejected that token.' : "That doesn't look like a bot token."
    if (!io.tty) throw new Error(`${why} Pipe a valid bot token into setup, or run it in a terminal.`)
    io.log(`${why} Try again.`)
  }
  io.log(`Bot: ${bot.username}`)
  let app = await api<App>('GET', '/applications/@me')

  // 5. Who may type.
  const owner = ownerOf(app)
  const who = owner.name ? `${owner.name} (${owner.id})` : owner.id
  if (owner.team && !io.tty) throw new Error('This app belongs to a team, so who may type is ambiguous. Run setup in a terminal to choose.')
  let userId = (await confirm(
    owner.team ? `This app belongs to a team. Let its owner ${who} type into sessions? [y/N] ` : `Only ${who} may type into sessions from Discord. OK? [Y/n] `,
    !owner.team,
  )) ? owner.id : ''
  while (!userId) {
    const id = (await io.ask('Discord user ID who may type: ')).trim()
    if (!USER_ID.test(id)) {
      io.log('A user ID is 17 to 20 digits. In Discord: Settings → Advanced → Developer Mode, then right-click the name → Copy User ID.')
      continue
    }
    const user = await api<User>('GET', `/users/${id}`).catch((e) => {
      if (statusOf(e) === undefined) throw e
      return null
    })
    if (!user) io.log('No Discord account has that ID.')
    else if (await confirm(`That is ${user.username}. Let them type? [Y/n] `, true)) userId = id
  }
  io.log(`Who may type: ${userId === owner.id ? who : userId}`)

  // 6. Message Content.
  if (!messageContentOn(app.flags)) {
    await api('PATCH', '/applications/@me', { flags: app.flags | MESSAGE_CONTENT_LIMITED }).catch(() => {})
    app = await api<App>('GET', '/applications/@me')
    if (!messageContentOn(app.flags)) {
      io.log('Turn on Message Content Intent under Privileged Gateway Intents, then Save Changes:')
      open(`${PORTAL}/${app.id}/bot`)
      await poll(async () => messageContentOn((await api<App>('GET', '/applications/@me')).flags), 'Message Content Intent')
    }
  }
  io.log('Message Content Intent: on')

  // 7. Avatar, only when the bot has none.
  if (!bot.avatar) {
    try {
      await api('PATCH', '/users/@me', { avatar: `data:image/png;base64,${readFileSync(LOGO).toString('base64')}` })
      io.log('Set the bot avatar to the claude-code-discord-sync logo.')
    } catch (e) {
      io.log(`Couldn't set the bot avatar (${(e as Error).message}). You can set one on the Bot page.`)
    }
  }

  // 8. Public warning: the API can't change bot_public.
  if (app.bot_public) io.log(`Warning: the bot is Public, so anyone can add it to their server. Turn off Public Bot at ${PORTAL}/${app.id}/bot`)

  // 9. Server.
  const guilds = () => api<Guild[]>('GET', '/users/@me/guilds?with_counts=true')
  let list = await guilds()
  if (!list.length) {
    io.log('Add the bot to a server you own (a new, empty one is best):')
    open(inviteUrl(app.id))
    list = await poll(async () => {
      const joined = await guilds()
      return joined.length > 0 && joined
    }, 'the bot to join a server')
  }
  let guild = pickGuild(list, config.guildId)
  if (!guild) {
    if (!io.tty) throw new Error(`The bot is in ${list.length} servers. Run setup in a terminal to pick one.`)
    list.forEach((g, i) => io.log(`  ${i + 1}. ${g.name}`))
    while (!guild) guild = list[Number(await io.ask(`Which server? [1-${list.length}] `)) - 1]
  }
  if (!hasPermissions(guild.permissions)) {
    const id = guild.id
    io.log(`The bot is missing permissions in ${guild.name}. Authorise it again:`)
    open(inviteUrl(app.id, id))
    guild = await poll(async () => (await guilds()).find((g) => g.id === id && hasPermissions(g.permissions)), 'the permissions')
  }
  const members = guild.approximate_member_count ?? 0
  io.log(`Server: ${guild.name} (${members} members)`)
  // You and the bot are 2; anyone more reads the channels.
  if (members > 2) io.log(`Warning: others are in this server, and everything Claude prints goes there.`)

  // 10. Save.
  if (fresh) io.writeToken(token)
  writeConfig(io.configPath, { guildId: guild.id, userId })
  io.log(`Saved. Run \`claude-code-discord-sync start\` to start the watcher.`)
}
