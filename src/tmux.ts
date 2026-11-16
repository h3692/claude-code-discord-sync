import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { powershell, runAsync } from './config.ts'
import { sameStartFt, windowsStartTimes } from './sessions.ts'

// confirm: an option preview pane is shown, where a digit only moves the highlight and Enter answers.
// cursor: the option the ❯ highlight is on.
export type Dialog = { question: string; options: { n: number; label: string }[]; hash: string; cursor: number; confirm?: true }

const OPTION = /^\s*(❯\s+)?(\d+)\.\s+(.+)$/
const SEPARATOR = /^[\s─╌▔]+$/
export const BORDER = /^ *─{10,} *$/
const CHECKBOX = /^\[[ ✔xX✓]\]/
// The preview pane AskUserQuestion draws beside its options; its art follows the highlight.
const PREVIEW = /\s{2,}[┌│└├╭╰].*$/
const PANE_TOP = /\s{2,}┌─{3,}┐\s*$/
const PANE = /^%\d+$/
// What may sit between a psmux pane's process and Claude Code on Windows.
const SHELLS = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe'])
const KEYS: Record<string, string> = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape',
  tab: 'Tab', btab: 'BTab', 'shift-tab': 'BTab', 'shift+tab': 'BTab', space: 'Space', bspace: 'BSpace', backspace: 'BSpace',
}

const exec = promisify(execFile)

// Screen-scraped and acted on, so anything short of a complete, unambiguous list is null.
export function parseDialog(screen: string): Dialog | null {
  const lines = screen.replace(/\n$/, '').split('\n')
  const isBlank = (i: number) => !lines[i].trim()
  const isSeparator = (i: number) => !isBlank(i) && SEPARATOR.test(lines[i])
  const last = lines.findLastIndex((l) => OPTION.test(l))
  if (last < 0) return null
  // Options of one list share the column their number starts in; deeper lines are descriptions or wraps.
  const column = (l: string) => l.search(/\d/)
  const col = column(lines[last])
  const start = lines.findLastIndex((l, i) => i <= last && column(l) === col && OPTION.exec(l)?.[2] === '1')
  if (start < 0) return null

  // Labels are model-authored, so only the pane's top edge beside option 1 plus Claude Code's own footer prove a preview.
  const confirm = PANE_TOP.test(lines[start]) && !!lines.findLast((l) => l.trim())?.includes('n to add notes')
  const cut = (l: string) => (confirm ? l.replace(PREVIEW, '') : l)
  const options: { n: number; label: string }[] = []
  let cursors = 0
  let cursor = 0
  let i = start
  for (; i < lines.length; i++) {
    const m = OPTION.exec(lines[i])
    if (m && column(lines[i]) === col) {
      if (Number(m[2]) !== options.length + 1) return null
      if (m[1]) {
        cursors++
        cursor = Number(m[2])
      }
      options.push({ n: Number(m[2]), label: cut(m[3]).trimEnd() })
    } else if (isBlank(i) || (!isSeparator(i) && lines[i].search(/\S/) <= col)) {
      break
    }
  }
  if (i <= last) return null
  // Any row below the list (footer or painted blank) proves it isn't cut off at the bottom of the pane.
  if (i >= lines.length) return null
  if (options.length < 2 || cursors !== 1 || options.some((o) => CHECKBOX.test(o.label))) return null

  let q = start - 1
  while (q >= 0 && (isBlank(q) || isSeparator(q))) q--
  if (q < 0) return null
  const question = lines[q].trim()
  // Hash everything shown from the dialog's top border down, so a different command gets a different hash.
  // The highest border, not the nearest: plan approval draws one between the plan and the options.
  const top = lines.findIndex((l) => BORDER.test(l))
  const first = top < start ? top + 1 : 0
  // The pane is cut only beside the options, so box art in a command above them still changes the hash.
  const rows = lines.slice(start, last + 1).map(cut)
  const hash = hashBody([...lines.slice(first, start), ...rows])
  return confirm ? { question, options, hash, cursor, confirm: true } : { question, options, hash, cursor }
}

// Identifies a prompt that parseDialog can't read: the dialog region below the highest border, or the last 25 non-blank lines.
export function screenHash(screen: string): string {
  const lines = screen.replace(/\n$/, '').split('\n')
  const top = lines.findIndex((l) => BORDER.test(l))
  return hashBody(top < 0 ? lines.filter((l) => l.trim()).slice(-25) : lines.slice(top + 1))
}

// The ❯ cursor is dropped so arrow-key navigation doesn't look like a new prompt.
export function hashBody(lines: string[]): string {
  const body = lines.map((l) => l.trim().replace(/^❯\s*/, '')).filter(Boolean).join('\n')
  return createHash('sha256').update(body).digest('hex').slice(0, 12)
}

export function parseKeys(args: string): string[] | null {
  const tokens = args.split(/\s+/).filter(Boolean)
  if (!tokens.length || tokens.length > 20) return null
  const keys = tokens.map((t) => (/^\d$/.test(t) ? t : Object.hasOwn(KEYS, t.toLowerCase()) ? KEYS[t.toLowerCase()] : undefined))
  return keys.every((k): k is string => k !== undefined) ? keys : null
}

// Strips ESC and other controls so pasted text cannot end the bracketed paste and inject keys.
export function sanitizePaste(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export function tmux(...args: string[]): Promise<{ stdout: string }> {
  const socket = process.env.TMUX_SOCKET_NAME
  return exec('tmux', socket ? ['-L', socket, ...args] : args)
}

function assertPane(pane: string): void {
  if (!PANE.test(pane)) throw new Error(`invalid tmux pane id: ${pane}`)
}

export async function capture(pane: string): Promise<string> {
  assertPane(pane)
  return (await tmux('capture-pane', '-p', '-J', '-t', pane)).stdout
}

// tmux prints /dev/ttys003 or /dev/pts/3 where ps prints ttys003 or pts/3.
export function sameTty(paneTty: string, tty: string): boolean {
  return paneTty.replace(/^\/dev\//, '') === tty
}

// From `display-message -p '#{pane_pid} #{pane_in_mode} #{pane_current_command}'`; psmux may leave fields empty.
export function checkPaneInfo(stdout: string): { panePid: number } | { refuse: string } {
  const m = /^([1-9]\d{0,9}) ([01]) (\S+)$/.exec(stdout.trim())
  if (!m) return { refuse: `tmux pane not found or not described: ${JSON.stringify(stdout.trim().slice(0, 60))}` }
  if (m[2] !== '0') return { refuse: 'tmux pane is in copy mode' }
  if (!/^claude(\.exe)?$/i.test(m[3])) return { refuse: `tmux pane is running ${m[3]}, not Claude Code` }
  return { panePid: Number(m[1]) }
}

// Claude's process and its parents, one "pid ppid FILETIME name" line each, up to the pane's pid or 8 levels.
// Any error stops the script, so a failed lookup refuses instead of leaving a gap.
export function ancestry(pid: number, panePid: number): Promise<string> {
  return runAsync(powershell(`$ErrorActionPreference = 'Stop'; $id = ${pid}; for ($i = 0; $i -lt 8 -and $id; $i++) { ` +
    `$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $p) { break }; ` +
    `'{0} {1} {2} {3}' -f $p.ProcessId, $p.ParentProcessId, $p.CreationDate.ToFileTimeUtc(), $p.Name; ` +
    `if ($p.ProcessId -eq ${panePid}) { break }; $id = $p.ParentProcessId }`))
}

// Windows has no pane tty to compare, so the pane's process must be Claude or an ancestor reached only through shells.
export function ancestryRefusal(text: string, pid: number, panePid: number): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => /^(\d+) (\d+) (\d+) (.+)$/.exec(l))
  if (!lines.length || lines.some((m) => !m)) return 'could not read the processes above Claude Code'
  const chain = lines.map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), created: BigInt(m![3]), name: m![4].toLowerCase() }))
  if (chain[0].pid !== pid) return 'could not read the processes above Claude Code'
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].pid !== chain[i - 1].ppid) return 'could not read the processes above Claude Code'
    // A parent's pid can be reused once it exits; the newcomer started after the child did.
    if (chain[i].created > chain[i - 1].created) return 'a parent process started after its child (pid reused?)'
  }
  const top = chain.findIndex((p) => p.pid === panePid)
  if (top < 0) return 'tmux pane is not running this session'
  const other = chain.slice(1, top).find((p) => !SHELLS.has(p.name))
  return other ? `${other.name} runs between the tmux pane and Claude Code` : null
}

// Confirms the pane still belongs to the registered Claude process before we type into it.
export async function checkPane(
  pane: string, pid: number, procStart: string, platform = process.platform as string, env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  // psmux's pane variables and paste are unverified, so typing there is opt-in until a Windows smoke test passes.
  if (platform === 'win32' && env.CCDS_WINDOWS_TYPING !== '1') return 'typing on Windows is experimental; set CCDS_WINDOWS_TYPING=1 to try it'
  if (!PANE.test(pane)) return 'invalid tmux pane id'
  // pid 0 or negative would signal a whole process group.
  if (!Number.isInteger(pid) || pid <= 0) return 'invalid pid'
  try {
    process.kill(pid, 0)
  } catch {
    return 'process is not running'
  }
  try {
    // No job control on Windows, so no foreground or suspend check; any empty output or PowerShell failure refuses.
    if (platform === 'win32') {
      if (!sameStartFt(procStart, (await windowsStartTimes([pid])).get(pid) ?? '')) return 'process start time does not match (pid reused?)'
      const info = checkPaneInfo((await tmux('display-message', '-p', '-t', pane, '#{pane_pid} #{pane_in_mode} #{pane_current_command}')).stdout)
      if ('refuse' in info) return info.refuse
      return ancestryRefusal(await ancestry(pid, info.panePid), pid, info.panePid)
    }
    // Claude records procStart as ps prints it in the C locale and UTC.
    const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    const start = (await exec('ps', ['-o', 'lstart=', '-p', String(pid)], { env })).stdout
    const squash = (s: string) => s.trim().replace(/\s+/g, ' ')
    if (squash(start) !== squash(procStart)) return 'process start time does not match (pid reused?)'
    const [tty, stat] = (await exec('ps', ['-o', 'tty=,stat=', '-p', String(pid)], { env })).stdout.trim().split(/\s+/)
    // display-message prints nothing (and exits 0) for a pane that no longer exists.
    const [paneTty, inMode] = (await tmux('display-message', '-p', '-t', pane, '#{pane_tty} #{pane_in_mode}')).stdout.trim().split(' ')
    if (!paneTty) return 'tmux pane not found'
    if (!sameTty(paneTty, tty)) return 'tmux pane is not running this session'
    // A stopped or background Claude would leave the paste to whatever owns the terminal, usually the shell.
    if (stat.includes('T')) return 'Claude Code is suspended (Ctrl-Z)'
    if (!stat.includes('+')) return 'Claude Code is not in the foreground of its terminal'
    if (inMode !== '0') return 'tmux pane is in copy mode'
    return null
  } catch (e) {
    // tmux and PowerShell append their stderr on further lines.
    return `pane check failed: ${(e as Error).message.split(/\r?\n/)[0]}`
  }
}

// enter: false leaves the text in the input, for a caller that checks the screen before submitting it.
export async function pasteText(pane: string, text: string, platform = process.platform as string, enter = true): Promise<void> {
  assertPane(pane)
  const name = `ccds-${randomBytes(6).toString('hex')}`
  if (platform === 'win32') {
    const clean = sanitizePaste(text)
    // Bracketed paste under psmux is unconfirmed: without it each line is entered on its own, and a `!` line runs in the shell.
    if (clean.includes('\n')) throw new Error("multi-line text can't be typed on Windows yet; send one line at a time")
    // psmux's load-buffer reads a file, not stdin; wx in a fresh private folder, so no other file can stand in for it.
    const dir = await mkdtemp(join(tmpdir(), 'ccds-'))
    try {
      const file = join(dir, 'paste.txt')
      await writeFile(file, clean, { flag: 'wx' })
      await tmux('load-buffer', '-b', name, file)
      await tmux('paste-buffer', '-p', '-d', '-b', name, '-t', pane)
      if (enter) await tmux('send-keys', '-t', pane, 'Enter')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    return
  }
  const socket = process.env.TMUX_SOCKET_NAME
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tmux', [...(socket ? ['-L', socket] : []), 'load-buffer', '-b', name, '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tmux load-buffer exited with ${code}`))))
    child.stdin.end(sanitizePaste(text))
  })
  await tmux('paste-buffer', '-p', '-d', '-b', name, '-t', pane)
  if (enter) await tmux('send-keys', '-t', pane, 'Enter')
}

export async function sendKeys(pane: string, keys: string[]): Promise<void> {
  assertPane(pane)
  for (const key of keys) {
    await (/^\d$/.test(key) ? tmux('send-keys', '-t', pane, '-l', key) : tmux('send-keys', '-t', pane, key))
  }
}
