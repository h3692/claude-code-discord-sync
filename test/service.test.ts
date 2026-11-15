import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { programOf, runSteps, serviceFor } from '../src/service.ts'

const mac = {
  name: 'claude-code-discord-sync', node: '/opt/homebrew/Cellar/node/24.12.0/bin/node',
  cli: '/opt/homebrew/lib/node_modules/claude-code-discord-sync/dist/cli.js', home: '/Users/me', uid: 501, env: {},
}
const isolated = { CCDS_NAME: 'ccds-test', CLAUDE_DIR: '/tmp/x/claude-empty', XDG_CONFIG_HOME: '/tmp/x/svc-live' }

describe('serviceFor darwin', () => {
  it('writes a LaunchAgent that runs node on cli.js start, with no shell and no token', () => {
    const s = serviceFor('darwin', mac)
    expect(s.file?.path).toBe('/Users/me/Library/LaunchAgents/claude-code-discord-sync.plist')
    expect(s.file?.text).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>claude-code-discord-sync</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/Cellar/node/24.12.0/bin/node</string>
		<string>/opt/homebrew/lib/node_modules/claude-code-discord-sync/dist/cli.js</string>
		<string>start</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/Cellar/node/24.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>30</integer>
	<key>StandardOutPath</key>
	<string>/Users/me/Library/Logs/claude-code-discord-sync.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/me/Library/Logs/claude-code-discord-sync.log</string>
</dict>
</plist>
`)
  })

  it('boots out any old job (ignoring failure), waits until it is gone, then bootstraps; uninstall boots out and waits', () => {
    const s = serviceFor('darwin', mac)
    const bootout = { file: 'launchctl', args: ['bootout', 'gui/501/claude-code-discord-sync'], mayFail: true }
    const gone = { file: 'launchctl', args: ['print', 'gui/501/claude-code-discord-sync'], untilFails: true }
    expect(s.install).toEqual([
      bootout, gone,
      { file: 'launchctl', args: ['bootstrap', 'gui/501', '/Users/me/Library/LaunchAgents/claude-code-discord-sync.plist'], retries: 3 },
    ])
    expect(s.uninstall).toEqual([bootout, gone])
    expect(s.query).toEqual({ file: 'launchctl', args: ['print', 'gui/501/claude-code-discord-sync'] })
    expect(s.log).toBe('/Users/me/Library/Logs/claude-code-discord-sync.log')
  })

  it('runs the bare bin shim, not node on its path, so a node upgrade does not break it', () => {
    const cli = '/opt/homebrew/bin/claude-code-discord-sync'
    const text = serviceFor('darwin', { ...mac, cli }).file!.text
    expect(text).toContain(`<array>\n\t\t<string>${cli}</string>\n\t\t<string>start</string>\n\t</array>`)
    expect(programOf('darwin', text)).toEqual([cli])
  })

  it('passes CCDS_NAME, CLAUDE_DIR and XDG_CONFIG_HOME through only when set', () => {
    const text = serviceFor('darwin', { ...mac, name: 'ccds-test', env: isolated }).file!.text
    expect(text).toContain(`		<key>PATH</key>
		<string>/opt/homebrew/Cellar/node/24.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
		<key>CCDS_NAME</key>
		<string>ccds-test</string>
		<key>CLAUDE_DIR</key>
		<string>/tmp/x/claude-empty</string>
		<key>XDG_CONFIG_HOME</key>
		<string>/tmp/x/svc-live</string>
	</dict>`)
    expect(text).toContain('<string>ccds-test</string>\n\t<key>ProgramArguments</key>')
    expect(text).toContain('/Users/me/Library/Logs/ccds-test.log')
    expect(serviceFor('darwin', { ...mac, env: { CCDS_NAME: '', HOME: '/Users/me' } }).file!.text).not.toMatch(/CCDS_NAME|HOME/)
  })

  it('escapes XML in paths', () => {
    const text = serviceFor('darwin', { ...mac, cli: '/Users/me/R&D <x>/cli.js' }).file!.text
    expect(text).toContain('<string>/Users/me/R&amp;D &lt;x&gt;/cli.js</string>')
  })
})

describe('serviceFor linux', () => {
  const linux = { ...mac, node: '/usr/bin/node', cli: '/usr/lib/node_modules/claude-code-discord-sync/dist/cli.js', home: '/home/me', uid: 1000 }

  it('writes a systemd user unit that restarts on failure', () => {
    const s = serviceFor('linux', linux)
    expect(s.file?.path).toBe('/home/me/.config/systemd/user/claude-code-discord-sync.service')
    expect(s.file?.text).toBe(`[Unit]
Description=claude-code-discord-sync

[Service]
ExecStart="/usr/bin/node" "/usr/lib/node_modules/claude-code-discord-sync/dist/cli.js" start
Environment="PATH=/usr/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`)
  })

  it('respects XDG_CONFIG_HOME and passes the isolation variables through', () => {
    const s = serviceFor('linux', { ...linux, name: 'ccds-test', env: isolated })
    expect(s.file?.path).toBe('/tmp/x/svc-live/systemd/user/ccds-test.service')
    expect(s.file?.text).toContain(`start
Environment="PATH=/usr/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
Environment="CCDS_NAME=ccds-test"
Environment="CLAUDE_DIR=/tmp/x/claude-empty"
Environment="XDG_CONFIG_HOME=/tmp/x/svc-live"
Restart=on-failure`)
  })

  it('quotes paths per systemd rules: spaces, quotes, backslashes, % specifiers and $ expansion', () => {
    const text = serviceFor('linux', {
      ...linux, node: '/home/me/my tools/node', cli: '/x/100%/$HOME/a"b\\c/cli.js', env: { CLAUDE_DIR: '/x/50%/$y' },
    }).file!.text
    expect(text).toContain('ExecStart="/home/me/my tools/node" "/x/100%%/$$HOME/a\\"b\\\\c/cli.js" start\n')
    // Environment= does no $ expansion, only specifiers.
    expect(text).toContain('Environment="CLAUDE_DIR=/x/50%%/$y"\n')
  })

  it('enables and restarts through systemctl --user, explaining the fix when systemd is missing', () => {
    const s = serviceFor('linux', linux)
    expect(s.install.map((c) => [c.file, ...c.args])).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'claude-code-discord-sync'],
      ['systemctl', '--user', 'restart', 'claude-code-discord-sync'],
    ])
    const fallback = s.install[0].fallback!
    expect(fallback).toContain('/etc/wsl.conf')
    expect(fallback).toContain('[boot]\n  systemd=true')
    expect(fallback).toContain('wsl --shutdown')
    expect(fallback).toContain('claude-code-discord-sync start')
    expect(s.install.slice(1).every((c) => !c.fallback && !c.mayFail)).toBe(true)
    expect(s.uninstall).toEqual([{ file: 'systemctl', args: ['--user', 'disable', '--now', 'claude-code-discord-sync'], mayFail: true }])
    expect(s.query).toEqual({ file: 'systemctl', args: ['--user', 'is-active', 'claude-code-discord-sync'] })
    expect(s.log).toBeUndefined()
  })

  it('runs the bare bin shim', () => {
    const text = serviceFor('linux', { ...linux, cli: '/home/linuxbrew/.linuxbrew/bin/claude-code-discord-sync' }).file!.text
    expect(text).toContain('ExecStart="/home/linuxbrew/.linuxbrew/bin/claude-code-discord-sync" start\n')
    expect(programOf('linux', text)).toEqual(['/home/linuxbrew/.linuxbrew/bin/claude-code-discord-sync'])
  })
})

describe('serviceFor win32', () => {
  const win = {
    ...mac, node: 'C:\\Program Files\\nodejs\\node.exe', home: 'C:\\Users\\me',
    cli: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\claude-code-discord-sync\\dist\\cli.js',
  }
  const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

  it('sets a Run value (no admin) that starts the watcher in the background, then starts it now', () => {
    const s = serviceFor('win32', win)
    expect(s.file).toBeNull()
    expect(s.install).toEqual([
      {
        file: 'reg',
        args: ['add', RUN, '/v', 'claude-code-discord-sync', '/t', 'REG_SZ', '/d', `"${win.node}" "${win.cli}" start --background`, '/f'],
      },
      { file: win.node, args: [win.cli, 'start', '--background'] },
    ])
    expect(s.uninstall).toEqual([{ file: 'reg', args: ['delete', RUN, '/v', 'claude-code-discord-sync', '/f'], mayFail: true }])
    expect(s.query).toEqual({ file: 'reg', args: ['query', RUN, '/v', 'claude-code-discord-sync'] })
    expect(s.note).toBeUndefined()
    expect(s.log).toBe(join('C:\\Users\\me', 'AppData', 'Local', 'claude-code-discord-sync', 'watcher.log'))
    expect(serviceFor('win32', { ...win, env: { LOCALAPPDATA: 'D:\\L' } }).log).toBe(join('D:\\L', 'claude-code-discord-sync', 'watcher.log'))
  })

  it('stops a running watcher before starting the new one, and on uninstall', () => {
    const s = serviceFor('win32', { ...win, watcher: 4242 })
    const kill = { file: 'taskkill', args: ['/PID', '4242', '/F'], mayFail: true }
    expect(s.install.map((c) => c.file)).toEqual(['reg', 'taskkill', win.node, win.node])
    expect(s.install[1]).toEqual(kill)
    // taskkill /F returns before the old watcher is gone, and the new one would find its lock held.
    expect(s.install[2]).toEqual({ file: win.node, args: ['-e', 'process.kill(4242, 0)'], untilFails: true })
    expect(s.uninstall).toEqual([{ file: 'reg', args: ['delete', RUN, '/v', 'claude-code-discord-sync', '/f'], mayFail: true }, kill])
  })

  it("notes that the Run value can't carry the isolation variables", () => {
    expect(serviceFor('win32', { ...win, name: 'ccds-test', env: isolated }).note).toMatch(/CCDS_NAME/)
  })

  it('passes CODEX_HOME through, without the isolation note on Windows', () => {
    expect(serviceFor('darwin', { ...mac, env: { CODEX_HOME: '/x/codex' } }).file!.text).toContain('<key>CODEX_HOME</key>\n\t\t<string>/x/codex</string>')
    expect(serviceFor('win32', { ...win, env: { CODEX_HOME: 'C:\\codex' } }).note).toBeUndefined()
  })
})

describe('serviceFor', () => {
  it('refuses a name that could leave the service folder', () => {
    expect(() => serviceFor('darwin', { ...mac, name: '../evil' })).toThrow()
    expect(() => serviceFor('linux', { ...mac, name: 'a b' })).toThrow()
  })
})

describe('runSteps', () => {
  const steps = serviceFor('darwin', mac).install
  const fake = (results: Record<string, boolean[]>) => {
    const calls: string[] = []
    const exec = ({ args }: { args: string[] }) => {
      calls.push(args[0])
      if (results[args[0]]?.shift() === false) throw new Error(`${args[0]} failed`)
      return ''
    }
    return { calls, exec }
  }

  it('waits until the booted-out job is gone before bootstrapping', () => {
    const { calls, exec } = fake({ print: [true, true, false] })
    const sleeps: number[] = []
    expect(runSteps(steps, () => {}, exec, (ms) => sleeps.push(ms))).toBe(true)
    expect(calls).toEqual(['bootout', 'print', 'print', 'print', 'bootstrap'])
    expect(sleeps).toEqual([200, 200])
  })

  it('on Windows, waits for the killed watcher to exit before starting the new one', () => {
    const win = { ...mac, node: 'C:\\node.exe', cli: 'C:\\cli.js', home: 'C:\\Users\\me', watcher: 4242 }
    const { calls, exec } = fake({ '-e': [true, true, false] })
    const sleeps: number[] = []
    expect(runSteps(serviceFor('win32', win).install, () => {}, exec, (ms) => sleeps.push(ms))).toBe(true)
    expect(calls).toEqual(['add', '/PID', '-e', '-e', '-e', win.cli])
    expect(sleeps).toEqual([200, 200])
  })

  it('stops waiting after 10 s, then retries a failing bootstrap', () => {
    const { calls, exec } = fake({ print: Array(100).fill(true), bootstrap: [false, false, true] })
    let slept = 0
    runSteps(steps, () => {}, exec, (ms) => (slept += ms))
    expect(calls.filter((c) => c === 'print')).toHaveLength(50)
    expect(calls.slice(-3)).toEqual(['bootstrap', 'bootstrap', 'bootstrap'])
    expect(slept).toBe(50 * 200 + 2 * 1000)
  })

  it('throws once the retries run out, and prints a fallback instead of throwing', () => {
    const { exec } = fake({ print: [false], bootstrap: [false, false, false, false] })
    expect(() => runSteps(steps, () => {}, exec, () => {})).toThrow('bootstrap failed')
    const lines: string[] = []
    const linux = serviceFor('linux', mac).install
    expect(runSteps(linux, (l) => lines.push(l), () => { throw new Error('no systemd') }, () => {})).toBe(false)
    expect(lines).toEqual([linux[0].fallback])
  })
})

describe('programOf', () => {
  it('reads back the node and cli paths each generator wrote', () => {
    const node = '/x/my "odd" 100% $dir\\/node'
    const cli = '/y/R&D <z>/cli.js'
    expect(programOf('darwin', serviceFor('darwin', { ...mac, node, cli }).file!.text)).toEqual([node, cli])
    expect(programOf('linux', serviceFor('linux', { ...mac, node, cli }).file!.text)).toEqual([node, cli])
    const win = { node: 'C:\\Program Files\\nodejs\\node.exe', cli: 'C:\\a b\\cli.js' }
    const value = serviceFor('win32', { ...mac, ...win }).install[0].args[7]
    // reg query prints: <blank line> HKEY_...\Run <newline> <4 spaces>name<4 spaces>REG_SZ<4 spaces>value
    const query = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    claude-code-discord-sync    REG_SZ    ${value}\r\n\r\n`
    expect(programOf('win32', query)).toEqual([win.node, win.cli])
  })

  it('is null for text it does not recognise', () => {
    expect(programOf('darwin', '')).toBeNull()
    expect(programOf('linux', '[Service]\n')).toBeNull()
    expect(programOf('win32', 'ERROR: The system was unable to find the specified registry key or value.')).toBeNull()
  })
})
