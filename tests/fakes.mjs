/**
 * Fake Telegram Bot API and OpenAI-compatible SSE endpoints.
 *
 * These were the top-level servers of `smoke.mjs`; they live here so a harness
 * can drive the plugin without re-implementing a Bot API. Importing this module
 * starts nothing and opens no socket — every server comes into being inside the
 * `start*` function that returns it.
 *
 * Each helper binds port **0** and reports the port it was given, so two
 * harnesses can run at once and neither depends on a fixed number.
 */
import http from 'node:http'

/**
 * Start a fake Telegram Bot API.
 *
 * @param options - optional overrides.
 * @param options.chatId - chat the bot is allowed to answer; auto-pressed
 *   approvals and question options are delivered as coming from here.
 * @param options.strangerId - chat outside the allowlist, used to prove a press
 *   from elsewhere is refused without settling anything.
 * @param options.pressDelayMs - how long to wait before pressing a button, so
 *   the message is observable first.
 * @returns the endpoint it bound (port and base URL), the writable update queue,
 *   what was observed, and a `close()` that cancels scheduled presses and awaits
 *   one shared shutdown.
 */
export async function startFakeTelegram(options = {}) {
  const { chatId, strangerId, pressDelayMs = 400 } = options
  const queue = [] // updates still to deliver; the caller may empty or add to it
  const sent = [] // sendMessage payloads
  const actions = []
  const approvals = [] // approval messages with buttons
  const questions = [] // question messages with buttons
  const callbackAnswers = [] // answerCallbackQuery payloads
  const edits = [] // editMessageText payloads
  const commands = [] // setMyCommands payloads
  const pollQueries = [] // getUpdates query strings
  let polls = 0
  // Scheduled button presses. They mutate `queue` when they fire, so close has
  // to own them: a press that lands after disposal would write to a queue nobody
  // will read and keep the process alive on a pending timer.
  const pending = new Set()
  const schedule = (fire, afterMs) => {
    const timer = setTimeout(() => {
      pending.delete(timer)
      fire()
    }, afterMs)
    pending.add(timer)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname.endsWith('/getUpdates')) {
      polls += 1
      pollQueries.push(url.search)
      json(200, { ok: true, result: queue.splice(0) })
    } else if (url.pathname.endsWith('/sendMessage')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const payload = JSON.parse(body)
        sent.push(payload)
        const messageId = sent.length
        // Auto-press the first "approve" button of any approval message and the
        // first option button of any forwarded question.
        const buttons = (payload.reply_markup?.inline_keyboard ?? []).flat()
        const approveButton = buttons.find(b => b.callback_data?.startsWith('approve:'))
        if (approveButton !== undefined) {
          approvals.push(payload)
          // A press from a chat outside the allowlist (e.g. a forwarded approval)
          // arrives first and must be refused without settling the approval.
          queue.push({
            update_id: 9_000 + approvals.length,
            callback_query: {
              id: `cb-stranger-${approvals.length}`,
              from: { id: strangerId },
              message: { message_id: messageId, chat: { id: strangerId } },
              data: approveButton.callback_data,
            },
          })
          schedule(() => {
            queue.push({
              update_id: 10_000 + approvals.length,
              callback_query: {
                id: `cb-${approvals.length}`,
                from: { id: chatId },
                message: { message_id: messageId, chat: { id: chatId } },
                data: approveButton.callback_data,
              },
            })
          }, pressDelayMs)
        } else {
          const questionButton = buttons.find(b => b.callback_data?.startsWith('question:'))
          if (questionButton !== undefined) {
            questions.push(payload)
            schedule(() => {
              queue.push({
                update_id: 20_000 + questions.length,
                callback_query: {
                  id: `qb-${questions.length}`,
                  from: { id: chatId },
                  message: { message_id: messageId, chat: { id: chatId } },
                  data: questionButton.callback_data,
                },
              })
            }, pressDelayMs)
          }
        }
        json(200, { ok: true, result: { message_id: messageId } })
      })
    } else if (url.pathname.endsWith('/sendChatAction')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        actions.push(JSON.parse(body))
        json(200, { ok: true, result: true })
      })
    } else if (url.pathname.endsWith('/answerCallbackQuery')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        callbackAnswers.push(JSON.parse(body))
        json(200, { ok: true, result: true })
      })
    } else if (url.pathname.endsWith('/editMessageText')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        edits.push(JSON.parse(body))
        json(200, { ok: true, result: { message_id: 1 } })
      })
    } else if (url.pathname.endsWith('/setMyCommands')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        commands.push(JSON.parse(body))
        json(200, { ok: true, result: true })
      })
    } else {
      json(404, { ok: false, description: `no route ${url.pathname}` })
    }
  })

  await listenOnFreePort(server)
  // One shutdown, however many callers ask: a second `close()` returns the same
  // promise rather than resolving early against a server that is still up.
  let closing
  const close = () => {
    closing ??= (async () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
      await new Promise((done) => server.close(() => done()))
    })()
    return closing
  }
  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    /** Deliver this update to the next getUpdates call. */
    queue,
    observations: {
      sent,
      actions,
      approvals,
      questions,
      callbackAnswers,
      edits,
      commands,
      pollQueries,
      /** How many getUpdates calls the bot has made so far. */
      pollCount: () => polls,
    },
    /** Stop serving and cancel scheduled presses. Concurrent callers await the same shutdown. */
    close,
  }
}

/**
 * Start a mock OpenAI-compatible endpoint.
 *
 * Answers `/chat/completions` as SSE (or JSON when `stream === false`), and
 * turns a prompt asking for the approval or the question test into the matching
 * tool call so those flows can be driven without a real model.
 *
 * @returns the endpoint it bound (port and base URL), the request bodies it
 *   received, and a `close()` that awaits one shared shutdown.
 */
export async function startFakeLlm() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      const payload = JSON.parse(body)
      requests.push(payload)
      const content = 'Hello <world> & everyone \u2705'
      // Only the CURRENT prompt's last user message may trigger the approval
      // tool call — matching against full history would loop forever.
      const messages = payload.messages ?? []
      const lastUser = [...messages].reverse().find(m => m.role === 'user')
      const lastUserText = typeof lastUser?.content === 'string'
        ? lastUser.content
        : (Array.isArray(lastUser?.content) ? lastUser.content.map(p => p.text ?? '').join('') : '')
      const wantsApproval = lastUserText.includes('run approval test')
      const wantsQuestion = lastUserText.includes('run question test')
      const toolCallArgs = JSON.stringify({
        command: 'echo hi > /tmp/tg-approval-smoke',
        description: 'run approval smoke test',
        sandbox_permissions: 'workspace-write',
        justification: 'smoke test approval flow',
      })
      const questionCallArgs = JSON.stringify({
        questions: [{ id: 'q1', question: 'Approve the smoke plan?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      })
      if (payload.stream !== false) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunks = wantsApproval
          ? [
            { id: 'mock-tc-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
            { id: 'mock-tc-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: toolCallArgs } }] }, finish_reason: 'tool_calls' }] },
          ]
          : wantsQuestion
            ? [
              { id: 'mock-q-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
              { id: 'mock-q-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'ask_user_question', arguments: questionCallArgs } }] }, finish_reason: 'tool_calls' }] },
            ]
            : [
            { id: 'mock-0', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: 'Let me think carefully about this request.' }, finish_reason: null }] },
            { id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
            { id: 'mock-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
            { id: 'mock-3', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'mock-1', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        }))
      }
    })
  })

  await listenOnFreePort(server)
  let closing
  const close = () => {
    closing ??= new Promise((done) => server.close(() => done()))
    return closing
  }
  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** Stop serving. Concurrent callers await the same shutdown. */
    close,
  }
}

/** Bind on an ephemeral loopback port, so callers never pick a number. */
function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}
