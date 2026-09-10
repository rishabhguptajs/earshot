# Earshot telemetry

Telemetry is opt-in. Its purpose is to understand aggregate adoption and which coarse product areas need support. On the first interactive run, Earshot offers **Enable anonymous telemetry** or **No thanks**. Declining is saved and is not prompted again.

When enabled, Earshot sends only these JSON fields to `https://earshot-telemetry.rishabhgupta4523.workers.dev/v1/events`: `installation_id` (a randomly generated UUID), `event`, ISO-8601 `timestamp`, Earshot `version`, OS family (`darwin`, `linux`, `win32`, or `other`), CPU architecture (`arm64`, `x64`, or `other`), and, where relevant, allowlisted `tool` name or built-in provider identifier. Events are `telemetry_enabled`, `telemetry_disabled`, `session_started`, `session_completed`, `session_failed`, and `tool_used`.

It never sends prompts, responses, source code, file contents, file names/paths, repository names/URLs/remotes, shell commands or arguments, tool arguments, diffs, environment variables, credentials, authentication tokens, email addresses, usernames, IP address fields, or raw errors. The UUID is random; it is not a fingerprint and is stored only in the global Earshot config directory as `telemetry.json`. Like any direct HTTPS request, the receiving network service can observe a source IP at the transport layer; deployment must avoid retaining or using it.

Use `earshot telemetry enable`, `disable`, `status`, or `reset`. Disabling removes the UUID. `reset` rotates it while enabled. Requests are HTTPS, unauthenticated, fixed to the endpoint above, limited to one second, and best-effort: networking failures never affect Earshot.

No third-party analytics SDK is used. The ingestion Worker and D1 schema are in `telemetry-worker/`; retention and dashboard queries remain operational work. Inspect `packages/core/src/telemetry.ts` for the complete client implementation.
