import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_LINES_PER_MESSAGE, channelName, formatDuration, renderActivity, renderAgents, renderCard,
  renderDone, renderEnded, renderPrompt, renderText, toolLine,
} from '../src/render.ts'
import type { Agent, Tool } from '../src/render.ts'

const cwd = '/Users/me/proj'
const tool = (name: string, input: Record<string, unknown> = {}, state: Tool['state'] = 'ok'): Tool =>
  ({ id: `id_${name}`, name, input, state })

describe('toolLine', () => {
  it('renders each known tool with its icon, label and target', () => {
    expect(toolLine(tool('Read', { file_path: '/Users/me/proj/src/a.ts' }), cwd)).toBe('-# 📄 Read `src/a.ts` ✅')
    expect(toolLine(tool('Write', { file_path: '/etc/hosts' }), cwd)).toBe('-# 📝 Write `/etc/hosts` ✅')
    expect(toolLine(tool('Edit', { file_path: '/Users/me/proj/a.ts' }), cwd)).toBe('-# ✏️ Edit `a.ts` ✅')
    expect(toolLine(tool('MultiEdit', { file_path: '/Users/me/proj/a.ts' }), cwd)).toBe('-# ✏️ Edit `a.ts` ✅')
    expect(toolLine(tool('NotebookEdit', { notebook_path: '/Users/me/proj/n.ipynb' }), cwd)).toBe('-# ✏️ Edit `n.ipynb` ✅')
    expect(toolLine(tool('Bash', { command: 'ls -la', description: 'List files' }), cwd)).toBe('-# ▶️ Run `List files` ✅')
    expect(toolLine(tool('Bash', { command: 'npm test\nnpm run build' }), cwd)).toBe('-# ▶️ Run `npm test` ✅')
    expect(toolLine(tool('Grep', { pattern: 'foo', path: '/Users/me/proj/src' }), cwd)).toBe('-# 🔍 Search `"foo" in src` ✅')
    expect(toolLine(tool('Grep', { pattern: 'foo' }), cwd)).toBe('-# 🔍 Search `"foo"` ✅')
    expect(toolLine(tool('Glob', { pattern: '**/*.ts' }), cwd)).toBe('-# 🔍 Find `**/*.ts` ✅')
    expect(toolLine(tool('WebFetch', { url: 'https://docs.example.com/a/b?c=1' }), cwd)).toBe('-# 🌐 Fetch `docs.example.com` ✅')
    expect(toolLine(tool('WebFetch', { url: 'not a url' }), cwd)).toBe('-# 🌐 Fetch `not a url` ✅')
    expect(toolLine(tool('WebSearch', { query: 'node 24' }), cwd)).toBe('-# 🌐 Search web `"node 24"` ✅')
    expect(toolLine(tool('Skill', { skill: 'ponytail' }), cwd)).toBe('-# 🧩 Skill `ponytail` ✅')
    expect(toolLine(tool('TodoWrite', { todos: [] }), cwd)).toBe('-# 📋 Todos ✅')
    expect(toolLine(tool('mcp__plugin_playwright__browser_click', { ref: 'x' }), cwd)).toBe('-# 🔌 browser_click ✅')
    expect(toolLine(tool('Frobnicate', { x: 1 }), cwd)).toBe('-# 🔧 Frobnicate ✅')
  })

  it('shortens Windows paths under the cwd', () => {
    const win = 'C:\\Users\\me\\proj'
    expect(toolLine(tool('Read', { file_path: 'C:\\Users\\me\\proj\\src\\a.ts' }), win)).toBe('-# 📄 Read `src\\a.ts` ✅')
    expect(toolLine(tool('Read', { file_path: 'C:\\Users\\me\\project\\a.ts' }), win)).toBe('-# 📄 Read `C:\\Users\\me\\project\\a.ts` ✅')
  })

  it('shows the state glyph', () => {
    expect(toolLine(tool('TodoWrite', {}, 'running'), cwd)).toBe('-# 📋 Todos ⏳')
    expect(toolLine(tool('TodoWrite', {}, 'error'), cwd)).toBe('-# 📋 Todos ❌')
  })

  it('keeps backticks and newlines from breaking the inline code', () => {
    expect(toolLine(tool('Bash', { description: 'echo `x`\nand more' }), cwd)).toBe("-# ▶️ Run `echo 'x' and more` ✅")
  })

  it('truncates the target to 80 characters and keeps every line within 130', () => {
    const line = toolLine(tool('Bash', { command: 'x'.repeat(500) }, 'running'), cwd)
    expect(line).toBe(`-# ▶️ Run \`${'x'.repeat(79)}…\` ⏳`)
    const long = toolLine(tool(`mcp__s__${'y'.repeat(300)}`, {}), cwd)
    const unknown = toolLine(tool('z'.repeat(300), {}), cwd)
    const grep = toolLine(tool('Grep', { pattern: 'p'.repeat(300), path: '/q'.repeat(100) }), cwd)
    for (const l of [line, long, unknown, grep]) expect(l.length).toBeLessThanOrEqual(130)
  })
})

describe('renderActivity', () => {
  it('returns nothing for no tools', () => {
    expect(renderActivity([], cwd)).toEqual([])
  })

  it('puts a header on the first chunk that says whether anything is still running', () => {
    const tools = [tool('TodoWrite'), tool('Skill', { skill: 's' }, 'running')]
    expect(renderActivity(tools, cwd)).toEqual(['-# ⚙️ Working…\n-# 📋 Todos ✅\n-# 🧩 Skill `s` ⏳'])
    expect(renderActivity([tool('TodoWrite')], cwd)).toEqual(['-# ⚙️ Done\n-# 📋 Todos ✅'])
  })

  it('holds exactly ACTIVITY_LINES_PER_MESSAGE tools per chunk, each within 2000 characters', () => {
    const tools = Array.from({ length: 40 }, (_, i) => tool('Bash', { command: `${i} ${'x'.repeat(300)}` }, i === 39 ? 'running' : 'ok'))
    const chunks = renderActivity(tools, cwd)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].split('\n')).toHaveLength(ACTIVITY_LINES_PER_MESSAGE + 1)
    expect(chunks[0].startsWith('-# ⚙️ Working…\n-# ▶️ Run `0 x')).toBe(true)
    expect(chunks[1].split('\n')).toHaveLength(ACTIVITY_LINES_PER_MESSAGE)
    expect(chunks[1].startsWith('-# ▶️ Run `15 x')).toBe(true)
    expect(chunks[2].split('\n')).toHaveLength(10)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
  })
})

describe('renderAgents', () => {
  const agent = (id: string, state: Agent['state'], durationMs?: number): Agent =>
    ({ id, agentType: 'codebase-browser', description: `Map ${id}`, state, durationMs })

  it('counts running and done agents and lists each one', () => {
    expect(renderAgents([agent('a', 'running'), agent('b', 'completed', 72000), agent('c', 'failed'), agent('d', 'stopped', 5000)])).toBe([
      '**🤖 Subagents** · 1 running · 3 done',
      '⏳ **codebase-browser** Map a',
      '✅ **codebase-browser** Map b · 1m 12s',
      '❌ **codebase-browser** Map c',
      '⏹️ **codebase-browser** Map d · 5s',
    ].join('\n'))
  })

  it('omits a zero count', () => {
    expect(renderAgents([agent('a', 'completed')]).split('\n')[0]).toBe('**🤖 Subagents** · 1 done')
    expect(renderAgents([agent('a', 'running')]).split('\n')[0]).toBe('**🤖 Subagents** · 1 running')
  })

  it('caps at 2000 characters, keeping running and most recent agents', () => {
    const agents = Array.from({ length: 100 }, (_, i) => agent(`agent-${i}-${'d'.repeat(40)}`, i === 0 ? 'running' : 'completed'))
    const text = renderAgents(agents)
    expect(text.length).toBeLessThanOrEqual(2000)
    const lines = text.split('\n')
    expect(lines[0]).toBe('**🤖 Subagents** · 1 running · 99 done')
    expect(lines[1]).toContain('agent-0-')
    expect(lines.at(-2)).toContain('agent-99-')
    expect(lines.at(-1)).toBe(`… and ${100 - (lines.length - 2)} more`)
  })
})

describe('renderText', () => {
  it('returns nothing for whitespace', () => {
    expect(renderText(' \n\t ')).toEqual([])
  })

  it('passes short text through', () => {
    expect(renderText('Hello **there**')).toEqual(['Hello **there**'])
  })

  it('turns a markdown table into an aligned code block', () => {
    const text = 'Before\n\n| Name | `Size` |\n|------|:---:|\n| **a.ts** | 12 |\n| bigger.ts | 3 |\n\nAfter'
    expect(renderText(text)).toEqual(['Before\n\n```\nName      | Size\n----------+-----\na.ts      | 12\nbigger.ts | 3\n```\n\nAfter'])
  })

  it('leaves tables inside code fences alone', () => {
    const text = '```md\n| a | b |\n|---|---|\n```'
    expect(renderText(text)).toEqual([text])
  })

  it('splits at line boundaries into chunks of at most 2000', () => {
    const line = 'y'.repeat(999)
    expect(renderText([line, line, line].join('\n'))).toEqual([`${line}\n${line}`, line])
  })

  it('hard-splits a single overlong line', () => {
    const chunks = renderText('z'.repeat(4500))
    expect(chunks.join('')).toBe('z'.repeat(4500))
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
  })

  it('closes and reopens a code fence across a split', () => {
    const body = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i}`).join('\n')
    const chunks = renderText(`Code:\n\`\`\`ts\n${body}\n\`\`\`\nDone`)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000)
      expect(c.match(/^```/gm)?.length ?? 0).toSatisfy((n: number) => n % 2 === 0)
    }
    expect(chunks[0].endsWith('\n```')).toBe(true)
    expect(chunks[1].startsWith('```ts\n')).toBe(true)
    expect(chunks.at(-1)?.endsWith('```\nDone')).toBe(true)
  })
})

describe('renderPrompt', () => {
  it('quotes each line under a from-terminal header', () => {
    expect(renderPrompt('fix it\n\nplease')).toEqual(['-# 🧑 from terminal\n> fix it\n>\n> please'])
  })

  it('chunks a long prompt', () => {
    const chunks = renderPrompt(Array.from({ length: 50 }, () => 'w'.repeat(100)).join('\n'))
    expect(chunks.length).toBe(3)
    expect(chunks[0].startsWith('-# 🧑 from terminal\n> www')).toBe(true)
    expect(chunks[1].startsWith('> www')).toBe(true)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
  })
})

describe('renderDone', () => {
  it('mentions the user and any agents still running', () => {
    expect(renderDone(72000, 0, '42')).toBe('✅ Done in 1m 12s <@42>')
    expect(renderDone(5000, 1, '42')).toBe('✅ Done in 5s <@42> · 1 background agent still running')
    expect(renderDone(5000, 3, '42')).toBe('✅ Done in 5s <@42> · 3 background agents still running')
  })
})

describe('renderCard', () => {
  it('fences the screen', () => {
    expect(renderCard('Allow?\n1. Yes\n2. No')).toEqual({ title: '🟡 Claude needs you', description: '```\nAllow?\n1. Yes\n2. No\n```' })
  })

  it('starts at the prompt\'s top border, dropping the chat above it and trailing spaces', () => {
    const screen = `⏺ earlier reply\n${'─'.repeat(40)}\n Which color?   \n❯ 1. Red\n  2. Green\n`
    expect(renderCard(screen).description).toBe('```\n Which color?\n❯ 1. Red\n  2. Green\n```')
  })

  it('keeps the bottom of a tall screen within 4096', () => {
    const screen = Array.from({ length: 500 }, (_, i) => `row ${i} ${'.'.repeat(20)}`).join('\n') + '\n❯ 1. Yes\n  2. No'
    const { description } = renderCard(screen)
    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description.startsWith('```\n…\nrow ')).toBe(true)
    expect(description.endsWith('❯ 1. Yes\n  2. No\n```')).toBe(true)
  })
})

describe('renderEnded', () => {
  it('says when the channel goes away', () => {
    expect(renderEnded(3600000)).toBe('-# 🔚 Session ended · this channel is deleted in 1h · type `!archive` to keep it')
  })
})

describe('channelName', () => {
  it('slugs folder and label', () => {
    expect(channelName('My Project', 'Fix the Bug!')).toBe('my-project-fix-the-bug')
    expect(channelName('--a__b', '')).toBe('a-b')
    expect(channelName('', '***')).toBe('session')
    const long = channelName('a'.repeat(99), 'b')
    expect(long).toBe('a'.repeat(99))
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours, rounding down', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(12999)).toBe('12s')
    expect(formatDuration(60000)).toBe('1m')
    expect(formatDuration(72000)).toBe('1m 12s')
    expect(formatDuration(3600000)).toBe('1h')
    expect(formatDuration(3780000)).toBe('1h 3m')
  })
})
