import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexScreen, dateFolders, listCodexSessions, parseCodexLine, parseCodexPs, parseCwds, parsePanes, pickRollout, readCodexMeta, type CodexMeta,
} from '../src/codex.ts'

// Keep every test off the user's real tmux server: anything not on its own socket hits an empty one.
process.env.TMUX_SOCKET_NAME = 'ccds-test-guard'

const fixture = (name: string) => readFile(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8')
const item = (item: object, timestamp = '2026-11-15T08:00:00.000Z') =>
  JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'item_completed', item } })

describe('parseCodexLine', () => {
  it('turns a redacted rollout into events, ignoring housekeeping, reasoning and aborted turns', async () => {
    const events = (await fixture('rollout.jsonl')).split('\n').flatMap((line) => parseCodexLine(line))
    expect(events).toEqual([
      { kind: 'prompt', text: 'Reply with exactly the word: pong' },
      { kind: 'text', text: 'pong' },
      { kind: 'turn_end', durationMs: 2101, pendingAgents: 0 },
      { kind: 'prompt', text: 'Line one of the probe.\nLine two of the probe.\nReply with exactly: ok' },
      { kind: 'text', text: 'ok' },
      { kind: 'turn_end', durationMs: 2086, pendingAgents: 0 },
      { kind: 'prompt', text: 'Reply with exactly the word done, ignore this @math' },
      { kind: 'text', text: 'done' },
      { kind: 'turn_end', durationMs: 2542, pendingAgents: 0 },
      { kind: 'prompt', text: 'Run exactly this shell command once, requesting approval/escalation if needed: touch probe1.txt' },
      { kind: 'text', text: 'I’ll run the requested command once and request the required filesystem approval.' },
      { kind: 'tool_start', id: 'exec-0190a000-0000-7000-8000-000000000017', name: 'Bash', input: { command: 'touch probe1.txt' } },
      { kind: 'tool_end', id: 'exec-0190a000-0000-7000-8000-000000000017', ok: true },
      { kind: 'text', text: 'Created `probe1.txt`.' },
      { kind: 'turn_end', durationMs: 15747, pendingAgents: 0 },
      { kind: 'prompt', text: 'In ONE response, issue TWO separate shell tool calls in parallel (do not combine them), each requesting escalation: `touch probe2.txt` and `touch probe3.txt`.' },
      { kind: 'text', text: 'I’ll issue two separate shell calls in parallel, each with its own escalation request.' },
      { kind: 'prompt', text: 'Use apply_patch to append the line "# probe" to the end of math.py. Do not run any shell commands.' },
      { kind: 'text', text: 'I’ll apply the requested one-line append directly with `apply_patch`; I won’t run shell commands.' },
      { kind: 'tool_start', id: 'exec-0190a000-0000-7000-8000-000000000024:/tmp/project/math.py', name: 'Edit', input: { file_path: '/tmp/project/math.py' } },
      { kind: 'tool_end', id: 'exec-0190a000-0000-7000-8000-000000000024:/tmp/project/math.py', ok: true },
      { kind: 'text', text: 'Appended `# probe` to the end of `math.py` using `apply_patch`.' },
      { kind: 'turn_end', durationMs: 28360, pendingAgents: 0 },
      { kind: 'prompt', text: 'Think carefully, then write a numbered list of 40 distinct fruit names.' },
      { kind: 'prompt', text: 'Change of plan: stop the list and reply with exactly: steered' },
      { kind: 'text', text: 'steered' },
      { kind: 'turn_end', durationMs: 5309, pendingAgents: 0 },
      { kind: 'prompt', text: 'Call the context7 MCP tool resolve-library-id once with libraryName "left-pad". Then reply: done.' },
      { kind: 'tool_start', id: 'exec-0190a000-0000-7000-8000-000000000033', name: 'mcp__context7__resolve-library-id', input: { libraryName: 'left-pad' } },
      { kind: 'tool_end', id: 'exec-0190a000-0000-7000-8000-000000000033', ok: false },
      { kind: 'text', text: 'done' },
      { kind: 'turn_end', durationMs: 7647, pendingAgents: 0 },
      { kind: 'prompt', text: 'If you have a request_permissions tool, call it once to request network access for this session; do not run any commands. Then reply: done.' },
      { kind: 'text', text: 'done' },
      { kind: 'turn_end', durationMs: 7087, pendingAgents: 0 },
      { kind: 'prompt', text: 'Reply with exactly: resumed' },
      { kind: 'text', text: 'resumed' },
      { kind: 'turn_end', durationMs: 1845, pendingAgents: 0 },
    ])
  })

  it('yields nothing for a forked rollout that has no turns yet', async () => {
    expect((await fixture('rollout_fork.jsonl')).split('\n').flatMap((line) => parseCodexLine(line))).toEqual([])
  })

  it('maps item types the probe did not hit, with shapes taken from real rollouts', () => {
    expect(parseCodexLine(item({ type: 'FileChange', id: 'fc1', status: 'completed', changes: { '/p/new.ts': { type: 'add', content: 'x' }, '/p/old.ts': { type: 'update', unified_diff: '', move_path: null } } }))).toEqual([
      { kind: 'tool_start', id: 'fc1:/p/new.ts', name: 'Write', input: { file_path: '/p/new.ts' } },
      { kind: 'tool_end', id: 'fc1:/p/new.ts', ok: true },
      { kind: 'tool_start', id: 'fc1:/p/old.ts', name: 'Edit', input: { file_path: '/p/old.ts' } },
      { kind: 'tool_end', id: 'fc1:/p/old.ts', ok: true },
    ])
    expect(parseCodexLine(item({ type: 'CommandExecution', id: 'c1', command: 'ls', status: 'completed', exit_code: 1 }))).toEqual([
      { kind: 'tool_start', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_end', id: 'c1', ok: false },
    ])
    expect(parseCodexLine(item({ type: 'Extension', kind: 'web.search', id: 'ws1', query: 'codex rollout', action: { type: 'search' }, results: [] }))).toEqual([
      { kind: 'tool_start', id: 'ws1', name: 'WebSearch', input: { query: 'codex rollout' } },
      { kind: 'tool_end', id: 'ws1', ok: true },
    ])
    const agent = (kind: string) => item({ type: 'SubAgentActivity', model: null, reasoning_effort: null, id: `call_${kind}`, kind, agent_thread_id: 'thread-a', agent_path: '/root/map_code' })
    expect(parseCodexLine(agent('started'))).toEqual([{ kind: 'agent_start', id: 'thread-a', agentType: 'subagent', description: '/root/map_code' }])
    expect(parseCodexLine(agent('completed'))).toEqual([{ kind: 'agent_end', id: 'thread-a', status: 'completed' }])
    expect(parseCodexLine(agent('interrupted'))).toEqual([{ kind: 'agent_end', id: 'thread-a', status: 'stopped' }])
    expect(parseCodexLine(agent('interacted'))).toEqual([])
  })

  it('skips question replies, reasoning, empty messages and unknown items or envelopes', () => {
    const user = (text: string) => item({ type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] })
    expect(parseCodexLine(user('<send_user_message_question_reply>yes</send_user_message_question_reply>'))).toEqual([])
    expect(parseCodexLine(user('  '))).toEqual([])
    expect(parseCodexLine(item({ type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: '' }] }))).toEqual([])
    expect(parseCodexLine(item({ type: 'Reasoning', id: 'r', summary_text: [] }))).toEqual([])
    expect(parseCodexLine(item({ type: 'Extension', kind: 'something.new', id: 'e' }))).toEqual([])
    expect(parseCodexLine(item({ type: 'Brand new item', id: 'n' }))).toEqual([])
    expect(parseCodexLine(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'injected' }] } }))).toEqual([])
    expect(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }))).toEqual([])
  })

  it('never throws on bad or unexpected input', () => {
    for (const line of ['', '{"type":"event_msg"', 'null', '42', '"text"', '{"type":"event_msg","payload":null}', '{"type":"event_msg","payload":{"type":"item_completed"}}', item({ type: 'FileChange', id: 'f', changes: null }), item({ type: 'UserMessage', content: 'oops' })]) {
      expect(parseCodexLine(line)).toEqual([])
    }
  })

  it('drops lines timestamped before `since`', () => {
    const line = (timestamp: string) => item({ type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'hi' }] }, timestamp)
    const since = Date.parse('2026-11-01T00:00:01.000Z')
    expect(parseCodexLine(line('2026-11-01T00:00:00.999Z'), since)).toEqual([])
    expect(parseCodexLine(line('2026-11-01T00:00:01.000Z'), since)).toEqual([{ kind: 'text', text: 'hi' }])
    expect(parseCodexLine(line('2026-11-01T00:00:00.999Z'))).toEqual([{ kind: 'text', text: 'hi' }])
  })
})

describe('readCodexMeta', () => {
  it('reads the session header of a plain and a forked rollout', async () => {
    const first = async (name: string) => (await fixture(name)).split('\n')[0]
    expect(readCodexMeta(await first('rollout.jsonl'))).toEqual({
      id: '0190a000-0000-7000-8000-000000000002', cwd: '/tmp/project', originator: 'codex-tui', threadSource: 'user', historyMode: 'paginated', forkedFromId: null,
    })
    expect(readCodexMeta(await first('rollout_fork.jsonl'))).toEqual({
      id: '0190a000-0000-7000-8000-000000000040', cwd: '/tmp/project', originator: 'codex-tui', threadSource: 'user', historyMode: 'paginated', forkedFromId: '0190a000-0000-7000-8000-000000000041',
    })
  })

  it('returns null for anything that is not a session header', () => {
    for (const line of ['', 'null', '{"type":"session_meta"', '{"type":"event_msg","payload":{"id":"x"}}', '{"type":"session_meta","payload":{}}']) {
      expect(readCodexMeta(line)).toBeNull()
    }
  })
})

describe('codexScreen', () => {
  const screen = (name: string) => fixture(`screens/${name}.txt`)
  const commandDialog = (cmd: string) => ({
    question: 'Would you like to run the following command?',
    options: [
      { n: 1, label: 'Yes, proceed' },
      { n: 2, label: `Yes, and don't ask again for commands that start with \`${cmd}\`` },
      { n: 3, label: 'No, and tell Codex what to do differently' },
    ],
    hash: expect.stringMatching(/^[0-9a-f]{12}$/),
    cursor: 1,
  })

  it.each([
    ['idle_empty', 'idle'], ['idle_empty_embedded', 'idle'], ['idle_draft', 'idle'], ['idle_with_history', 'idle'],
    ['idle_resumed', 'idle'], ['idle_after_new', 'idle'], ['working', 'idle'], ['working_with_draft', 'idle'],
    ['paste_multiline_draft', 'idle'], ['paste_atword_after_enter', 'idle'], ['approval_after_digit', 'idle'], ['approval_after_esc', 'idle'],
    ['shell_mode_empty', 'unknown'], ['shell_mode_draft', 'unknown'], ['popup_file', 'unknown'], ['popup_slash', 'unknown'],
    ['popup_skill', 'unknown'], ['paste_atword_popup', 'unknown'], ['model_picker', 'unknown'], ['startup_hooks_review', 'unknown'],
    ['startup_update_prompt', 'unknown'], ['after_quit_shell', 'unknown'],
    ['approval_command', 'waiting'], ['approval_queued_first', 'waiting'], ['approval_queued_second', 'waiting'], ['approval_edit', 'waiting'],
  ])('reads %s as %s', async (name, state) => {
    const s = codexScreen(await screen(name))
    expect(s.state).toBe(state)
    if (state !== 'waiting') expect(s.dialog).toBeNull()
  })

  it('parses command and edit approvals into dialogs, without confirm', async () => {
    expect(codexScreen(await screen('approval_command')).dialog).toEqual(commandDialog('touch probe1.txt'))
    expect(codexScreen(await screen('approval_queued_first')).dialog).toEqual(commandDialog('touch probe2.txt'))
    expect(codexScreen(await screen('approval_queued_second')).dialog).toEqual(commandDialog('touch probe3.txt'))
    expect(codexScreen(await screen('approval_edit')).dialog).toEqual({
      question: 'Would you like to make the following edits?',
      options: [
        { n: 1, label: 'Yes, proceed' },
        { n: 2, label: "Yes, and don't ask again for these files" },
        { n: 3, label: 'No, and tell Codex what to do differently' },
      ],
      hash: expect.stringMatching(/^[0-9a-f]{12}$/),
      cursor: 1,
    })
  })

  it('hashes the command, not the cursor', async () => {
    const first = codexScreen(await screen('approval_queued_first')).dialog!
    expect(codexScreen(await screen('approval_queued_second')).dialog!.hash).not.toBe(first.hash)
    const moved = (await screen('approval_queued_first')).replace('› 1. Yes', '  1. Yes').replace('  2. Yes, and', '› 2. Yes, and')
    expect(codexScreen(moved)).toEqual({ state: 'waiting', dialog: { ...first, cursor: 2 } })
  })

  it('keeps an approval it cannot parse strictly as waiting, with no dialog', async () => {
    const gap = (await screen('approval_command')).replace('  3. No,', '  4. No,')
    expect(codexScreen(gap)).toEqual({ state: 'waiting', dialog: null })
  })

  it('reads near-misses as unknown', async () => {
    const approval = await screen('approval_command')
    const lines = approval.split('\n')
    const near = [
      approval.replace('Would you like to run the following command?', 'Would you like to delete everything?'),
      approval.replace(/\n$/, '\n  1. Yes\n'),
      approval.replace('  2. Yes, and', '› 2. Yes, and'),
      lines.slice(lines.findIndex((l) => l.startsWith('› 1.'))).join('\n'),
      (await screen('idle_draft')).replace('› say hi', '! say hi'),
      (await screen('idle_empty')).split('\n').slice(0, -2).join('\n'),
      '',
    ]
    for (const s of near) expect(codexScreen(s)).toEqual({ state: 'unknown', dialog: null })
  })
})

describe('parsePanes', () => {
  it('maps each pane tty, without /dev/, to its pane id', () => {
    expect(parsePanes('%0 /dev/ttys009\n%1 /dev/ttys011\n%12 /dev/pts/3\n\nbogus\n0:1 /dev/ttys004\n')).toEqual(new Map([
      ['ttys009', '%0'], ['ttys011', '%1'], ['pts/3', '%12'],
    ]))
  })
})

describe('parseCodexPs', () => {
  it('keeps codex executables that have a terminal, with lstart as printed and comm in full', () => {
    const stdout = [
      '17099 ttys009  Ss   Sun Nov 15 07:49:22 2026     /bin/zsh',
      '17325 ttys009  S+   Sun Nov 15 07:49:28 2026     node',
      '17326 ttys009  S+   Sun Nov 15 07:49:28 2026     /Users/me/.nvm/versions/node/v24.21.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
      '18016 ??       Ss   Sun Nov 15 06:00:01 2026     /Users/me/.codex/packages/app-server-daemon/releases/0.169.0-aarch64-apple-darwin/bin/codex',
      '30719 ??       S    Sun Nov 15 06:00:02 2026     /Users/me/.codex/packages/app-server-daemon/releases/0.169.0-aarch64-apple-darwin/bin/codex-code-mode-host',
      '43008 ttys013  T    Sun Nov  5 07:58:43 2026     /opt/homebrew/bin/codex',
      '44179 ttys013  S    Sun Nov 15 07:59:08 2026     npm exec shadcn@latest mcp',
      ' 4321 pts/3    Sl+  Sun Nov 15 07:59:08 2026     codex',
      '  999 ?        Ss   Sun Nov 15 07:59:08 2026     codex',
      ' 1000 ttys001  S    Sun Nov 15 07:59:08 2026     /Applications/My Tools/codex',
      'garbage',
    ].join('\n')
    expect(parseCodexPs(stdout)).toEqual([
      { pid: 17326, tty: 'ttys009', stat: 'S+', lstart: 'Sun Nov 15 07:49:28 2026' },
      { pid: 43008, tty: 'ttys013', stat: 'T', lstart: 'Sun Nov  5 07:58:43 2026' },
      { pid: 4321, tty: 'pts/3', stat: 'Sl+', lstart: 'Sun Nov 15 07:59:08 2026' },
      { pid: 1000, tty: 'ttys001', stat: 'S', lstart: 'Sun Nov 15 07:59:08 2026' },
    ])
  })
})

describe('parseCwds', () => {
  it('reads each pid\'s cwd from lsof field output', () => {
    expect(parseCwds('p17326\nfcwd\nn/private/tmp/proj\np38536\nfcwd\nn/Users/me/my proj\n')).toEqual(new Map([
      [17326, '/private/tmp/proj'], [38536, '/Users/me/my proj'],
    ]))
    expect(parseCwds('')).toEqual(new Map())
  })
})

describe('dateFolders', () => {
  const d = (...a: [number, number, number, number?]) => new Date(a[0], a[1] - 1, a[2], a[3] ?? 12)
  it('runs from the day before the start through tomorrow, in local time', () => {
    expect(dateFolders(d(2026, 11, 15, 7), d(2026, 11, 15, 19))).toEqual(['2026/11/14', '2026/11/15', '2026/11/16'])
  })
  it('crosses month and year ends', () => {
    expect(dateFolders(d(2026, 10, 31, 23), d(2026, 11, 1, 0))).toEqual(['2026/10/30', '2026/10/31', '2026/11/01', '2026/11/02'])
    expect(dateFolders(d(2026, 1, 1, 0), d(2026, 1, 1, 1))).toEqual(['2025/12/31', '2026/01/01', '2026/01/02'])
  })
})

describe('pickRollout', () => {
  const meta = (over: Partial<CodexMeta> = {}): CodexMeta => ({
    id: 't1', cwd: '/w', originator: 'codex-tui', threadSource: 'user', historyMode: 'paginated', forkedFromId: null, ...over,
  })
  const start = 1_000_000

  it('takes the newest same-folder TUI thread written since the TUI started', () => {
    const resumed = { path: 'old', meta: meta({ id: 'old' }), mtimeMs: start + 5 }
    const newer = { path: 'new', meta: meta({ id: 'new' }), mtimeMs: start + 9 }
    // Resume appends to a file created days earlier; only its last write counts.
    expect(pickRollout([resumed], '/w', start)).toBe(resumed)
    // After /new the fresh rollout is the one being written.
    expect(pickRollout([resumed, newer], '/w', start)).toBe(newer)
    expect(pickRollout([{ path: 'x', meta: meta(), mtimeMs: start }], '/w', start)?.path).toBe('x')
  })

  it('ignores other folders, exec and sub-agent threads, unreadable headers and files last written before the start', () => {
    expect(pickRollout([
      { path: 'a', meta: meta({ cwd: '/other' }), mtimeMs: start + 1 },
      { path: 'b', meta: meta({ originator: 'codex_exec' }), mtimeMs: start + 1 },
      { path: 'c', meta: meta({ threadSource: 'subagent' }), mtimeMs: start + 1 },
      { path: 'd', meta: null, mtimeMs: start + 1 },
      { path: 'e', meta: meta(), mtimeMs: start - 1 },
    ], '/w', start)).toBeNull()
  })
})

describe('listCodexSessions', () => {
  const START = 'Sun Nov 15 07:49:28 2026'
  const startMs = Date.parse(`${START} UTC`)
  const at = new Date(startMs)
  const folder = `${at.getFullYear()}/${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')}`
  const screen = (name: string) => fixture(`screens/${name}.txt`)
  let home = ''
  let work = ''
  let realWork = ''
  let lonely = ''
  let rollout = ''

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'ccds-codex-'))
    work = join(home, 'work')
    lonely = join(home, 'lonely')
    await mkdir(work)
    await mkdir(lonely)
    // lsof prints the resolved path (/private/tmp on macOS) while the header keeps the path Codex was started in.
    realWork = await realpath(work)
    lonely = await realpath(lonely)
    await mkdir(join(home, 'sessions', folder), { recursive: true })
    rollout = join(home, 'sessions', folder, 'rollout-2026-11-15T02-49-50-t1.jsonl')
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 't1', cwd: work, originator: 'codex-tui', thread_source: 'user', history_mode: 'paginated' } }) + '\n')
    await utimes(rollout, new Date(startMs + 60_000), new Date(startMs + 60_000))
  })

  afterAll(() => rm(home, { recursive: true, force: true }))

  type Proc = { pid: number; tty: string; cwd: string; comm?: string }
  // Stands in for tmux, ps and lsof; screens are keyed by pane.
  function fake(procs: Proc[], panes: Record<string, string>, screens: Record<string, string>) {
    const calls: string[][] = []
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args])
      if (file === 'tmux' && args[0] === 'list-panes') return Object.entries(panes).map(([tty, pane]) => `${pane} /dev/${tty}\n`).join('')
      if (file === 'tmux' && args[0] === 'capture-pane') {
        const s = screens[args.at(-1)!]
        if (s === undefined) throw new Error("can't find pane")
        return s
      }
      if (file === 'ps') return procs.map((p) => `${String(p.pid).padStart(5)} ${p.tty.padEnd(8)} S+   ${START}     ${p.comm ?? '/opt/homebrew/bin/codex'}\n`).join('')
      if (file === 'lsof') {
        const pids = args[args.indexOf('-p') + 1].split(',').map(Number)
        return procs.filter((p) => pids.includes(p.pid)).map((p) => `p${p.pid}\nfcwd\nn${p.cwd}\n`).join('')
      }
      throw new Error(`unexpected ${file}`)
    }
    return { run, calls }
  }
  const quiet = () => {}

  it('lists a pane only once its screen has shown the Codex TUI, then keeps it while the process lives', async () => {
    const procs = [{ pid: 101, tty: 'ttys101', cwd: realWork }]
    const panes = { ttys101: '%1' }
    const shell = await screen('after_quit_shell')
    expect(await listCodexSessions(home, [], quiet, fake(procs, panes, { '%1': shell }).run, 'darwin')).toEqual([])

    const idle = await listCodexSessions(home, [], quiet, fake(procs, panes, { '%1': await screen('idle_empty') }).run, 'darwin')
    expect(idle).toEqual([{
      pid: 101, procStart: START, sessionId: 't1', cwd: realWork, name: '', status: 'idle', interactive: true, pane: '%1',
      transcript: rollout, provider: 'codex', ambiguous: false,
    }])
    expect((await listCodexSessions(home, [], quiet, fake(procs, panes, { '%1': await screen('approval_command') }).run, 'darwin'))[0].status).toBe('waiting')
    expect((await listCodexSessions(home, [], quiet, fake(procs, panes, { '%1': shell }).run, 'darwin'))[0].status).toBe('unknown')
    // A capture that fails reads as unknown rather than failing the whole list.
    expect((await listCodexSessions(home, [], quiet, fake(procs, panes, {}).run, 'darwin'))[0].status).toBe('unknown')

    // Once the process is gone it is forgotten, so the same pid and start must be recognised again.
    expect(await listCodexSessions(home, [], quiet, fake([], panes, {}).run, 'darwin')).toEqual([])
    expect(await listCodexSessions(home, [], quiet, fake(procs, panes, { '%1': shell }).run, 'darwin')).toEqual([])
  })

  it('has no transcript and an empty sessionId until the first message creates the rollout', async () => {
    const { run } = fake([{ pid: 102, tty: 'ttys102', cwd: lonely }], { ttys102: '%2' }, { '%2': await screen('idle_empty') })
    expect(await listCodexSessions(home, [], quiet, run, 'darwin')).toMatchObject([{ pid: 102, sessionId: '', transcript: null, cwd: lonely }])
  })

  it('marks every session in a folder shared with another terminal codex as ambiguous', async () => {
    const idle = await screen('idle_empty')
    const procs = [
      { pid: 103, tty: 'ttys103', cwd: realWork }, { pid: 104, tty: 'ttys104', cwd: realWork },
      { pid: 105, tty: 'ttys105', cwd: lonely }, { pid: 106, tty: 'ttys199', cwd: lonely },
      { pid: 107, tty: '??', cwd: realWork },
    ]
    const { run, calls } = fake(procs, { ttys103: '%3', ttys104: '%4', ttys105: '%5' }, { '%3': idle, '%4': idle, '%5': idle })
    const list = await listCodexSessions(home, [], quiet, run, 'darwin')
    expect(list.map((s) => [s.pid, s.ambiguous, s.transcript])).toEqual([[103, true, rollout], [104, true, rollout], [105, true, null]])
    // One ps and one lsof per call, the lsof covering the codex outside tmux too.
    expect(calls.filter((c) => c[0] === 'ps')).toHaveLength(1)
    expect(calls.filter((c) => c[0] === 'lsof').map((c) => c[c.indexOf('-p') + 1])).toEqual(['103,104,105,106'])
  })

  it('returns the previous list and logs when a tool fails, and nothing when tmux has no server', async () => {
    const prev = [{ pid: 1 }] as any
    const logged: unknown[][] = []
    const failing = async (file: string) => {
      if (file === 'ps') throw new Error('ps: broken')
      return '%1 /dev/ttys101\n'
    }
    expect(await listCodexSessions(home, prev, (...a) => logged.push(a), failing, 'darwin')).toBe(prev)
    expect(String(logged[0])).toContain('ps: broken')

    for (const msg of ['no server running on /tmp/tmux-501/default', 'error connecting to /private/tmp/tmux-501/x (No such file or directory)']) {
      const noServer = async () => {
        throw new Error(`Command failed: tmux list-panes\n${msg}`)
      }
      expect(await listCodexSessions(home, prev, (...a) => logged.push(a), noServer, 'darwin')).toEqual([])
    }
    expect(logged).toHaveLength(1)
  })

  it('does nothing without a sessions folder or on Windows', async () => {
    const { run, calls } = fake([], {}, {})
    expect(await listCodexSessions(join(home, 'nope'), [], quiet, run, 'darwin')).toEqual([])
    expect(await listCodexSessions(home, [], quiet, run, 'win32')).toEqual([])
    expect(calls).toEqual([])
  })
})

const has = (cmd: string, arg: string) => {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A sleep named codex stands in for the TUI, under the real tmux, ps and lsof.
describe.skipIf(process.platform === 'win32' || !has('tmux', '-V') || !has('lsof', '-v'))('listCodexSessions on a real tmux pane', () => {
  const socket = `ccds-test-${randomBytes(4).toString('hex')}`
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' })
  let dir = ''

  beforeAll(() => {
    process.env.TMUX_SOCKET_NAME = socket
  })

  afterAll(async () => {
    // kill-server leaves the socket file behind.
    try {
      const path = tmux('display-message', '-p', '#{socket_path}').trim()
      tmux('kill-server')
      await rm(path, { force: true })
    } catch {}
    process.env.TMUX_SOCKET_NAME = 'ccds-test-guard'
    await rm(dir, { recursive: true, force: true })
  })

  it('finds the pane, its process start and cwd, and the rollout written since', async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'ccds-codex-real-')))
    const work = join(dir, 'work')
    await mkdir(work)
    await mkdir(join(dir, 'bin'))
    // The stand-in must keep `codex` as its process name: Ubuntu's multi-call sleep exits under another name,
    // and node renames its thread to MainThread, so Linux uses python3 and macOS uses sleep.
    const linux = process.platform !== 'darwin'
    const real = execFileSync('sh', ['-c', `command -v ${linux ? 'python3' : 'sleep'}`], { encoding: 'utf8' }).trim()
    await symlink(real, join(dir, 'bin', 'codex'))
    const args = linux ? `-c 'import time; time.sleep(60)'` : '60'
    await writeFile(join(dir, 'screen.txt'), '\n\n› Ask Codex to do anything\n\n  model high · /w\n  ? for shortcuts')
    // Exactly as tall as the screen, so its last row is the pane's last row.
    tmux('-f', '/dev/null', 'new-session', '-d', '-x', '60', '-y', '6', '-c', work, `cat '${dir}/screen.txt'; exec '${dir}/bin/codex' ${args}`)
    const pane = tmux('list-panes', '-F', '#{pane_id}').trim()
    const pid = Number(tmux('display-message', '-p', '-t', pane, '#{pane_pid}').trim())
    const home = join(dir, 'home')
    const now = new Date()
    const day = join(home, 'sessions', `${now.getFullYear()}`, String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
    await mkdir(day, { recursive: true })
    const file = join(day, 'rollout-2026-11-15T02-49-50-t9.jsonl')
    await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 't9', cwd: work, originator: 'codex-tui', thread_source: 'user' } }) + '\n')

    let list: Awaited<ReturnType<typeof listCodexSessions>> = []
    for (let i = 0; i < 40 && !list.length; i++) {
      await new Promise((r) => setTimeout(r, 50))
      list = await listCodexSessions(home, [], (...a) => console.error(...a))
    }
    if (!list.length) {
      // Say which discovery input differed, so a failure on another OS is diagnosable from the CI log.
      const sh = (cmd: string) => { try { return execFileSync('sh', ['-c', cmd], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }) } catch (e) { return `ERR ${(e as Error).message}` } }
      console.error([
        tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_tty} #{pane_pid}'),
        sh(`ps -A -o pid=,tty=,stat=,lstart=,comm= | grep -v ' ??' | tail -n 40`),
        sh(`lsof -a -p ${pid} -d cwd -Fn`),
        tmux('capture-pane', '-p', '-J', '-t', pane),
      ].join('\n---\n'))
    }
    const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim()
    expect(list).toEqual([{
      pid, procStart: expect.stringMatching(/\S/), sessionId: 't9', cwd: work, name: '', status: 'idle', interactive: true, pane,
      transcript: file, provider: 'codex', ambiguous: false,
    }])
    expect(list[0].procStart.replace(/\s+/g, ' ')).toBe(procStart.replace(/\s+/g, ' '))
  })
})
