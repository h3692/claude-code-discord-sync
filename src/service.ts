import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { appName, configDirFor, deleteToken, readConfig, readToken, run } from './config.ts'
import type { Command } from './config.ts'
import { listSessions } from './sessions.ts'
import { checkPane } from './tmux.ts'

type Env = Record<string, string | undefined>
// mayFail: ignore a failure. fallback: on failure, print this instead and stop the install.
type Step = Command & { mayFail?: true; fallback?: string }
export type Paths = { name: string; node: string; cli: string; home: string; uid: number; env: Env }
export type Service = {
  file: { path: string; text: string } | null // null on Windows, where the Run value is the whole definition
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
export function serviceFor(platform: string, { name, node, cli, home, uid, env }: Paths): Service {
  if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) throw new Error(`Refusing the service name ${name}`)
  const passed = PASSTHROUGH.filter((k) => env[k]).map((k) => [k, env[k]!])
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
${[node, cli, 'start'].map((a) => `		<string>${xml(a)}</string>\n`).join('')}	</array>
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
    const bootout: Step = { file: 'launchctl', args: ['bootout', `gui/${uid}/${name}`], mayFail: true }
    return {
      file: { path, text },
      install: [bootout, { file: 'launchctl', args: ['bootstrap', `gui/${uid}`, path] }],
      uninstall: [bootout],
      query: { file: 'launchctl', args: ['print', `gui/${uid}/${name}`] },
    }
  }
  if (platform === 'win32') {
    // shortcut: a Run value can't carry env vars, so isolated names only work until the next login; fine for live tests.
    const note = passed.some(([k]) => k !== 'XDG_CONFIG_HOME')
      ? `At login the Run entry starts with the default settings: it can't carry CCDS_NAME or CLAUDE_DIR.`
      : undefined
    return {
      file: null,
      install: [
        { file: 'reg', args: ['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', `"${node}" "${cli}" start --background`, '/f'] },
        { file: node, args: [cli, 'start', '--background'] },
      ],
      uninstall: [{ file: 'reg', args: ['delete', RUN_KEY, '/v', name, '/f'], mayFail: true }],
      query: { file: 'reg', args: ['query', RUN_KEY, '/v', name] },
      ...(note && { note }),
    }
  }
  const path = posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'systemd', 'user', `${name}.service`)
  const text = `[Unit]
Description=${name}

[Service]
ExecStart=${systemdQuote(node, true)} ${systemdQuote(cli, true)} start
${passed.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`).join('')}Restart=on-failure
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

// The node and cli paths an installed service runs, from its file (or `reg query` output on Windows).
export function programOf(platform: string, text: string): [string, string] | null {
  if (platform === 'darwin') {
    const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>/.exec(text)
    return m ? [unxml(m[1]), unxml(m[2])] : null
  }
  if (platform === 'win32') {
    const m = /REG_SZ\s+"([^"]*)" "([^"]*)"/.exec(text)
    return m ? [m[1], m[2]] : null
  }
  const m = /^ExecStart="((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"/m.exec(text)
  return m ? [systemdUnquote(m[1]), systemdUnquote(m[2])] : null
}

const here = (env: Env = process.env): Paths => ({
  name: appName(env), node: process.execPath, cli: realpathSync(process.argv[1]), home: homedir(), uid: process.getuid?.() ?? 0, env,
})

const query = (c: Command): { ok: boolean; stdout: string } => {
  try {
    return { ok: true, stdout: run(c) }
  } catch (e) {
    return { ok: false, stdout: String((e as { stdout?: unknown }).stdout ?? '') }
  }
}

// Installs (or reinstalls) the service and (re)starts it.
export function installService(log: (line: string) => void, platform = process.platform as string): void {
  const s = serviceFor(platform, here())
  if (s.file) {
    mkdirSync(dirname(s.file.path), { recursive: true })
    writeFileSync(s.file.path, s.file.text)
  }
  for (const step of s.install) {
    try {
      run(step)
    } catch (e) {
      if (step.fallback) return void log(step.fallback)
      if (!step.mayFail) throw e
    }
  }
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
    for (const [what, path] of program ? [['node', program[0]], ['cli', program[1]]] : []) {
      console.log(`  ${what}: ${path}${existsSync(path) ? '' : ' (missing: re-run setup)'}`)
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
  const sessions = await listSessions(join(claudeDir, 'sessions'), join(claudeDir, 'projects'))
  console.log(`Sessions: ${sessions.length || 'none'}`)
  for (const x of sessions) {
    // Bead 6: on Windows, print the raw procStartFt and the measured start time here.
    const why = !x.interactive ? 'background session' : !x.pane ? 'not in tmux' : await checkPane(x.pane, x.pid, x.procStart)
    console.log(`  ${x.name} (pid ${x.pid}${x.pane ? `, pane ${x.pane}` : ''}): ${why ? `read-only, ${why}` : 'can type'}`)
  }
}

// Removes only what appName() names, so CCDS_NAME isolates it. Never touches Discord.
export function uninstall(platform = process.platform as string, env: Env = process.env): void {
  const s = serviceFor(platform, here(env))
  const installed = s.file ? existsSync(s.file.path) : query(s.query).ok
  for (const step of s.uninstall) {
    try {
      run(step)
    } catch (e) {
      if (!step.mayFail) throw e
    }
  }
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

  const dir = configDirFor(platform, env, homedir())
  const had = existsSync(dir)
  rmSync(dir, { recursive: true, force: true })
  console.log(had ? `Removed the config folder ${dir}` : 'No config folder was found.')
  console.log('Your Discord server, bot and channels were left alone.')
}
