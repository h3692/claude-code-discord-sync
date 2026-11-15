import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  acquireLock, CATEGORY, codexStart, commandLine, freshEvents, isWatcherCommand, lockDirFor, missCount, Outbox, readOnlyReason, serialQueue, shouldConfirm,
  startOffset, typeCodex, typingRefusal, unanswer,
} from '../src/index.ts'
import { parseCodexLine } from '../src/codex.ts'
import { newMirror } from '../src/mirror.ts'

// Keep every test off the user's real tmux server: anything not on its own socket hits an empty one.
process.env.TMUX_SOCKET_NAME = 'ccds-test-guard'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'ccds-lock-')), 'lock')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.restoreAllMocks())

// Needs ps and true.
describe.skipIf(process.platform === 'win32')('acquireLock', () => {
  let deadPid: number
  beforeAll(async () => {
    const child = spawn('true')
    await new Promise((resolve) => child.on('exit', resolve))
    deadPid = child.pid!
  })

  it('takes a free lock and writes our pid', () => {
    const path = lockPath()
    expect(acquireLock(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
  })

  it('refuses while another live watcher holds it', async () => {
    // The command line carries the src/index.ts marker, like a real watcher.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)', 'src/index.ts'])
    await once(child, 'spawn')
    try {
      const path = lockPath()
      writeFileSync(path, String(child.pid))
      expect(acquireLock(path)).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(String(child.pid))
    } finally {
      child.kill()
    }
  })

  it('takes over a lock whose pid was reused by an unrelated live process', () => {
    for (const pid of [1, process.ppid]) {
      const path = lockPath()
      writeFileSync(path, String(pid))
      expect(acquireLock(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
    }
  })

  it('takes over a lock left by a dead process', () => {
    const path = lockPath()
    writeFileSync(path, String(deadPid))
    expect(acquireLock(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
  })

  it('takes over a lock file with no valid pid (never signals pid 0)', () => {
    for (const body of ['', '0', 'junk', '-1']) {
      const path = lockPath()
      writeFileSync(path, body)
      expect(acquireLock(path)).toBe(true)
    }
  })
})

describe('commandLine', () => {
  it('reads the command line of a live process', () => {
    expect(commandLine(process.pid)).toMatch(/node|vitest/i)
  }, 60_000) // PowerShell on a cold Windows runner can take longer than vitest's 5 s default to start.
})

describe('isWatcherCommand', () => {
  it('recognises every generation of the watcher', () => {
    for (const command of [
      'node src/index.ts', // v1 LaunchAgent
      '/usr/local/bin/node /Users/me/claude-code-discord-sync/src/index.ts',
      'node src/cli.ts start', // npm start
      '/usr/local/bin/node /opt/homebrew/lib/node_modules/claude-code-discord-sync/dist/cli.js start',
      'node /opt/homebrew/bin/claude-code-discord-sync start', // bin shim
      '/opt/homebrew/bin/claude-code-discord-sync start',
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\claude-code-discord-sync\\dist\\cli.js" start --background',
      'C:\\nodejs\\node.exe C:\\npm\\node_modules\\claude-code-discord-sync\\dist\\cli.js start',
    ]) expect(isWatcherCommand(command), command).toBe(true)
  })

  it('ignores other commands that mention it', () => {
    for (const command of [
      'tail -f /Users/me/Library/Logs/claude-code-discord-sync.log',
      'vim /Users/me/claude-code-discord-sync/README.md',
      'node /opt/homebrew/bin/claude-code-discord-sync setup',
      'claude-code-discord-sync setup',
      'node /opt/homebrew/lib/node_modules/claude-code-discord-sync/dist/cli.js status',
      'node /x/other-tool/dist/cli.js start',
      'node /opt/homebrew/bin/claude-code-discord-sync starter',
    ]) expect(isWatcherCommand(command), command).toBe(false)
  })
})

describe('lockDirFor', () => {
  it('keeps the lock in ~/Library/Caches on macOS', () => {
    expect(lockDirFor('darwin', { XDG_CONFIG_HOME: '/x' }, '/Users/me')).toBe(join('/Users/me', 'Library', 'Caches'))
  })

  it('uses the config folder on Linux, honouring XDG_CONFIG_HOME', () => {
    expect(lockDirFor('linux', {}, '/home/me')).toBe(join('/home/me', '.config', 'claude-code-discord-sync'))
    expect(lockDirFor('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(join('/cfg', 'claude-code-discord-sync'))
  })

  it('uses %APPDATA% on Windows', () => {
    const appData = 'C:\\Users\\me\\AppData\\Roaming'
    expect(lockDirFor('win32', { APPDATA: appData }, 'C:\\Users\\me')).toBe(join(appData, 'claude-code-discord-sync'))
  })

  it('names the Linux and Windows lock folder after CCDS_NAME', () => {
    expect(lockDirFor('linux', { CCDS_NAME: 'ccds-test' }, '/home/me')).toBe(join('/home/me', '.config', 'ccds-test'))
    expect(lockDirFor('win32', { CCDS_NAME: 'ccds-test', APPDATA: 'C:\\a' }, 'C:\\Users\\me')).toBe(join('C:\\a', 'ccds-test'))
  })
})

describe('Outbox', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('holds edits until the send resolved, then applies them to the sent message', async () => {
    const box = new Outbox<string>()
    const sent = deferred<string>()
    const calls: string[] = []
    box.send('r1', () => sent.promise)
    box.edit('r1', 'a', async (m, p) => void calls.push(`${m}:${p}`))
    await tick()
    expect(calls).toEqual([])
    sent.resolve('msg1')
    await tick()
    expect(calls).toEqual(['msg1:a'])
  })

  it('runs one edit per ref at a time and keeps only the latest pending one', async () => {
    const box = new Outbox<string>()
    box.send('r1', async () => 'm')
    const first = deferred<void>()
    const calls: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const fn = async (_m: string, p: string) => {
      calls.push(p)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (p === 'a') await first.promise
      inFlight--
    }
    box.edit('r1', 'a', fn)
    await tick()
    box.edit('r1', 'b', fn)
    box.edit('r1', 'c', fn)
    box.edit('r1', 'd', fn)
    await tick()
    expect(calls).toEqual(['a'])
    first.resolve()
    await tick()
    expect(calls).toEqual(['a', 'd'])
    expect(maxInFlight).toBe(1)
  })

  it('keeps refs independent', async () => {
    const box = new Outbox<string>()
    const slow = deferred<string>()
    const calls: string[] = []
    box.send('r1', () => slow.promise)
    box.send('r2', async () => 'm2')
    box.edit('r1', 'x', async (m, p) => void calls.push(`${m}:${p}`))
    box.edit('r2', 'y', async (m, p) => void calls.push(`${m}:${p}`))
    await tick()
    expect(calls).toEqual(['m2:y'])
  })

  it('drops edits for a ref whose send failed, and never throws', async () => {
    const log = quiet()
    const box = new Outbox<string>()
    const fn = vi.fn(async () => {})
    await expect(box.send('r1', async () => { throw new Error('send boom') })).resolves.toBeUndefined()
    box.edit('r1', 'a', fn)
    box.edit('nope', 'b', fn)
    await tick()
    expect(fn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })

  it('logs a failed edit and still applies the next one', async () => {
    const log = quiet()
    const box = new Outbox<string>()
    box.send('r1', async () => 'm')
    const calls: string[] = []
    const gate = deferred<void>()
    box.edit('r1', 'a', async (_m, p) => {
      calls.push(p)
      await gate.promise
      throw new Error('edit boom')
    })
    await tick()
    box.edit('r1', 'b', async (_m, p) => void calls.push(p))
    gate.resolve()
    await tick()
    expect(calls).toEqual(['a', 'b'])
    expect(log).toHaveBeenCalled()
  })
})

describe('serialQueue', () => {
  it('runs tasks for one key strictly in order, and other keys concurrently', async () => {
    const run = serialQueue()
    const order: string[] = []
    const a1 = deferred<void>()
    run('a', async () => {
      order.push('a1 start')
      await a1.promise
      order.push('a1 end')
    })
    run('a', async () => void order.push('a2'))
    run('b', async () => void order.push('b1'))
    await tick()
    expect(order).toEqual(['a1 start', 'b1'])
    a1.resolve()
    await tick()
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2'])
  })

  it('keeps going after a task throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = serialQueue()
    const order: string[] = []
    run('a', async () => { throw new Error('boom') })
    await run('a', async () => void order.push('after'))
    expect(order).toEqual(['after'])
  })
})

describe('startOffset', () => {
  const now = 1_000_000
  it('reads a transcript born in the last 15 seconds from the start', () => {
    expect(startOffset(now - 15_000, 500, now)).toBe(0)
    expect(startOffset(now, 500, now)).toBe(0)
  })

  it('skips the history of an older transcript (resume, -c)', () => {
    expect(startOffset(now - 15_001, 500, now)).toBe(500)
  })
})

describe('typingRefusal', () => {
  const paste = { type: 'paste', text: 'hi', replyTo: 'm1' } as const
  const typed = { type: 'paste', text: 'hi', replyTo: 'm1', allowWaiting: true } as const
  const button = { type: 'keys', keys: ['1'], hash: 'abc' } as const
  const keys = { type: 'keys', keys: ['Down'], replyTo: 'm1' } as const

  it('refuses anything once the session is gone', () => {
    for (const a of [paste, typed, button, keys]) expect(typingRefusal(a, null, 'abc')).toMatch(/gone/)
  })

  it('refuses a plain message when a prompt opened, but lets !type through', () => {
    expect(typingRefusal(paste, 'waiting', null)).toMatch(/prompt opened/)
    expect(typingRefusal(paste, 'busy', null)).toBeNull()
    expect(typingRefusal(paste, 'idle', null)).toBeNull()
    expect(typingRefusal(typed, 'waiting', null)).toBeNull()
  })

  it('sends a button only while the same prompt is still open', () => {
    expect(typingRefusal(button, 'waiting', 'abc')).toBeNull()
    expect(typingRefusal(button, 'waiting', 'def')).toMatch(/prompt changed/)
    expect(typingRefusal(button, 'waiting', null)).toMatch(/prompt changed/)
    expect(typingRefusal(button, 'idle', 'abc')).toMatch(/prompt changed/)
  })

  it('lets !keys through in any live status', () => {
    expect(typingRefusal(keys, 'waiting', null)).toBeNull()
    expect(typingRefusal(keys, 'idle', null)).toBeNull()
  })
})

describe('freshEvents', () => {
  const seenAt = Date.parse('2026-11-14T12:00:00Z')
  const prompt = (timestamp?: string) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'hi' }, timestamp })

  it('drops lines written more than 5s before the session id was first seen (resumed history)', () => {
    expect(freshEvents([prompt('2026-11-10T09:00:00Z'), prompt('2026-11-14T11:59:54Z')], seenAt)).toEqual([])
  })

  it('keeps lines from the last 5s before first sight onwards, and lines without a timestamp', () => {
    const lines = [prompt('2026-11-14T11:59:56Z'), prompt('2026-11-14T12:00:01Z'), prompt()]
    expect(freshEvents(lines, seenAt)).toHaveLength(3)
  })
})

describe('freshEvents for Codex', () => {
  it('drops rollout lines from before the session was first seen (a resumed thread)', () => {
    const seenAt = Date.parse('2026-11-14T12:00:00Z')
    const line = (timestamp: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'task_complete', duration_ms: 1 } })
    expect(freshEvents([line('2026-11-10T09:00:00Z'), line('2026-11-14T12:00:01Z')], seenAt, parseCodexLine)).toEqual([
      { kind: 'turn_end', durationMs: 1, pendingAgents: 0 },
    ])
  })
})

describe('typeCodex', () => {
  const at = (state: string, name?: string) => ({ state, screen: name ? readFileSync(new URL(`./fixtures/codex/screens/${name}.txt`, import.meta.url), 'utf8') : null })
  const sent = () => [at('idle', 'idle_empty'), at('idle', 'idle_draft'), at('idle', 'idle_empty')]
  function io(states: { state: string; screen: string | null }[], pane: string | null = null, fail = false) {
    const calls: string[] = []
    return {
      calls,
      io: {
        state: async () => (calls.push('state'), states.shift()!),
        checkPane: async () => (calls.push('checkPane'), pane),
        paste: async () => {
          calls.push('paste')
          if (fail) throw new Error('tmux load-buffer exited with 1')
        },
        enter: async () => void calls.push('enter'),
      },
    }
  }

  it('checks the screen and the pane, pastes, sees the composer change, presses Enter, then sees it cleared', async () => {
    const t = io(sent())
    expect(await typeCodex('hello\nworld', false, t.io)).toBeNull()
    expect(t.calls).toEqual(['state', 'checkPane', 'paste', 'state', 'enter', 'state'])
  })

  it('refuses before touching the pane when two Codex sessions share the folder', async () => {
    const t = io(sent())
    expect(await typeCodex('hello', true, t.io)).toBe('two Codex sessions share this folder; reply in the terminal')
    expect(t.calls).toEqual([])
  })

  it.each(['!ls', 'fine\n!rm -rf ~', 'fine\n   !ls', 'fine\n\u200b!ls', 'fine\n！ls', 'fine\r\n!ls', 'fine\n\x01!ls'])(
    'refuses %j, since a line starting with ! would run as a shell command', async (text) => {
      const t = io(sent())
      expect(await typeCodex(text, false, t.io)).toMatch(/starts with `!`/)
      expect(t.calls).toEqual([])
    })

  it('refuses unless the first capture shows the prompt', async () => {
    const unknown = io([at('unknown')])
    expect(await typeCodex('hello', false, unknown.io)).toBe("can't confirm Codex is at its prompt")
    expect(unknown.calls).toEqual(['state'])
    const waiting = io([at('waiting', 'approval_command')])
    expect(await typeCodex('hello', false, waiting.io)).toBe('a prompt is open — use the buttons or `!keys`')
    expect(waiting.calls).toEqual(['state'])
  })

  it('refuses when the pane check fails, before pasting', async () => {
    const t = io(sent(), 'Claude Code is suspended (Ctrl-Z)')
    expect(await typeCodex('hello', false, t.io)).toBe('Claude Code is suspended (Ctrl-Z)')
    expect(t.calls).toEqual(['state', 'checkPane'])
  })

  it('leaves Enter unpressed when the screen changed after the paste (a popup opened)', async () => {
    for (const second of [at('unknown', 'popup_file'), at('waiting', 'approval_command')]) {
      const t = io([at('idle', 'idle_empty'), second])
      expect(await typeCodex('look at @src', false, t.io)).toBe("pasted but not sent — Codex isn't at its prompt; check the terminal")
      expect(t.calls).toEqual(['state', 'checkPane', 'paste', 'state'])
    }
  })

  it('leaves Enter unpressed when the composer looks the same after the paste (the text never landed)', async () => {
    // The status row differs, but only the composer counts.
    const after = at('idle', 'idle_draft')
    after.screen = after.screen!.replace('· /tmp/project', '· /tmp/project · Reply with pong')
    const t = io([at('idle', 'idle_draft'), after])
    expect(await typeCodex('hello', false, t.io)).toBe("pasted but not sent — Codex didn't take the text; check the terminal")
    expect(t.calls).toEqual(['state', 'checkPane', 'paste', 'state'])
  })

  it('reports a message Codex kept in its composer after Enter, so it is not marked sent', async () => {
    const t = io([at('idle', 'idle_empty'), at('idle', 'idle_draft'), at('idle', 'idle_draft')])
    expect(await typeCodex('/foo bar', false, t.io)).toBe('Codex kept the message in its composer instead of sending it — check the terminal')
    expect(t.calls).toEqual(['state', 'checkPane', 'paste', 'state', 'enter', 'state'])
  })

  it('counts a message as sent when Enter leaves the prompt (an approval opened)', async () => {
    const t = io([at('idle', 'idle_empty'), at('idle', 'idle_draft'), at('waiting', 'approval_command')])
    expect(await typeCodex('hello', false, t.io)).toBeNull()
  })

  it('passes a failed paste on, without pressing Enter', async () => {
    const t = io(sent(), null, true)
    await expect(typeCodex('hello', false, t.io)).rejects.toThrow(/load-buffer/)
    expect(t.calls).toEqual(['state', 'checkPane', 'paste'])
  })
})

describe('codexStart', () => {
  const meta = { id: 't', cwd: '/p', originator: 'codex-tui', threadSource: 'user', historyMode: 'paginated', forkedFromId: null }

  it('reads a thread first seen after startup from its start, whatever its age, or an unreadable header', () => {
    expect(codexStart(meta, 'birth', 900)).toEqual({ offset: 0, notice: null })
    expect(codexStart(null, 'birth', 900)).toEqual({ offset: 0, notice: null })
  })

  it('reads a thread already running at startup from its end', () => {
    expect(codexStart(meta, 'eof', 900)).toEqual({ offset: 900, notice: null })
  })

  it('starts a forked thread at its end, so the history it copied is not replayed', () => {
    expect(codexStart({ ...meta, forkedFromId: 'parent' }, 'birth', 900)).toEqual({ offset: 900, notice: null })
  })

  // A resumed thread matches only after its first new write, which brings task_started and the prompt together.
  it('keeps the first prompt of a resumed thread and drops its history', () => {
    const rollout = readFileSync(new URL('./fixtures/codex/rollout.jsonl', import.meta.url), 'utf8')
    const { offset } = codexStart(meta, 'birth', Buffer.byteLength(rollout))
    // Resumed a few seconds before the second turn's task_started (07:53:24.598), prompt 0.17 s later.
    const seenAt = Date.parse('2026-11-15T07:53:20Z')
    const events = freshEvents(rollout.slice(offset).split('\n'), seenAt, parseCodexLine)
    expect(events.slice(0, 2)).toEqual([
      { kind: 'prompt', text: 'Line one of the probe.\nLine two of the probe.\nReply with exactly: ok' },
      { kind: 'text', text: 'ok' },
    ])
  })

  it('says when a thread records no output', () => {
    expect(codexStart({ ...meta, historyMode: 'legacy' }, 'birth', 900)).toEqual({
      offset: 0, notice: "-# 📭 This Codex thread doesn't record its output; only approvals and typing work here.",
    })
  })
})

describe('CATEGORY', () => {
  it('puts each provider in its own live category', () => {
    expect(CATEGORY).toEqual({ claude: 'Claude Sessions', codex: 'Codex Sessions' })
  })
})

describe('missCount', () => {
  it('ends a session only after two polls in a row without its registry entry', () => {
    const first = missCount(0, false)
    expect(first).toEqual({ misses: 1, ended: false })
    expect(missCount(first.misses, false)).toEqual({ misses: 2, ended: true })
  })

  it('resets once the session is seen again', () => {
    expect(missCount(1, true)).toEqual({ misses: 0, ended: false })
    expect(missCount(missCount(1, true).misses, false)).toEqual({ misses: 1, ended: false })
  })
})

describe('shouldConfirm', () => {
  const fresh = { question: 'Which layout?', options: [{ n: 1, label: 'A' }, { n: 2, label: 'B' }], hash: 'abc', cursor: 2, confirm: true } as const

  it('presses Enter only on the same preview question with the highlight on the chosen option', () => {
    expect(shouldConfirm(fresh, 'abc', 2)).toBe(true)
    expect(shouldConfirm(null, 'abc', 2)).toBe(false)
    expect(shouldConfirm({ ...fresh, confirm: undefined }, 'abc', 2)).toBe(false)
    expect(shouldConfirm(fresh, 'def', 2)).toBe(false)
    expect(shouldConfirm(fresh, 'abc', 1)).toBe(false)
  })
})

describe('unanswer', () => {
  const dialog = { question: 'Proceed?', options: [{ n: 1, label: 'Yes' }], hash: 'abc', cursor: 1 }
  const withCard = (hash: string, answered: string | null) => ({
    ...newMirror({ pid: 42, procStart: 'x', sessionId: 's1', cwd: '/p', name: 'n', pane: '%1', status: 'waiting' }, 'u1').state,
    card: { ref: 'r7', hash, screenHash: 'sh', dialog: hash === 'abc' ? dialog : null, answered, repeats: 0 },
  })
  const button = { type: 'keys', keys: ['1'], hash: 'abc' } as const
  const keys = { type: 'keys', keys: ['Enter'], replyTo: 'm1' } as const

  it('resets the card of a refused button and edits its message out of Sending', () => {
    const { state, edit } = unanswer(withCard('abc', 'Yes'), button, 'the prompt changed')
    expect(state.card).toBeNull()
    expect(edit).toEqual({
      type: 'edit', ref: 'r7', content: '⚠️ Not sent — the prompt changed', embed: { title: '⚠️ Not sent', description: 'Proceed?' }, buttons: [],
    })
  })

  it('leaves a newer card alone when a refused button was for an older prompt', () => {
    const s = withCard('def', null)
    expect(unanswer(s, button, 'x')).toEqual({ state: s, edit: null })
  })

  it('un-marks an open card answered by a refused !keys, without editing it', () => {
    const { state, edit } = unanswer(withCard('abc', '`!keys Enter`'), keys, 'the session is gone')
    expect(state.card).toMatchObject({ ref: 'r7', hash: 'abc', answered: null })
    expect(edit).toBeNull()
  })

  it('does nothing without an open card', () => {
    const s = { ...withCard('abc', null), card: null }
    expect(unanswer(s, keys, 'x')).toEqual({ state: s, edit: null })
    expect(unanswer(s, button, 'x')).toEqual({ state: s, edit: null })
  })
})

describe('readOnlyReason', () => {
  const tmuxed = { interactive: true, pane: '%3' }
  it('is null for an interactive session in tmux', () => {
    expect(readOnlyReason(tmuxed, 'darwin', {})).toBeNull()
    expect(readOnlyReason(tmuxed, 'win32', { CCDS_WINDOWS_TYPING: '1' })).toBeNull()
  })
  it('names why Discord cannot type into the session', () => {
    expect(readOnlyReason({ interactive: false, pane: '%3' }, 'darwin', {})).toBe('it is a background session')
    expect(readOnlyReason({ interactive: true, pane: null }, 'linux', {})).toBe('it is not running inside tmux')
    expect(readOnlyReason(tmuxed, 'win32', {})).toBe('typing on Windows is off (set CCDS_WINDOWS_TYPING=1)')
  })
})
