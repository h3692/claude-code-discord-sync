import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { promisify } from 'node:util'

export type Dialog = { question: string; options: { n: number; label: string }[]; hash: string }

const OPTION = /^\s*(❯\s+)?(\d+)\.\s+(.+)$/
const SEPARATOR = /^[\s─╌▔]+$/
export const BORDER = /^ *─{10,} *$/
const CHECKBOX = /^\[[ ✔xX✓]\]/
const PANE = /^%\d+$/
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

  const options: { n: number; label: string }[] = []
  let cursors = 0
  let i = start
  for (; i < lines.length; i++) {
    const m = OPTION.exec(lines[i])
    if (m && column(lines[i]) === col) {
      if (Number(m[2]) !== options.length + 1) return null
      if (m[1]) cursors++
      options.push({ n: Number(m[2]), label: m[3].trimEnd() })
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
  return { question, options, hash: hashBody(lines.slice(top < start ? top + 1 : 0, last + 1)) }
}

// Identifies a prompt that parseDialog can't read: the dialog region below the highest border, or the last 25 non-blank lines.
export function screenHash(screen: string): string {
  const lines = screen.replace(/\n$/, '').split('\n')
  const top = lines.findIndex((l) => BORDER.test(l))
  return hashBody(top < 0 ? lines.filter((l) => l.trim()).slice(-25) : lines.slice(top + 1))
}

// The ❯ cursor is dropped so arrow-key navigation doesn't look like a new prompt.
function hashBody(lines: string[]): string {
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

function tmux(...args: string[]): Promise<{ stdout: string }> {
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

// Confirms the pane still belongs to the registered Claude process before we type into it.
export async function checkPane(pane: string, pid: number, procStart: string): Promise<string | null> {
  if (!PANE.test(pane)) return 'invalid tmux pane id'
  // pid 0 or negative would signal a whole process group.
  if (!Number.isInteger(pid) || pid <= 0) return 'invalid pid'
  try {
    process.kill(pid, 0)
  } catch {
    return 'process is not running'
  }
  try {
    // Claude records procStart as ps prints it in the C locale and UTC.
    const env = { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    const start = (await exec('ps', ['-o', 'lstart=', '-p', String(pid)], { env })).stdout
    const squash = (s: string) => s.trim().replace(/\s+/g, ' ')
    if (squash(start) !== squash(procStart)) return 'process start time does not match (pid reused?)'
    const [tty, stat] = (await exec('ps', ['-o', 'tty=,stat=', '-p', String(pid)], { env })).stdout.trim().split(/\s+/)
    // display-message prints nothing (and exits 0) for a pane that no longer exists.
    const [paneTty, inMode] = (await tmux('display-message', '-p', '-t', pane, '#{pane_tty} #{pane_in_mode}')).stdout.trim().split(' ')
    if (!paneTty) return 'tmux pane not found'
    if (basename(paneTty) !== tty) return 'tmux pane is not running this session'
    // A stopped or background Claude would leave the paste to whatever owns the terminal, usually the shell.
    if (stat.includes('T')) return 'Claude Code is suspended (Ctrl-Z)'
    if (!stat.includes('+')) return 'Claude Code is not in the foreground of its terminal'
    if (inMode !== '0') return 'tmux pane is in copy mode'
    return null
  } catch (e) {
    return `pane check failed: ${(e as Error).message}`
  }
}

export async function pasteText(pane: string, text: string): Promise<void> {
  assertPane(pane)
  const name = `ccds-${randomBytes(6).toString('hex')}`
  const socket = process.env.TMUX_SOCKET_NAME
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tmux', [...(socket ? ['-L', socket] : []), 'load-buffer', '-b', name, '-'], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tmux load-buffer exited with ${code}`))))
    child.stdin.end(sanitizePaste(text))
  })
  await tmux('paste-buffer', '-p', '-d', '-b', name, '-t', pane)
  await tmux('send-keys', '-t', pane, 'Enter')
}

export async function sendKeys(pane: string, keys: string[]): Promise<void> {
  assertPane(pane)
  for (const key of keys) {
    await (/^\d$/.test(key) ? tmux('send-keys', '-t', pane, '-l', key) : tmux('send-keys', '-t', pane, key))
  }
}
