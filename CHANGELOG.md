# Changelog

All notable changes to `@narcisbodea/smstunnel-directus` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-03

### Added

- **Send a text with SMSTunnel**, an operation for Directus Flows: one text per run, from your own phone, to one
  number. Fields: API key (`{{ $env.SMSTUNNEL_API_KEY }}` by default), To, Type (text or sign-in code), Message,
  Phone ID, Country code, Idempotency key.
- Runs in Directus' extension sandbox and may call only `https://smstunnel.io/api/v1/*`, so the Marketplace installs it
  with its default trust setting.
- Resolves with `{ messageId, to, status, queued, replayed }`; rejects with `{ message, status, code, retryAfter,
  mayHaveSent }` (thrown as JSON, like Directus' own Request URL operation).
- A `{{ … }}` that finds nothing (`undefined`) counts as empty; lists of numbers are refused with how to loop.
- Tested end to end in Directus 12.6.0 and 11.17.4: an event-hook flow on a new item, a webhook flow (sign-in code,
  idempotent re-run, refusals), the key redacted from the stored flow log, and the sandbox refusing other addresses.
