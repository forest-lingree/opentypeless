# Agent Maestro LLM Provider Integration

Date: 2026-09-15

## Goal and agreed scope

Integrate Agent Maestro as a first-class LLM provider in OpenTypeless without
modifying the Agent Maestro repository or requiring new server endpoints.
Support settings, onboarding, connection testing, model discovery, streamed
polishing, translation, Ask, and configuration/credential persistence.

The user approved:

- An independent `agent-maestro` provider reusing the OpenAI Chat Completions
  transport.
- Optional API key authentication with an editable field.
- Discovery through Agent Maestro's existing model endpoint, filtered to
  `vendor === "copilot"`.
- Explicit model selection or manual entry; no default `auto` and no automatic
  selection of the first result.
- Visible discovery, configuration, credential, HTTP, streaming, and timeout
  failures.
- A 120-second generation request timeout and a 10-second discovery timeout.
- Targeted automated validation and a synthetic live smoke test when the server
  is available.

## Existing contracts

OpenTypeless routes non-cloud LLM providers through
[OpenAiProvider](../../../src-tauri/src/llm/openai.rs).
[protocol.rs](../../../src-tauri/src/llm/protocol.rs) owns endpoint construction,
authentication, request bodies, response extraction, and stream event parsing.
Ask uses the same protocol helpers through
[commands/ask.rs](../../../src-tauri/src/commands/ask.rs).

Provider choices and defaults live in
[constants.ts](../../../src/lib/constants.ts), while the frontend provider union
and configuration live in [appStore.ts](../../../src/stores/appStore.ts).
Both [LlmPane.tsx](../../../src/components/Settings/LlmPane.tsx) and
[LlmSetupStep.tsx](../../../src/components/Onboarding/LlmSetupStep.tsx)
currently use API-key requirement checks to control field visibility. That
coupling cannot represent an optional key.

Agent Maestro currently exposes:

| Operation | Endpoint | Contract |
| --- | --- | --- |
| Text generation | `POST /api/openai/v1/chat/completions` | OpenAI Chat Completions; streaming and non-streaming |
| Model discovery | `GET /api/v1/lm/chatModels` | Top-level array of VS Code model objects |

There is no OpenAI-compatible `/api/openai/v1/models` endpoint in the inspected
Agent Maestro checkout. Its discovery endpoint includes all VS Code vendors,
but its generation model resolver uses only Copilot-vendor models.
Here `copilot` identifies the VS Code model provider, not the model developer;
Claude, Gemini, and GPT models supplied through Copilot are eligible.

Agent Maestro may fuzzy-match or fall back to another model. This integration
does not remove that behavior or promise exact server-side model selection.

## Architecture and responsibilities

1. Provider metadata defines the identifier, defaults, and API-key policy.
2. A small Rust Agent Maestro adapter owns provider-specific URL validation,
   discovery response parsing, and configuration validation. Reuse existing
   HTTP and protocol helpers instead of implementing a second generation client.
3. Shared protocol code continues to own Chat Completions request/response
   handling and the targeted stream parser fixes needed for this integration.
4. Tauri LLM commands resolve credentials and orchestrate discovery and
   connection tests. Keep testable request/response logic independent of Tauri
   state where practical.
5. Settings and onboarding expose identical provider behavior using their
   existing layouts. Extract narrowly shared frontend logic where needed to
   avoid divergent credential policies or discovery race handling.
6. Existing runtime error and output policies remain responsible for reporting
   failures and handling any dictation fallback; adapter failures are never
   converted into successful model output.

No dependency or database-schema change is expected. Do not add a generic
provider-plugin framework or duplicate cloud and OpenAI transport logic.

## Configuration and UI

| Field | Agent Maestro behavior |
| --- | --- |
| Provider ID | `agent-maestro` |
| Display label | `Agent Maestro` |
| Default Base URL | `http://127.0.0.1:23333/api/openai/v1` |
| Initial model | Empty string |
| API key | Optional, always editable |

Add the provider to settings and onboarding without changing the default
provider for existing installations. Selecting Agent Maestro applies its URL
and empty model defaults rather than keeping another provider's model.

Model discovery populates suggestions only. It must not set a model, overwrite
manual input, or reject a nonempty manual ID merely because it is absent from
the current discovery results. Discovery failures must not prevent manual
configuration.

Disable connection-test actions when the model or URL is blank, or when the
relevant credential read is still pending or has failed. Explain missing
configuration visibly rather than relying only on a disabled button. Validate
again on the Rust side so direct IPC and runtime calls cannot send a blank model.

A blank key is valid. A missing vault entry is distinct from a vault read
failure. The latter must be surfaced, not treated as permission to send an
unauthenticated request.

Use existing localization conventions for the provider label, optional-key
hint, discovery empty/error states, prerequisite guidance, and validation errors.
Keep all locale key sets consistent.

## URL contract

The Base URL field expects an HTTP(S) API base ending in `/api/openai/v1`.
Also accept a pasted full `/api/openai/v1/chat/completions` endpoint and trailing
slashes, normalizing them consistently for generation and discovery.

Preserve the scheme, hostname, port, and any deployment prefix before
`/api/openai/v1`. For example:

| Configured value | Generation | Discovery |
| --- | --- | --- |
| `http://127.0.0.1:23333/api/openai/v1` | `/api/openai/v1/chat/completions` | `/api/v1/lm/chatModels` |
| `https://example.test/am/api/openai/v1/` | `/am/api/openai/v1/chat/completions` | `/am/api/v1/lm/chatModels` |

Do not hardcode discovery to localhost, drop a configured deployment prefix, or
switch origins. Reject unsupported schemes, embedded credentials, query
strings, fragments, and an unrecognized Agent Maestro API path with an explicit
configuration error. These provider-specific restrictions must not change
other providers' existing URL behavior.

## Authentication and persistence

Separate API-key requirement from API-key support/visibility:

- Existing keyed providers remain required.
- Ollama remains keyless with its existing UI behavior.
- Agent Maestro accepts an optional key and retains a visible input.
- Cloud keeps its existing session-based path.

Trim the Agent Maestro key at the request boundary. With an empty key, omit the
Authorization header; with a nonempty key, use Bearer authentication. Apply the
same credential handling to tests, discovery, polishing, translation, and Ask.
The existing discovery endpoint does not require Agent Maestro's LLM key, but
any configured credential must only ever be sent to the configured same-origin
server, never to a separately inferred host.

Use the existing `llm` credential namespace and the `agent-maestro` provider
account. Do not reuse another provider's stored key. Pending credential loads
and saves must not overwrite another provider when the user switches providers.
Deleting the optional key must clear the stored credential, and subsequent
requests must work without a placeholder value.

Onboarding must use the existing secure migration/persistence flow, not add
plaintext long-term storage. Configuration save/load and backup/restore retain
the provider, Base URL, and model; backups continue to exclude secrets.

## Model discovery

Fetch the derived `/api/v1/lm/chatModels` endpoint with a 10-second timeout.
Validate the top-level array and the model fields needed by the adapter.
An invalid response is an error, not an empty successful list.

Keep entries whose vendor is exactly `copilot`, extract their nonblank IDs,
deduplicate, and sort deterministically. Do not infer eligibility from model
family or model-name prefixes.

Expose three distinct UI outcomes: loading, successful results (including an
explicit no-eligible-models state), and failure. HTTP failures must retain useful
status information and a bounded diagnostic message without displaying or
logging credentials.

Scope cached results and pending requests to the active provider, Base URL, and
credential revision. Clear inappropriate results when that scope changes.
Ignore stale responses, including late errors, and do not let stale requests
clear the loading state of a newer request. An explicit refresh of the same
configuration may retain its previous suggestions, but must still show refresh
failure rather than presenting the cached list as newly fetched.

## Generation, testing, and streaming

Reuse existing Chat Completions bodies and prompt construction. The selected
model ID is forwarded unchanged after trimming surrounding whitespace; do not
inject model-family aliases or `auto`.

For Agent Maestro, `request_timeout` returns 120 seconds regardless of model
name. This is a per-HTTP-attempt deadline including response consumption, not an
idle timeout. Preserve existing retry eligibility and attempt limits; retries
can make the total operation longer. Do not retry after streaming has started
or add a new fallback provider.

Validate nonblank model and a supported Base URL before every generation or
connection-test request. Propagate credential failures through existing runtime
error surfaces. Do not silently skip enabled Agent Maestro processing because
there is no API key, and do not silently switch Ask to cloud.

For Agent Maestro connection testing, send a short synthetic prompt requesting
a brief reply with a small output budget (128 tokens), rather than the existing
one-token probe. Require a successful HTTP status, a valid Chat Completions
response, and nonblank text. Test latency includes reading and validating that
response. No exact literal answer is required from the model.

The shared stream parser must:

- Buffer bytes until complete UTF-8 data can be decoded; never decode individual
  network chunks lossily.
- Support the Chat Completions text deltas and `[DONE]` termination.
- Ignore SSE comments such as Agent Maestro's `: keep-alive`.
- Recognize OpenAI error payloads, including Agent Maestro's `event: error`
  frames carrying `error.message`, and propagate failures.
- Preserve existing Anthropic events and reasoning-content handling.

Agent Maestro malformed, empty, or prematurely terminated output must not be
reported as successful generation. On a stream error, any text already emitted
cannot necessarily be retracted; report the error and keep existing pipeline
failure/history handling rather than relabeling that partial result as success.
Keep strict provider-specific validation scoped to Agent Maestro where broader
behavior would otherwise change, and regression-test shared parser fixes.

## Documentation and non-goals

Update the relevant English and Chinese setup documentation with the settings,
model-discovery behavior, optional key, actual server-port guidance, and
troubleshooting.

Explain that the extension must be installed and running in VS Code, Copilot
must be signed in with eligible models, and the VS Code window must stay open.
Agent Maestro is a local bridge to model services, not proof that inference
runs locally or avoids Copilot usage limits.

Do not:

- Modify Agent Maestro or require an OpenAI models endpoint.
- Add an STT provider, a second proxy, auto-start integration, or port scanning.
- Add Responses, native Anthropic, or Gemini protocols.
- Change Agent Maestro's model fallback or certify untested model/prompt pairs.
- Log secrets or send repository content during live verification.
- Refactor unrelated authentication, backup validation, or provider behavior.

## Acceptance and verification

Use the existing Vitest and Rust test infrastructure; do not add a test runner
or network-mocking dependency. Local HTTP fixtures may use existing runtime
capabilities or standard-library networking.

Required automated coverage:

1. Provider metadata, optional-key policy, and unchanged existing defaults.
2. Both UI surfaces: provider selection, blank-model validation, manual IDs,
   optional key, loading/empty/failure discovery states, and stale responses.
3. Same-origin URL derivation: default/custom ports, HTTPS, deployment prefix,
   trailing slash, full endpoint, and rejected malformed inputs.
4. Discovery: mixed vendors, empty results, duplicate IDs, malformed JSON/shape,
   HTTP errors, and unchanged manually selected model.
5. Credentials: absent, stored, cleared, read failure, provider isolation, and
   no loss of a stored key across restart or configuration migration.
6. Connection test: actual request method/path/body, optional Authorization,
   nonblank response validation, HTTP failures, and timeout policy.
7. Generation: local HTTP fixtures for non-streamed Ask and streamed polishing,
   with translation prompt construction retaining its existing behavior.
8. Stream parsing: split Chinese UTF-8 bytes, split SSE lines, heartbeat comments,
   final marker, server errors after partial text, invalid/truncated data, and
   existing OpenAI/Anthropic/reasoning-content regressions.
9. Configuration/backup round-trip for provider, URL, and model, excluding keys.
10. Existing provider URL/auth/body/timeout and locale-parity regression tests.

Run the smallest relevant grouped tests, then the existing TypeScript build
and focused Rust validation needed for the changed modules. Record any build
prerequisite blockers explicitly instead of claiming unrun checks passed.

If an Agent Maestro instance is reachable, perform a short synthetic discovery
and generation smoke test without repository data. Verify both non-streaming
and SSE behavior where feasible. If no server is available, report that live
validation remains unperformed; automated local fixtures are not proof of a
live Copilot connection.

## Design decisions and review

The independent-provider approach was selected over a generic custom-provider
configuration surface (unnecessary user-facing complexity) and a separate
generation client (duplicated transport and error handling).

The implementation remains one cohesive integration. No unresolved design
choices are required before planning. The 120-second deadline, explicit model
selection, server-side fallback limitation, optional-key semantics, URL format,
and discovery failure states are specified above to prevent inconsistent
interpretations across frontend and Rust code.
