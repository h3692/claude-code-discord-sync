import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { Session } from './sessions.ts'
import { hashBody, tmux, type Dialog } from './tmux.ts'
import type { TranscriptEvent } from './transcript.ts'

export type CodexMeta = {
  id: string
  cwd: string
  originator: string
  threadSource: string
  historyMode: string
  forkedFromId: string | null
}

// Rollout lines are an undocumented format, so the parsed JSON stays loosely typed, as in transcript.ts.
// Only event_msg lines are read; response_item, turn_context, token_count and the rest repeat or add nothing we show.
// since (epoch ms): drop lines written before it.
export function parseCodexLine(line: string, since?: number): TranscriptEvent[] {
  try {
    const entry = JSON.parse(line)
    if (entry.type !== 'event_msg') return []
    if (since !== undefined && typeof entry.timestamp === 'string' && Date.parse(entry.timestamp) < since) return []
    const payload = entry.payload
    switch (payload.type) {
      case 'item_completed': return parseItem(payload.item)
      case 'task_complete': return [{ kind: 'turn_end', durationMs: payload.duration_ms ?? 0, pendingAgents: 0 }]
      // Closing still-running sub-agent rows is the mirror's job; the parser keeps no state.
      case 'turn_aborted': return [{ kind: 'turn_aborted' }]
      default: return []
    }
  } catch {
    return []
  }
}

function parseItem(item: any): TranscriptEvent[] {
  switch (item.type) {
    case 'UserMessage': {
      const text = textOf(item.content, 'text')
      return !text.trim() || text.startsWith('<send_user_message_question_reply>') ? [] : [{ kind: 'prompt', text }]
    }
    case 'AgentMessage': {
      const text = textOf(item.content, 'Text')
      return text.trim() ? [{ kind: 'text', text }] : []
    }
    case 'CommandExecution':
      return tool(item.id, 'Bash', { command: commandOf(item.command) }, item.status === 'completed' && item.exit_code === 0)
    case 'FileChange':
      return Object.entries(item.changes).flatMap(([path, change]: [string, any]) =>
        tool(`${item.id}:${path}`, change.type === 'add' ? 'Write' : 'Edit', { file_path: path }, item.status === 'completed'))
    case 'McpToolCall':
      return tool(item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {}, item.status === 'completed')
    case 'Extension':
      return item.kind === 'web.search' ? tool(item.id, 'WebSearch', { query: item.query }, true) : []
    // agent_thread_id is the one id shared by an agent's started and finished items; rollouts carry no role, only a path.
    case 'SubAgentActivity':
      if (item.kind === 'started') return [{ kind: 'agent_start', id: item.agent_thread_id, agentType: 'subagent', description: item.agent_path ?? '' }]
      if (item.kind === 'completed') return [{ kind: 'agent_end', id: item.agent_thread_id, status: 'completed' }]
      if (item.kind === 'interrupted') return [{ kind: 'agent_end', id: item.agent_thread_id, status: 'stopped' }]
      return []
    default: return []
  }
}

// Codex logs a finished tool as one item, so its start and end arrive together.
function tool(id: string, name: string, input: Record<string, unknown>, ok: boolean): TranscriptEvent[] {
  return [{ kind: 'tool_start', id, name, input }, { kind: 'tool_end', id, ok }]
}

// Commands arrive wrapped as [shell, '-lc', script]; show the script itself.
function commandOf(command: unknown): string {
  if (!Array.isArray(command)) return String(command)
  return command.length === 3 && /^-l?c$/.test(command[1]) ? command[2] : command.join(' ')
}

function textOf(content: any[], type: string): string {
  return content.filter((b) => b.type === type).map((b) => b.text).join('\n')
}

// Line 0 of a rollout; null for anything else.
export function readCodexMeta(firstLine: string): CodexMeta | null {
  try {
    const entry = JSON.parse(firstLine)
    const p = entry.payload
    if (entry.type !== 'session_meta' || typeof p.id !== 'string') return null
    return { id: p.id, cwd: p.cwd, originator: p.originator, threadSource: p.thread_source, historyMode: p.history_mode, forkedFromId: p.forked_from_id ?? null }
  } catch {
    return null
  }
}

// Approval overlays draw this footer on the last row; the titles are the ones Codex's approval views use.
const APPROVAL_FOOTER = '  Press enter to confirm or esc to cancel'
const APPROVAL_TITLES = new Set([
  'Would you like to run the following command?', 'Would you like to make the following edits?',
  'Would you like to grant these permissions?', 'Would you like to send input to the existing terminal?',
])
const APPROVAL_TITLE = /^(Do you want to approve network access to .+|\S.* needs your approval\.)$/
const CODEX_OPTION = /^(›| ) (\d+)\. (.+)$/
// The key hint after a label: (y), (p), (a), (esc).
const SHORTCUT = /\s+\((?:[a-z]|esc)\)$/
// Below the composer: `  <model> <effort> · <cwd>[ · <title>]`, then a hint row that is blank while drafting or in a popup.
const STATUS = /^  \S.* · \S/
const HINT = /^ *(← for agents · )?(\? for shortcuts|tab to queue message)?( +⚠ \d+ warnings? · f2 to view)? *$/

// Decides whether the app may type into a Codex pane, so anything not positively recognised is unknown.
export function codexScreen(screen: string): { state: 'waiting' | 'idle' | 'unknown'; dialog: Dialog | null } {
  const lines = screen.replace(/\n$/, '').split('\n')
  return approval(lines) ?? (idle(lines) ? { state: 'idle', dialog: null } : { state: 'unknown', dialog: null })
}

function approval(lines: string[]): { state: 'waiting'; dialog: Dialog | null } | null {
  const end = lines.findLastIndex((l) => l.trim())
  if (end < 0 || lines[end].trimEnd() !== APPROVAL_FOOTER) return null
  const title = lines.findLastIndex((l, i) => i < end && (APPROVAL_TITLES.has(l.trim()) || APPROVAL_TITLE.test(l.trim())))
  if (title < 0 || lines.slice(title + 1, end).filter((l) => /^› \d+\. /.test(l)).length !== 1) return null

  // Complete or nothing: the list right above the footer must be options 1..N, one row each.
  let last = end - 1
  while (last > title && !lines[last].trim()) last--
  let first = last
  while (first - 1 > title && CODEX_OPTION.test(lines[first - 1])) first--
  const options: { n: number; label: string }[] = []
  let cursor = 0
  for (let i = first; i <= last; i++) {
    const m = CODEX_OPTION.exec(lines[i])
    if (!m || Number(m[2]) !== options.length + 1) return { state: 'waiting', dialog: null }
    if (m[1] === '›') cursor = Number(m[2])
    options.push({ n: Number(m[2]), label: m[3].trimEnd().replace(SHORTCUT, '') })
  }
  if (options.length < 2 || !cursor) return { state: 'waiting', dialog: null }
  // Title, command or destination, and options, so a different request gets a different hash and cursor moves don't.
  const hash = hashBody(lines.slice(title, last + 1).map((l) => l.replace(/^›/, '')))
  return { state: 'waiting', dialog: { question: lines[title].trim(), options, hash, cursor } }
}

// Bottom up: hint row, status row, a blank row, the composer (`› ` then indented continuation rows), two blank rows.
// The two blank rows are what tell a draft from a popup, which sits right above the composer when the hint row is blank.
function idle(lines: string[]): boolean {
  const n = lines.length
  if (n < 6 || !HINT.test(lines[n - 1]) || !STATUS.test(lines[n - 2]) || HINT.test(lines[n - 2]) || lines[n - 3].trim()) return false
  let top = n - 4
  while (top >= 0 && lines[top].startsWith('  ') && lines[top].trim()) top--
  return top >= 2 && lines[top].startsWith('› ') && !lines[top - 1].trim() && !lines[top - 2].trim()
}

const exec = promisify(execFile)
const PANE = /^%\d+$/
// pid, tty, stat, lstart (as ps prints it in the C locale), then comm, last so ps doesn't cut it to 16 characters.
const PS_LINE = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/
// tmux says "no server running" for a socket nobody listens on and "error connecting to … (No such file or directory)"
// when the server never started; any other connect error (permissions, a stale non-socket) is a failure.
const NO_SERVER = /no server running|error connecting to .*\(No such file or directory\)/

export type Rollout = { path: string; meta: CodexMeta | null; mtimeMs: number }
type Run = (file: string, args: string[]) => Promise<string>

// tmux through its wrapper, so TMUX_SOCKET_NAME holds; ps and lsof in the C locale and UTC, the form checkPane compares.
async function runTool(file: string, args: string[]): Promise<string> {
  if (file === 'tmux') return (await tmux(...args)).stdout
  return (await exec(file, args, { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout
}

// `#{pane_id} #{pane_tty}` lines to a map from tty, as ps prints it, to pane id.
export function parsePanes(stdout: string): Map<string, string> {
  const panes = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const [pane, tty] = line.trim().split(' ')
    if (PANE.test(pane) && tty) panes.set(tty.replace(/^\/dev\//, ''), pane)
  }
  return panes
}

// Codex executables with a terminal; the app-server daemon has none (??), and the npm wrapper is node.
export function parseCodexPs(stdout: string): { pid: number; tty: string; stat: string; lstart: string }[] {
  return stdout.split('\n').flatMap((line) => {
    const m = PS_LINE.exec(line)
    if (!m || basename(m[5].trim()) !== 'codex' || /^(\?+|-)$/.test(m[2])) return []
    return [{ pid: Number(m[1]), tty: m[2], stat: m[3], lstart: m[4] }]
  })
}

// `lsof -Fn` output: a p<pid> line, then n<path> for its cwd.
export function parseCwds(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1))
  }
  return cwds
}

// Rollout folders (YYYY/MM/DD, local time) from the day before the TUI started through tomorrow.
export function dateFolders(start: Date, now: Date): string[] {
  const folders: string[] = []
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  for (const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1); d <= end; d.setDate(d.getDate() + 1)) {
    folders.push(`${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`)
  }
  return folders
}

// The daemon, not the TUI, holds the rollout open, so the match is by folder and time: the newest user thread
// last written since the TUI started. A resumed thread appends to an older file, so creation time doesn't count.
export function pickRollout(rollouts: Rollout[], cwd: string, start: number): Rollout | null {
  let best: Rollout | null = null
  for (const r of rollouts) {
    if (r.meta?.originator !== 'codex-tui' || r.meta.threadSource !== 'user' || r.meta.cwd !== cwd || r.mtimeMs < start) continue
    if (!best || r.mtimeMs > best.mtimeMs) best = r
  }
  return best
}

// Headers by path, with cwd resolved; a header never changes once written.
// shortcut: never pruned, fine for the few rollouts a day brings; prune to the scanned folders if that grows.
const headers = new Map<string, CodexMeta>()

export async function header(path: string): Promise<CodexMeta | null> {
  const cached = headers.get(path)
  if (cached) return cached
  const input = createReadStream(path)
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const meta = readCodexMeta(line)
      if (meta) headers.set(path, { ...meta, cwd: await realpath(meta.cwd).catch(() => meta.cwd) })
      return headers.get(path) ?? null
    }
    return null
  } catch {
    return null
  } finally {
    input.destroy()
  }
}

// Same-folder rollouts among files (relative to sessionsDir); only those written since start get their header read.
async function readRollouts(sessionsDir: string, files: string[], cwd: string, start: number): Promise<Rollout[]> {
  const rollouts: Rollout[] = []
  for (const f of files) {
    if (!basename(f).startsWith('rollout-') || !f.endsWith('.jsonl')) continue
    const path = join(sessionsDir, f)
    const st = await stat(path).catch(() => null)
    if (!st || st.mtimeMs < start) continue
    const meta = await header(path)
    if (meta?.cwd === cwd) rollouts.push({ path, meta, mtimeMs: st.mtimeMs })
  }
  return rollouts
}

// When each TUI last looked through every date folder.
const wideScans = new Map<string, number>()

async function findRollout(sessionsDir: string, cwd: string, start: number, key: string): Promise<Rollout | null> {
  const recent = await Promise.all(dateFolders(new Date(start), new Date()).map((d) =>
    readdir(join(sessionsDir, d)).then((files) => files.map((f) => join(d, f)), () => [])))
  const found = pickRollout(await readRollouts(sessionsDir, recent.flat(), cwd, start), cwd, start)
  // `codex resume` appends to the thread's file in the folder of the day it was created, however long ago.
  if (found || Date.now() - (wideScans.get(key) ?? -Infinity) < 30_000) return found
  wideScans.set(key, Date.now())
  const all = await readdir(sessionsDir, { recursive: true }).catch(() => [])
  return pickRollout(await readRollouts(sessionsDir, all, cwd, start), cwd, start)
}

// `${pid}|${procStart}` of Codex processes whose pane has shown the TUI (composer or approval) at least once,
// so `codex exec` or anything else named codex in a pane never gets a channel.
const recognised = new Set<string>()

// A restarted watcher seeds the keys of its live Codex channels, so a TUI not on a recognisable screen right then
// keeps its channel. A seed only counts while it matches a running codex in a pane; the next list drops the rest.
export function seedRecognised(keys: string[]): void {
  for (const k of keys) recognised.add(k)
}

// The last discovery failure logged: a lasting one is logged once, then again when it changes or every ten minutes.
let lastFailure = { message: '', at: 0 }

// Codex TUIs running in tmux panes. A session whose rollout doesn't exist yet (it's created at the first message)
// has transcript null and sessionId '', which is a placeholder, not a thread: '' → a real id is not a new conversation.
// Never throws: when tmux, ps or lsof fails it logs and returns prev, the previous Codex list.
export async function listCodexSessions(
  codexHome: string, prev: Session[], log: (...parts: unknown[]) => void = console.error, run: Run = runTool, platform = process.platform as string,
): Promise<Session[]> {
  const sessionsDir = join(codexHome, 'sessions')
  if (platform === 'win32' || !(await access(sessionsDir).then(() => true, () => false))) return []
  try {
    let panesOut: string
    try {
      panesOut = await run('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}'])
    } catch (e) {
      if (!NO_SERVER.test((e as Error).message)) throw e
      recognised.clear()
      return []
    }
    const panes = parsePanes(panesOut)
    const procs = parseCodexPs(await run('ps', ['-A', '-o', 'pid=,tty=,stat=,lstart=,comm=']))
    const tuis = procs.filter((p) => panes.has(p.tty))
    const live = new Set(tuis.map((p) => `${p.pid}|${p.lstart}`))
    for (const k of recognised) if (!live.has(k)) recognised.delete(k)
    for (const k of wideScans.keys()) if (!live.has(k)) wideScans.delete(k)
    if (!tuis.length) return []

    // Every codex with a terminal counts toward a shared folder, in tmux or not. A pid gone since ps fails its lookup
    // (lsof exits 1 but still prints the live ones), so a lookup error counts only when no TUI got a cwd.
    // Linux reads /proc, since lsof isn't on every install.
    let failure: unknown = null
    const cwds = platform === 'linux'
      ? new Map((await Promise.all(procs.map(async (p) => [p.pid, await readlink(`/proc/${p.pid}/cwd`).catch((e) => void (failure = e))] as const)))
        .filter((e): e is readonly [number, string] => !!e[1]))
      : parseCwds(await run('lsof', ['-a', '-p', procs.map((p) => p.pid).join(','), '-d', 'cwd', '-Fn']).catch((e) => {
        failure = e
        return e.stdout ?? ''
      }))
    if (failure && !tuis.some((p) => cwds.has(p.pid))) throw failure
    const sharing = new Map<string, number>()
    for (const cwd of cwds.values()) sharing.set(cwd, (sharing.get(cwd) ?? 0) + 1)

    const sessions: Session[] = []
    for (const p of tuis) {
      const pane = panes.get(p.tty)!
      const key = `${p.pid}|${p.lstart}`
      // A pane that vanished since list-panes reads as unknown; it drops out on the next list.
      const { state } = codexScreen(await run('tmux', ['capture-pane', '-p', '-J', '-t', pane]).catch(() => ''))
      if (state !== 'unknown') recognised.add(key)
      const cwd = cwds.get(p.pid)
      if (!recognised.has(key) || !cwd) continue
      const rollout = await findRollout(sessionsDir, cwd, Date.parse(`${p.lstart} UTC`), key)
      sessions.push({
        pid: p.pid, procStart: p.lstart, sessionId: rollout?.meta?.id ?? '', cwd, name: '', status: state, interactive: true, pane,
        transcript: rollout?.path ?? null, provider: 'codex', ambiguous: (sharing.get(cwd) ?? 0) > 1,
      })
    }
    return sessions
  } catch (e) {
    const message = (e as Error).message
    if (message !== lastFailure.message || Date.now() - lastFailure.at >= 10 * 60_000) {
      lastFailure = { message, at: Date.now() }
      log('codex discovery failed:', message)
    }
    return prev
  }
}
