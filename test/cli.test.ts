import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

  it('still asks for setup when the config has ids but no token is stored', () => {
    mkdirSync(join(scratch, env.CCDS_NAME), { recursive: true })
    writeFileSync(join(scratch, env.CCDS_NAME, 'config.json'), JSON.stringify({ guildId: '111', userId: '222' }))
    const r = run('start')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('claude-code-discord-sync setup')
  })
})
