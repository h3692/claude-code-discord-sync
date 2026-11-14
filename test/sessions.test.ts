import { beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { listSessions } from '../src/sessions.ts'

const exec = promisify(execFile)

let procStart: string
let deadPid: number

beforeAll(async () => {
  procStart = (await exec('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout.trim()
  const child = spawn('true')
  await new Promise((resolve) => child.on('exit', resolve))
  deadPid = child.pid!
})

async function setup(entries: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'ccds-sessions-'))
  const sessionsDir = join(root, 'sessions')
  const projectsDir = join(root, 'projects')
  await mkdir(sessionsDir)
  await mkdir(projectsDir)
  for (const [file, body] of Object.entries(entries)) {
    await writeFile(join(sessionsDir, file), typeof body === 'string' ? body : JSON.stringify(body))
  }
  return { sessionsDir, projectsDir }
}

const live = (over: Record<string, unknown>) => ({
  pid: process.pid, procStart, cwd: '/Users/me/proj', name: 'proj-1', kind: 'interactive', status: 'idle', startedAt: 1, ...over,
})

describe('listSessions', () => {
  it('keeps live sessions and maps their fields, parsing the pane and finding the transcript', async () => {
    const { sessionsDir, projectsDir } = await setup({
      'a.json': live({ sessionId: 'sid-a', tmux: '0:@0.%11', status: 'waiting' }),
    })
    await mkdir(join(projectsDir, '-Users-me-proj'))
    await writeFile(join(projectsDir, '-Users-me-proj', 'sid-a.jsonl'), '')
    expect(await listSessions(sessionsDir, projectsDir)).toEqual([{
      pid: process.pid, procStart, sessionId: 'sid-a', cwd: '/Users/me/proj', name: 'proj-1', status: 'waiting',
      interactive: true, pane: '%11', transcript: join(projectsDir, '-Users-me-proj', 'sid-a.jsonl'),
    }])
  })

  it('matches procStart regardless of whitespace differences', async () => {
    const { sessionsDir, projectsDir } = await setup({ 'a.json': live({ sessionId: 'sid-a', procStart: ` ${procStart.replace(' ', '  ')} ` }) })
    expect((await listSessions(sessionsDir, projectsDir)).map((s) => s.sessionId)).toEqual(['sid-a'])
  })

  it('drops dead pids, reused pids, bad pids, invalid files and non-json files', async () => {
    const { sessionsDir, projectsDir } = await setup({
      'ok.json': live({ sessionId: 'sid-ok' }),
      'dead.json': live({ sessionId: 'sid-dead', pid: deadPid }),
      'reused.json': live({ sessionId: 'sid-reused', procStart: 'Mon Jan  1 00:00:00 2001' }),
      'zero.json': live({ sessionId: 'sid-zero', pid: 0 }),
      'neg.json': live({ sessionId: 'sid-neg', pid: -1 }),
      'str.json': live({ sessionId: 'sid-str', pid: String(process.pid) }),
      'nosid.json': live({ sessionId: undefined }),
      'nopid.json': live({ sessionId: 'sid-nopid', pid: undefined }),
      'broken.json': '{"pid":',
      'null.json': 'null',
      [`${process.pid}.abc123.key`]: JSON.stringify(live({ sessionId: 'sid-key' })),
    })
    expect((await listSessions(sessionsDir, projectsDir)).map((s) => s.sessionId)).toEqual(['sid-ok'])
  })

  it('returns no pane for missing or malformed tmux, no transcript when absent, and falls back on name and status', async () => {
    const { sessionsDir, projectsDir } = await setup({
      'a.json': live({ sessionId: 'sid-a', startedAt: 1 }),
      'b.json': live({ sessionId: 'sid-b', startedAt: 2, tmux: '0:@0.foo', kind: 'bg', name: undefined, status: undefined }),
    })
    const [a, b] = await listSessions(sessionsDir, projectsDir)
    expect(a).toMatchObject({ sessionId: 'sid-a', pane: null, transcript: null, interactive: true })
    expect(b).toMatchObject({ sessionId: 'sid-b', pane: null, transcript: null, interactive: false, name: 'proj', status: '' })
  })

  it('sorts by startedAt, oldest first', async () => {
    const { sessionsDir, projectsDir } = await setup({
      'a.json': live({ sessionId: 'sid-new', startedAt: 300 }),
      'b.json': live({ sessionId: 'sid-old', startedAt: 100 }),
      'c.json': live({ sessionId: 'sid-mid', startedAt: 200 }),
    })
    expect((await listSessions(sessionsDir, projectsDir)).map((s) => s.sessionId)).toEqual(['sid-old', 'sid-mid', 'sid-new'])
  })

  it('falls back to the pid check alone when ps cannot run', async () => {
    const { sessionsDir, projectsDir } = await setup({ 'a.json': live({ sessionId: 'sid-a', procStart: 'Mon Jan  1 00:00:00 2001' }) })
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      expect((await listSessions(sessionsDir, projectsDir)).map((s) => s.sessionId)).toEqual(['sid-a'])
    } finally {
      process.env.PATH = path
    }
  })

  it('returns an empty list when the registry directory is missing', async () => {
    expect(await listSessions(join(tmpdir(), 'ccds-no-such-dir'), join(tmpdir(), 'ccds-no-such-dir'))).toEqual([])
  })
})
