import { describe, expect, it } from 'vitest'
import { programOf, serviceFor } from '../src/service.ts'

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

  it('boots out any old job (ignoring failure), then bootstraps; uninstall boots out', () => {
    const s = serviceFor('darwin', mac)
    expect(s.install).toEqual([
      { file: 'launchctl', args: ['bootout', 'gui/501/claude-code-discord-sync'], mayFail: true },
      { file: 'launchctl', args: ['bootstrap', 'gui/501', '/Users/me/Library/LaunchAgents/claude-code-discord-sync.plist'] },
    ])
    expect(s.uninstall).toEqual([{ file: 'launchctl', args: ['bootout', 'gui/501/claude-code-discord-sync'], mayFail: true }])
    expect(s.query).toEqual({ file: 'launchctl', args: ['print', 'gui/501/claude-code-discord-sync'] })
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
  })

  it("notes that the Run value can't carry the isolation variables", () => {
    expect(serviceFor('win32', { ...win, name: 'ccds-test', env: isolated }).note).toMatch(/CCDS_NAME/)
  })
})

describe('serviceFor', () => {
  it('refuses a name that could leave the service folder', () => {
    expect(() => serviceFor('darwin', { ...mac, name: '../evil' })).toThrow()
    expect(() => serviceFor('linux', { ...mac, name: 'a b' })).toThrow()
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
