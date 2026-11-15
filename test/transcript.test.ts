import { describe, expect, it } from 'vitest'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLine, readAppended } from '../src/transcript.ts'

describe('parseLine', () => {
  it('turns a redacted session into events, ignoring housekeeping, meta, peer and sidechain lines', async () => {
    const text = await readFile(new URL('./fixtures/session.jsonl', import.meta.url), 'utf8')
    const events = text.split('\n').flatMap(parseLine)
    expect(events).toEqual([
      { kind: 'prompt', text: 'hello' },
      { kind: 'text', text: 'Hi there.' },
      { kind: 'tool_start', id: 'toolu_bash', name: 'Bash', input: { command: 'ls /tmp/x', description: 'List files' } },
      { kind: 'tool_end', id: 'toolu_bash', ok: true },
      { kind: 'tool_start', id: 'toolu_read', name: 'Read', input: { file_path: '/tmp/x.ts' } },
      { kind: 'tool_end', id: 'toolu_read', ok: false },
      { kind: 'agent_start', id: 'toolu_agent_bg', agentType: 'codebase-browser', description: 'Map the code' },
      { kind: 'agent_start', id: 'toolu_task_sync', agentType: 'general-purpose', description: '' },
      { kind: 'tool_end', id: 'toolu_task_sync', ok: true },
      { kind: 'prompt', text: 'also this' },
      { kind: 'agent_end', id: 'toolu_agent_bg', status: 'completed', durationMs: 4567 },
      { kind: 'agent_end', id: 'toolu_agent_bg2', status: 'failed' },
      { kind: 'prompt', text: 'line one\nline two' },
      { kind: 'prompt', text: '/model haiku' },
      { kind: 'prompt', text: '/clear' },
      { kind: 'text', text: 'API Error: placeholder' },
      { kind: 'turn_end', durationMs: 68597, pendingAgents: 1 },
      { kind: 'turn_end', durationMs: 1200, pendingAgents: 0 },
      { kind: 'title', title: 'Placeholder title' },
    ])
  })

  it('never throws on bad or unexpected input', () => {
    for (const line of ['', '{"type":"user"', 'null', '42', '"text"', '{"type":"assistant","message":{"content":"oops"}}', '{"type":"user","message":null}']) {
      expect(parseLine(line)).toEqual([])
    }
  })

  it('drops lines timestamped before `since`, keeping later and untimestamped ones', () => {
    const at = (timestamp: string) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' }, timestamp })
    const since = Date.parse('2026-11-01T00:00:01.000Z')
    expect(parseLine(at('2026-11-01T00:00:00.999Z'), since)).toEqual([])
    expect(parseLine(at('2026-11-01T00:00:01.000Z'), since)).toEqual([{ kind: 'prompt', text: 'hi' }])
    expect(parseLine(at('2026-11-01T00:00:00.999Z'))).toEqual([{ kind: 'prompt', text: 'hi' }])
    expect(parseLine('{"type":"ai-title","aiTitle":"Placeholder title"}', since)).toEqual([{ kind: 'title', title: 'Placeholder title' }])
  })

  it('parses a stopped notification and a queued prompt given as text blocks', () => {
    const stopped = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<tool-use-id>toolu_x</tool-use-id>\n<status>stopped</status>\n</task-notification>' } }
    expect(parseLine(JSON.stringify(stopped))).toEqual([{ kind: 'agent_end', id: 'toolu_x', status: 'stopped' }])
    const blocks = { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, prompt: [{ type: 'text', text: 'queued' }] } }
    expect(parseLine(JSON.stringify(blocks))).toEqual([{ kind: 'prompt', text: 'queued' }])
  })

  it('takes an agent\'s end from the queue log, which is written before the turn that reports it ends', () => {
    const enqueue = { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<tool-use-id>toolu_y</tool-use-id>\n<status>completed</status>\n</task-notification>' }
    expect(parseLine(JSON.stringify(enqueue))).toEqual([{ kind: 'agent_end', id: 'toolu_y', status: 'completed' }])
    expect(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'a typed prompt' }))).toEqual([])
    expect(parseLine(JSON.stringify({ ...enqueue, operation: 'dequeue' }))).toEqual([])
  })
})

describe('readAppended', () => {
  const tmpFile = async () => join(await mkdtemp(join(tmpdir(), 'transcript-')), 'session.jsonl')

  it('returns nothing for a missing file', async () => {
    expect(await readAppended(await tmpFile(), 7)).toEqual({ lines: [], next: 7 })
  })

  it('returns only complete lines and re-reads a trailing partial line', async () => {
    const file = await tmpFile()
    await writeFile(file, 'a\nb')
    expect(await readAppended(file, 0)).toEqual({ lines: ['a'], next: 2 })
    expect(await readAppended(file, 2)).toEqual({ lines: [], next: 2 })
    await appendFile(file, 'c\nd\n')
    expect(await readAppended(file, 2)).toEqual({ lines: ['bc', 'd'], next: 7 })
  })

  it('restarts from 0 when the file shrank', async () => {
    const file = await tmpFile()
    await writeFile(file, 'aaaa\nbbbb\n')
    expect((await readAppended(file, 0)).next).toBe(10)
    await writeFile(file, 'c\n')
    expect(await readAppended(file, 10)).toEqual({ lines: ['c'], next: 2 })
  })

  it('keeps multi-byte characters split across reads intact', async () => {
    const file = await tmpFile()
    const e = Buffer.from('é')
    await writeFile(file, Buffer.concat([Buffer.from('héllo\n'), e.subarray(0, 1)]))
    expect(await readAppended(file, 0)).toEqual({ lines: ['héllo'], next: 7 })
    await appendFile(file, Buffer.concat([e.subarray(1), Buffer.from('\n')]))
    expect(await readAppended(file, 7)).toEqual({ lines: ['é'], next: 10 })
  })

  it('reads a very large line whole', async () => {
    const file = await tmpFile()
    const big = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ü'.repeat(500_000) }] } })
    await writeFile(file, `${big}\n`)
    const { lines, next } = await readAppended(file, 0)
    expect(lines).toEqual([big])
    expect(next).toBe(Buffer.byteLength(big) + 1)
  })
})
