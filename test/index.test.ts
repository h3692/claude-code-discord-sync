import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { acquireLock, freshEvents, missCount, Outbox, serialQueue, startOffset, typingRefusal, unanswer } from '../src/index.ts'
import { newMirror } from '../src/mirror.ts'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'ccds-lock-')), 'lock')
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => vi.restoreAllMocks())

describe('acquireLock', () => {
  let deadPid: number
  beforeAll(async () => {
    const child = spawn('true')
    await new Promise((resolve) => child.on('exit', resolve))
    deadPid = child.pid!
  })

  it('takes a free lock and writes our pid', () => {
    const path = lockPath()
    expect(acquireLock(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
  })

  it('refuses while another live watcher holds it', async () => {
    // The command line carries the src/index.ts marker, like a real watcher.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)', 'src/index.ts'])
    await once(child, 'spawn')
    try {
      const path = lockPath()
      writeFileSync(path, String(child.pid))
      expect(acquireLock(path)).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(String(child.pid))
    } finally {
      child.kill()
    }
  })

  it('takes over a lock whose pid was reused by an unrelated live process', () => {
    for (const pid of [1, process.ppid]) {
      const path = lockPath()
      writeFileSync(path, String(pid))
      expect(acquireLock(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
    }
  })

  it('takes over a lock left by a dead process', () => {
    const path = lockPath()
    writeFileSync(path, String(deadPid))
    expect(acquireLock(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(String(process.pid))
  })

  it('takes over a lock file with no valid pid (never signals pid 0)', () => {
    for (const body of ['', '0', 'junk', '-1']) {
      const path = lockPath()
      writeFileSync(path, body)
      expect(acquireLock(path)).toBe(true)
    }
  })
})

describe('Outbox', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {})

  it('holds edits until the send resolved, then applies them to the sent message', async () => {
    const box = new Outbox<string>()
    const sent = deferred<string>()
    const calls: string[] = []
    box.send('r1', () => sent.promise)
    box.edit('r1', 'a', async (m, p) => void calls.push(`${m}:${p}`))
    await tick()
    expect(calls).toEqual([])
    sent.resolve('msg1')
    await tick()
    expect(calls).toEqual(['msg1:a'])
  })

  it('runs one edit per ref at a time and keeps only the latest pending one', async () => {
    const box = new Outbox<string>()
    box.send('r1', async () => 'm')
    const first = deferred<void>()
    const calls: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const fn = async (_m: string, p: string) => {
      calls.push(p)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (p === 'a') await first.promise
      inFlight--
    }
    box.edit('r1', 'a', fn)
    await tick()
    box.edit('r1', 'b', fn)
    box.edit('r1', 'c', fn)
    box.edit('r1', 'd', fn)
    await tick()
    expect(calls).toEqual(['a'])
    first.resolve()
    await tick()
    expect(calls).toEqual(['a', 'd'])
    expect(maxInFlight).toBe(1)
  })

  it('keeps refs independent', async () => {
    const box = new Outbox<string>()
    const slow = deferred<string>()
    const calls: string[] = []
    box.send('r1', () => slow.promise)
    box.send('r2', async () => 'm2')
    box.edit('r1', 'x', async (m, p) => void calls.push(`${m}:${p}`))
    box.edit('r2', 'y', async (m, p) => void calls.push(`${m}:${p}`))
    await tick()
    expect(calls).toEqual(['m2:y'])
  })

  it('drops edits for a ref whose send failed, and never throws', async () => {
    const log = quiet()
    const box = new Outbox<string>()
    const fn = vi.fn(async () => {})
    await expect(box.send('r1', async () => { throw new Error('send boom') })).resolves.toBeUndefined()
    box.edit('r1', 'a', fn)
    box.edit('nope', 'b', fn)
    await tick()
    expect(fn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })

  it('logs a failed edit and still applies the next one', async () => {
    const log = quiet()
    const box = new Outbox<string>()
    box.send('r1', async () => 'm')
    const calls: string[] = []
    const gate = deferred<void>()
    box.edit('r1', 'a', async (_m, p) => {
      calls.push(p)
      await gate.promise
      throw new Error('edit boom')
    })
    await tick()
    box.edit('r1', 'b', async (_m, p) => void calls.push(p))
    gate.resolve()
    await tick()
    expect(calls).toEqual(['a', 'b'])
    expect(log).toHaveBeenCalled()
  })
})

describe('serialQueue', () => {
  it('runs tasks for one key strictly in order, and other keys concurrently', async () => {
    const run = serialQueue()
    const order: string[] = []
    const a1 = deferred<void>()
    run('a', async () => {
      order.push('a1 start')
      await a1.promise
      order.push('a1 end')
    })
    run('a', async () => void order.push('a2'))
    run('b', async () => void order.push('b1'))
    await tick()
    expect(order).toEqual(['a1 start', 'b1'])
    a1.resolve()
    await tick()
    expect(order).toEqual(['a1 start', 'b1', 'a1 end', 'a2'])
  })

  it('keeps going after a task throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = serialQueue()
    const order: string[] = []
    run('a', async () => { throw new Error('boom') })
    await run('a', async () => void order.push('after'))
    expect(order).toEqual(['after'])
  })
})

describe('startOffset', () => {
  const now = 1_000_000
  it('reads a transcript born in the last 15 seconds from the start', () => {
    expect(startOffset(now - 15_000, 500, now)).toBe(0)
    expect(startOffset(now, 500, now)).toBe(0)
  })

  it('skips the history of an older transcript (resume, -c)', () => {
    expect(startOffset(now - 15_001, 500, now)).toBe(500)
  })
})

describe('typingRefusal', () => {
  const paste = { type: 'paste', text: 'hi', replyTo: 'm1' } as const
  const typed = { type: 'paste', text: 'hi', replyTo: 'm1', allowWaiting: true } as const
  const button = { type: 'keys', keys: ['1'], hash: 'abc' } as const
  const keys = { type: 'keys', keys: ['Down'], replyTo: 'm1' } as const

  it('refuses anything once the session is gone', () => {
    for (const a of [paste, typed, button, keys]) expect(typingRefusal(a, null, 'abc')).toMatch(/gone/)
  })

  it('refuses a plain message when a prompt opened, but lets !type through', () => {
    expect(typingRefusal(paste, 'waiting', null)).toMatch(/prompt opened/)
    expect(typingRefusal(paste, 'busy', null)).toBeNull()
    expect(typingRefusal(paste, 'idle', null)).toBeNull()
    expect(typingRefusal(typed, 'waiting', null)).toBeNull()
  })

  it('sends a button only while the same prompt is still open', () => {
    expect(typingRefusal(button, 'waiting', 'abc')).toBeNull()
    expect(typingRefusal(button, 'waiting', 'def')).toMatch(/prompt changed/)
    expect(typingRefusal(button, 'waiting', null)).toMatch(/prompt changed/)
    expect(typingRefusal(button, 'idle', 'abc')).toMatch(/prompt changed/)
  })

  it('lets !keys through in any live status', () => {
    expect(typingRefusal(keys, 'waiting', null)).toBeNull()
    expect(typingRefusal(keys, 'idle', null)).toBeNull()
  })
})

describe('freshEvents', () => {
  const seenAt = Date.parse('2026-11-14T12:00:00Z')
  const prompt = (timestamp?: string) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'hi' }, timestamp })

  it('drops lines written more than 5s before the session id was first seen (resumed history)', () => {
    expect(freshEvents([prompt('2026-11-10T09:00:00Z'), prompt('2026-11-14T11:59:54Z')], seenAt)).toEqual([])
  })

  it('keeps lines from the last 5s before first sight onwards, and lines without a timestamp', () => {
    const lines = [prompt('2026-11-14T11:59:56Z'), prompt('2026-11-14T12:00:01Z'), prompt()]
    expect(freshEvents(lines, seenAt)).toHaveLength(3)
  })
})

describe('missCount', () => {
  it('ends a session only after two polls in a row without its registry entry', () => {
    const first = missCount(0, false)
    expect(first).toEqual({ misses: 1, ended: false })
    expect(missCount(first.misses, false)).toEqual({ misses: 2, ended: true })
  })

  it('resets once the session is seen again', () => {
    expect(missCount(1, true)).toEqual({ misses: 0, ended: false })
    expect(missCount(missCount(1, true).misses, false)).toEqual({ misses: 1, ended: false })
  })
})

describe('unanswer', () => {
  const dialog = { question: 'Proceed?', options: [{ n: 1, label: 'Yes' }], hash: 'abc' }
  const withCard = (hash: string, answered: string | null) => ({
    ...newMirror({ pid: 42, procStart: 'x', sessionId: 's1', cwd: '/p', name: 'n', pane: '%1', status: 'waiting' }, 'u1').state,
    card: { ref: 'r7', hash, screenHash: 'sh', dialog: hash === 'abc' ? dialog : null, answered, repeats: 0 },
  })
  const button = { type: 'keys', keys: ['1'], hash: 'abc' } as const
  const keys = { type: 'keys', keys: ['Enter'], replyTo: 'm1' } as const

  it('resets the card of a refused button and edits its message out of Sending', () => {
    const { state, edit } = unanswer(withCard('abc', 'Yes'), button, 'the prompt changed')
    expect(state.card).toBeNull()
    expect(edit).toEqual({
      type: 'edit', ref: 'r7', content: '⚠️ Not sent — the prompt changed', embed: { title: '⚠️ Not sent', description: 'Proceed?' }, buttons: [],
    })
  })

  it('leaves a newer card alone when a refused button was for an older prompt', () => {
    const s = withCard('def', null)
    expect(unanswer(s, button, 'x')).toEqual({ state: s, edit: null })
  })

  it('un-marks an open card answered by a refused !keys, without editing it', () => {
    const { state, edit } = unanswer(withCard('abc', '`!keys Enter`'), keys, 'the session is gone')
    expect(state.card).toMatchObject({ ref: 'r7', hash: 'abc', answered: null })
    expect(edit).toBeNull()
  })

  it('does nothing without an open card', () => {
    const s = { ...withCard('abc', null), card: null }
    expect(unanswer(s, keys, 'x')).toEqual({ state: s, edit: null })
    expect(unanswer(s, button, 'x')).toEqual({ state: s, edit: null })
  })
})
