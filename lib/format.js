/**
 * Pure formatting helpers for Telegram payloads. No harness or network
 * dependencies, so they are unit-testable in isolation.
 * @module dsh-telegram-control/format
 */
/** Escape text so it is safe inside Telegram's HTML parse mode. */
export function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (char) => {
        switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return char;
        }
    });
}
/**
 * Render the subset of Markdown that Telegram's HTML parse mode can show:
 * fenced and inline code, bold, italic, links, headings
 * (as bold) and list markers (as bullets). Everything else is escaped text —
 * a model reply must never produce a 400 from Telegram.
 */
export function markdownToTelegramHtml(markdown) {
    const out = [];
    const lines = markdown.split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^\s*```/.test(line)) {
            const body = [];
            i += 1;
            while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
                body.push(lines[i] ?? '');
                i += 1;
            }
            i += 1; // closing fence (or EOF)
            out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
            continue;
        }
        out.push(inlineMarkdown(line));
        i += 1;
    }
    return out.join('\n');
}
function inlineMarkdown(line) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null)
        return `<b>${inlineSpans(heading[1] ?? '')}</b>`;
    return inlineSpans(line.replace(/^(\s*)[-*+]\s+/, '$1• '));
}
/** Inline code first (its contents are literal), then links, bold and italic on the rest. */
function inlineSpans(text) {
    return text.split(/(`[^`\n]+`)/).map((part, index) => {
        if (index % 2 === 1)
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        let html = escapeHtml(part);
        html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
        html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
        html = html.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
        html = html.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
        return html;
    }).join('');
}
/** One-line preview of a tool call for the chat: the tool name plus its command or path, clipped. */
export function toolCallPreview(name, rawArguments, maxChars = 120) {
    let args = {};
    try {
        args = JSON.parse(rawArguments);
    }
    catch { /* not JSON: name only */ }
    const value = ['command', 'path', 'file_path', 'pattern', 'query', 'url']
        .map((key) => args[key])
        .find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
    const head = `🔧 <code>${escapeHtml(name)}</code>`;
    if (value === undefined)
        return head;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    const clipped = oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
    return `${head} <code>${escapeHtml(clipped)}</code>`;
}
/**
 * Split one message into Telegram-safe chunks (hard cap `max` chars each).
 * Prefers newline boundaries; a single over-long line is hard-split.
 * @param text - the full message to split.
 * @param max - per-chunk character cap (Telegram's own limit is 4096).
 * @returns the ordered chunks; `[text]` when it already fits.
 */
export function splitMessage(text, max = 4000) {
    if (text.length <= max)
        return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max);
        if (cut <= 0)
            cut = max;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length > 0)
        chunks.push(rest);
    return chunks;
}
/** Render a duration in seconds as a compact `1h 23m 45s` string. */
export function renderUptime(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const parts = [];
    if (hours > 0)
        parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0)
        parts.push(`${minutes}m`);
    parts.push(`${secs}s`);
    return parts.join(' ');
}
/**
 * Shorten an absolute path under the user's home directory to `~/…` form.
 * @param path - the absolute path to shorten.
 * @param home - the home directory to anchor on (empty means `path` is already `~`).
 * @returns `~`/`~/…` for paths under `home`, otherwise the path unchanged.
 */
export function homeShorten(path, home) {
    if (path === home)
        return '~';
    if (path.startsWith(`${home}/`))
        return `~${path.slice(home.length)}`;
    return path;
}
/**
 * Summarize a reasoning chain the way the Web UI's collapsed Think row does:
 * the first line of the finished chain. A single over-long line is capped at
 * `maxChars`, cut at a sentence boundary when one fits, ellipsized.
 * @param text - the full reasoning text.
 * @param maxChars - the per-line cap; `0` (or below) suppresses reasoning entirely.
 * @returns the summary, or `''` when suppressed.
 */
export function trimReasoning(text, maxChars) {
    if (maxChars <= 0)
        return '';
    const newline = text.indexOf('\n');
    let summary = (newline === -1 ? text : text.slice(0, newline)).trim();
    if (summary.length <= maxChars)
        return summary;
    let cut = maxChars;
    for (const match of summary.slice(0, maxChars).matchAll(/[。！？!?.]\s*/g)) {
        cut = (match.index ?? 0) + match[0].length;
    }
    if (cut < maxChars * 0.5)
        cut = maxChars;
    return `${summary.slice(0, cut).trimEnd()}…`;
}
/**
 * Parse a Telegram message as a bot command. Group-chat mentions
 * (`/status@my_bot`) are normalized away; anything that does not start with a
 * slash returns `undefined`.
 * @param text - the raw message text.
 * @returns the parsed command, or `undefined` for a plain message.
 */
export function parseBotCommand(text) {
    const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (match === null)
        return undefined;
    return {
        command: (match[1] ?? '').toLowerCase(),
        rawInput: match[2] === undefined ? '' : match[2].trim(),
    };
}
/**
 * Parse an inline-button callback for an approval request.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export function parseApprovalCallback(data) {
    const match = /^(approve|reject):([0-9a-f-]+)$/.exec(data);
    if (match === null)
        return undefined;
    return { approve: match[1] === 'approve', token: match[2] ?? '' };
}
/**
 * Parse an inline-button callback for a forwarded user question.
 * @param data - the raw `callback_data` from a Telegram callback query.
 * @returns the parsed choice, or `undefined` for stale or malformed data.
 */
export function parseQuestionCallback(data) {
    const match = /^question:([0-9a-f-]+):(\d+)$/.exec(data);
    if (match === null)
        return undefined;
    return { token: match[1] ?? '', optionIndex: Number(match[2]) };
}
