import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConfig, writeConfig } from '../src/config.ts'
import {
  hasPermissions, inviteUrl, messageContentOn, openCommand, ownerOf, parseYesNo, pickGuild, preflight, setup,
} from '../src/setup.ts'

const fake = 'dummy.token-123'
const OWNER = '528659982686879764'
const guild = (id: string, permissions = '85072', approximate_member_count = 2) => ({ id, name: `Server ${id}`, permissions, approximate_member_count })

describe('inviteUrl', () => {
  it('asks for the 6 permissions, preselecting a server when given', () => {
    expect(inviteUrl('app1')).toBe('https://discord.com/oauth2/authorize?client_id=app1&scope=bot&permissions=85072')
    expect(inviteUrl('app1', 'g1')).toBe(
      'https://discord.com/oauth2/authorize?client_id=app1&scope=bot&permissions=85072&guild_id=g1&disable_guild_select=true')
  })
})

describe('hasPermissions', () => {
  it('needs all 6 bits, or ADMINISTRATOR', () => {
    expect(hasPermissions('85072')).toBe(true)
    expect(hasPermissions('8')).toBe(true)
    expect(hasPermissions('0')).toBe(false)
    expect(hasPermissions('85056')).toBe(false) // no MANAGE_CHANNELS
    expect(hasPermissions(String(85072 - 1024))).toBe(false)
  })

  it('reads permission strings beyond 2^53 exactly', () => {
    expect(hasPermissions(((1n << 60n) | 85072n).toString())).toBe(true)
    expect(hasPermissions(((1n << 60n) | 85056n).toString())).toBe(false)
  })
})

describe('messageContentOn', () => {
  it('counts the full or the limited flag', () => {
    expect(messageContentOn(1 << 18)).toBe(true)
    expect(messageContentOn(1 << 19)).toBe(true)
    expect(messageContentOn((1 << 23) | (1 << 19))).toBe(true)
    expect(messageContentOn(0)).toBe(false)
    expect(messageContentOn(1 << 17)).toBe(false)
  })
})

describe('ownerOf', () => {
  it('is the owning user for a personal app', () => {
    expect(ownerOf({ owner: { id: OWNER, username: 'me', flags: 0 }, team: null })).toEqual({ id: OWNER, name: 'me', team: false })
  })

  it('is the team owner for a team app, not the pseudo-user', () => {
    const app = {
      owner: { id: '999', username: 'team123', flags: 1024 },
      team: { owner_user_id: OWNER, members: [{ user: { id: '777', username: 'other' } }, { user: { id: OWNER, username: 'boss' } }] },
    }
    expect(ownerOf(app)).toEqual({ id: OWNER, name: 'boss', team: true })
  })
})

describe('pickGuild', () => {
  it('prefers the configured server, else the only one, else none', () => {
    const guilds = [guild('g1'), guild('g2')]
    expect(pickGuild(guilds, 'g2')).toBe(guilds[1])
    expect(pickGuild(guilds)).toBeUndefined()
    expect(pickGuild(guilds, 'gone')).toBeUndefined()
    expect(pickGuild([guilds[0]])).toBe(guilds[0])
    expect(pickGuild([guilds[0]], 'gone')).toBe(guilds[0])
  })
})

describe('parseYesNo', () => {
  it('takes the default on an empty answer', () => {
    expect(parseYesNo('', true)).toBe(true)
    expect(parseYesNo('  ', false)).toBe(false)
    expect(parseYesNo('n', true)).toBe(false)
    expect(parseYesNo('No', true)).toBe(false)
    expect(parseYesNo('Y', false)).toBe(true)
    expect(parseYesNo('yes', false)).toBe(true)
  })
})

describe('preflight', () => {
  it('passes a recent Node with tmux', () => {
    expect(preflight('darwin', '24.12.0', true)).toEqual([])
    expect(preflight('linux', '25.0.1', true)).toEqual([])
  })

  it('flags an old Node', () => {
    expect(preflight('darwin', '24.11.1', true).join('\n')).toContain('24.12')
    expect(preflight('darwin', '22.20.0', true).join('\n')).toContain('24.12')
  })

  it('prints the install command for the missing tmux', () => {
    expect(preflight('darwin', '24.12.0', false).join('\n')).toContain('brew install tmux')
    expect(preflight('linux', '24.12.0', false).join('\n')).toContain('sudo apt install tmux')
    expect(preflight('win32', '24.12.0', false).join('\n')).toContain('winget install marlocarlo.psmux')
  })
})

describe('openCommand', () => {
  it('uses the platform opener, quoting the URL for cmd so & stays literal', () => {
    const url = inviteUrl('app1')
    expect(openCommand('darwin', url)).toEqual(['open', [url]])
    expect(openCommand('linux', url)).toEqual(['xdg-open', [url]])
    expect(openCommand('win32', url)).toEqual(['cmd', ['/c', 'start', '""', `"${url}"`]])
  })
})

type Routes = Record<string, unknown>
// A scripted Discord: each route is a value, a Response, or a function of (body, auth) returning one.
function harness(routes: Routes, over: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: any; auth?: string }[] = []
  const lines: string[] = []
  const opened: string[] = []
  const questions: string[] = []
  const saved: string[] = []
  const installs: string[] = []
  const answers = (over.answers as string[] | undefined) ?? []
  const hidden = (over.hidden as string[] | undefined) ?? [fake]
  const io = {
    fetch: async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET'
      const path = url.replace('https://discord.com/api/v10', '')
      const body = init.body ? JSON.parse(init.body as string) : undefined
      const auth = (init.headers as Record<string, string>).Authorization
      calls.push({ method, path, body, auth })
      let r = routes[`${method} ${path}`]
      if (typeof r === 'function') r = r(body, auth)
      if (r === undefined) return new Response('{}', { status: 404 })
      return r instanceof Response ? r : Response.json(r)
    },
    tty: false,
    ask: async (q: string) => {
      questions.push(q)
      if (!answers.length) throw new Error(`unexpected question: ${q}`)
      return answers.shift()!
    },
    askHidden: async () => {
      if (!hidden.length) throw new Error('unexpected token prompt')
      return hidden.shift()!
    },
    open: (url: string) => void opened.push(url),
    log: (line: string) => void lines.push(line),
    sleep: async () => {},
    hasTmux: () => true,
    readToken: () => null,
    writeToken: (t: string) => void saved.push(t),
    installService: (log: (line: string) => void) => { installs.push('install'); log('installed') },
    configPath: join(mkdtempSync(join(tmpdir(), 'ccds-setup-')), 'config.json'),
    ...over,
  }
  const output = () => lines.join('\n')
  return { io, calls, lines, opened, questions, saved, installs, output, config: () => readConfig(io.configPath) }
}

const me = (auth?: string) => (auth === `Bot ${fake}` ? { id: 'bot1', username: 'ccds', avatar: 'a1b2' } : new Response('{}', { status: 401 }))
const app = (over: Record<string, unknown> = {}) => ({
  id: 'app1', owner: { id: OWNER, username: 'me', flags: 0 }, team: null, bot_public: false, flags: 1 << 19, ...over,
})
const happy = (over: Routes = {}): Routes => ({
  'GET /users/@me': (_: unknown, auth: string) => me(auth),
  'GET /applications/@me': app(),
  'GET /users/@me/guilds?with_counts=true': [guild('892877557492510771')],
  ...over,
})

describe('setup (non-TTY)', () => {
  it('reads the token, finds owner, intent and server, then saves without printing the token', async () => {
    const h = harness(happy())
    await setup(h.io)
    expect(h.saved).toEqual([fake])
    expect(h.config()).toEqual({ guildId: '892877557492510771', userId: OWNER })
    expect(h.calls.every((c) => c.auth === `Bot ${fake}`)).toBe(true)
    expect(h.calls.some((c) => c.method !== 'GET')).toBe(false) // intent on, avatar set: nothing to change
    expect(h.opened).toEqual([]) // token came on stdin, bot already in a server
    expect(h.output()).not.toContain(fake)
    expect(h.output()).toContain('Server 892877557492510771')
    expect(h.output()).toContain(`Who may type: me (${OWNER})`)
    expect(h.installs).toEqual(['install']) // no terminal: start at login by default
    expect(h.lines.slice(-2)).toEqual(['installed', 'Start Claude Code inside tmux and a channel appears.'])
  })

  it('saves a new token as soon as it validates, so a later failure needs no new token', async () => {
    const h = harness(happy({ 'GET /applications/@me': app({ flags: 0 }), 'PATCH /applications/@me': new Response('{}', { status: 403 }) }))
    await expect(setup(h.io)).rejects.toThrow(/Message Content/)
    expect(h.saved).toEqual([fake])
    expect(h.config()).toEqual({})
    expect(h.installs).toEqual([])
  })

  it('refuses a malformed token without sending it anywhere', async () => {
    const h = harness(happy(), { hidden: ['not a token'] })
    await expect(setup(h.io)).rejects.toThrow(/token/i)
    expect(h.calls).toEqual([])
    expect(h.saved).toEqual([])
  })

  it('errors on a token Discord rejects, saving nothing', async () => {
    const h = harness(happy(), { hidden: ['wrong.token-456'] })
    await expect(setup(h.io)).rejects.toThrow(/token/i)
    expect(h.saved).toEqual([])
    expect(h.config()).toEqual({})
  })

  it('keeps a stored token that still works when nothing is piped', async () => {
    const h = harness(happy(), { readToken: () => fake, hidden: [''] })
    await setup(h.io)
    expect(h.saved).toEqual([])
    expect(h.config().userId).toBe(OWNER)
  })

  it('replaces a stored token that still works with one piped on stdin', async () => {
    const stored = 'stored.token-111'
    const h = harness(happy({ 'GET /users/@me': (_: unknown, auth: string) => me(auth === `Bot ${stored}` ? `Bot ${fake}` : auth) }), {
      readToken: () => stored,
    })
    await setup(h.io)
    expect(h.saved).toEqual([fake])
    expect(h.calls.every((c) => c.auth === `Bot ${fake}`)).toBe(true)
  })

  it('refuses a rejected piped token instead of falling back to the stored one', async () => {
    const h = harness(happy(), { readToken: () => fake, hidden: ['wrong.token-456'] })
    await expect(setup(h.io)).rejects.toThrow(/rejected/)
    expect(h.saved).toEqual([])
  })

  it('keeps the user chosen last time, even for a team app', async () => {
    const other = '123456789012345678'
    const team = { owner_user_id: OWNER, members: [{ user: { id: OWNER, username: 'boss' } }] }
    for (const a of [app(), app({ owner: { id: '999', username: 'team', flags: 1024 }, team })]) {
      const h = harness(happy({ 'GET /applications/@me': a }))
      writeConfig(h.io.configPath, { guildId: '892877557492510771', userId: other })
      await setup(h.io)
      expect(h.config().userId).toBe(other)
    }
  })

  it('replaces a config file that is not valid JSON', async () => {
    const h = harness(happy())
    writeFileSync(h.io.configPath, 'null')
    await setup(h.io)
    expect(h.output()).toContain(`Warning: ignoring the unreadable ${h.io.configPath}`)
    expect(h.config()).toEqual({ guildId: '892877557492510771', userId: OWNER })
  })

  it('asks for a new token when the stored one no longer works', async () => {
    const h = harness(happy(), { readToken: () => 'stale.token-000' })
    await setup(h.io)
    expect(h.saved).toEqual([fake])
  })

  it('refuses a team-owned app, since who may type is ambiguous', async () => {
    const team = { owner_user_id: OWNER, members: [{ user: { id: OWNER, username: 'boss' } }] }
    const h = harness(happy({ 'GET /applications/@me': app({ owner: { id: '999', username: 'team', flags: 1024 }, team }) }))
    await expect(setup(h.io)).rejects.toThrow(/team/i)
    expect(h.saved).toEqual([fake])
    expect(h.config()).toEqual({})
  })

  it('refuses to guess between several servers', async () => {
    const h = harness(happy({ 'GET /users/@me/guilds?with_counts=true': [guild('g1'), guild('g2')] }))
    await expect(setup(h.io)).rejects.toThrow(/server/i)
    expect(h.config()).toEqual({})
  })

  it('uses the configured server among several', async () => {
    const h = harness(happy({ 'GET /users/@me/guilds?with_counts=true': [guild('g1'), guild('g2')] }))
    writeConfig(h.io.configPath, { guildId: 'g2', userId: OWNER })
    await setup(h.io)
    expect(h.config()).toEqual({ guildId: 'g2', userId: OWNER })
  })

  it('turns Message Content on through the API, keeping the other flags', async () => {
    let flags = 1 << 23
    const h = harness(happy({
      'GET /applications/@me': () => app({ flags }),
      'PATCH /applications/@me': (body: { flags: number }) => { flags = body.flags; return app({ flags }) },
    }))
    await setup(h.io)
    expect(h.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ flags: (1 << 23) | (1 << 19) })
    expect(h.opened).toEqual([])
  })

  it('opens the Bot page and waits for the switch when the API cannot set Message Content', async () => {
    let reads = 0
    const h = harness(happy({
      'GET /applications/@me': () => app({ flags: ++reads > 3 ? 1 << 19 : 0 }),
      'PATCH /applications/@me': new Response('{}', { status: 403 }),
    }))
    await setup(h.io)
    expect(h.opened).toEqual(['https://discord.com/developers/applications/app1/bot'])
    expect(h.output()).toContain('https://discord.com/developers/applications/app1/bot') // URL always printed too
    expect(h.config().guildId).toBe('892877557492510771')
  })

  it('gives up on Message Content after 10 minutes', async () => {
    const h = harness(happy({ 'GET /applications/@me': app({ flags: 0 }), 'PATCH /applications/@me': new Response('{}', { status: 403 }) }))
    await expect(setup(h.io)).rejects.toThrow(/Message Content/)
    expect(h.calls.filter((c) => c.path === '/applications/@me' && c.method === 'GET').length).toBeLessThan(210)
  })

  it('uploads the logo when the bot has no avatar, and survives a failed upload', async () => {
    const noAvatar = (_: unknown, auth: string) => ({ ...me(auth), avatar: null })
    const ok = harness(happy({ 'GET /users/@me': noAvatar, 'PATCH /users/@me': { id: 'bot1' } }))
    await setup(ok.io)
    expect(ok.calls.find((c) => c.method === 'PATCH' && c.path === '/users/@me')?.body.avatar).toMatch(/^data:image\/png;base64,iVBOR/)

    const bad = harness(happy({ 'GET /users/@me': noAvatar, 'PATCH /users/@me': new Response('{}', { status: 400 }) }))
    await setup(bad.io)
    expect(bad.config().guildId).toBe('892877557492510771')
  })

  it('warns when the bot is Public', async () => {
    const h = harness(happy({ 'GET /applications/@me': app({ bot_public: true }) }))
    await setup(h.io)
    expect(h.output()).toMatch(/Public/)
  })

  it('opens the invite and waits until the bot joins a server', async () => {
    let reads = 0
    const h = harness(happy({ 'GET /users/@me/guilds?with_counts=true': () => (++reads > 2 ? [guild('g1')] : []) }))
    await setup(h.io)
    expect(h.opened).toEqual([inviteUrl('app1')])
    expect(h.output()).toContain(inviteUrl('app1'))
    expect(h.config().guildId).toBe('g1')
  })

  it('reopens the invite for that server when permissions are missing', async () => {
    let reads = 0
    const h = harness(happy({ 'GET /users/@me/guilds?with_counts=true': () => [guild('g1', ++reads > 2 ? '8' : '1024')] }))
    await setup(h.io)
    expect(h.opened).toEqual([inviteUrl('app1', 'g1')])
    expect(h.config().guildId).toBe('g1')
  })

  it('warns when other people are in the server', async () => {
    const quiet = harness(happy())
    await setup(quiet.io)
    expect(quiet.output()).not.toMatch(/everything Claude prints/)
    const busy = harness(happy({ 'GET /users/@me/guilds?with_counts=true': [guild('g1', '85072', 5)] }))
    await setup(busy.io)
    expect(busy.output()).toMatch(/everything Claude prints/)
  })
})

describe('setup (TTY)', () => {
  it('opens the portal and asks again after a rejected token', async () => {
    const h = harness(happy(), { tty: true, hidden: ['wrong.token-456', 'not a token', fake], answers: ['', ''] })
    await setup(h.io)
    expect(h.opened).toEqual(['https://discord.com/developers/applications'])
    expect(h.saved).toEqual([fake])
  })

  it('asks before replacing a stored bot', async () => {
    const h = harness(happy(), { tty: true, readToken: () => fake, hidden: [fake], answers: ['n', '', ''] })
    await setup(h.io)
    expect(h.questions[0]).toMatch(/Keep the existing bot.*\[Y\/n\]/)
    expect(h.saved).toEqual([fake])
  })

  it('takes a typed user ID, echoing the account name', async () => {
    const other = '123456789012345678'
    const h = harness(happy({ [`GET /users/${other}`]: { id: other, username: 'friend' } }), {
      tty: true, answers: ['n', 'abc', other, 'y', ''],
    })
    await setup(h.io)
    expect(h.output()).toMatch(/17 to 20 digits/)
    expect(h.questions.at(-2)).toContain('friend')
    expect(h.config().userId).toBe(other)
  })

  it('offers to keep the user chosen last time, by name, and asks the usual way on no', async () => {
    const other = '123456789012345678'
    const routes = happy({ [`GET /users/${other}`]: { id: other, username: 'friend' } })
    const kept = harness(routes, { tty: true, answers: ['', ''] })
    writeConfig(kept.io.configPath, { guildId: '892877557492510771', userId: other })
    await setup(kept.io)
    expect(kept.questions[0]).toBe('Keep friend as the only user who can type? [Y/n] ')
    expect(kept.config().userId).toBe(other)

    const changed = harness(routes, { tty: true, answers: ['n', '', ''] })
    writeConfig(changed.io.configPath, { guildId: '892877557492510771', userId: other })
    await setup(changed.io)
    expect(changed.questions[1]).toMatch(/^Only me .* OK\? \[Y\/n\] $/)
    expect(changed.config().userId).toBe(OWNER)
  })

  it('defaults to No for a team app', async () => {
    const other = '123456789012345678'
    const team = { owner_user_id: OWNER, members: [{ user: { id: OWNER, username: 'boss' } }] }
    const h = harness(happy({
      'GET /applications/@me': app({ owner: { id: '999', username: 'team', flags: 1024 }, team }),
      [`GET /users/${other}`]: { id: other, username: 'friend' },
    }), { tty: true, answers: ['', other, '', ''] })
    await setup(h.io)
    expect(h.questions[0]).toMatch(/\[y\/N\]/)
    expect(h.config().userId).toBe(other)
  })

  it('lets the user pick among several servers', async () => {
    const h = harness(happy({ 'GET /users/@me/guilds?with_counts=true': [guild('g1'), guild('g2')] }), {
      tty: true, answers: ['', '9', '2', ''],
    })
    await setup(h.io)
    expect(h.config().guildId).toBe('g2')
  })

  it('asks to start at login, installing on yes', async () => {
    const h = harness(happy(), { tty: true, answers: ['', ''] })
    await setup(h.io)
    expect(h.questions.at(-1)).toBe('Start automatically at login? [Y/n] ')
    expect(h.installs).toEqual(['install'])
    expect(h.output()).toContain('Start Claude Code inside tmux and a channel appears.')
  })

  it('prints the start command instead when the user declines', async () => {
    const h = harness(happy(), { tty: true, answers: ['', 'n'] })
    await setup(h.io)
    expect(h.installs).toEqual([])
    expect(h.config().userId).toBe(OWNER)
    expect(h.output()).toContain('claude-code-discord-sync start')
  })
})
