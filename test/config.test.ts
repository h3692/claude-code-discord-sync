import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  appName, configDirFor, deleteToken, dpapiDecrypt, dpapiEncrypt, keychainDelete, keychainRead, keychainWrite,
  promptHidden, readConfig, readToken, writeConfig, writeToken,
} from '../src/config.ts'

const scratch = () => mkdtempSync(join(tmpdir(), 'ccds-config-'))
const fake = 'dummy.token-123'

describe('appName', () => {
  it('defaults to claude-code-discord-sync and honours CCDS_NAME', () => {
    expect(appName({})).toBe('claude-code-discord-sync')
    expect(appName({ CCDS_NAME: 'ccds-test' })).toBe('ccds-test')
  })
})

describe('configDirFor', () => {
  it('uses ~/.config or XDG_CONFIG_HOME on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(configDirFor(platform, {}, '/home/me')).toBe(join('/home/me', '.config', 'claude-code-discord-sync'))
      expect(configDirFor(platform, { XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(join('/cfg', 'claude-code-discord-sync'))
    }
  })

  it('uses %APPDATA% on Windows', () => {
    const appData = 'C:\\Users\\me\\AppData\\Roaming'
    expect(configDirFor('win32', { APPDATA: appData }, 'C:\\Users\\me')).toBe(join(appData, 'claude-code-discord-sync'))
  })

  it('names the folder after CCDS_NAME', () => {
    expect(configDirFor('linux', { CCDS_NAME: 'ccds-test' }, '/home/me')).toBe(join('/home/me', '.config', 'ccds-test'))
  })
})

describe('readConfig / writeConfig', () => {
  it('reads a missing file as empty', () => {
    expect(readConfig(join(scratch(), 'nope', 'config.json'))).toEqual({})
  })

  it('round-trips the ids, creating the folder', () => {
    const path = join(scratch(), 'a', 'b', 'config.json')
    writeConfig(path, { guildId: '111', userId: '222' })
    expect(readConfig(path)).toEqual({ guildId: '111', userId: '222' })
  })

  it('refuses a file that is not a JSON object with a message naming it', () => {
    const path = join(scratch(), 'config.json')
    for (const text of ['{"guildId": ', 'null', '[]', '"x"', '1', '']) {
      writeFileSync(path, text)
      expect(() => readConfig(path), text).toThrow(`${path} is not valid JSON — fix it or re-run setup`)
    }
  })

  it.skipIf(process.platform === 'win32')('writes the file 0600', () => {
    const path = join(scratch(), 'config.json')
    writeConfig(path, { guildId: '111' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('keychain commands', () => {
  it('writes through security -i with the token only on stdin, updating v1 item', () => {
    const c = keychainWrite('claude-code-discord-sync', 'me', fake)
    expect(c.file).toBe('security')
    expect(c.args).toEqual(['-i'])
    expect(c.input).toBe(`add-generic-password -U -a me -s claude-code-discord-sync -w ${fake}\n`)
  })

  it('refuses a token that could inject a second command on stdin', () => {
    for (const bad of ['a b', 'a\ndelete-generic-password -s x', 'a"b', "a'b", '']) {
      expect(() => keychainWrite('n', 'me', bad)).toThrow()
    }
  })

  it('reads and deletes by service without the token in argv', () => {
    expect(keychainRead('ccds-test')).toEqual({ file: 'security', args: ['find-generic-password', '-s', 'ccds-test', '-w'] })
    expect(keychainDelete('ccds-test')).toEqual({ file: 'security', args: ['delete-generic-password', '-s', 'ccds-test'] })
  })
})

describe('dpapi commands', () => {
  it('keeps the token and the blob on stdin, never in args', () => {
    const enc = dpapiEncrypt(fake)
    expect(enc.file).toBe('powershell.exe')
    expect(enc.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(enc.args.join(' ')).not.toContain(fake)
    expect(enc.args.join(' ')).not.toContain('-AsPlainText -Force | ConvertFrom-SecureString -AsPlainText')
    expect(enc.input).toBe(fake)

    // Launched from PowerShell 7, Windows PowerShell 5.1 inherits 7's module path and fails to load its cmdlets.
    const saved = process.env.PSModulePath
    process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules'
    try {
      expect(dpapiEncrypt(fake).env).not.toHaveProperty('PSModulePath')
    } finally {
      if (saved === undefined) delete process.env.PSModulePath
      else process.env.PSModulePath = saved
    }
    expect(enc.args.join(' ')).not.toMatch(/SecureString/)

    const dec = dpapiDecrypt('01000000d08c')
    expect(dec.args.join(' ')).not.toContain('01000000d08c')
    expect(dec.input).toBe('01000000d08c')
  })
})

// The Linux store is plain files, so it runs on every POSIX host.
describe.skipIf(process.platform === 'win32')('linux token file', () => {
  it('round-trips through a 0600 file in a 0700 folder, and deletes it', () => {
    const home = scratch()
    const env = { CCDS_NAME: 'ccds-test' }
    expect(readToken('linux', env, home)).toBeNull()
    writeToken(fake, 'linux', env, home)
    const dir = join(home, '.config', 'ccds-test')
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readToken('linux', env, home)).toBe(fake)
    deleteToken('linux', env, home)
    expect(readToken('linux', env, home)).toBeNull()
  })

  it('tightens a token file that already existed with looser permissions', () => {
    const home = scratch()
    writeToken(fake, 'linux', {}, home)
    const path = join(home, '.config', 'claude-code-discord-sync', 'token')
    writeFileSync(path, 'old', { mode: 0o644 })
    writeToken(fake, 'linux', {}, home)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe.runIf(process.platform === 'win32')('dpapi round trip (real powershell)', () => {
  it('encrypts to a file under LOCALAPPDATA and decrypts it back', () => {
    const local = scratch()
    const env = { CCDS_NAME: 'ccds-test', LOCALAPPDATA: local }
    expect(readToken('win32', env, local)).toBeNull()
    writeToken(fake, 'win32', env, local)
    expect(statSync(join(local, 'ccds-test', 'token.dpapi')).size).toBeGreaterThan(0)
    expect(readToken('win32', env, local)).toBe(fake)
    deleteToken('win32', env, local)
    expect(readToken('win32', env, local)).toBeNull()
  }, 60_000)
})

describe.runIf(process.platform === 'darwin' && process.env.CCDS_KEYCHAIN_TEST)('keychain round trip (real security)', () => {
  it('writes, reads and deletes a dummy item under ccds-test', () => {
    const env = { CCDS_NAME: 'ccds-test' }
    writeToken(fake, 'darwin', env, '/')
    expect(readToken('darwin', env, '/')).toBe(fake)
    deleteToken('darwin', env, '/')
    expect(readToken('darwin', env, '/')).toBeNull()
  })
})

describe('promptHidden', () => {
  it('reads all of piped stdin, trimmed, when not a TTY', async () => {
    const input = new PassThrough()
    input.end(`${fake}\n`)
    expect(await promptHidden('Token: ', input, new PassThrough())).toBe(fake)
  })
})
