import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

export type Session = {
  pid: number; procStart: string; sessionId: string; cwd: string; name: string
  status: string; interactive: boolean; pane: string | null; transcript: string | null
}

const PANE = /^%\d+$/

const exec = promisify(execFile)
const squash = (s: string) => s.trim().replace(/\s+/g, ' ')

// The registry is an undocumented format, so entries stay loosely typed and anything unexpected is skipped.
async function readRegistry(sessionsDir: string): Promise<any[]> {
  const files = await readdir(sessionsDir).catch(() => [])
  const entries = await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => {
    try {
      return JSON.parse(await readFile(join(sessionsDir, f), 'utf8'))
    } catch {
      return null
    }
  }))
  // pid 0 or negative would signal a whole process group.
  return entries.filter((e) => Number.isInteger(e?.pid) && e.pid > 0 && typeof e.sessionId === 'string' && e.sessionId)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Live start time per pid, or null when ps cannot run at all.
async function startTimes(pids: number[]): Promise<Map<number, string> | null> {
  let stdout: string
  try {
    // Claude records procStart as ps prints it in the C locale and UTC.
    const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    stdout = (await exec('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { env })).stdout
  } catch (e) {
    // ps exits 1 when any listed pid is gone, but still prints the live ones.
    if (typeof (e as any).code !== 'number') return null
    stdout = (e as any).stdout ?? ''
  }
  const starts = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (m) starts.set(Number(m[1]), squash(m[2]))
  }
  return starts
}

async function findTranscript(projectsDir: string, dirs: string[], sessionId: string): Promise<string | null> {
  for (const dir of dirs) {
    const path = join(projectsDir, dir, `${sessionId}.jsonl`)
    try {
      await access(path)
      return path
    } catch {}
  }
  return null
}

export async function listSessions(sessionsDir: string, projectsDir: string): Promise<Session[]> {
  const running = (await readRegistry(sessionsDir)).filter((e) => alive(e.pid))
  if (!running.length) return []
  const starts = await startTimes(running.map((e) => e.pid))
  // Without ps we cannot detect pid reuse, so a live pid is the best we have.
  const live = starts ? running.filter((e) => starts.get(e.pid) === squash(String(e.procStart ?? ''))) : running
  live.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const dirs = await readdir(projectsDir).catch(() => [])
  return Promise.all(live.map(async (e): Promise<Session> => {
    const cwd = e.cwd ?? ''
    const pane = typeof e.tmux === 'string' ? e.tmux.slice(e.tmux.lastIndexOf('.') + 1) : ''
    return {
      pid: e.pid, procStart: e.procStart ?? '', sessionId: e.sessionId, cwd, name: e.name || basename(cwd),
      status: e.status ?? '', interactive: e.kind === 'interactive', pane: PANE.test(pane) ? pane : null,
      transcript: await findTranscript(projectsDir, dirs, e.sessionId),
    }
  }))
}
