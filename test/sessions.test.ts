import { beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { listSessions, parseStartTimes, readStatus, sameStartFt, verifiedStarts, windowsStartTimes } from '../src/sessions.ts'

const exec = promisify(execFile)

let procStart: string
let deadPid: number

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

// Needs ps and true.
describe.skipIf(process.platform === 'win32')('listSessions', () => {
  beforeAll(async () => {
    procStart = (await exec('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout.trim()
    const child = spawn('true')
    await new Promise((resolve) => child.on('exit', resolve))
    deadPid = child.pid!
  })

  it('keeps live sessions and maps their fields, parsing the pane and finding the transcript', async () => {
    const { sessionsDir, projectsDir } = await setup({
      'a.json': live({ sessionId: 'sid-a', tmux: '0:@0.%11', status: 'waiting' }),
    })
    await mkdir(join(projectsDir, '-Users-me-proj'))
    await writeFile(join(projectsDir, '-Users-me-proj', 'sid-a.jsonl'), '')
    expect(await listSessions(sessionsDir, projectsDir)).toEqual([{
      pid: process.pid, procStart, sessionId: 'sid-a', cwd: '/Users/me/proj', name: 'proj-1', status: 'waiting',
      interactive: true, pane: '%11', transcript: join(projectsDir, '-Users-me-proj', 'sid-a.jsonl'), provider: 'claude',
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

  it('does not throw on a non-string cwd or name', async () => {
    const { sessionsDir, projectsDir } = await setup({ 'a.json': live({ sessionId: 'sid-a', cwd: 42, name: { x: 1 } }) })
    expect(await listSessions(sessionsDir, projectsDir)).toMatchObject([{ sessionId: 'sid-a', cwd: '', name: '' }])
  })

  it('returns an empty list when the registry directory is missing', async () => {
    expect(await listSessions(join(tmpdir(), 'ccds-no-such-dir'), join(tmpdir(), 'ccds-no-such-dir'))).toEqual([])
  })
})

describe('readStatus', () => {
  it('reads the status from <pid>.json, fresh on every call', async () => {
    const { sessionsDir } = await setup({ '123.json': { pid: 123, status: 'busy' } })
    expect(await readStatus(sessionsDir, 123)).toBe('busy')
    await writeFile(join(sessionsDir, '123.json'), JSON.stringify({ pid: 123, status: 'waiting' }))
    expect(await readStatus(sessionsDir, 123)).toBe('waiting')
  })

  it('returns an empty status for an entry without one', async () => {
    const { sessionsDir } = await setup({ '123.json': { pid: 123 } })
    expect(await readStatus(sessionsDir, 123)).toBe('')
  })

  it('retries once when the entry is caught mid-rewrite', async () => {
    const { sessionsDir } = await setup({ '123.json': '{"pid":12' })
    const read = readStatus(sessionsDir, 123)
    setTimeout(() => void writeFile(join(sessionsDir, '123.json'), JSON.stringify({ pid: 123, status: 'waiting' })), 5)
    expect(await read).toBe('waiting')
  })

  it('returns null for a missing, broken or non-object entry', async () => {
    const { sessionsDir } = await setup({ '2.json': '{"status":', '3.json': 'null', '4.json': '"waiting"' })
    for (const pid of [1, 2, 3, 4]) expect(await readStatus(sessionsDir, pid)).toBeNull()
  })
})

describe('sameStartFt', () => {
  it('matches an exact FILETIME string, and nothing else for an exact value', () => {
    expect(sameStartFt('134012345678901234', '134012345678901234')).toBe(true)
    expect(sameStartFt('134012345678901234', '134012345678901235')).toBe(false)
    expect(sameStartFt('', '')).toBe(false)
    expect(sameStartFt('1e17', '100000000000000000')).toBe(false)
    expect(sameStartFt('134012345678901234', '')).toBe(false)
  })

  it('allows one float64 step for a value that arrived as a rounded JSON number', () => {
    const recorded = String(Number('134012345678901234')) // 134012345678901230: the double is ...232
    expect(sameStartFt(recorded, '134012345678901234')).toBe(true)
    expect(sameStartFt(recorded, '134012345678901246')).toBe(true)
    expect(sameStartFt(recorded, '134012345678901250')).toBe(false)
    expect(sameStartFt(recorded, '134012345678900000')).toBe(false)
  })
})

describe('parseStartTimes', () => {
  it('reads "pid filetime" lines, tolerating CRLF, blanks and junk', () => {
    expect(parseStartTimes('123 134012345678901234\r\n\r\n 456 134012345678909999 \r\nnope\n')).toEqual(new Map([
      [123, '134012345678901234'], [456, '134012345678909999'],
    ]))
    expect(parseStartTimes('')).toEqual(new Map())
  })
})

const winEntry = (over: Record<string, unknown>) => ({
  pid: process.pid, cwd: 'C:\\Users\\me\\proj', kind: 'interactive', status: 'idle', startedAt: 1, ...over,
})

describe('listSessions on Windows', () => {
  it('drops a session whose start time cannot be confirmed (fails closed)', async () => {
    const { sessionsDir, projectsDir } = await setup({ 'a.json': winEntry({ sessionId: 'sid-a', procStartFt: '1' }) })
    expect(await listSessions(sessionsDir, projectsDir, 'win32')).toEqual([])
  })

  it('uses the cached check for a (pid, procStartFt) and keeps procStartFt as procStart', async () => {
    verifiedStarts.set(`${process.pid}|999`, true)
    const { sessionsDir, projectsDir } = await setup({ 'a.json': winEntry({ sessionId: 'sid-a', procStartFt: 999 }) })
    expect(await listSessions(sessionsDir, projectsDir, 'win32')).toMatchObject([{ sessionId: 'sid-a', procStart: '999' }])
  })

  it('forgets cached checks for entries no longer live in the registry, so a reused pid is measured again', async () => {
    verifiedStarts.set(`${process.pid}|999`, true)
    verifiedStarts.set(`${process.pid}|555`, true)
    verifiedStarts.set('999999|1', true)
    const { sessionsDir, projectsDir } = await setup({ 'a.json': winEntry({ sessionId: 'sid-a', procStartFt: '999' }) })
    await listSessions(sessionsDir, projectsDir, 'win32')
    expect([...verifiedStarts.keys()]).toEqual([`${process.pid}|999`])
    const empty = await setup({})
    expect(await listSessions(empty.sessionsDir, empty.projectsDir, 'win32')).toEqual([])
    expect(verifiedStarts.size).toBe(0)
  })
})

describe.runIf(process.platform === 'win32')('Windows start times (real PowerShell)', () => {
  it('measures this process as a FILETIME close to when node started', async () => {
    const ft = (await windowsStartTimes([process.pid])).get(process.pid)
    expect(ft).toMatch(/^\d+$/)
    // FILETIME counts 100 ns ticks since 1601; timeOrigin is when this node process started, in ms since 1970.
    const ms = Number((BigInt(ft!) - 116444736000000000n) / 10000n)
    expect(Math.abs(ms - performance.timeOrigin)).toBeLessThan(60_000)
  })

  it('keeps a session whose procStartFt matches, as a string or a rounded number, and drops a mismatch', async () => {
    const ft = (await windowsStartTimes([process.pid])).get(process.pid)!
    for (const procStartFt of [ft, Number(ft)]) {
      const { sessionsDir, projectsDir } = await setup({ 'a.json': winEntry({ sessionId: 'sid-a', procStartFt }) })
      expect(await listSessions(sessionsDir, projectsDir), String(procStartFt)).toMatchObject([{ sessionId: 'sid-a', procStart: String(procStartFt) }])
    }
    const { sessionsDir, projectsDir } = await setup({ 'a.json': winEntry({ sessionId: 'sid-a', procStartFt: String(BigInt(ft) + 1000n) }) })
    expect(await listSessions(sessionsDir, projectsDir)).toEqual([])
  })
})
