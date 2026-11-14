import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { capture, checkPane, parseDialog, parseKeys, pasteText, sanitizePaste, sendKeys } from '../src/tmux.ts'

const screen = (name: string) => readFile(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')

describe('parseDialog', () => {
  it('reads a permission prompt, including an option whose path wraps', async () => {
    const d = parseDialog(await screen('approval_bash'))
    expect(d?.question).toBe('Do you want to proceed?')
    expect(d?.options).toEqual([
      { n: 1, label: 'Yes' },
      { n: 2, label: 'Yes, and always allow access to' },
      { n: 3, label: 'Yes, and switch to auto mode · auto mode handles these prompts for you' },
      { n: 4, label: 'No' },
    ])
    expect(d?.hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('reads a single question across the separator before "Chat about this"', async () => {
    const d = parseDialog(await screen('ask_single'))
    expect(d?.question).toBe('Pick a color')
    expect(d?.options.map((o) => o.label)).toEqual(['Red', 'Blue', 'Type something.', 'Chat about this'])
  })

  it('reads each step of a multi-question dialog with a distinct hash', async () => {
    const q1 = parseDialog(await screen('ask_two'))
    const q2 = parseDialog(await screen('ask_two_q2'))
    expect(q1?.question).toBe('Pick a size')
    expect(q1?.options.map((o) => o.label)).toEqual(['Small', 'Large', 'Type something.', 'Chat about this'])
    expect(q2?.question).toBe('Pick a drink')
    expect(q2?.options.map((o) => o.label)).toEqual(['Tea', 'Coffee', 'Type something.', 'Chat about this'])
    expect(q2?.hash).not.toBe(q1?.hash)
  })

  it('reads plan approval', async () => {
    const d = parseDialog(await screen('plan_approval'))
    expect(d?.question).toBe('Claude has written up a plan and is ready to execute. Would you like to proceed?')
    expect(d?.options.map((o) => o.label)).toEqual(['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'])
  })

  // The review screen has no footer, but a painted blank row below "2. Cancel" shows the list ended on screen.
  it('parses the review screen, which ends with a blank row instead of a footer', async () => {
    const d = parseDialog(await screen('ask_two_review'))
    expect(d?.question).toBe('Ready to submit your answers?')
    expect(d?.options).toEqual([{ n: 1, label: 'Submit answers' }, { n: 2, label: 'Cancel' }])
  })

  it('rejects the trust screen and multi-select questions', async () => {
    expect(parseDialog(await screen('trust'))).toBeNull()
    expect(parseDialog(await screen('ask_multi'))).toBeNull()
  })

  it('rejects a list cut off at the bottom, a numbering gap, and a missing cursor', async () => {
    const single = await screen('ask_single')
    const lines = single.split('\n')
    const cut = lines.slice(0, lines.findIndex((l) => l.includes('4. Chat about this')) + 1).join('\n')
    expect(parseDialog(cut)).toBeNull()
    expect(parseDialog(cut + '\n')).toBeNull() // capture-pane's final newline is not a row
    expect(parseDialog(single.replace('  2. Blue', '  5. Blue'))).toBeNull()
    expect(parseDialog(single.replace('❯ 1. Red', '  1. Red'))).toBeNull()
    expect(parseDialog(single.replace('  2. Blue', '❯ 2. Blue'))).toBeNull()
  })

  it('keeps the hash stable across redraw whitespace', async () => {
    const single = await screen('ask_single')
    const redrawn = single.replace('  2. Blue', '  2. Blue      ').replace('Pick a color', 'Pick a color   ')
    expect(parseDialog(redrawn)?.hash).toBe(parseDialog(single)?.hash)
  })

  it('hashes the whole dialog body, so a different command gets a different hash', async () => {
    const bash = await screen('approval_bash')
    const d = parseDialog(bash)
    expect(parseDialog(bash.replace('\n touch probe.txt\n', '\n rm -rf ~/important\n'))?.hash).not.toBe(d?.hash)
    expect(parseDialog(bash.replace('Create empty file probe.txt', 'Delete everything'))?.hash).not.toBe(d?.hash)
    // Transcript above the dialog's top border scrolls and redraws; it is not part of what is being approved.
    expect(parseDialog(bash.replace('⏺ Creating empty file', '⏺ Making an empty file'))?.hash).toBe(d?.hash)
    expect(parseDialog('scrolled text\n' + bash)?.hash).toBe(d?.hash)
  })

  it('hashes from the top of the screen when the dialog has no top border', async () => {
    const bash = (await screen('approval_bash')).split('\n').slice(4).join('\n')
    expect(parseDialog(bash)?.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(parseDialog(bash.replace('\n touch probe.txt\n', '\n rm -rf ~/important\n'))?.hash).not.toBe(parseDialog(bash)?.hash)
  })

  it('ignores a numbered list in the transcript above the dialog', async () => {
    const d = parseDialog('⏺ Steps:\n  1. one\n  2. two\n  3. three\nDone.\n' + (await screen('approval_bash')))
    expect(d?.options).toHaveLength(4)
  })

  it('returns null for a numbered list with no dialog', () => {
    expect(parseDialog('⏺ Steps:\n  1. one\n  2. two\nDone.')).toBeNull()
    expect(parseDialog('')).toBeNull()
  })
})

describe('parseKeys', () => {
  it('maps allowed keys case-insensitively to tmux names', () => {
    expect(parseKeys(' 2  Down up LEFT right enter Return esc Escape tab btab shift-tab Shift+Tab space bspace backspace 0 ')).toEqual([
      '2', 'Down', 'Up', 'Left', 'Right', 'Enter', 'Enter', 'Escape', 'Escape', 'Tab', 'BTab', 'BTab', 'BTab', 'Space', 'BSpace', 'BSpace', '0',
    ])
  })

  it('rejects the whole command on any unknown token, an empty list, or more than 20 keys', () => {
    expect(parseKeys('up C-c')).toBeNull()
    expect(parseKeys('12')).toBeNull()
    expect(parseKeys('enter;ls')).toBeNull()
    expect(parseKeys('   ')).toBeNull()
    expect(parseKeys(Array(21).fill('up').join(' '))).toBeNull()
    expect(parseKeys(Array(20).fill('up').join(' '))).toHaveLength(20)
  })

  it('rejects names inherited from Object.prototype', () => {
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'up Constructor']) expect(parseKeys(t)).toBeNull()
  })
})

describe('sanitizePaste', () => {
  it('normalises line endings and strips controls that could end a bracketed paste', () => {
    expect(sanitizePaste('a\r\nb\rc\nd\te')).toBe('a\nb\nc\nd\te')
    expect(sanitizePaste('x\x1b[201~rm -rf /\x1b[200~')).toBe('x[201~rm -rf /[200~')
    expect(sanitizePaste('\x00\x03\x07\x08\x0b\x0c\x7f\x80\x9b\x9fok é ❯')).toBe('ok é ❯')
  })
})

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasTmux)('tmux exec wrappers', () => {
  const socket = `ccds-test-${randomBytes(4).toString('hex')}`
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' })
  let pane = ''

  beforeAll(() => {
    process.env.TMUX_SOCKET_NAME = socket
    tmux('-f', '/dev/null', 'new-session', '-d', '-x', '80', '-y', '20', 'cat')
    pane = tmux('list-panes', '-F', '#{pane_id}').trim()
  })

  afterAll(async () => {
    // kill-server leaves the socket file behind.
    const path = tmux('display-message', '-p', '#{socket_path}').trim()
    try {
      tmux('kill-server')
    } catch {}
    await rm(path, { force: true })
    delete process.env.TMUX_SOCKET_NAME
  })

  it('pastes text, sends keys, captures the pane, and refuses an unverified pane', async () => {
    await pasteText(pane, 'a\nb')
    await sendKeys(pane, ['1'])
    let text = ''
    for (let i = 0; i < 40 && !/a\n[\s\S]*b[\s\S]*1/.test(text); i++) {
      await new Promise((r) => setTimeout(r, 50))
      text = await capture(pane)
    }
    expect(text).toMatch(/a\n[\s\S]*b[\s\S]*1/)
    expect(await checkPane(pane, 999999, 'Thu Jan  1 00:00:00 1970')).not.toBeNull()
    expect(await checkPane(pane, process.pid, 'Thu Jan  1 00:00:00 1970')).not.toBeNull()
    expect(await checkPane('%999999', process.pid, 'x')).not.toBeNull()
    expect(await checkPane('0:1.%2', process.pid, 'x')).not.toBeNull()
    await expect(sendKeys('main:0', ['1'])).rejects.toThrow()
  })

  // Each case puts a real process on a pane's tty in the state checkPane must refuse.
  it('passes only a running, foreground process on the pane\'s own tty', async () => {
    const start = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
    const open = (cmd: string) => tmux('new-window', '-d', '-P', '-F', '#{pane_id}', cmd).trim()
    const panePid = (p: string) => Number(tmux('display-message', '-p', '-t', p, '#{pane_pid}').trim())
    // set -m gives the child its own process group, like a job under an interactive shell.
    const child = async (p: string) => {
      for (let i = 0; i < 40; i++) {
        try {
          return Number(execFileSync('pgrep', ['-P', String(panePid(p))], { encoding: 'utf8' }).trim())
        } catch {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
      throw new Error(`no child in pane ${p}`)
    }

    const fg = open('sleep 300')
    const pid = panePid(fg)
    expect(await checkPane(fg, pid, start(pid))).toBeNull()
    tmux('copy-mode', '-t', fg)
    expect(await checkPane(fg, pid, start(pid))).toBe('tmux pane is in copy mode')
    tmux('send-keys', '-t', fg, '-X', 'cancel')
    expect(await checkPane(fg, process.pid, start(process.pid))).toBe('tmux pane is not running this session')

    const bgPane = open("sh -c 'set -m; sleep 300 & wait'")
    const stoppedPane = open("sh -c 'set -m; sleep 300; sleep 300'")
    const bg = await child(bgPane)
    const stopped = await child(stoppedPane)
    try {
      expect(await checkPane(bgPane, bg, start(bg))).toBe('Claude Code is not in the foreground of its terminal')
      expect(await checkPane(stoppedPane, stopped, start(stopped))).toBeNull()
      process.kill(stopped, 'SIGSTOP')
      expect(await checkPane(stoppedPane, stopped, start(stopped))).toBe('Claude Code is suspended (Ctrl-Z)')
      process.kill(stopped, 'SIGCONT')
    } finally {
      // Background jobs outlive kill-server's hangup, so end them here.
      for (const p of [bg, stopped]) process.kill(p, 'SIGKILL')
    }
  })
})
