import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { acquireLock, Outbox, serialQueue } from '../src/index.ts'

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

  it('refuses while another live process holds it', () => {
    const path = lockPath()
    writeFileSync(path, String(process.ppid))
    expect(acquireLock(path)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(String(process.ppid))
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
