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
  drive this plugin without re-implementing a Bot API and two runs cannot
  collide on a fixed port. Importing the module starts nothing.
- Smoke test now imports those helpers and still passes 33/33.
- Declare `plexus.channel = telegram`, so a host can tell which channel a package
  provides without knowing the package by name.

No plugin behaviour, configuration or message rendering changed.
