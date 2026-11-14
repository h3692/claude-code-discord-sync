import { describe, expect, it } from 'vitest'
import {
  endedTopic, isDue, newMirror, parseTopic, pickArchiveCategory, step, topicFor,
} from '../src/mirror.ts'
import type { Action, State } from '../src/mirror.ts'
import type { TranscriptEvent } from '../src/transcript.ts'
import { renderActivity, renderAgents, renderDone, renderPrompt, renderText } from '../src/render.ts'

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
    expect(b.actions[0]).toMatchObject({ type: 'edit', ref: 'c1', buttons: [] })
    expect(b.actions[1]).toMatchObject({ type: 'send', content: '-# ── new conversation ──' })
  })

  it('ends the channel, archiving it when asked', () => {
    expect(step(start().state, { kind: 'ended' }).actions).toEqual([{ type: 'end_channel', archive: false }])
    const s0 = { ...start().state, archiveOnEnd: true, card: { ref: 'c1', hash: null, dialog: null, answered: null } }
    expect(step(s0, { kind: 'ended' }).actions).toEqual([
      { type: 'edit', ref: 'c1', content: '-# 🔚 session ended', buttons: [] },
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

describe('topics', () => {
  it('round-trips the process identity, spaces included', () => {
    const topic = topicFor(42, procStart)
    expect(topic).toBe(`ccds|42|${procStart}`)
    expect(parseTopic(topic)).toEqual({ pid: 42, procStart, endedAt: null })
    expect(parseTopic(endedTopic(topic, 1700))).toEqual({ pid: 42, procStart, endedAt: 1700 })
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
