/**
 * Unit tests for the pure helpers in lib/format.js. Run with:
 *   node --test tests/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, homeShorten, markdownToTelegramHtml, parseApprovalCallback, parseBotCommand, parseQuestionCallback, renderUptime, splitMessage, toolCallPreview, trimReasoning } from '../lib/format.js'

test('escapeHtml escapes HTML metacharacters', () => {
  assert.equal(escapeHtml('<b>&"quoted"</b>'), '&lt;b&gt;&amp;&quot;quoted&quot;&lt;/b&gt;')
  assert.equal(escapeHtml('plain'), 'plain')
})

test('splitMessage keeps short text whole', () => {
  assert.deepEqual(splitMessage('hello world'), ['hello world'])
})

test('splitMessage splits on newline boundaries', () => {
  const text = 'a'.repeat(300) + '\n' + 'b'.repeat(300) + '\n' + 'c'.repeat(300)
  const chunks = splitMessage(text, 400)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every(chunk => chunk.length <= 400))
  assert.equal(chunks.join('\n'), text)
})

test('splitMessage hard-splits a single over-long line', () => {
  const text = 'x'.repeat(1000)
  const chunks = splitMessage(text, 400)
  assert.equal(chunks.length, 3)
  assert.ok(chunks.every(chunk => chunk.length <= 400))
  assert.equal(chunks.join(''), text)
})

test('splitMessage preserves content across splits', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'pad'.repeat(i)}`).join('\n')
  const chunks = splitMessage(text, 137)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => chunk.length <= 137))
  // Every chunk is a verbatim slice of the original: nothing is invented,
  // dropped, or duplicated.
  assert.ok(chunks.every(chunk => text.includes(chunk)))
})

test('renderUptime formats compactly', () => {
  assert.equal(renderUptime(0), '0s')
  assert.equal(renderUptime(45), '45s')
  assert.equal(renderUptime(60), '1m 0s')
  assert.equal(renderUptime(3661), '1h 1m 1s')
  assert.equal(renderUptime(-5), '0s')
})

test('parseBotCommand parses bare commands', () => {
  assert.deepEqual(parseBotCommand('/status'), { command: 'status', rawInput: '' })
  assert.deepEqual(parseBotCommand('/agent abc-123'), { command: 'agent', rawInput: 'abc-123' })
  assert.deepEqual(parseBotCommand('/kill bash-4  '), { command: 'kill', rawInput: 'bash-4' })
})

test('parseBotCommand strips bot username mentions', () => {
  assert.deepEqual(parseBotCommand('/status@my_dsh_bot'), { command: 'status', rawInput: '' })
  assert.deepEqual(parseBotCommand('/agent@my_bot abc'), { command: 'agent', rawInput: 'abc' })
})

test('parseBotCommand returns undefined for plain text', () => {
  assert.equal(parseBotCommand('hello agent'), undefined)
  assert.equal(parseBotCommand('no slash here'), undefined)
})

test('homeShorten shortens paths under home', () => {
  assert.equal(homeShorten('/Users/jack/Code', '/Users/jack'), '~/Code')
  assert.equal(homeShorten('/Users/jack', '/Users/jack'), '~')
  assert.equal(homeShorten('/Users/jack/Code/deepseek-harness', '/Users/jack'), '~/Code/deepseek-harness')
})

test('homeShorten leaves unrelated paths unchanged', () => {
  assert.equal(homeShorten('/opt/homebrew/bin', '/Users/jack'), '/opt/homebrew/bin')
  assert.equal(homeShorten('/Users/jackie', '/Users/jack'), '/Users/jackie')
})


test('trimReasoning summarizes multi-line chains by the first line', () => {
  const chain = 'First, I understand the request.\nThen I explore the codebase.\nFinally I write the fix.'
  assert.equal(trimReasoning(chain, 300), 'First, I understand the request.')
  assert.equal(trimReasoning('single line', 300), 'single line')
  assert.equal(trimReasoning('', 300), '')
})

test('trimReasoning cuts long chains at a sentence boundary', () => {
  const long = 'First I check the request. Then I plan the fix. Then I write the code and verify it runs correctly end to end.'
  const trimmed = trimReasoning(long, 40)
  assert.ok(trimmed.length <= 42, `trimmed too long: ${trimmed}`)
  assert.ok(trimmed.endsWith('…'))
  assert.ok(trimmed.includes('First I check the request.'))
})

test('trimReasoning hard-cuts when no sentence boundary fits', () => {
  const text = 'x'.repeat(200)
  const trimmed = trimReasoning(text, 100)
  assert.equal(trimmed.length, 101)
  assert.equal(trimmed, `${'x'.repeat(100)}…`)
})

test('trimReasoning suppresses reasoning at cap 0', () => {
  assert.equal(trimReasoning('anything at all', 0), '')
  assert.equal(trimReasoning('anything at all', -5), '')
})

test('parseApprovalCallback parses approve and reject buttons', () => {
  assert.deepEqual(parseApprovalCallback('approve:abc-123'), { approve: true, token: 'abc-123' })
  assert.deepEqual(parseApprovalCallback('reject:abc-123'), { approve: false, token: 'abc-123' })
})

test('parseApprovalCallback rejects stale or malformed data', () => {
  assert.equal(parseApprovalCallback('unknown'), undefined)
  assert.equal(parseApprovalCallback('approve:'), undefined)
  assert.equal(parseApprovalCallback('Approve:abc'), undefined)
  assert.equal(parseApprovalCallback(''), undefined)
})

test('parseQuestionCallback parses question buttons', () => {
  assert.deepEqual(parseQuestionCallback('question:abc-123:0'), { token: 'abc-123', optionIndex: 0 })
  assert.deepEqual(parseQuestionCallback('question:abc-123:2'), { token: 'abc-123', optionIndex: 2 })
})

test('parseQuestionCallback rejects stale or malformed data', () => {
  assert.equal(parseQuestionCallback('question:abc-123'), undefined)
  assert.equal(parseQuestionCallback('question::0'), undefined)
  assert.equal(parseQuestionCallback('Question:abc:1'), undefined)
  assert.equal(parseQuestionCallback('approve:abc'), undefined)
})

test('markdownToTelegramHtml renders the Telegram subset and escapes the rest', () => {
  const md = '# Title\n\nSome **bold** and *it* and `a<b`.\n- one\n- two\n\n```sh\nls -la && echo "<x>"\n```\nSee [docs](https://example.com/a?b=1).'
  assert.equal(markdownToTelegramHtml(md),
    '<b>Title</b>\n\nSome <b>bold</b> and <i>it</i> and <code>a&lt;b</code>.\n• one\n• two\n\n<pre>ls -la &amp;&amp; echo &quot;&lt;x&gt;&quot;</pre>\nSee <a href="https://example.com/a?b=1">docs</a>.')
})

test('markdownToTelegramHtml leaves snake_case and 2*3*4 alone', () => {
  assert.equal(markdownToTelegramHtml('use file_name_here and 2*3*4'), 'use file_name_here and 2*3*4')
})

test('toolCallPreview shows the command, clipped, and falls back to the name', () => {
  assert.equal(toolCallPreview('bash', '{"command":"ls -la;  echo hi","description":"x"}'), '🔧 <code>bash</code> <code>ls -la; echo hi</code>')
  assert.equal(toolCallPreview('bash', `{"command":"${'x'.repeat(200)}"}`).length < 160, true)
  assert.equal(toolCallPreview('think', '{"thought":"..."}'), '🔧 <code>think</code>')
  assert.equal(toolCallPreview('bash', 'not json'), '🔧 <code>bash</code>')
})
