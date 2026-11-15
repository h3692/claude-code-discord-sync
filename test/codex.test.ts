import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { parseCodexLine, readCodexMeta } from '../src/codex.ts'

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
