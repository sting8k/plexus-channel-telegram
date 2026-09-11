/**
 * dsh-telegram-control — remote control for DeepSeek Harness over Telegram.
 *
 * A Cordis function plugin that runs a long-polling Telegram bot inside the
 * harness process. Authorized chats can inspect the harness (`/status`,
 * `/agents`, `/jobs`), select and drive an agent (`/agent`, `/cancel`, plain
 * text as a follow-up), kill background jobs (`/kill`), and opt into a live
 * activity feed (`/watch` / `/unwatch`). Agent replies are relayed back to the
 * requesting chat when the agent's turn settles.
 *
 * All outbound text is HTML-escaped before it reaches Telegram.
 *
 * @module dsh-telegram-control
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { TelegramApiError, TelegramClient, chatKeyOf, keyOf, } from "./client.js";
import { escapeHtml, homeShorten, markdownToTelegramHtml, parseApprovalCallback, parseBotCommand, parseQuestionCallback, questionOptions, renderUptime, splitMessage, toolCallPreview, trimReasoning } from "./format.js";
export const name = 'telegram-control';
export const inject = ['agents', 'sessions'];
const DEFAULT_API_BASE = 'https://api.telegram.org';
const DEFAULT_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_TIMEOUT_SEC = 50;
const DEFAULT_REASONING_MAX_CHARS = 300;
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_MESSAGE_CHARS = 4000;
const MAX_BACKOFF_MS = 30_000;
/** The bot's command menu, published via `setMyCommands` so the input field
 * offers the plugin's commands without typing the leading slash by hand. */
const BOT_COMMANDS = [
    { command: 'help', description: 'Command list' },
    { command: 'status', description: 'Harness status' },
    { command: 'agents', description: 'List conversations' },
    { command: 'agent', description: 'Select a conversation' },
    { command: 'jobs', description: 'Background jobs' },
    { command: 'kill', description: 'Stop a job' },
    { command: 'cancel', description: 'Cancel the current turn' },
    { command: 'watch', description: 'Enable live forwarding' },
    { command: 'unwatch', description: 'Disable live forwarding' },
    { command: 'chatid', description: 'Show this chat id' },
];
export const Config = z.object({
    token: z.string(),
    allowedChatIds: z.array(z.number()),
    apiBase: z.string(),
    defaultAgentId: z.string(),
    pollTimeoutSec: z.number().step(1).min(1).max(50),
    replyTimeoutMs: z.number().step(1).min(1000),
    showToolCalls: z.boolean(),
    reasoningMaxChars: z.number().step(1).min(0),
    approvalTimeoutMs: z.number().step(1).min(1000),
    maxMessageChars: z.number().step(1).min(200).max(4096),
});
/** Parse the comma-separated `DSH_TELEGRAM_ALLOWED_CHATS` environment value. */
function parseChatIdsEnv() {
    const raw = process.env.DSH_TELEGRAM_ALLOWED_CHATS;
    if (raw === undefined || raw === '')
        return [];
    return raw
        .split(',')
        .map(part => Number(part.trim()))
        .filter(value => Number.isSafeInteger(value) && value !== 0);
}
/** Render an arbitrary thrown value without trusting its string coercion. */
function describeError(error) {
    if (error instanceof Error)
        return error.message;
    try {
        return String(error);
    }
    catch {
        return '<unprintable error>';
    }
}
/** Extract the visible text and trimmed thinking blocks of an assistant message. */
function assistantText(message, reasoningMaxChars) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text')
            parts.push(block.text);
        else if (block.type === 'reasoning') {
            const trimmed = trimReasoning(block.text, reasoningMaxChars);
            if (trimmed !== '')
                parts.push(`💭 ${trimmed}`);
        }
    }
    return parts.join('\n\n');
}
/** A sleep that resolves early when the abort signal fires. */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
export function apply(ctx, config) {
    const token = config.token !== undefined && config.token !== ''
        ? config.token
        : process.env.DSH_TELEGRAM_TOKEN;
    if (token === undefined || token === '') {
        throw new Error('telegram-control: no bot token — set config.token or DSH_TELEGRAM_TOKEN');
    }
    // schemastery validates a missing array field to `[]`, so an explicit empty
    // array and an absent one both mean "resolve from the environment".
    const allowedChatIds = config.allowedChatIds !== undefined && config.allowedChatIds.length > 0
        ? config.allowedChatIds
        : parseChatIdsEnv();
    const apiBase = config.apiBase ?? DEFAULT_API_BASE;
    const defaultAgentId = config.defaultAgentId ?? '';
    const pollTimeoutSec = config.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
    const replyTimeoutMs = config.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    const showToolCalls = config.showToolCalls ?? false;
    const reasoningMaxChars = config.reasoningMaxChars ?? DEFAULT_REASONING_MAX_CHARS;
    const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const maxMessageChars = config.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    const client = new TelegramClient(token, apiBase);
    const chats = new Map();
    const pendingBySession = new Map();
    const abort = new AbortController();
    // Resolve the Harness home through the launcher-provided accessor when
    // present, then the environment, then the platform default.
    const homePath = () => {
        const provided = ctx.get('dshHomePath');
        if (typeof provided === 'function')
            return provided();
        return process.env.DSH_HOME ?? join(homedir(), '.dsh');
    };
    // Per-chat agent selections persist across harness restarts so a chat keeps
    // talking to the same agent.
    const stateFile = join(homePath(), 'telegram-control-state.json');
    const chatSelections = {};
    try {
        if (existsSync(stateFile)) {
            Object.assign(chatSelections, JSON.parse(readFileSync(stateFile, 'utf8')));
        }
    }
    catch (error) {
        ctx.logger.warn(`telegram-control: cannot read ${stateFile}: ${describeError(error)}`);
    }
    // Human-readable agent names: the latest `session/title` event per session.
    // The map is a cache: seeding covers sessions live at mount, `session/created`
    // covers later appearances, and the conversation helpers re-fold the log as a
    // fallback, so a session whose title predates this plugin is still named.
    const titles = new Map();
    // Session history moved from the `events` property to `snapshotEvents()` in
    // `session.events` was removed in 0.1.2; `snapshotEvents()` is the only way to
    // read a session's events, and the peer range no longer admits the older form.
    const sessionEvents = (session) => session.snapshotEvents();
    const seedTitle = (session) => {
        const snapshot = foldSessionTitle(sessionEvents(session));
        if (snapshot !== undefined)
            titles.set(session.id, snapshot.title);
    };
    for (const session of ctx.sessions.list())
        seedTitle(session);
    ctx.effect(() => () => abort.abort());
    // Approval requests awaiting a Telegram button press, keyed by the random
    // token embedded in the button callback_data.
    const pendingApprovals = new Map();
    ctx.effect(() => () => {
        for (const entry of pendingApprovals.values()) {
            entry.timeoutDispose();
            entry.resolve('cancelled');
        }
        pendingApprovals.clear();
    });
    // User questions forwarded to Telegram; settled by a button press or by the
    // wrapped `ask` falling through to the Web dialog's answer.
    const pendingQuestions = new Map();
    const disposePendingQuestions = () => {
        for (const entry of pendingQuestions.values())
            entry.timeoutDispose();
        pendingQuestions.clear();
    };
    ctx.effect(() => disposePendingQuestions);
    // User questions flow through a SINGLE UI provider, and the Web UI owns that
    // seat. Instead of fighting for it, wrap `userQuestions.ask` — deferred until
    // the service exists, because it may mount after this plugin — so every
    // question is also surfaced in Telegram with option buttons; the first answer
    // (a Telegram button or the Web dialog) wins.
    ctx.inject(['userQuestions'], (scope) => {
        if (allowedChatIds.length === 0)
            return;
        const questionService = scope.userQuestions;
        const originalAsk = questionService.ask.bind(questionService);
        questionService.ask = (request) => {
            if (request.questions.length === 0)
                return originalAsk(request);
            const web = Promise.resolve(originalAsk(request));
            const { promise, resolve, reject } = Promise.withResolvers();
            let settled = false;
            const settle = (answer) => {
                if (settled)
                    return;
                settled = true;
                disposePendingQuestions();
                resolve(answer);
            };
            const fail = (error) => {
                if (settled)
                    return;
                settled = true;
                disposePendingQuestions();
                reject(error);
            };
            void web.then(settle, fail);
            void forwardQuestions(request, settle).catch((error) => {
                ctx.logger.warn(`telegram-control: question forwarding failed: ${describeError(error)}`);
            });
            return promise;
        };
    });
    const logWarn = (error) => {
        ctx.logger.warn(`telegram-control: ${describeError(error)}`);
    };
    const jobsService = () => ctx.get('jobs');
    const persistence = () => ctx.get('sessionPersistence');
    const presetsService = () => ctx.get('agentPresets');
    const defaultModel = () => ctx.get('agentDefaultModel');
    /** Shorten a session id for display when it has no title. */
    function shortSessionId(id) {
        return id.length > 18 ? `${id.slice(0, 15)}…` : id;
    }
    /** Resolve one persisted session's title from its stored log, cached per session. */
    const storedTitles = new Map();
    async function storedTitle(sessionId) {
        const cached = storedTitles.get(sessionId);
        if (cached !== undefined)
            return cached;
        const service = persistence();
        if (service === undefined)
            return undefined;
        try {
            const inspected = await service.inspect(sessionId);
            const snapshot = foldSessionTitle(inspected.events);
            if (snapshot !== undefined) {
                storedTitles.set(sessionId, snapshot.title);
                return snapshot.title;
            }
        }
        catch (error) {
            ctx.logger.warn(`telegram-control: reading title for ${sessionId} failed: ${describeError(error)}`);
        }
        return undefined;
    }
    /** All conversations: live agents plus persisted sessions, most recent first. */
    /** How a live agent appears as a conversation, in the lister and elsewhere. */
    const toEntry = (agent) => ({
        sessionId: agent.session.id,
        agent,
        cwd: agent.session.header.cwd,
        createdAt: agent.session.header.createdAt,
    });
    async function listConversations() {
        const agents = ctx.agents.list();
        const entries = agents.map(toEntry);
        const service = persistence();
        if (service !== undefined) {
            try {
                const stored = await service.list();
                const liveIds = new Set(agents.map(agent => agent.session.id));
                for (const header of stored) {
                    // Subagent children are work products, not conversations.
                    if (header.origin === 'subagent')
                        continue;
                    if (liveIds.has(header.id))
                        continue;
                    entries.push({ sessionId: header.id, agent: undefined, cwd: header.cwd, createdAt: header.createdAt });
                }
            }
            catch (error) {
                ctx.logger.warn(`telegram-control: listing persisted sessions failed: ${describeError(error)}`);
            }
        }
        entries.sort((a, b) => b.createdAt - a.createdAt);
        return entries;
    }
    /** The title of a conversation entry, live-folded or read from storage. */
    async function conversationTitle(entry) {
        if (entry.agent !== undefined) {
            return titles.get(entry.sessionId) ?? foldSessionTitle(sessionEvents(entry.agent.session))?.title;
        }
        return storedTitle(entry.sessionId);
    }
    /** Bring a conversation live, resuming a persisted session exactly like the Web UI does. */
    async function ensureLiveAgent(sessionId) {
        const live = ctx.agents.get(sessionId);
        if (live !== undefined)
            return live;
        const service = persistence();
        if (service === undefined)
            return undefined;
        try {
            const presets = presetsService();
            let presetId;
            // The preset a session is running is read from the session-query seam when
            // the host provides one, and left undefined otherwise: the caller then falls
            // back to the deployment default, which is what it did before this seam
            // existed. The observation is a synchronous Disposable, so it is released
            // in a `finally` rather than left to a collection.
            const query = ctx.get('sessionQuery');
            if (typeof query?.observeSession === 'function') {
                try {
                    const observation = await query.observeSession(sessionId, { projectionMode: 'all' });
                    try {
                        presetId = observation.projections?.values?.agentPreset ?? undefined;
                    }
                    finally {
                        observation[Symbol.dispose]();
                    }
                }
                catch (error) {
                    ctx.logger.warn(`telegram-control: preset resolution for ${sessionId} failed: ${describeError(error)}`);
                }
            }
            const selection = defaultModel()?.currentSelection() ?? {};
            const handle = await ctx.agents.resume({
                resumeSessionId: sessionId,
                agentOptions: selection,
                setup: async (agentCtx) => {
                    // Mount the session's recorded preset, or the deployment default
                    // when none is recorded — exactly like the Web UI's cold resume.
                    if (presets !== undefined) {
                        await presets.mount(agentCtx, (await presets.resolve(presetId)).id);
                    }
                },
            });
            return handle.agent;
        }
        catch (error) {
            // A concurrent resume from the Web UI may have won the identity race.
            const winner = ctx.agents.get(sessionId);
            if (winner !== undefined)
                return winner;
            ctx.logger.warn(`telegram-control: resuming ${sessionId} failed: ${describeError(error)}`);
            return undefined;
        }
    }
    /** Look up a chat's state, creating it on first contact with the persisted selection. */
    function ensureChat(chat) {
        const key = keyOf(chat);
        let state = chats.get(key);
        if (state === undefined) {
            state = { chat, agentId: chatSelections[key] ?? undefined, watching: false };
            chats.set(key, state);
        }
        return state;
    }
    /** The display name of an agent: its session title, or a short id when untitled. */
    function agentDisplay(agent) {
        const title = titles.get(agent.session.id) ?? foldSessionTitle(sessionEvents(agent.session))?.title;
        if (title !== undefined)
            return { name: title, hasTitle: true };
        const id = agent.id;
        return { name: id.length > 18 ? `${id.slice(0, 15)}…` : id, hasTitle: false };
    }
    /** `[~/Code]`-style workspace suffix from the session header cwd, when present. */
    function workspacePart(agent) {
        const cwd = agent.session.header.cwd;
        if (cwd === undefined || cwd === '')
            return '';
        return ` [${escapeHtml(homeShorten(cwd, homedir()))}]`;
    }
    /** One-line agent description for listings and confirmations: name + workspace. */
    function describeAgent(agent) {
        const { name, hasTitle } = agentDisplay(agent);
        const body = hasTitle ? `<b>${escapeHtml(name)}</b>` : `<code>${escapeHtml(name)}</code>`;
        return `${body}${workspacePart(agent)}`;
    }
    /** Persist one chat's agent selection to the state file. */
    function persistChatSelections() {
        try {
            writeFileSync(stateFile, `${JSON.stringify(chatSelections, null, 2)}\n`);
        }
        catch (error) {
            ctx.logger.warn(`telegram-control: cannot write ${stateFile}: ${describeError(error)}`);
        }
    }
    /** A short name for a conversation, from what the update carries: the topic id. */
    function describeChat(chat) {
        return chat.threadId === undefined ? 'the main chat' : `topic ${chat.threadId}`;
    }
    /**
     * Record a selection and return the confirmation text to send.
     *
     * One session belongs to one conversation at a time: taking it from whoever
     * held it is what lets a question or an approval be routed by session id alone,
     * rather than guessed between conversations that both claim it — and the
     * conversation that lost it is told, instead of going quiet with no reason.
     */
    async function selectEntry(chat, entry) {
        const key = keyOf(chat);
        const state = ensureChat(chat);
        const moved = [...chats.values()].filter((other) => keyOf(other.chat) !== key && other.agentId === entry.sessionId);
        state.agentId = entry.sessionId;
        chatSelections[key] = entry.sessionId;
        for (const other of moved) {
            other.agentId = undefined;
            delete chatSelections[keyOf(other.chat)];
        }
        // A holder that has not spoken in this process has no conversation to tell, so
        // its persisted entry is dropped without a notice: uniqueness is the invariant,
        // and this is the only side of it that has nothing to send to.
        for (const held of Object.keys(chatSelections)) {
            if (held !== key && chatSelections[held] === entry.sessionId)
                delete chatSelections[held];
        }
        persistChatSelections();
        const title = await conversationTitle(entry);
        const namePart = title !== undefined
            ? `<b>${escapeHtml(title)}</b>`
            : `<code>${escapeHtml(shortSessionId(entry.sessionId))}</code>`;
        const cwdPart = entry.cwd !== undefined && entry.cwd !== ''
            ? ` [${escapeHtml(homeShorten(entry.cwd, homedir()))}]`
            : '';
        const pausedNote = entry.agent === undefined ? ' (paused — resumes on your first message)' : '';
        for (const other of moved) {
            await client.sendMessage(other.chat, `conversation moved to ${describeChat(chat)}`);
        }
        await client.sendMessage(chat, `Selected ${namePart}${cwdPart}.${pausedNote}`);
    }
    /** Resolve the agent a chat's plain messages target: explicit selection, default, then the single conversation. */
    async function resolveAgent(chat) {
        const state = ensureChat(chat);
        for (const candidate of [state.agentId, defaultAgentId]) {
            if (candidate === undefined || candidate === '')
                continue;
            return await ensureLiveAgent(SessionId(candidate));
        }
        const entries = await listConversations();
        if (entries.length === 1)
            return await ensureLiveAgent(entries[0].sessionId);
        return undefined;
    }
    /** Send a message, splitting over-long payloads into Telegram-safe chunks. */
    async function sendChunks(chat, text) {
        for (const chunk of splitMessage(text, maxMessageChars)) {
            await client.sendMessage(chat, chunk);
        }
    }
    /** How often the indicator is refreshed while a turn is pending. */
    const TYPING_INTERVAL_MS = 4_000;
    /** The longest a turn may keep it up, so a turn that never settles cannot type forever. */
    const TYPING_CAP_MS = 300_000;
    /**
     * Show, and keep showing, the typing indicator while a turn is pending.
     *
     * Telegram's indicator expires after about five seconds, so the single call a
     * turn used to make was long gone before a real answer arrived and the reader
     * was left guessing whether anything was happening. This refreshes it; the cap
     * stops a turn that never settles from typing forever. A failed refresh is
     * logged and ignored — the indicator is a courtesy, and the turn it describes
     * is not.
     *
     * @param chat - the conversation to show the indicator in.
     * @returns an idempotent stop; the plugin's fiber also clears the timers.
     */
    function startTyping(chat) {
        const send = () => {
            void client.sendChatAction(chat, 'typing').catch(logWarn);
        };
        send();
        const interval = setInterval(send, TYPING_INTERVAL_MS);
        const cap = setTimeout(() => stop(), TYPING_CAP_MS);
        // `stop` cannot run before this assignment: the cap is minutes away, and the
        // fiber effect below clears both timers if the plugin goes away first.
        let dispose = () => { };
        let stopped = false;
        const stop = () => {
            if (stopped)
                return;
            stopped = true;
            clearInterval(interval);
            clearTimeout(cap);
            dispose();
        };
        dispose = ctx.effect(() => () => {
            clearInterval(interval);
            clearTimeout(cap);
        }, 'telegram-control.typing()');
        return stop;
    }
    /**
     * Start the indicator for a pending reply unless it is already running.
     *
     * The entry owns the timer, so the follow-up and the status flip share one
     * lifecycle instead of racing two intervals into the same conversation.
     */
    function ensureTyping(entry) {
        if (entry.typingStop !== undefined)
            return;
        entry.typingStop = startTyping(entry.chat);
    }
    /** Register a pending reply for `chat` on `agent`'s session; call before `agent.followup`. */
    function registerPending(agent, chat, messageId) {
        const sessionId = agent.session.id;
        const key = keyOf(chat);
        let byChat = pendingBySession.get(sessionId);
        if (byChat === undefined) {
            byChat = new Map();
            pendingBySession.set(sessionId, byChat);
        }
        const existing = byChat.get(key);
        if (existing !== undefined) {
            existing.timeoutDispose();
            existing.typingStop?.();
        }
        const entry = {
            chat,
            buffer: [],
            startedAt: Date.now(),
            messageId,
            turn: undefined,
            typingStop: undefined,
            timeoutDispose: () => { },
        };
        entry.timeoutDispose = ctx.effect(() => {
            const timer = setTimeout(() => flush(sessionId, chat, 'timeout'), replyTimeoutMs);
            return () => clearTimeout(timer);
        }, 'telegram-control.replyTimeout()');
        byChat.set(key, entry);
        // Typing starts with the pending lifecycle, so every way that lifecycle ends —
        // flush, the timeout, a failed follow-up, disposal — stops it in one place.
        ensureTyping(entry);
    }
    /** Remove a pending reply and deliver whatever was accumulated. */
    function flush(sessionId, chat, reason) {
        const key = keyOf(chat);
        const byChat = pendingBySession.get(sessionId);
        const entry = byChat?.get(key);
        if (byChat === undefined || entry === undefined)
            return;
        byChat.delete(key);
        if (byChat.size === 0)
            pendingBySession.delete(sessionId);
        entry.timeoutDispose();
        entry.typingStop?.();
        const text = entry.buffer.join('\n\n').trim();
        const note = reason === 'timeout'
            ? `(agent still busy after ${Math.round((Date.now() - entry.startedAt) / 1000)}s)`
            : '(agent finished without textual output)';
        void sendChunks(chat, text === '' ? note : text).catch(logWarn);
    }
    /** Forward one assistant message to every watching chat. */
    function forwardWatching(text) {
        for (const state of chats.values()) {
            if (state.watching)
                void sendChunks(state.chat, text).catch(logWarn);
        }
    }
    /**
     * Where a question or an approval for one agent belongs.
     *
     * A request is answered where the agent was picked, not in every chat the bot
     * can post to: selecting an agent takes it from every previous holder, so its
     * conversation is unique and this lookup is exact. Only an agent no Telegram
     * conversation owns — started from the Web UI or the socket — fans out to every
     * allowed chat, which is what always happened before a conversation could be a
     * topic. A session two conversations claim is a state selection is meant to make
     * impossible, and it delivers nothing.
     */
    function targetsFor(sessionId) {
        const fallback = allowedChatIds.map((chatId) => ({ chatId }));
        if (sessionId === undefined)
            return fallback;
        const owners = [...chats.values()].filter((state) => state.agentId === sessionId);
        if (owners.length === 1)
            return [owners[0].chat];
        if (owners.length > 1) {
            // Not a neutral choice: an approval forwarded to a conversation that does
            // not own the agent lets that conversation authorize its tool calls. So this
            // refuses to deliver, says which session and which conversations, and lets
            // the approval time out (or the question fall through to the Web dialog) —
            // both degrade to something the caller already handles.
            ctx.logger.error(`telegram-control: ${owners.length} conversations claim agent ${sessionId} ` +
                `(${owners.map((state) => keyOf(state.chat)).join(', ')}); ` +
                'no question or approval was delivered for it');
            return [];
        }
        return fallback;
    }
    /** Edit every forwarded approval message to show the settled outcome. */
    async function updateApprovalMessages(entry, suffix) {
        for (const { chat, messageId } of entry.sent) {
            try {
                await client.editMessageText(chat, messageId, `${entry.text}\n\n${suffix}`);
            }
            catch (error) {
                ctx.logger.warn(`telegram-control: editing approval message ${messageId} failed: ${describeError(error)}`);
            }
        }
    }
    /** Edit every forwarded question message to show the chosen answer. */
    async function updateQuestionMessages(entry, suffix) {
        for (const { chat, messageId } of entry.sent) {
            try {
                await client.editMessageText(chat, messageId, `${entry.text}\n\n${suffix}`);
            }
            catch (error) {
                ctx.logger.warn(`telegram-control: editing question message ${messageId} failed: ${describeError(error)}`);
            }
        }
    }
    /** Forward one user-question request to Telegram with option buttons. */
    async function forwardQuestions(request, settle) {
        if (request.questions.length === 0)
            return;
        for (const item of request.questions) {
            // Multi-select and free-text questions have no one-button answer; show
            // them as notifications and let the Web dialog collect the answer.
            const singleSelect = item.multiSelect !== true && (item.options?.length ?? 0) > 0;
            const token = randomUUID();
            const options = item.options ?? [];
            const header = item.header !== undefined ? `${item.header}\n` : '';
            // Every option is spelled out in the body; when the question has a single
            // answer the buttons carry the same options, numbered to match. One
            // builder keeps the numbering and the order identical between the two.
            const { lines: optionLines, keyboard } = questionOptions(options, token, singleSelect);
            const text = [
                '❓ <b>Question</b>',
                `Agent: ${describeAgentSafe(request.agent)}`,
                `${header}${escapeHtml(item.question)}`,
                item.detail !== undefined && item.detail !== '' ? `\n${escapeHtml(item.detail)}` : '',
                optionLines.length > 0 ? `\n${optionLines.join('\n')}` : '',
            ].filter(part => part !== '').join('\n');
            const sent = [];
            const entry = {
                resolve: settle,
                text,
                sent,
                items: options.map(option => ({ id: item.id, label: option.label })),
                timeoutDispose: () => { },
            };
            if (singleSelect) {
                const timer = setTimeout(() => {
                    const current = pendingQuestions.get(token);
                    if (current === undefined)
                        return;
                    pendingQuestions.delete(token);
                    void updateQuestionMessages(current, '⏹️ <b>Cancelled</b> (no answer in time).').catch(logWarn);
                }, approvalTimeoutMs);
                entry.timeoutDispose = () => clearTimeout(timer);
                pendingQuestions.set(token, entry);
            }
            try {
                for (const chat of targetsFor(request.agent?.session.id)) {
                    const result = await client.sendMessage(chat, text, keyboard === undefined ? {} : { replyMarkup: keyboard });
                    sent.push({ chat, messageId: result.message_id });
                }
            }
            catch (error) {
                ctx.logger.warn(`telegram-control: forwarding question failed: ${describeError(error)}`);
                if (pendingQuestions.has(token))
                    pendingQuestions.delete(token);
            }
        }
    }
    /** Agent label without a live agent (questions may lack one). */
    function describeAgentSafe(agent) {
        return agent === undefined ? '<code>unknown</code>' : describeAgent(agent);
    }
    /** Answer one inline-button press on a forwarded approval request. */
    async function handleCallbackQuery(query) {
        // Same gate as messages: a button press only counts from an authorized chat.
        // Tokens are random, but a forwarded approval message would otherwise let
        // anyone who sees it decide; the chat that holds the keyboard must be allowed.
        const origin = query.message;
        if (origin === undefined || !allowedChatIds.includes(origin.chat.id)) {
            await client.answerCallbackQuery(query.id, 'not authorized');
            return;
        }
        const data = query.data;
        if (data === undefined) {
            await client.answerCallbackQuery(query.id, 'no action');
            return;
        }
        const question = parseQuestionCallback(data);
        if (question !== undefined) {
            const entry = pendingQuestions.get(question.token);
            if (entry === undefined) {
                await client.answerCallbackQuery(query.id, 'question already settled');
                return;
            }
            pendingQuestions.delete(question.token);
            entry.timeoutDispose();
            const item = entry.items[question.optionIndex];
            if (item === undefined || question.optionIndex < 0) {
                await client.answerCallbackQuery(query.id, 'invalid option');
                return;
            }
            const answer = { answers: [{ id: item.id, selected: [item.label] }] };
            await client.answerCallbackQuery(query.id, 'Selected');
            entry.resolve(answer);
            void updateQuestionMessages(entry, `✅ Selected: ${item.label}`).catch(logWarn);
            return;
        }
        const parsed = parseApprovalCallback(data);
        if (parsed === undefined) {
            await client.answerCallbackQuery(query.id, 'stale button');
            return;
        }
        const { approve, token } = parsed;
        const entry = pendingApprovals.get(token);
        if (entry === undefined) {
            await client.answerCallbackQuery(query.id, 'request already settled');
            return;
        }
        pendingApprovals.delete(token);
        entry.timeoutDispose();
        const outcome = approve ? 'allowed-once' : 'rejected';
        await client.answerCallbackQuery(query.id, approve ? 'Approved' : 'Rejected');
        entry.resolve(outcome);
        ctx.logger.info(`telegram-control: approval ${token.slice(0, 8)} ${approve ? 'approved' : 'rejected'} via Telegram`);
        void updateApprovalMessages(entry, approve
            ? '✅ <b>Approved</b> (allowed once).'
            : '❌ <b>Rejected</b>.').catch(logWarn);
    }
    /** Handle one Telegram message from an authorized chat. */
    async function handleMessage(message) {
        if (message.text === undefined)
            return;
        const chat = chatKeyOf(message);
        const parsed = parseBotCommand(message.text);
        if (parsed !== undefined) {
            await handleCommand(chat, parsed.command, parsed.rawInput);
        }
        else {
            await handlePlain(chat, message.text);
        }
    }
    /** Dispatch a parsed bot command. */
    async function handleCommand(chat, command, rawInput) {
        // The id, not the topic, is what an operator reads and edits in config.
        const chatId = chat.chatId;
        switch (command) {
            case 'start':
            case 'help':
                await sendChunks(chat, helpText());
                return;
            case 'chatid':
                await client.sendMessage(chat, `Your chat id is <code>${chatId}</code>.`);
                return;
            case 'status': {
                const entries = await listConversations();
                const live = entries.filter(entry => entry.agent !== undefined).length;
                const jobs = jobsService()?.list() ?? [];
                const lines = [
                    '🤖 <b>dsh status</b>',
                    `uptime: ${renderUptime(process.uptime())}`,
                    `conversations: ${entries.length} (${live} live)`,
                    `jobs: ${jobs.length}`,
                ];
                await sendChunks(chat, lines.join('\n'));
                return;
            }
            case 'agents': {
                const state = ensureChat(chat);
                const entries = await listConversations();
                if (entries.length === 0) {
                    await client.sendMessage(chat, 'No conversations yet. Start one from the Web UI first.');
                    return;
                }
                const lines = [];
                for (const [index, entry] of entries.entries()) {
                    const icon = entry.agent === undefined ? '⚪' : entry.agent.status === 'running' ? '⏳' : '🟢';
                    const selected = state.agentId === entry.sessionId ? ' 👈' : '';
                    const title = await conversationTitle(entry);
                    const namePart = title !== undefined
                        ? `<b>${escapeHtml(title)}</b>`
                        : `<code>${escapeHtml(shortSessionId(entry.sessionId))}</code>`;
                    const cwdPart = entry.cwd !== undefined && entry.cwd !== ''
                        ? ` [${escapeHtml(homeShorten(entry.cwd, homedir()))}]`
                        : '';
                    const statusPart = entry.agent !== undefined
                        ? `${entry.agent.status} — ${escapeHtml(entry.agent.options.model ?? entry.agent.options.provider ?? 'unknown')}`
                        : 'paused';
                    lines.push(`${index + 1}. ${icon} ${namePart}${cwdPart}${selected} — ${statusPart}`);
                }
                await sendChunks(chat, `Conversations — pick one with <code>/agent &lt;number&gt;</code> or <code>/agent &lt;name&gt;</code> (paused ones resume on your first message):\n${lines.join('\n')}`);
                return;
            }
            case 'agent': {
                const state = ensureChat(chat);
                const requested = rawInput.trim();
                if (requested === '') {
                    const current = state.agentId;
                    if (current === undefined) {
                        await client.sendMessage(chat, 'No agent selected. Use <code>/agents</code> then <code>/agent &lt;number&gt;</code>.');
                    }
                    else {
                        const entries = await listConversations();
                        const entry = entries.find(candidate => candidate.sessionId === SessionId(current));
                        if (entry === undefined) {
                            await client.sendMessage(chat, `Selected session <code>${escapeHtml(current)}</code> (not found).`);
                        }
                        else {
                            const title = await conversationTitle(entry);
                            const namePart = title !== undefined
                                ? `<b>${escapeHtml(title)}</b>`
                                : `<code>${escapeHtml(shortSessionId(entry.sessionId))}</code>`;
                            const cwdPart = entry.cwd !== undefined && entry.cwd !== ''
                                ? ` [${escapeHtml(homeShorten(entry.cwd, homedir()))}]`
                                : '';
                            await client.sendMessage(chat, `Selected: ${namePart}${cwdPart}`);
                        }
                    }
                    return;
                }
                const entries = await listConversations();
                // 1) exact session id
                const exact = entries.find(entry => entry.sessionId === SessionId(requested));
                if (exact !== undefined) {
                    await selectEntry(chat, exact);
                    return;
                }
                // 2) 1-based index into the /agents listing
                const index = Number(requested);
                if (Number.isSafeInteger(index) && index >= 1 && index <= entries.length) {
                    const entry = entries[index - 1];
                    if (entry !== undefined) {
                        await selectEntry(chat, entry);
                        return;
                    }
                }
                // 3) case-insensitive substring match on the title or session id
                const needle = requested.toLowerCase();
                const matches = [];
                for (const entry of entries) {
                    const label = (await conversationTitle(entry)) ?? '';
                    if (label.toLowerCase().includes(needle) || entry.sessionId.toLowerCase().includes(needle)) {
                        matches.push(entry);
                    }
                }
                if (matches.length === 1) {
                    await selectEntry(chat, matches[0]);
                    return;
                }
                if (matches.length > 1) {
                    const candidateLines = [];
                    for (const match of matches) {
                        const label = (await conversationTitle(match)) ?? shortSessionId(match.sessionId);
                        candidateLines.push(`• ${escapeHtml(label)}`);
                    }
                    await client.sendMessage(chat, `Multiple conversations match "<code>${escapeHtml(requested)}</code>":\n${candidateLines.join('\n')}\nUse <code>/agent &lt;number&gt;</code> to pick one.`);
                    return;
                }
                await client.sendMessage(chat, `No conversation matches "<code>${escapeHtml(requested)}</code>". Use <code>/agents</code> to list them.`);
                return;
            }
            case 'jobs': {
                const service = jobsService();
                if (service === undefined) {
                    await client.sendMessage(chat, 'jobs service unavailable in this profile.');
                    return;
                }
                const jobs = service.list();
                if (jobs.length === 0) {
                    await client.sendMessage(chat, 'No background jobs.');
                    return;
                }
                const lines = jobs.map(job => `• <code>${escapeHtml(job.id)}</code> — ${job.kind} — ${job.status} — ${escapeHtml(job.label)}`);
                await sendChunks(chat, `Background jobs:\n${lines.join('\n')}`);
                return;
            }
            case 'kill': {
                const service = jobsService();
                const jobId = rawInput.trim();
                if (service === undefined) {
                    await client.sendMessage(chat, 'jobs service unavailable in this profile.');
                    return;
                }
                if (jobId === '') {
                    await client.sendMessage(chat, 'Usage: <code>/kill &lt;job id&gt;</code>');
                    return;
                }
                const outcome = service.kill(jobId, undefined, 'telegram-control');
                await client.sendMessage(chat, outcome === 'requested'
                    ? `Kill requested for <code>${escapeHtml(jobId)}</code>.`
                    : `Job <code>${escapeHtml(jobId)}</code> was already finished.`);
                return;
            }
            case 'cancel': {
                const state = ensureChat(chat);
                const selectedId = state.agentId;
                const liveAgents = ctx.agents.list();
                const agent = selectedId !== undefined
                    ? ctx.agents.get(SessionId(selectedId))
                    : liveAgents.length === 1 ? liveAgents[0] : undefined;
                if (agent === undefined) {
                    await client.sendMessage(chat, 'No live agent to cancel. Send a message to resume one first, then <code>/cancel</code>.');
                    return;
                }
                agent.cancel({ kind: 'user' });
                await client.sendMessage(chat, `Cancellation requested for ${describeAgent(agent)}.`);
                return;
            }
            case 'watch': {
                ensureChat(chat).watching = true;
                await client.sendMessage(chat, 'Watching: live agent output will be forwarded to this chat. <code>/unwatch</code> to stop.');
                return;
            }
            case 'unwatch': {
                ensureChat(chat).watching = false;
                await client.sendMessage(chat, 'Watching stopped.');
                return;
            }
            default:
                await client.sendMessage(chat, `Unknown command <code>/${escapeHtml(command)}</code>. Send <code>/help</code> for the command list.`);
        }
    }
    // The poll loop dispatches without awaiting, so two messages from one chat can
    // arrive together. Only the first may open a conversation; the second waits for
    // that same attempt rather than creating a second one and overwriting the
    // selection. Only ever one promise per chat is installed, so the one that
    // finishes is the one that clears the entry.
    const openingAgents = new Map();
    /** The chat's agent, opening a conversation when the host allows one. */
    async function resolveOrOpenAgent(chat) {
        const key = keyOf(chat);
        const existing = await resolveAgent(chat);
        if (existing !== undefined)
            return existing;
        const inFlight = openingAgents.get(key);
        if (inFlight !== undefined)
            return await inFlight;
        // A host that exposes its own sessions facade can open a conversation here,
        // with that host's workspace, route default model and preset — the same
        // semantics its own UI has. A host that does not gets no conversation.
        const starter = ctx.get('plexusSessions');
        if (starter === undefined)
            return undefined;
        const opening = (async () => {
            try {
                // The host mints the identifier: it owns the id policy, so a session
                // opened here is the same kind of session, visible to the same RPC, as
                // one opened from its own UI.
                const opened = await starter.start();
                const agent = ctx.agents.get(SessionId(opened));
                // Select only once the conversation really exists, so a failed creation
                // leaves no chat pointing at a session that is not there.
                if (agent === undefined)
                    return undefined;
                await selectEntry(chat, toEntry(agent));
                return agent;
            }
            finally {
                openingAgents.delete(key);
            }
        })();
        openingAgents.set(key, opening);
        return await opening;
    }
    /** Send a plain message as a follow-up to the conversation's selected agent. */
    async function handlePlain(chat, text) {
        const agent = await resolveOrOpenAgent(chat);
        if (agent === undefined) {
            await client.sendMessage(chat, 'No conversation selected. Use <code>/agents</code> then <code>/agent &lt;number&gt;</code>, or start one from the Web UI.');
            return;
        }
        const sessionId = agent.session.id;
        const message = createUserMessage({
            // A `user` source — exactly what the Web UI's own input uses — so the
            // message renders as a normal user bubble in the desktop conversation
            // instead of an invisible plugin context card.
            source: { kind: 'user' },
            content: [{ type: 'text', text }],
        });
        // Register before followup so the turn's events land in the reply buffer.
        registerPending(agent, chat, message.id);
        try {
            agent.followup(message);
        }
        catch (error) {
            // A follow-up that fails synchronously (agent disposed mid-flight) would
            // otherwise leave the pending entry to time out; close it immediately.
            flush(sessionId, chat, 'idle');
            throw error;
        }
        ctx.logger.info(`telegram-control: follow-up queued for agent ${sessionId} from chat ${keyOf(chat)}`);
    }
    /** Handle one update from the poll loop; never throws. */
    async function handleUpdate(update) {
        if (update.callback_query !== undefined) {
            try {
                await handleCallbackQuery(update.callback_query);
            }
            catch (error) {
                ctx.logger.warn(`telegram-control: callback query failed: ${describeError(error)}`);
            }
            return;
        }
        const message = update.message;
        if (message === undefined || message.text === undefined)
            return;
        // The allowlist stays a decision about the chat; the topic only decides which
        // conversation the message — and its reply — belongs to.
        const chatId = message.chat.id;
        const chat = chatKeyOf(message);
        const authorized = allowedChatIds.includes(chatId);
        if (!authorized) {
            if (message.text.trimStart().startsWith('/')) {
                await client.sendMessage(chat, `Not authorized. Add chat id <code>${chatId}</code> to <code>allowedChatIds</code> (or <code>DSH_TELEGRAM_ALLOWED_CHATS</code>).`);
            }
            return;
        }
        try {
            await handleMessage(message);
        }
        catch (error) {
            ctx.logger.warn(`telegram-control: handling message from chat ${chatId} failed: ${describeError(error)}`);
            try {
                await client.sendMessage(chat, `⚠️ Handling failed: ${escapeHtml(describeError(error))}`);
            }
            catch {
                // The failure report itself failed; the log above is the record.
            }
        }
    }
    /** Long-poll the Telegram API until the plugin unloads. */
    async function poll() {
        let offset = 0;
        let backoffMs = 1000;
        while (!abort.signal.aborted) {
            try {
                const updates = await client.getUpdates(offset, pollTimeoutSec, abort.signal);
                backoffMs = 1000;
                for (const update of updates) {
                    if (update.update_id >= offset)
                        offset = update.update_id + 1;
                    void handleUpdate(update).catch(logWarn);
                }
            }
            catch (error) {
                if (abort.signal.aborted)
                    return;
                if (error instanceof TelegramApiError && error.code === 409) {
                    ctx.logger.warn('telegram-control: 409 Conflict — another getUpdates instance is polling; this one stops');
                    return;
                }
                ctx.logger.warn(`telegram-control: getUpdates failed: ${describeError(error)}; retrying in ${backoffMs}ms`);
                await sleep(backoffMs, abort.signal);
                backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            }
        }
    }
    // ---- live harness events ----
    // Approval requests: forward to every authorized chat with Allow/Reject
    // buttons AND let the rest of the answerer chain run — so the Web UI dialog
    // still appears. The first answer wins: a Telegram button, the Web dialog,
    // the turn's abort, or the timeout. When the chain contains no real answerer
    // (it settles `unavailable` immediately) or Telegram cannot be reached,
    // the other channel answers alone.
    ctx.on('approval/request', (req, next) => {
        if (allowedChatIds.length === 0)
            return next();
        if (req.signal !== undefined && req.signal.aborted) {
            return Promise.resolve('cancelled');
        }
        const web = Promise.resolve(next()).catch((error) => {
            ctx.logger.warn(`telegram-control: Web approval answerer failed: ${describeError(error)}`);
            return 'unavailable';
        });
        return forwardApproval(req, web);
    }, true);
    /** Forward one approval ask to Telegram and race it against the Web dialog. */
    async function forwardApproval(req, web) {
        const token = randomUUID();
        const sent = [];
        const { promise, resolve } = Promise.withResolvers();
        let settled = false;
        const settle = (outcome) => {
            if (settled)
                return;
            settled = true;
            const current = pendingApprovals.get(token);
            if (current !== undefined) {
                pendingApprovals.delete(token);
                current.timeoutDispose();
            }
            resolve(outcome);
        };
        const entry = {
            resolve: settle,
            text: '',
            sent,
            timeoutDispose: () => { },
        };
        const timer = setTimeout(() => {
            settle('cancelled');
            void updateApprovalMessages(entry, '⏹️ <b>Cancelled</b> (no answer in time).').catch(logWarn);
        }, approvalTimeoutMs);
        entry.timeoutDispose = () => clearTimeout(timer);
        pendingApprovals.set(token, entry);
        if (req.signal !== undefined) {
            req.signal.addEventListener('abort', () => settle('cancelled'), { once: true });
        }
        try {
            const text = [
                '🔒 <b>Approval required</b>',
                `Agent: ${describeAgent(req.agent)}`,
                `Tool: <code>${escapeHtml(req.toolName)}</code>`,
                req.reason !== undefined && req.reason !== ''
                    ? `Reason: ${escapeHtml(req.reason)}`
                    : 'Reason: (none given)',
            ].join('\n');
            entry.text = text;
            const keyboard = {
                inline_keyboard: [[
                        { text: '✅ Allow once', callback_data: `approve:${token}` },
                        { text: '❌ Reject', callback_data: `reject:${token}` },
                    ]],
            };
            for (const chat of targetsFor(req.agent.session.id)) {
                const result = await client.sendMessage(chat, text, { replyMarkup: keyboard });
                sent.push({ chat, messageId: result.message_id });
            }
            ctx.logger.info(`telegram-control: approval request ${token.slice(0, 8)} for ${req.toolName} forwarded`);
        }
        catch (error) {
            pendingApprovals.delete(token);
            entry.timeoutDispose();
            ctx.logger.warn(`telegram-control: forwarding approval failed, delegating to the Web dialog: ${describeError(error)}`);
            return web;
        }
        // If a real Web answerer exists, its outcome settles this race too; an
        // immediate `unavailable` means the chain had no answerer, so Telegram is
        // the sole channel and keeps waiting for a button.
        void web.then((outcome) => {
            if (outcome === 'unavailable')
                return;
            settle(outcome);
            const suffix = outcome === 'allowed-once'
                ? '✅ <b>Approved</b> in the Web UI.'
                : outcome === 'rejected'
                    ? '❌ <b>Rejected</b> in the Web UI.'
                    : '⏹️ <b>Cancelled</b>.';
            void updateApprovalMessages(entry, suffix).catch(logWarn);
        });
        return promise;
    }
    // A session appearing after this plugin mounted (GUI resume, new chat)
    // carries its stored `session/title` events in its seed, which never replay
    // through the event feed — fold them on publication.
    ctx.on('session/created', (session) => {
        seedTitle(session);
    });
    // Durable event feed: accumulate assistant text for pending replies and
    // forward to watching chats. `turn/end` delivers a pending reply the moment
    // its own turn closes — reliable even when the agent stays busy with other
    // work and never reports `idle`.
    ctx.on('session/event', (session, event) => {
        if (event.type === 'assistant/message') {
            const text = assistantText(event.data.message, reasoningMaxChars);
            if (text === '')
                return;
            const byChat = pendingBySession.get(session.id);
            if (byChat !== undefined) {
                // Only buffer output from OUR follow-up's own turn: a GUI-initiated
                // turn that runs while a reply is pending must not leak into it.
                // Render at the buffer boundary: the final send uses Telegram's HTML
                // parse mode; the model's Markdown becomes the HTML subset Telegram
                // shows, and everything else is escaped so no reply is a 400.
                const html = markdownToTelegramHtml(text);
                for (const entry of byChat.values()) {
                    if (entry.turn === event.data.turn)
                        entry.buffer.push(html);
                }
            }
            else {
                forwardWatching(markdownToTelegramHtml(text));
            }
        }
        else if (event.type === 'turn/end') {
            const byChat = pendingBySession.get(session.id);
            if (byChat === undefined)
                return;
            for (const entry of byChat.values()) {
                if (entry.turn === event.data.turn) {
                    flush(session.id, entry.chat, 'idle');
                }
            }
        }
        else if (event.type === 'session/title') {
            titles.set(session.id, event.data.title);
        }
        else if (event.type === 'tool/call' && showToolCalls) {
            const byChat = pendingBySession.get(session.id);
            if (byChat === undefined)
                return;
            const notice = toolCallPreview(event.data.name, event.data.arguments);
            for (const entry of byChat.values()) {
                if (entry.turn === event.data.turn) {
                    void client.sendMessage(entry.chat, notice).catch(logWarn);
                }
            }
        }
    });
    // When our follow-up is claimed into a turn, remember the turn so its
    // `turn/end` can flush the reply precisely.
    ctx.on('agent/inbox/claimed', (payload) => {
        const byChat = pendingBySession.get(payload.agent.session.id);
        if (byChat === undefined)
            return;
        for (const entry of byChat.values()) {
            if (entry.messageId === payload.message.id)
                entry.turn = payload.turn;
        }
    });
    // A discarded follow-up (cancellation, agent shutdown) never gets a turn;
    // tell the requesting chat instead of leaving it pending until timeout.
    ctx.on('agent/inbox/discarded', (payload) => {
        const byChat = pendingBySession.get(payload.agent.session.id);
        if (byChat === undefined)
            return;
        for (const entry of byChat.values()) {
            if (entry.messageId !== payload.message.id)
                continue;
            entry.buffer.push('⚠️ message was discarded before the agent processed it');
            flush(payload.agent.session.id, entry.chat, 'idle');
        }
    });
    // Status flips: typing while running, plus an idle flush as a fallback
    // (turn/end already delivered the reply in the common case).
    ctx.on('agent/status', (payload) => {
        const sessionId = payload.agent.session.id;
        const byChat = pendingBySession.get(sessionId);
        if (byChat === undefined)
            return;
        if (payload.status === 'idle') {
            for (const entry of byChat.values())
                flush(sessionId, entry.chat, 'idle');
        }
        else if (payload.status === 'running') {
            // A turn started elsewhere keeps this conversation's indicator up too; the
            // pending reply owns the timer, so this cannot start a second one.
            for (const entry of byChat.values())
                ensureTyping(entry);
        }
    });
    // Terminal failures land in the pending buffer so the requesting chat sees why.
    ctx.on('agent/error', (payload) => {
        const byChat = pendingBySession.get(payload.agent.session.id);
        if (byChat === undefined)
            return;
        const note = `⚠️ <b>agent error</b>: ${escapeHtml(describeError(payload.error))}`;
        for (const entry of byChat.values()) {
            if (entry.turn === payload.turn)
                entry.buffer.push(note);
        }
    });
    // An agent leaving the registry resolves its pending replies with a notice.
    ctx.on('agent/disposed', (payload) => {
        const sessionId = payload.agent.session.id;
        const byChat = pendingBySession.get(sessionId);
        if (byChat === undefined)
            return;
        pendingBySession.delete(sessionId);
        for (const entry of byChat.values()) {
            entry.timeoutDispose();
            entry.typingStop?.();
            void client.sendMessage(entry.chat, '⚠️ agent was disposed while working').catch(logWarn);
        }
    });
    ctx.logger.info(`telegram-control: bot active (${allowedChatIds.length} authorized chat(s), token ${token.slice(0, 8)}…)`);
    // Publish the command menu so the plugin's slash commands show up in the
    // Telegram input field without being typed by hand.
    void client.setMyCommands(BOT_COMMANDS).catch((error) => {
        ctx.logger.warn(`telegram-control: setMyCommands failed: ${describeError(error)}`);
    });
    void poll().catch(logWarn);
}
/** The `/help` text. */
function helpText() {
    return [
        '🤖 <b>dsh remote control</b>',
        '',
        '<code>/status</code> — harness uptime, agent and job counts',
        '<code>/agents</code> — list live agents (numbered, with names)',
        '<code>/agent &lt;number|name&gt;</code> — select the agent this chat drives',
        '<code>/jobs</code> — list background jobs',
        '<code>/kill &lt;job id&gt;</code> — stop a background job',
        '<code>/cancel</code> — cancel the selected agent\u2019s current turn',
        '<code>/watch</code> / <code>/unwatch</code> — toggle forwarding live agent output',
        '<code>/chatid</code> — show this chat\u2019s id (for setup)',
        '<code>/help</code> — this list',
        '',
        'Plain messages are sent as follow-ups to the selected agent; its reply is relayed here.',
    ].join('\n');
}
