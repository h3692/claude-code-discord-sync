import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
// A throwaway name and folders, so start never finds the real config or the real Keychain item.
const scratch = mkdtempSync(join(tmpdir(), 'ccds-cli-'))
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DISCORD_'))),
  CCDS_NAME: `ccds-test-${process.pid}`, XDG_CONFIG_HOME: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
  CLAUDE_DIR: join(scratch, 'claude'),
}
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env })

describe('cli', () => {
  it('prints usage listing every command for --help, -h, help and no command', () => {
    for (const args of [['--help'], ['-h'], ['help'], []]) {
      const r = run(...args)
      expect(r.status, args.join(' ')).toBe(0)
      for (const command of ['setup', 'start', 'status', 'uninstall']) expect(r.stdout).toContain(command)
    }
  })

  it('prints usage to stderr and exits 1 for an unknown command', () => {
    const r = run('nope')
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('Usage: claude-code-discord-sync')
  })

  it('tells the user to run setup when nothing is configured', () => {
    const r = run('start')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('claude-code-discord-sync setup')
  })

  it('runs setup, which refuses an empty piped token before touching the network', () => {
    const r = spawnSync(process.execPath, [cli, 'setup'], { encoding: 'utf8', env, input: '' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/token/i)
    expect(r.stderr).not.toContain('not available yet')
  })

  it('reports status for a fresh install without printing secrets', () => {
    const r = run('status')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Config: not set up')
    expect(r.stdout).toContain('Token: not stored')
    expect(r.stdout).toContain('Service: not installed')
    expect(r.stdout).toMatch(/^tmux: /m)
    expect(r.stdout).toContain('Sessions: none')
  })

  it.runIf(process.platform === 'win32')('on Windows, status prints the raw procStartFt, the measured start time and the typing switch', () => {
    mkdirSync(join(scratch, 'claude', 'sessions'), { recursive: true })
    writeFileSync(join(scratch, 'claude', 'sessions', `${process.pid}.json`), `{"pid":${process.pid},"sessionId":"sid-w","procStartFt":"123"}`)
    const r = run('status')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Windows typing: off')
    expect(r.stdout).toMatch(new RegExp(`pid ${process.pid}: procStartFt "123", measured \\d+`))
  })

  it('uninstalls: removes the config folder and says Discord is left alone', () => {
    const dir = join(scratch, env.CCDS_NAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ guildId: '111', userId: '222' }))
    const r = run('uninstall')
    expect(r.status, r.stderr).toBe(0)
    expect(existsSync(dir)).toBe(false)
    expect(r.stdout).toContain(`Removed the config folder ${dir}`)
    expect(r.stdout).toContain('No login service was installed.')
    expect(r.stdout).toContain('Discord')
  })

  it('still asks for setup when the config has ids but no token is stored', () => {
    mkdirSync(join(scratch, env.CCDS_NAME), { recursive: true })
    writeFileSync(join(scratch, env.CCDS_NAME, 'config.json'), JSON.stringify({ guildId: '111', userId: '222' }))
    const r = run('start')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('claude-code-discord-sync setup')
  })

  it('start --background returns at once, leaving a detached watcher that logs to LOCALAPPDATA', async () => {
    const r = run('start', '--background')
    expect(r.status, r.stderr).toBe(0)
    // No token in the scratch store, so the detached watcher says so in its log and exits.
    const log = join(scratch, env.CCDS_NAME, 'watcher.log')
    const read = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    for (let i = 0; i < 100 && !read().includes('setup'); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(read()).toContain('claude-code-discord-sync setup')
  })
})
