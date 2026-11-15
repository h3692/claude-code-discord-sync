import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { appName, configDirFor, deleteToken, readConfig, readToken, run } from './config.ts'
import type { Command } from './config.ts'
import { commandLine, isWatcherCommand, lockDirFor } from './index.ts'
import { listSessions, readRegistry, windowsStartTimes } from './sessions.ts'
import { checkPane } from './tmux.ts'

type Env = Record<string, string | undefined>
// mayFail: ignore a failure. fallback: on failure, print this instead and stop the install.
// untilFails: rerun every 200 ms until it fails, for up to 10 s. retries: on failure, run again after 1 s.
type Step = Command & { mayFail?: true; fallback?: string; untilFails?: true; retries?: number }
// watcher: the pid of a running Windows watcher, which nothing else stops.
export type Paths = { name: string; node: string; cli: string; home: string; uid: number; env: Env; watcher?: number }
export type Service = {
  file: { path: string; text: string } | null // null on Windows, where the Run value is the whole definition
  log?: string // the watcher's log file, where it has one
  install: Step[]
  uninstall: Step[]
  query: Command
  note?: string
}

// Only set for isolated installs (live tests); a default install passes none of them.
const PASSTHROUGH = ['CCDS_NAME', 'CLAUDE_DIR', 'XDG_CONFIG_HOME']
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const NO_SYSTEMD = `systemd isn't running for your user, so nothing can start the watcher at login.
On WSL, add this to /etc/wsl.conf, run \`wsl --shutdown\` from Windows, then run setup again:
  [boot]
  systemd=true
Until then, start the watcher yourself with: claude-code-discord-sync start`

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
// systemd unquotes C-style and expands %specifiers everywhere; ExecStart also expands $VARS.
function systemdQuote(s: string, exec = false): string {
  const quoted = s.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')
  return `"${exec ? quoted.replace(/\$/g, '$$$$') : quoted}"`
}
const systemdUnquote = (s: string) => s.replace(/\\(.)|%%|\$\$/g, (m, c) => c ?? m[0])

// POSIX paths for macOS and Linux, so the generators give the same text on any OS (and in Windows CI).
export function serviceFor(platform: string, { name, node, cli, home, uid, env, watcher }: Paths): Service {
  if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) throw new Error(`Refusing the service name ${name}`)
  const passed = PASSTHROUGH.filter((k) => env[k]).map((k) => [k, env[k]!])
  // The bin shim finds node through PATH, so upgrading node (a new Cellar keg) doesn't break the service.
  const program = /\.[jt]s$/.test(cli) ? [node, cli] : [cli]
  if (platform === 'darwin') {
    const path = posix.join(home, 'Library', 'LaunchAgents', `${name}.plist`)
    const log = posix.join(home, 'Library', 'Logs', `${name}.log`)
    const vars = [['PATH', `${posix.dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`], ...passed]
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(name)}</string>
	<key>ProgramArguments</key>
	<array>
${[...program, 'start'].map((a) => `		<string>${xml(a)}</string>\n`).join('')}	</array>
	<key>EnvironmentVariables</key>
	<dict>
${vars.map(([k, v]) => `		<key>${k}</key>\n		<string>${xml(v)}</string>\n`).join('')}	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`
    // bootout returns before the job is gone, and bootstrap fails with error 5 until it is.
    const bootout: Step[] = [
      { file: 'launchctl', args: ['bootout', `gui/${uid}/${name}`], mayFail: true },
      { file: 'launchctl', args: ['print', `gui/${uid}/${name}`], untilFails: true },
    ]
    return {
      file: { path, text },
      log,
      install: [...bootout, { file: 'launchctl', args: ['bootstrap', `gui/${uid}`, path], retries: 3 }],
      uninstall: bootout,
      query: { file: 'launchctl', args: ['print', `gui/${uid}/${name}`] },
    }
  }
  if (platform === 'win32') {
    // shortcut: a Run value can't carry env vars, so isolated names only work until the next login; fine for live tests.
    const note = passed.some(([k]) => k !== 'XDG_CONFIG_HOME')
      ? `At login the Run entry starts with the default settings: it can't carry CCDS_NAME or CLAUDE_DIR.`
      : undefined
    const kill: Step[] = watcher ? [{ file: 'taskkill', args: ['/PID', String(watcher), '/F'], mayFail: true }] : []
    return {
      file: null,
      log: join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), name, 'watcher.log'),
      install: [
        { file: 'reg', args: ['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', `"${node}" "${cli}" start --background`, '/f'] },
        ...kill,
        { file: node, args: [cli, 'start', '--background'] },
      ],
      uninstall: [{ file: 'reg', args: ['delete', RUN_KEY, '/v', name, '/f'], mayFail: true }, ...kill],
      query: { file: 'reg', args: ['query', RUN_KEY, '/v', name] },
      ...(note && { note }),
    }
  }
  const path = posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'systemd', 'user', `${name}.service`)
  const text = `[Unit]
Description=${name}

[Service]
ExecStart=${program.map((a) => systemdQuote(a, true)).join(' ')} start
${[['PATH', `${posix.dirname(node)}:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin`], ...passed].map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`).join('')}Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`
  const systemctl = (...args: string[]): Command => ({ file: 'systemctl', args: ['--user', ...args] })
  return {
    file: { path, text },
    install: [{ ...systemctl('daemon-reload'), fallback: NO_SYSTEMD }, systemctl('enable', '--now', name), systemctl('restart', name)],
    uninstall: [{ ...systemctl('disable', '--now', name), mayFail: true }],
    query: systemctl('is-active', name),
  }
}

// The paths an installed service runs, [node, cli] or the bin shim alone, from its file (or `reg query` output on Windows).
export function programOf(platform: string, text: string): string[] | null {
  if (platform === 'darwin') {
    const m = /<key>ProgramArguments<\/key>\s*<array>([^]*?)<\/array>/.exec(text)
    const args = m ? [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => unxml(x[1])) : []
    return args.length > 1 ? args.slice(0, -1) : null
  }
  if (platform === 'win32') {
    const m = /REG_SZ\s+"([^"]*)" "([^"]*)"/.exec(text)
    return m ? [m[1], m[2]] : null
  }
  const m = /^ExecStart=((?:"(?:[^"\\]|\\.)*" )+)start$/m.exec(text)
  return m ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => systemdUnquote(x[1])) : null
}

// argv[1] unresolved: the bin symlink survives `brew upgrade`, the Cellar keg it points into doesn't.
const here = (env: Env = process.env): Paths => ({
  name: appName(env), node: process.execPath, cli: process.argv[1], home: homedir(), uid: process.getuid?.() ?? 0, env,
})

const lockOf = (platform: string, env: Env): string => join(lockDirFor(platform, env, homedir()), `${appName(env)}.lock`)
// The pid of the watcher holding this lock: undefined for no lock, a stale one, or a command line we can't read.
function holder(lock: string): number | undefined {
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 && isWatcherCommand(commandLine(pid)) ? pid : undefined
  } catch {
    return undefined
  }
}

const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Runs the steps in order; false when a step's fallback was printed instead.
export function runSteps(steps: Step[], log: (line: string) => void, exec: (c: Command) => unknown = run, sleep = pause): boolean {
  for (const step of steps) {
    if (step.untilFails) {
      for (let i = 0; i < 50; i++) {
        try {
          exec(step)
        } catch {
          break
        }
        sleep(200)
      }
      continue
    }
    for (let tries = step.retries ?? 0; ; tries--) {
      try {
        exec(step)
        break
      } catch (e) {
        if (step.fallback) return (log(step.fallback), false)
        if (step.mayFail) break
        if (tries <= 0) throw e
        sleep(1000)
      }
    }
  }
  return true
}

const query = (c: Command): { ok: boolean; stdout: string } => {
  try {
    return { ok: true, stdout: run(c) }
  } catch (e) {
    return { ok: false, stdout: String((e as { stdout?: unknown }).stdout ?? '') }
  }
}

// Installs (or reinstalls) the service and (re)starts it.
export function installService(log: (line: string) => void, platform = process.platform as string): void {
  const s = serviceFor(platform, { ...here(), watcher: platform === 'win32' ? holder(lockOf(platform, process.env)) : undefined })
  if (s.file) {
    mkdirSync(dirname(s.file.path), { recursive: true })
    writeFileSync(s.file.path, s.file.text)
  }
  if (!runSteps(s.install, log)) return
  log(`Starts at login: ${s.file?.path ?? `${RUN_KEY}\\${appName(process.env)}`}`)
  if (s.note) log(`Note: ${s.note}`)
}

export async function status(platform = process.platform as string, env: Env = process.env): Promise<void> {
  const s = serviceFor(platform, here(env))
  const configPath = join(configDirFor(platform, env, homedir()), 'config.json')
  const config = readConfig(configPath)
  console.log(config.guildId && config.userId
    ? `Config: server ${config.guildId}, typing allowed for user ${config.userId} (${configPath})`
    : `Config: not set up (run \`claude-code-discord-sync setup\`)`)
  let token: string
  try {
    token = readToken(platform, env) === null ? 'not stored' : 'stored'
  } catch {
    token = 'stored but unreadable'
  }
  console.log(`Token: ${token}`)

  const q = query(s.query)
  const installed = s.file ? existsSync(s.file.path) : q.ok
  if (!installed) console.log('Service: not installed')
  else {
    const state = platform === 'darwin' ? (/^\s*state = (.+)$/m.exec(q.stdout)?.[1] ?? 'not loaded')
      : platform === 'win32' ? 'starts at login' : q.stdout.trim() || 'unknown'
    console.log(`Service: ${state} (${s.file?.path ?? RUN_KEY})`)
    const program = programOf(platform, s.file ? readFileSync(s.file.path, 'utf8') : q.stdout)
    // A version manager switch (nvm) can remove the node the service was set up with.
    const what = program?.length === 2 ? ['node', 'cli'] : ['cli']
    for (const [i, path] of (program ?? []).entries()) {
      console.log(`  ${what[i]}: ${path}${existsSync(path) ? '' : ' (missing: re-run setup)'}`)
    }
    if (s.note) console.log(`  Note: ${s.note}`)
  }

  let tmux: string
  try {
    tmux = execFileSync('tmux', ['-V'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim()
  } catch {
    tmux = 'not found'
  }
  console.log(`tmux: ${tmux}`)

  const claudeDir = env.CLAUDE_DIR || join(homedir(), '.claude')
  const sessionsDir = join(claudeDir, 'sessions')
  if (platform === 'win32') {
    console.log(`Windows typing: ${env.CCDS_WINDOWS_TYPING === '1' ? 'on (CCDS_WINDOWS_TYPING=1)' : 'off (set CCDS_WINDOWS_TYPING=1 to try it)'}`)
    // Every registry entry with procStartFt exactly as written and the start time measured now, to diagnose a mismatch.
    const entries = await readRegistry(sessionsDir)
    const measured = entries.length ? await windowsStartTimes(entries.map((e) => e.pid)).catch((e: Error) => `failed: ${e.message}`) : new Map()
    for (const e of entries) {
      const text = await readFile(join(sessionsDir, `${e.pid}.json`), 'utf8').catch(() => '')
      const raw = /"procStartFt"\s*:\s*("[^"]*"|[^\s,}]+)/.exec(text)?.[1] ?? 'missing'
      console.log(`  pid ${e.pid}: procStartFt ${raw}, measured ${typeof measured === 'string' ? measured : measured.get(e.pid) ?? 'none'}`)
    }
  }
  const sessions = await listSessions(sessionsDir, join(claudeDir, 'projects'), platform)
  console.log(`Sessions: ${sessions.length || 'none'}`)
  const typingOff = platform === 'win32' && env.CCDS_WINDOWS_TYPING !== '1'
  for (const x of sessions) {
    // The full checks run even with Windows typing off, so status shows whatever else would block it.
    const why = !x.interactive ? 'background session' : !x.pane ? 'not in tmux'
      : await checkPane(x.pane, x.pid, x.procStart, platform, { ...env, CCDS_WINDOWS_TYPING: '1' }) ?? (typingOff ? 'checks pass, but Windows typing is off' : null)
    console.log(`  ${x.name} (pid ${x.pid}${x.pane ? `, pane ${x.pane}` : ''}): ${why ? `read-only, ${why}` : 'can type'}`)
  }
}

// Removes only what appName() names, so CCDS_NAME isolates it. Never touches Discord.
export function uninstall(platform = process.platform as string, env: Env = process.env): void {
  const lock = lockOf(platform, env)
  const s = serviceFor(platform, { ...here(env), watcher: platform === 'win32' ? holder(lock) : undefined })
  const installed = s.file ? existsSync(s.file.path) : query(s.query).ok
  runSteps(s.uninstall, console.log)
  if (s.file) rmSync(s.file.path, { force: true })
  console.log(installed ? `Removed the login service ${s.file?.path ?? `${RUN_KEY}\\${appName(env)}`}` : 'No login service was installed.')

  let stored: boolean
  try {
    stored = readToken(platform, env) !== null
  } catch {
    stored = true
  }
  deleteToken(platform, env)
  console.log(stored ? 'Removed the stored token.' : 'No token was stored.')

  // The service is stopped by now. launchd's SIGTERM skips the watcher's own lock cleanup; a watcher run by hand keeps its lock.
  for (const path of [s.log, holder(lock) ? undefined : lock]) {
    if (path && existsSync(path)) {
      rmSync(path)
      console.log(`Removed ${path}`)
    }
  }
  if (platform === 'win32' && s.log) {
    try {
      rmdirSync(dirname(s.log)) // only once empty: the token file lived here too
      console.log(`Removed the folder ${dirname(s.log)}`)
    } catch {}
  }

  const dir = configDirFor(platform, env, homedir())
  const had = existsSync(dir)
  rmSync(dir, { recursive: true, force: true })
  console.log(had ? `Removed the config folder ${dir}` : 'No config folder was found.')
  console.log('Your Discord server, bot and channels were left alone.')
}
