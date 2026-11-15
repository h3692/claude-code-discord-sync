import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DISCORD_')))
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

  it('refuses to start without the required environment variables', () => {
    const r = run('start')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Missing required environment variable DISCORD_BOT_TOKEN')
  })
})
