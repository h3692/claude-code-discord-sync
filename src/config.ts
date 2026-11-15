import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { text } from 'node:stream/consumers'
import { Writable } from 'node:stream'
import { promisify } from 'node:util'

type Env = Record<string, string | undefined>
export type Config = { guildId?: string; userId?: string }
// The token travels only in `input` (stdin), never in args.
export type Command = { file: string; args: string[]; input?: string; env?: NodeJS.ProcessEnv }

export const appName = (env: Env): string => env.CCDS_NAME || 'claude-code-discord-sync'

export function configDirFor(platform: string, env: Env, home: string): string {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), appName(env))
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), appName(env))
}

export function readConfig(path: string): Config {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
}

export function writeConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

// `security -i` reads one command per line: a space, quote or newline in a value would smuggle in another command.
const safe = (value: string): string => {
  if (!/^[\w.-]+$/.test(value)) throw new Error('Refusing a value with characters other than letters, digits, _ . -')
  return value
}

export const keychainWrite = (name: string, user: string, token: string): Command => ({
  file: 'security',
  args: ['-i'],
  input: `add-generic-password -U -a ${safe(user)} -s ${safe(name)} -w ${safe(token)}\n`,
})
export const keychainRead = (name: string): Command => ({ file: 'security', args: ['find-generic-password', '-s', name, '-w'] })
export const keychainDelete = (name: string): Command => ({ file: 'security', args: ['delete-generic-password', '-s', name] })

// ConvertFrom-SecureString without -AsPlainText (PowerShell 7 only) gives the DPAPI blob for this user.
// Started from PowerShell 7, Windows PowerShell 5.1 inherits 7's PSModulePath and can't load its own cmdlets, so drop it.
export function powershell(script: string, input?: string): Command {
  const { PSModulePath: _, ...env } = process.env
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], input, env }
}
// DPAPI through .NET directly, so no PowerShell module has to load.
const DPAPI = "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); "
export const dpapiEncrypt = (token: string): Command => powershell(DPAPI +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()), $null, 'CurrentUser'))", token)
export const dpapiDecrypt = (blob: string): Command => powershell(DPAPI +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()), $null, 'CurrentUser'))", blob)

export const run = ({ file, args, input, env }: Command): string => execFileSync(file, args, { input, env, encoding: 'utf8', stdio: 'pipe', windowsHide: true })
// For the watcher, which must not block or hang on a slow PowerShell: any failure or timeout rejects. Takes no stdin.
export const runAsync = async ({ file, args, env }: Command): Promise<string> =>
  (await promisify(execFile)(file, args, { env, encoding: 'utf8', timeout: 10_000, windowsHide: true })).stdout

const tokenFileFor = (platform: string, env: Env, home: string): string =>
  platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), appName(env), 'token.dpapi')
    : join(configDirFor(platform, env, home), 'token')

function readFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export function readToken(platform = process.platform as string, env: Env = process.env, home = homedir()): string | null {
  if (platform === 'darwin') {
    try {
      return run(keychainRead(appName(env))).trim()
    } catch (e) {
      if ((e as { status?: unknown }).status === 44) return null // item not found
      throw e
    }
  }
  const stored = readFile(tokenFileFor(platform, env, home))
  if (platform !== 'win32' || stored === null) return stored
  return run(dpapiDecrypt(stored)).trim()
}

export function writeToken(token: string, platform = process.platform as string, env: Env = process.env, home = homedir()): void {
  if (platform === 'darwin') {
    run(keychainWrite(appName(env), userInfo().username, token))
    return
  }
  const path = tokenFileFor(platform, env, home)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (platform === 'win32') {
    writeFileSync(path, run(dpapiEncrypt(token)).trim())
    return
  }
  // `mode` applies only when the file or folder is created.
  chmodSync(dirname(path), 0o700)
  writeFileSync(path, token, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function deleteToken(platform = process.platform as string, env: Env = process.env, home = homedir()): void {
  if (platform === 'darwin') {
    try {
      run(keychainDelete(appName(env)))
    } catch (e) {
      if ((e as { status?: unknown }).status !== 44) throw e
    }
    return
  }
  rmSync(tokenFileFor(platform, env, home), { force: true })
}

// Piped stdin (no TTY) is read whole, so `security find-generic-password -w | ... setup` works.
export async function promptHidden(
  label: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  if (!input.isTTY) return (await text(input)).trim()
  // readline echoes keystrokes to its output; dropping that output hides the token.
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() })
  const rl = createInterface({ input, output: muted, terminal: true, historySize: 0 })
  rl.on('SIGINT', () => process.exit(130))
  output.write(label)
  try {
    return (await rl.question('')).trim()
  } finally {
    rl.close()
    output.write('\n')
  }
}
