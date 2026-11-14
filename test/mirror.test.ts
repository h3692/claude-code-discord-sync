import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dropEcho, endedTopic, isDue, newMirror, parseTopic, pickArchiveCategory, step, topicFor,
} from '../src/mirror.ts'
import type { Action, State } from '../src/mirror.ts'
import type { TranscriptEvent } from '../src/transcript.ts'
import { renderActivity, renderAgents, renderCard, renderDone, renderPrompt, renderText } from '../src/render.ts'
import { parseDialog } from '../src/tmux.ts'

const cwd = '/Users/me/proj'
const procStart = 'Thu Nov  3 10:00:01 2026'
const start = () => newMirror({ pid: 42, procStart, sessionId: 's1', cwd, name: 'fix login', pane: '%1', status: 'idle' }, 'u1')
const events = (state: State, ...evs: TranscriptEvent[]) => step(state, { kind: 'events', events: evs })
const tool = (id: string): TranscriptEvent => ({ kind: 'tool_start', id, name: 'Read', input: { file_path: `${cwd}/${id}.ts` } })
const agent = (id: string): TranscriptEvent => ({ kind: 'agent_start', id, agentType: 'Explore', description: `look ${id}` })
const sends = (actions: Action[]) => actions.filter((a) => a.type === 'send')
const edits = (actions: Action[]) => actions.filter((a) => a.type === 'edit')

describe('newMirror', () => {
  it('creates a channel named after folder and session, with the process in its topic', () => {
    const { state, actions } = start()
    expect(actions).toEqual([{ type: 'create_channel', name: 'proj-fix-login', topic: `ccds|42|${procStart}` }])
    expect(state).toMatchObject({ key: `42|${procStart}`, sessionId: 's1', folder: 'proj', cwd, userId: 'u1', pane: '%1', status: 'idle', titled: false })
  })

  it('does not repeat the folder when the session name already starts with it', () => {
    const make = (name: string) => newMirror({ pid: 42, procStart, sessionId: 's1', cwd, name, pane: '%1', status: 'idle' }, 'u1')
    expect(make('proj-30').state.channel).toBe('proj-30')
    expect(make('Proj 30').actions[0]).toMatchObject({ name: 'proj-30' })
    expect(make('project-30').state.channel).toBe('proj-project-30')
  })

  it('restores the archive flag on reattach', () => {
    const { state, actions } = newMirror({ pid: 42, procStart, sessionId: 's1', cwd, name: 'x', pane: '%1', status: 'idle', archiveOnEnd: true }, 'u1')
    expect(state.archiveOnEnd).toBe(true)
    expect(actions[0]).toMatchObject({ topic: `ccds|42|${procStart}|archive` })
    expect(start().state.archiveOnEnd).toBe(false)
  })
})

describe('step: messages from the terminal', () => {
  it('posts assistant text as renderText chunks', () => {
    const text = 'x'.repeat(3000)
    const { actions } = events(start().state, { kind: 'text', text })
    expect(actions.map((a) => a.type === 'send' && a.content)).toEqual(renderText(text))
    expect(new Set(actions.map((a) => a.type === 'send' && a.ref)).size).toBe(actions.length)
  })

  it('posts a typed prompt as renderPrompt chunks', () => {
    const { actions } = events(start().state, { kind: 'prompt', text: 'hello' })
    expect(actions.map((a) => a.type === 'send' && a.content)).toEqual(renderPrompt('hello'))
  })

  it('skips the echo of a message pasted from Discord once, then posts the same text when typed again', () => {
    const s0 = { ...start().state, pendingEcho: ['other', 'hi there'] }
    const first = events(s0, { kind: 'prompt', text: '  hi there\r\n' })
    expect(first.actions).toEqual([])
    expect(first.state.pendingEcho).toEqual(['other'])
    const second = events(first.state, { kind: 'prompt', text: 'hi there' })
    expect(sends(second.actions)).toHaveLength(1)
  })

  it('drops a refused paste from the pending echoes, so a later identical prompt still posts', () => {
    const s0 = { ...start().state, pendingEcho: ['a', 'hi', 'hi'] }
    const s1 = dropEcho(s0, ' hi\r\n')
    expect(s1.pendingEcho).toEqual(['a', 'hi'])
    expect(s0.pendingEcho).toEqual(['a', 'hi', 'hi'])
    expect(dropEcho(s1, 'nope').pendingEcho).toEqual(['a', 'hi'])
  })
})

describe('step: tool activity', () => {
  it('sends one activity message for a stretch of tools, then edits it as they progress', () => {
    const a = events(start().state, tool('t1'), tool('t2'))
    expect(sends(a.actions)).toHaveLength(1)
    expect(edits(a.actions)).toHaveLength(1)
    const ref = (a.actions[0] as { ref: string }).ref
    expect(a.actions[1]).toMatchObject({ type: 'edit', ref })

    const b = events(a.state, { kind: 'tool_end', id: 't1', ok: true })
    expect(b.actions).toHaveLength(1)
    expect(b.actions[0]).toMatchObject({ type: 'edit', ref, content: renderActivity(b.state.tools, cwd)[0] })
    expect(b.state.tools[0].state).toBe('ok')

    // Nothing visible changes, so nothing is edited.
    expect(events(b.state, { kind: 'tool_end', id: 't1', ok: true }).actions).toEqual([])
    expect(events(b.state, { kind: 'tool_end', id: 'nope', ok: true }).actions).toEqual([])
    expect(events(b.state, { kind: 'tool_end', id: 't2', ok: false }).state.tools[1].state).toBe('error')
  })

  it('opens a second activity message after 15 tools, leaving the first untouched', () => {
    const ids = Array.from({ length: 15 }, (_, i) => tool(`t${i}`))
    const a = events(start().state, ...ids)
    const b = events(a.state, tool('t15'))
    expect(b.actions).toHaveLength(1)
    expect(b.actions[0]).toMatchObject({ type: 'send', content: renderActivity(b.state.tools, cwd)[1] })
    expect(b.state.activityRefs).toHaveLength(2)
  })

  it('starts a new activity message after text', () => {
    const a = events(start().state, tool('t1'))
    const firstRef = a.state.activityRefs[0]
    const b = events(a.state, { kind: 'text', text: 'thinking' }, tool('t2'))
    expect(sends(b.actions)).toHaveLength(2)
    expect(b.state.tools.map((t) => t.id)).toEqual(['t2'])
    expect(b.state.activityRefs).toHaveLength(1)
    expect(b.state.activityRefs[0]).not.toBe(firstRef)
  })
})

describe('step: subagents', () => {
  it('shows parallel agents in one panel and edits it as they finish', () => {
    const a = events(start().state, agent('a1'), agent('a2'))
    expect(sends(a.actions)).toHaveLength(1)
    expect(edits(a.actions)).toHaveLength(1)
    expect(a.state.agents).toHaveLength(2)
    const ref = a.state.agentsRef
    const b = events(a.state, { kind: 'agent_end', id: 'a1', status: 'completed', durationMs: 5000 })
    expect(b.actions).toEqual([{ type: 'edit', ref, content: renderAgents(b.state.agents) }])
    expect(b.state.agents[0]).toMatchObject({ state: 'completed', durationMs: 5000 })
  })

  it('marks a foreground agent finished from its tool result', () => {
    const a = events(start().state, agent('a1'))
    const b = events(a.state, { kind: 'tool_end', id: 'a1', ok: false })
    expect(b.state.agents[0].state).toBe('failed')
    expect(b.actions).toEqual([{ type: 'edit', ref: a.state.agentsRef, content: renderAgents(b.state.agents) }])
    expect(b.state.tools).toEqual([])
  })

  it('opens a new panel for an agent started after all earlier ones finished', () => {
    const a = events(start().state, agent('a1'), { kind: 'agent_end', id: 'a1', status: 'completed' })
    const b = events(a.state, agent('a2'))
    expect(b.actions).toHaveLength(1)
    expect(b.actions[0]).toMatchObject({ type: 'send' })
    expect(b.state.agentsRef).not.toBe(a.state.agentsRef)
    expect(b.state.agents.map((x) => x.id)).toEqual(['a2'])
  })

  it('ignores the end of something that was never an agent', () => {
    const a = events(start().state, agent('a1'))
    const b = events(a.state, { kind: 'agent_end', id: 'bash-bg', status: 'completed' })
    expect(b.actions).toEqual([])
    expect(b.state.agents[0].state).toBe('running')
  })
})

describe('step: turn end', () => {
  it('pings the user, marks leftover agents done when none are pending, and closes the stretch', () => {
    const a = events(start().state, agent('a1'), tool('t1'))
    const b = events(a.state, { kind: 'turn_end', durationMs: 65000, pendingAgents: 0 })
    expect(b.state.agents[0].state).toBe('completed')
    expect(b.actions).toEqual([
      { type: 'edit', ref: a.state.agentsRef, content: renderAgents(b.state.agents) },
      expect.objectContaining({ type: 'send', content: renderDone(65000, 0, 'u1'), ping: true }),
    ])
    expect(b.state.tools).toEqual([])
    expect(b.state.activityRefs).toEqual([])
  })

  it('leaves agents running while background agents are pending', () => {
    const a = events(start().state, agent('a1'))
    const b = events(a.state, { kind: 'turn_end', durationMs: 1000, pendingAgents: 1 })
    expect(b.state.agents[0].state).toBe('running')
    expect(b.actions).toEqual([expect.objectContaining({ type: 'send', content: renderDone(1000, 1, 'u1'), ping: true })])
  })
})

describe('step: title', () => {
  it('renames the channel once, on the first title', () => {
    const a = events(start().state, { kind: 'title', title: 'Fix the login bug' })
    expect(a.actions).toEqual([{ type: 'rename_channel', name: 'proj-fix-the-login-bug' }])
    expect(events(a.state, { kind: 'title', title: 'Something else' }).actions).toEqual([])
  })

  it('does not rename when the title gives the same name', () => {
    const a = events(start().state, { kind: 'title', title: 'Fix login' })
    expect(a.actions).toEqual([])
    expect(a.state.titled).toBe(true)
  })
})

describe('step: session changes', () => {
  it('posts a divider and starts fresh on a new conversation', () => {
    const a = events(start().state, tool('t1'), agent('a1'))
    const b = step(a.state, { kind: 'session_changed', sessionId: 's2' })
    expect(b.actions).toEqual([expect.objectContaining({ type: 'send', content: '-# ── new conversation ──' })])
    expect(b.state).toMatchObject({ sessionId: 's2', tools: [], activityRefs: [], agents: [], agentsRef: null, card: null })
    expect(sends(events(b.state, tool('t2')).actions)).toHaveLength(1)
  })

  it('closes an open card before the divider', () => {
    const s0 = { ...start().state, card: { ref: 'c1', hash: 'h', dialog: null, answered: null } }
    const b = step(s0, { kind: 'session_changed', sessionId: 's2' })
    expect(b.actions[0]).toEqual({
      type: 'edit', ref: 'c1', content: '-# 🔄 session restarted', embed: { title: '🔄 Session restarted', description: 'prompt' }, buttons: [],
    })
    expect(b.actions[1]).toMatchObject({ type: 'send', content: '-# ── new conversation ──' })
  })

  it('ends the channel, archiving it when asked', () => {
    expect(step(start().state, { kind: 'ended' }).actions).toEqual([{ type: 'end_channel', archive: false }])
    const s0 = { ...start().state, archiveOnEnd: true, card: { ref: 'c1', hash: null, dialog: null, answered: null } }
    expect(step(s0, { kind: 'ended' }).actions).toEqual([
      { type: 'edit', ref: 'c1', content: '-# 🔚 session ended', embed: { title: '🔚 Session ended', description: 'prompt' }, buttons: [] },
      { type: 'end_channel', archive: true },
    ])
  })

  it('never changes the state it was given', () => {
    const s0 = start().state
    const snapshot = structuredClone(s0)
    let s = s0
    for (const input of [
      { kind: 'events', events: [tool('t1'), agent('a1'), { kind: 'tool_end', id: 't1', ok: true }] },
      { kind: 'events', events: [{ kind: 'agent_end', id: 'a1', status: 'failed' }, { kind: 'title', title: 'New name' }] },
      { kind: 'events', events: [{ kind: 'turn_end', durationMs: 1, pendingAgents: 0 }] },
      { kind: 'session_changed', sessionId: 's2' },
    ] as const) {
      const before = structuredClone(s)
      const next = step(s, input as never).state
      expect(s).toEqual(before)
      s = next
    }
    expect(s0).toEqual(snapshot)
  })
})

const screen = (name: string) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')
const waiting = (state: State, name: string | null) => step(state, { kind: 'status', status: 'waiting', screen: name && screen(name) })
const click = (state: State, n: number, name: string | null, status = 'waiting', hash = name ? parseDialog(screen(name))!.hash : 'x') =>
  step(state, { kind: 'button', id: 'i1', n, hash, status, screen: name && screen(name) })
const HINT = "\n-# Can't read the options reliably — reply with `!keys 2`, `!keys Down Enter` or `!type your answer`"

describe('step: prompt cards', () => {
  it('pings with the screen and one button per option', () => {
    const { state, actions } = waiting(start().state, 'approval_bash')
    const d = parseDialog(screen('approval_bash'))!
    expect(actions).toEqual([{
      type: 'send', ref: state.card!.ref, content: '<@u1>', ping: true, embed: renderCard(screen('approval_bash')),
      buttons: [
        { id: `ccds:1:${d.hash}`, label: '1. Yes' },
        { id: `ccds:2:${d.hash}`, label: '2. Yes, and always allow access to' },
        { id: `ccds:3:${d.hash}`, label: '3. Yes, and switch to auto mode · auto mode handles these prompts for you' },
        { id: `ccds:4:${d.hash}`, label: '4. No' },
      ],
    }])
    expect(state.card).toEqual({ ref: state.card!.ref, hash: d.hash, dialog: d, answered: null, repeats: 0 })
    expect(state.status).toBe('waiting')
  })

  it('does not repost or edit while the same prompt is redrawn', () => {
    const a = waiting(start().state, 'plan_approval')
    expect(waiting(a.state, 'plan_approval').actions).toEqual([])
  })

  it('falls back to a hint and no buttons when the options cannot be read', () => {
    const { state, actions } = waiting(start().state, 'ask_multi')
    const card = renderCard(screen('ask_multi'))
    expect(actions).toEqual([{
      type: 'send', ref: state.card!.ref, content: '<@u1>', ping: true, buttons: [],
      embed: { title: card.title, description: card.description + HINT },
    }])
    expect(state.card).toMatchObject({ hash: null, dialog: null })
  })

  it('keeps the hint and stays within 4096 on a tall unreadable screen', () => {
    const tall = Array.from({ length: 500 }, (_, i) => `row ${i} ${'.'.repeat(20)}`).join('\n')
    const { actions } = step(start().state, { kind: 'status', status: 'waiting', screen: tall })
    const { description } = (actions[0] as { embed: { description: string } }).embed
    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description.endsWith('row 499 ' + '.'.repeat(20) + '\n```' + HINT)).toBe(true)
    expect(description.startsWith('```\n…\nrow ')).toBe(true)
    // Fits on its own, but not with the hint.
    const near = Array.from({ length: 102 }, (_, i) => `${i}`.padEnd(39, '.')).join('\n')
    expect(renderCard(near).description.length).toBeLessThanOrEqual(4096)
    const fit = (step(start().state, { kind: 'status', status: 'waiting', screen: near }).actions[0] as { embed: { description: string } }).embed
    expect(fit.description.length).toBeLessThanOrEqual(4096)
    expect(fit.description.startsWith('```\n…\n')).toBe(true)
    expect(fit.description.endsWith('101'.padEnd(39, '.') + '\n```' + HINT)).toBe(true)
  })

  it('says to answer at the terminal when the session is not in tmux', () => {
    const { state, actions } = waiting({ ...start().state, pane: null }, null)
    expect(actions).toEqual([{
      type: 'send', ref: state.card!.ref, content: '<@u1>', ping: true, buttons: [],
      embed: { title: '🟡 Claude needs you', description: "Claude is waiting for you, but this session isn't in tmux — answer at the terminal." },
    }])
  })

  it('says the screen could not be read when the session is in tmux but the capture failed', () => {
    const { actions } = waiting({ ...start().state, pane: '%1' }, null)
    expect(actions[0]).toMatchObject({
      embed: { description: "Claude is waiting for you, but the screen couldn't be read — answer at the terminal, or try `!keys`." },
    })
  })

  it('edits the same card, without a new ping, when the prompt moves on after a terminal answer', () => {
    const a = waiting(start().state, 'ask_two')
    const c = waiting(a.state, 'ask_two_q2')
    const q2 = parseDialog(screen('ask_two_q2'))!
    expect(c.actions).toEqual([{
      type: 'edit', ref: a.state.card!.ref, content: '<@u1>', embed: renderCard(screen('ask_two_q2')),
      buttons: q2.options.map((o) => ({ id: `ccds:${o.n}:${q2.hash}`, label: `${o.n}. ${o.label}` })),
    }])
    expect(c.state.card).toEqual({ ref: a.state.card!.ref, hash: q2.hash, dialog: q2, answered: null, repeats: 0 })
  })

  it('finalizes a card answered via Discord and pings a new one when the next prompt appears', () => {
    const a = waiting(start().state, 'ask_two')
    const b = click(a.state, 1, 'ask_two')
    const c = waiting(b.state, 'ask_two_q2')
    const q2 = parseDialog(screen('ask_two_q2'))!
    expect(c.actions).toEqual([
      { type: 'edit', ref: a.state.card!.ref, content: `✅ ${a.state.card!.dialog!.options[0].label} — via Discord`,
        embed: { title: '✅ Answered', description: a.state.card!.dialog!.question }, buttons: [] },
      { type: 'send', ref: c.state.card!.ref, content: '<@u1>', ping: true, embed: renderCard(screen('ask_two_q2')),
        buttons: q2.options.map((o) => ({ id: `ccds:${o.n}:${q2.hash}`, label: `${o.n}. ${o.label}` })) },
    ])
    expect(c.state.card).toEqual({ ref: c.state.card!.ref, hash: q2.hash, dialog: q2, answered: null, repeats: 0 })
    expect(c.state.card!.ref).not.toBe(a.state.card!.ref)
    const d = waiting(click(c.state, 2, 'ask_two_q2').state, 'ask_two_review')
    expect(d.actions).toHaveLength(2)
    expect(d.actions[1]).toMatchObject({ type: 'send', ping: true, buttons: [{ label: '1. Submit answers' }, { label: '2. Cancel' }] })
  })

  it('treats the same prompt still showing three polls after an answer as a new identical prompt', () => {
    const a = waiting(start().state, 'approval_bash')
    let s = click(a.state, 1, 'approval_bash').state
    for (let i = 0; i < 2; i++) {
      const r = waiting(s, 'approval_bash')
      expect(r.actions).toEqual([])
      s = r.state
    }
    // An unreadable redraw breaks the run.
    s = waiting(s, 'ask_multi').state
    for (let i = 0; i < 2; i++) s = waiting(s, 'approval_bash').state
    const r = waiting(s, 'approval_bash')
    expect(r.actions).toEqual([
      { type: 'edit', ref: a.state.card!.ref, content: '✅ Yes — via Discord', embed: { title: '✅ Answered', description: 'Do you want to proceed?' }, buttons: [] },
      expect.objectContaining({ type: 'send', ref: r.state.card!.ref, ping: true, embed: renderCard(screen('approval_bash')) }),
    ])
    expect(r.state.card).toMatchObject({ answered: null, repeats: 0 })
    expect(waiting(r.state, 'approval_bash').actions).toEqual([])
    // Never answered: redraws stay quiet however long they last.
    let q = a.state
    for (let i = 0; i < 5; i++) {
      const x = waiting(q, 'approval_bash')
      expect(x.actions).toEqual([])
      q = x.state
    }
  })

  it('adds buttons once an unreadable prompt becomes readable', () => {
    const a = waiting(start().state, 'ask_multi')
    const b = waiting(a.state, 'ask_single')
    expect(b.actions).toEqual([expect.objectContaining({ type: 'edit', ref: a.state.card!.ref, embed: renderCard(screen('ask_single')) })])
    expect(b.state.card!.hash).toBe(parseDialog(screen('ask_single'))!.hash)
    // Becoming unreadable again changes nothing.
    expect(waiting(b.state, 'ask_multi').actions).toEqual([])
  })

  it('truncates long labels to 80 and gives up on buttons past 25 options', () => {
    const long = `Do it?\n❯ 1. ${'a'.repeat(100)}\n  2. No\nEsc to cancel`
    const a = step(start().state, { kind: 'status', status: 'waiting', screen: long })
    const [first] = (a.actions[0] as { buttons: { label: string }[] }).buttons
    expect(first.label).toBe(`1. ${'a'.repeat(76)}…`)
    const many = `Pick\n${Array.from({ length: 26 }, (_, i) => `${i ? '  ' : '❯ '}${i + 1}. opt ${i + 1}`).join('\n')}\nEsc to cancel`
    expect(parseDialog(many)!.options).toHaveLength(26)
    const b = step(start().state, { kind: 'status', status: 'waiting', screen: many })
    expect(b.actions[0]).toMatchObject({ type: 'send', buttons: [] })
    expect((b.actions[0] as { embed: { description: string } }).embed.description.endsWith(HINT)).toBe(true)
    expect(b.state.card!.hash).toBeNull()
  })

  it('finalizes the card when answered in the terminal', () => {
    const a = waiting(start().state, 'approval_bash')
    const b = step(a.state, { kind: 'status', status: 'busy', screen: null })
    expect(b.actions).toEqual([{
      type: 'edit', ref: a.state.card!.ref, content: '✅ answered in terminal',
      embed: { title: '✅ Answered', description: 'Do you want to proceed?' }, buttons: [],
    }])
    expect(b.state).toMatchObject({ card: null, status: 'busy' })
    expect(step(b.state, { kind: 'status', status: 'idle', screen: null }).actions).toEqual([])
  })

  it('sends the chosen key from a button, then finalizes as answered via Discord', () => {
    const a = waiting(start().state, 'approval_bash')
    const b = click(a.state, 4, 'approval_bash')
    expect(b.actions).toEqual([
      { type: 'keys', keys: ['4'], hash: parseDialog(screen('approval_bash'))!.hash },
      { type: 'edit', ref: a.state.card!.ref, content: '⏳ sending 4. No…', embed: { title: '⏳ Sending', description: 'Do you want to proceed?' }, buttons: [] },
    ])
    expect(b.state.card!.answered).toBe('No')
    expect(waiting(b.state, 'approval_bash').actions).toEqual([])
    const c = step(b.state, { kind: 'status', status: 'busy', screen: null })
    expect(c.actions).toEqual([{
      type: 'edit', ref: a.state.card!.ref, content: '✅ No — via Discord',
      embed: { title: '✅ Answered', description: 'Do you want to proceed?' }, buttons: [],
    }])
  })

  it('does not send twice on a double click', () => {
    const b = click(waiting(start().state, 'approval_bash').state, 1, 'approval_bash')
    expect(click(b.state, 1, 'approval_bash').actions).toEqual([{ type: 'reply', replyTo: 'i1', content: 'Already sent.' }])
  })

  it('rejects a button for a prompt that is no longer open', () => {
    const closed = [{ type: 'reply', replyTo: 'i1', content: 'That prompt is no longer open.' }]
    const open = waiting(start().state, 'ask_two').state
    const q2 = parseDialog(screen('ask_two_q2'))!.hash
    expect(click(start().state, 1, 'ask_two').actions).toEqual(closed) // no card
    expect(click(open, 1, 'ask_two', 'busy').actions).toEqual(closed)
    expect(click(open, 1, null, 'waiting', 'abc').actions).toEqual(closed)
    expect(click(open, 1, 'ask_two_q2', 'waiting', parseDialog(screen('ask_two'))!.hash).actions).toEqual(closed) // screen moved on
    expect(click(open, 1, 'ask_multi', 'waiting', q2).actions).toEqual(closed) // unreadable now
    expect(click(open, 9, 'ask_two').actions).toEqual(closed)
    expect(click(open, 1, 'ask_two').actions[0]).toEqual({ type: 'keys', keys: ['1'], hash: parseDialog(screen('ask_two'))!.hash })
  })

  it('never changes the state it was given', () => {
    let s = start().state
    for (const input of [
      { kind: 'status', status: 'waiting', screen: screen('ask_two') },
      { kind: 'button', id: 'i1', n: 1, hash: parseDialog(screen('ask_two'))!.hash, status: 'waiting', screen: screen('ask_two') },
      { kind: 'status', status: 'waiting', screen: screen('ask_two_q2') },
      { kind: 'status', status: 'busy', screen: null },
    ] as const) {
      const before = structuredClone(s)
      const next = step(s, input as never).state
      expect(s).toEqual(before)
      s = next
    }
  })
})

const say = (state: State, text: string, id = 'm1') => step(state, { kind: 'message', id, text })
const READ_ONLY = "👀 Read-only: this session isn't running in tmux."

describe('step: messages from Discord', () => {
  it('pastes plain text and skips its transcript echo, while a different prompt still posts', () => {
    const a = say(start().state, '  fix the login bug  ')
    expect(a.actions).toEqual([{ type: 'paste', text: 'fix the login bug', replyTo: 'm1' }])
    const echo = events(a.state, { kind: 'prompt', text: 'fix the login bug' })
    expect(echo.actions).toEqual([])
    expect(echo.state.pendingEcho).toEqual([])
    expect(sends(events(a.state, { kind: 'prompt', text: 'something else' }).actions)).toHaveLength(1)
  })

  it('matches the echo after CRLF and control characters are cleaned by the paste', () => {
    const a = say(start().state, 'line one\r\nline\x1b[31m two\x07')
    expect(a.state.pendingEcho).toEqual(['line one\nline[31m two'])
    expect(events(a.state, { kind: 'prompt', text: 'line one\nline[31m two\n' }).actions).toEqual([])
  })

  it('ignores empty messages', () => {
    expect(say(start().state, '   ').actions).toEqual([])
  })

  it('passes slash commands through as text', () => {
    expect(say(start().state, '/clear').actions).toEqual([{ type: 'paste', text: '/clear', replyTo: 'm1' }])
  })

  it('refuses other ! messages, which Claude Code would run as shell commands', () => {
    const content = "🚫 Messages starting with `!` aren't sent — Claude Code would run them as shell commands. Commands: `!keys`, `!type`, `!archive`."
    for (const text of ['!ls', '!keysx Down', '! rm -rf /', '\x07 !ls']) {
      const { state, actions } = say(start().state, text)
      expect(actions).toEqual([{ type: 'reply', replyTo: 'm1', content }])
      expect(state.pendingEcho).toEqual([])
    }
  })

  it('refuses ! hidden behind invisible characters or written as a lookalike', () => {
    const content = "🚫 Messages starting with `!` aren't sent — Claude Code would run them as shell commands. Commands: `!keys`, `!type`, `!archive`."
    for (const text of ['\u200b!id', '\ufeff!id', '\u200d\u2060!id', '！id', '﹗id']) {
      const { state, actions } = say(start().state, text)
      expect(actions).toEqual([{ type: 'reply', replyTo: 'm1', content }])
      expect(state.pendingEcho).toEqual([])
    }
    const s0 = { ...start().state, status: 'waiting' }
    for (const text of ['!type \u200b!id', '!type ！id', '!type ﹗id', '\u200b!type !id']) {
      expect(say(s0, text).actions).toEqual([
        { type: 'reply', replyTo: 'm1', content: '🚫 That text starts with `!`, which Claude Code would run as a shell command — not sent.' },
      ])
    }
  })

  it('resolves an open card as answered by !keys', () => {
    const a = waiting(start().state, 'approval_bash')
    const b = say(a.state, '!KEYS  1 ')
    expect(b.actions).toEqual([{ type: 'keys', keys: ['1'], replyTo: 'm1' }])
    expect(b.state.card!.answered).toBe('`!keys 1`')
    expect(step(b.state, { kind: 'status', status: 'busy', screen: null }).actions).toEqual([{
      type: 'edit', ref: a.state.card!.ref, content: '✅ `!keys 1` — via Discord',
      embed: { title: '✅ Answered', description: 'Do you want to proceed?' }, buttons: [],
    }])
    expect(say(start().state, '!keys 1').state.card).toBeNull()
  })

  it('sends keys, case-insensitively', () => {
    expect(say(start().state, '!KEYS down enter').actions).toEqual([{ type: 'keys', keys: ['Down', 'Enter'], replyTo: 'm1' }])
  })

  it('lists the allowed keys when they cannot be parsed', () => {
    const content = '⌨️ Allowed keys: digits 0-9, Up, Down, Left, Right, Enter, Escape, Tab, BTab, Space, BSpace (max 20). Example: `!keys Down Enter`'
    for (const text of ['!keys rm -rf', '!keys']) {
      expect(say(start().state, text).actions).toEqual([{ type: 'reply', replyTo: 'm1', content }])
    }
  })

  it('types an answer while a prompt is open, but not one starting with !', () => {
    const s0 = { ...start().state, status: 'waiting' }
    const a = say(s0, '!type yes')
    expect(a.actions).toEqual([{ type: 'paste', text: 'yes', replyTo: 'm1', allowWaiting: true }])
    expect(a.state.pendingEcho).toEqual(['yes'])
    for (const text of ['!type !ls', '!type \x1b!ls']) expect(say(s0, text).actions).toEqual([
      { type: 'reply', replyTo: 'm1', content: '🚫 That text starts with `!`, which Claude Code would run as a shell command — not sent.' },
    ])
    expect(say(s0, '!type  ').actions).toEqual([{ type: 'reply', replyTo: 'm1', content: '✍️ Usage: `!type your answer`' }])
  })

  it('does not paste plain text while a prompt is open', () => {
    const { state, actions } = say({ ...start().state, status: 'waiting' }, 'yes')
    expect(actions).toEqual([{ type: 'reply', replyTo: 'm1', content: '🟡 A prompt is open — tap a button, or use `!keys` / `!type`.' }])
    expect(state.pendingEcho).toEqual([])
  })

  it('replies read-only when the session is not in tmux', () => {
    const s0 = { ...start().state, pane: null }
    for (const text of ['hello', '!keys Enter', '!type yes']) {
      expect(say(s0, text).actions).toEqual([{ type: 'reply', replyTo: 'm1', content: READ_ONLY }])
    }
  })

  it('archives the channel at the end once asked, with or without tmux', () => {
    const done = { type: 'reply', replyTo: 'm1', content: '📦 This channel will be archived when the session ends.' }
    const a = say({ ...start().state, pane: null }, '!Archive')
    // Kept in the topic so a watcher restart still archives.
    expect(a.actions).toEqual([{ type: 'set_topic', topic: `ccds|42|${procStart}|archive` }, done])
    expect(say(a.state, '!archive').actions).toEqual([done])
    expect(step(a.state, { kind: 'ended' }).actions).toEqual([{ type: 'end_channel', archive: true }])
  })

  it('keeps only the 20 newest pending echoes', () => {
    let s = start().state
    for (let i = 0; i < 22; i++) s = say(s, `msg ${i}`).state
    expect(s.pendingEcho).toHaveLength(20)
    expect(s.pendingEcho[0]).toBe('msg 2')
    expect(s.pendingEcho[19]).toBe('msg 21')
  })

  it('never changes the state it was given', () => {
    let s = start().state
    for (const text of ['hello', '!type yes', '!archive', '!keys Enter']) {
      const before = structuredClone(s)
      const next = say(s, text).state
      expect(s).toEqual(before)
      s = next
    }
  })
})

describe('topics', () => {
  it('round-trips the process identity, spaces included', () => {
    const topic = topicFor(42, procStart)
    expect(topic).toBe(`ccds|42|${procStart}`)
    expect(parseTopic(topic)).toEqual({ pid: 42, procStart, archive: false, endedAt: null })
    expect(parseTopic(endedTopic(topic, 1700))).toEqual({ pid: 42, procStart, archive: false, endedAt: 1700 })
  })

  it('round-trips the archive flag, through an end and a re-end', () => {
    const topic = topicFor(42, procStart, true)
    expect(topic).toBe(`ccds|42|${procStart}|archive`)
    expect(parseTopic(topic)).toEqual({ pid: 42, procStart, archive: true, endedAt: null })
    const ended = endedTopic(endedTopic(topic, 1700), 1800)
    expect(ended).toBe(`ccds|42|${procStart}|archive|ended:1800`)
    expect(parseTopic(ended)).toEqual({ pid: 42, procStart, archive: true, endedAt: 1800 })
    expect(parseTopic(`ccds|42|${procStart}|ended:5|archive`)).toBeNull()
  })

  it('rejects topics it did not write', () => {
    expect(parseTopic(null)).toBeNull()
    expect(parseTopic('')).toBeNull()
    expect(parseTopic('my channel about cats')).toBeNull()
    expect(parseTopic('ccds|abc|x')).toBeNull()
    expect(parseTopic('ccds|42|')).toBeNull()
  })

  it('is due once the ttl has passed since the end', () => {
    const ended = endedTopic(topicFor(42, procStart), 1000)
    expect(isDue(ended, 1999, 1000)).toBe(false)
    expect(isDue(ended, 2000, 1000)).toBe(true)
    expect(isDue(topicFor(42, procStart), 99999, 1000)).toBe(false)
    expect(isDue(null, 99999, 1000)).toBe(false)
  })
})

describe('pickArchiveCategory', () => {
  it('refuses at the 500-channel limit', () => {
    expect(pickArchiveCategory([{ id: 'a', name: 'Archive', count: 3 }], 500)).toEqual({
      refuse: "Discord's 500-channel limit is reached — delete some channels first",
    })
  })

  it('uses the first archive category with room', () => {
    expect(pickArchiveCategory([
      { id: 'x', name: 'General', count: 1 },
      { id: 'a', name: 'Archive', count: 50 },
      { id: 'b', name: 'Archive 2', count: 49 },
    ], 120)).toEqual({ id: 'b' })
  })

  it('creates the next archive category when all are full', () => {
    expect(pickArchiveCategory([], 10)).toEqual({ create: 'Archive' })
    expect(pickArchiveCategory([
      { id: 'a', name: 'Archive', count: 50 },
      { id: 'b', name: 'Archive 2', count: 50 },
    ], 120)).toEqual({ create: 'Archive 3' })
  })
})
