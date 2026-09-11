# Changes from upstream

Fork of [jackControls/dsh-telegram-control](https://github.com/jackControls/dsh-telegram-control) (MIT).
Upstream is the `upstream` remote; pull fixes from there when useful.

- Package renamed to `@plexus/channel-telegram`; repo `sting8k/plexus-channel-telegram`.
- **Security**: inline-button presses (approve/reject/question) are only honoured
  from a chat in `allowedChatIds`. Upstream trusted the random token alone, so a
  forwarded approval message — or another member of an allowlisted group — could
  settle an approval from any chat.
- Smoke test boots `dsh web --no-open` (no browser tab), covers the stranger
  press, and matches callback answers by id because updates are handled concurrently.

## Unreleased

- Extract the fake Telegram Bot API and the mock OpenAI-compatible LLM from
  `tests/smoke.mjs` into `tests/fakes.mjs`, exported as
  `@plexus/channel-telegram/testing`. Both bind port 0 and report the port they
  were given, return their observations, and close idempotently, so a harness can
  drive this plugin without re-implementing a Bot API. The two fake endpoints no
  longer pick fixed ports, so two harnesses no longer collide on them — the
  smoke's web port is still fixed at 3188. Importing the module starts nothing.
- Smoke test now imports those helpers and still passes 33/33.
- Declare `plexus.channel = telegram`, so a host can tell which channel a package
  provides without knowing the package by name.

No plugin behaviour, configuration or message rendering changed.
- Read a session's agent preset from the optional `sessionQuery` seam instead of
  `resolveSessionPreset`, which 0.1.2 removed; the observation is released in a
  `finally`, and an absent or failing seam leaves the deployment default in place.
- Pin the dsh closure to 0.1.2-rc.1 throughout: dev dependencies exact, peer ranges
  `^0.1.2-rc.1`, and `session.events` — gone in 0.1.2 — dropped from the shim.
- The previous smoke pass was a false green: the CLI was 0.1.2 but the plugin
  resolved its imports from this package's own 0.1.0-rc.6 development closure, so
  no 0.1.2 API was ever exercised.
- A host that exposes `plexusSessions` opens a conversation on the first plain
  message from an allowlisted chat; hosts without it keep the Web-UI-first reply.

- Command menu, question and approval acknowledgements are in English (upstream: Chinese).
- Replies render Markdown (code, bold, italic, links, headings, lists) as Telegram HTML instead of escaped text; tool-call notices include the command/path clipped to 120 chars.
