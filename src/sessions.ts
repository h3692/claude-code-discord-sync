import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { powershell, runAsync } from './config.ts'

export type Session = {
  pid: number; procStart: string; sessionId: string; cwd: string; name: string
  status: string; interactive: boolean; pane: string | null; transcript: string | null
}

const PANE = /^%\d+$/

const exec = promisify(execFile)
const squash = (s: string) => s.trim().replace(/\s+/g, ' ')

// The registry is an undocumented format, so entries stay loosely typed and anything unexpected is skipped.
export async function readRegistry(sessionsDir: string): Promise<any[]> {
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

// Status of one session read straight from its registry entry; null when the entry is missing or unreadable.
// Claude Code rewrites the entry in place, so an unreadable one gets a second look before it counts as gone.
export async function readStatus(sessionsDir: string, pid: number): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const e = JSON.parse(await readFile(join(sessionsDir, `${pid}.json`), 'utf8'))
      if (typeof e !== 'object' || !e) return null
      return typeof e.status === 'string' ? e.status : ''
    } catch {
      if (attempt) return null
      await new Promise((r) => setTimeout(r, 25))
    }
  }
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

// "pid FILETIME" lines; anything else is skipped.
export function parseStartTimes(stdout: string): Map<number, string> {
  const starts = new Map<number, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (m) starts.set(Number(m[1]), m[2])
  }
  return starts
}

// Start time per live pid as a FILETIME (100 ns ticks since 1601, UTC); rejects when PowerShell fails or times out.
// .NET directly, so no module has to load; single quotes only, so Windows argv quoting can't mangle the script.
export async function windowsStartTimes(pids: number[]): Promise<Map<number, string>> {
  return parseStartTimes(await runAsync(powershell(
    `foreach ($n in ${pids.join(',')}) { try { '{0} {1}' -f $n, [Diagnostics.Process]::GetProcessById($n).StartTime.ToFileTimeUtc() } catch {} }; exit 0`,
  )))
}

// Claude Code's procStartFt against a measured FILETIME, both digit strings.
export function sameStartFt(recorded: string, measured: string): boolean {
  if (!/^\d+$/.test(recorded) || !/^\d+$/.test(measured)) return false
  if (recorded === measured) return true
  // A JSON number above 2^53 reaches us rounded to a double: allow its spacing (16 ticks, 1.6 µs, for today's dates).
  const n = Number(recorded)
  if (n <= Number.MAX_SAFE_INTEGER || String(n) !== recorded) return false
  const diff = BigInt(recorded) - BigInt(measured)
  return (diff < 0n ? -diff : diff) <= 2n ** BigInt(Math.floor(Math.log2(n)) - 52)
}

// procStartFt as a string, whether Claude Code wrote a JSON number or a string.
const startFt = (e: any): string => (['number', 'string'].includes(typeof e.procStartFt) ? String(e.procStartFt) : '')

// Checked once per (pid, procStartFt): sessions are listed every second, and PowerShell takes about that long to start.
export const verifiedStarts = new Map<string, boolean>()

// Unlike ps on Unix, a failed PowerShell check drops the sessions it was asked about, and is retried next time.
async function verifiedOnWindows(entries: any[]): Promise<any[]> {
  const key = (e: any) => `${e.pid}|${startFt(e)}`
  // A key whose entry is gone or whose pid died is dropped, so a later reuse of that pid is measured afresh.
  const current = new Set(entries.map(key))
  for (const k of verifiedStarts.keys()) if (!current.has(k)) verifiedStarts.delete(k)
  const unknown = entries.filter((e) => !verifiedStarts.has(key(e)))
  if (unknown.length) {
    const starts = await windowsStartTimes(unknown.map((e) => e.pid)).catch(() => null)
    for (const e of starts ? unknown : []) verifiedStarts.set(key(e), sameStartFt(startFt(e), starts!.get(e.pid) ?? ''))
  }
  return entries.filter((e) => verifiedStarts.get(key(e)) === true)
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

export async function listSessions(sessionsDir: string, projectsDir: string, platform = process.platform as string): Promise<Session[]> {
  const running = (await readRegistry(sessionsDir)).filter((e) => alive(e.pid))
  const windows = platform === 'win32'
  // Windows goes on with no live entries too, to prune its start-time cache.
  if (!running.length && !windows) return []
  const starts = windows ? null : await startTimes(running.map((e) => e.pid))
  // Without ps we cannot detect pid reuse, so a live pid is the best we have.
  const live = windows ? await verifiedOnWindows(running)
    : starts ? running.filter((e) => starts.get(e.pid) === squash(String(e.procStart ?? ''))) : running
  live.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  const dirs = await readdir(projectsDir).catch(() => [])
  return Promise.all(live.map(async (e): Promise<Session> => {
    const cwd = typeof e.cwd === 'string' ? e.cwd : ''
    const pane = typeof e.tmux === 'string' ? e.tmux.slice(e.tmux.lastIndexOf('.') + 1) : ''
    return {
      pid: e.pid, procStart: windows ? startFt(e) : e.procStart ?? '', sessionId: e.sessionId, cwd, name: (typeof e.name === 'string' && e.name) || basename(cwd),
      status: e.status ?? '', interactive: e.kind === 'interactive', pane: PANE.test(pane) ? pane : null,
      transcript: await findTranscript(projectsDir, dirs, e.sessionId),
    }
  }))
}
