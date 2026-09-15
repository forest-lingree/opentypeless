# Azure OpenAI LLM and STT provider design

Date: 2026-09-14

## Goal and decisions

Add first-class Azure OpenAI providers for text generation and file-based speech
transcription. The first version prioritizes a small, consistent integration:

- Deployment-based Azure REST APIs for both providers.
- API-key authentication through the existing credential vault.
- Existing OpenAI-compatible chat and Whisper-upload engines.
- Independent LLM and STT configuration, available in Settings and onboarding.

Azure AI Speech, live transcription, Microsoft Entra authentication, the Azure
v1 API, the Responses API, automatic deployment discovery, and unrelated provider
refactoring are outside scope.

## Configuration and interface

Both provider selectors gain an Azure OpenAI entry. Each integration exposes:

| Setting | Meaning |
| --- | --- |
| Resource endpoint | HTTPS resource root, without a deployment or operation path |
| Deployment name | Exact Azure deployment name, not necessarily a model name |
| API version | Editable; defaults to `2024-10-21` |
| API key | Stored under the integration's provider-specific credential slot |

Resource endpoints and deployment names start empty. Example values are
placeholders, not usable saved defaults. LLM model discovery is disabled for
Azure because model identifiers do not establish deployed resource names.
Existing provider selections and application defaults remain unchanged.

LLM and STT settings are independent, including their keys. They may point to the
same resource but must not implicitly copy credentials between integrations.
Use existing LLM endpoint/model fields where they retain their meaning, with
Azure-specific labels for resource endpoint and deployment name. Add a separate
LLM API-version field. Add dedicated Azure STT endpoint, deployment, and
API-version fields rather than overwriting Local / Custom Whisper settings.

Add default values to both frontend and Rust configuration so older saved files
remain readable. Include the nonsecret Azure settings in backup creation and
restore validation; exclude credentials as existing backups do.

Settings and onboarding use the same field meanings, required-field rules, and
request configuration. New copy follows existing localization patterns and
locale-key parity requirements. STT setup explicitly states that results appear
after recording stops.

## Endpoint construction and authentication

Use a shared Azure-specific helper to validate configuration and construct
deployment endpoints:

```text
{resource}/openai/deployments/{deployment}/chat/completions?api-version={version}
{resource}/openai/deployments/{deployment}/audio/transcriptions?api-version={version}
```

Trim surrounding whitespace. Accept a resource root with or without a trailing
slash. Require HTTPS and a host. Reject embedded credentials, query parameters,
fragments, and non-root paths on the resource endpoint. Do not constrain valid
resource hosts to a single public Azure domain; sovereign-cloud and private DNS
resource roots may differ.

Deployment names and versions must be nonempty after trimming. Treat the
deployment as one URL path segment and the version as one query value, using URL
APIs rather than raw unescaped concatenation. Validation must not silently strip
meaningful input or reinterpret an already-complete operation URL.

Send the trimmed secret in the `api-key` header, not a Bearer header or URL
parameter. Existing providers retain their current authentication behavior.
Diagnostics, errors, and documentation must not reveal actual credentials.

## Runtime integration

### LLM

Reuse the current prompt generation, OpenAI-compatible response parsing,
streaming, retry, and output paths. Apply Azure endpoint and authentication
handling consistently to:

- Dictation polishing and translation.
- Ask requests.
- Connection tests and latency benchmarks.
- Connection warm-up and configuration-change invalidation.

Azure deployment names are opaque. A deployment named `production-polisher`
must not depend on a model-prefix heuristic. Azure requests use
`max_completion_tokens`, omit optional `temperature` and other sampling controls,
and use a timeout suitable for reasoning models. This supports compatible
chat-completions deployments without pretending to support models that only
expose the Responses API.

The default API version is a starting point, not a promise that every Azure model
supports that version. Setup documentation explains that newer deployments can
require a different API version.

### STT

Reuse the existing PCM buffering, WAV encoding, multipart upload, retry, and
transcription parsing behavior. Azure-specific construction supplies the
deployment endpoint and key authentication. The same resolved provider
configuration must serve real dictation, Ask recording, connection tests,
benchmarks, diagnostics, and warm-up.

Send the recorded WAV in the multipart `file` field. Preserve language hints.
The URL determines the Azure deployment; omit the multipart `model` field for
Azure requests. Do not send unrelated provider-specific fields.
Accept the existing transcription response contract containing a `text` field.
No live partial transcription is promised.

Register Azure STT as file-upload transport with the existing buffered-provider
limits: 600-second recommendation, 720-second hard ceiling, and the existing
24 MiB client audio-buffer ceiling. Document these as client limits, not a
guarantee that every deployed model accepts recordings of this size. Smaller
service limits surface as provider errors; users can lower their recording limit.

## Error handling

Validate Azure configuration before attempting a request. Incomplete drafts may
be saved, but incomplete configurations cannot pass a connection check or start
an Azure operation successfully.

Surface invalid endpoints, missing deployment/version/key, authentication
failures, unavailable deployments, unsupported versions, rate limits, timeouts,
and provider errors through the existing application error paths. Do not silently
fall back to another provider or report an unsuccessful connection as healthy.
Reuse existing retry policy rather than adding an Azure-only retry subsystem.

Existing behavior for preserving raw transcription when polishing fails remains
unchanged. Existing non-Azure providers must retain their request URLs, headers,
body options, recording behavior, and credential selection.

## Implementation boundaries

- A small shared Rust Azure configuration/URL helper owns endpoint validation.
- LLM protocol/request helpers own Azure chat request behavior.
- Whisper configuration and upload code own Azure transcription behavior.
- Provider factories and orchestration resolve the same configuration everywhere.
- Storage, backup, frontend types, selectors, and setup fields expose configuration.
- Existing credential infrastructure stores secrets; no new secret-storage system.

No new SDK or test framework is needed. Any small extraction should serve these
integration paths directly, not create a generalized provider framework.

## Verification and acceptance criteria

Use existing Rust tests and Vitest/React Testing Library suites.

1. Azure is selectable in both Settings panes and both onboarding steps.
2. Required Azure fields reach backend connection tests and real operations.
3. LLM deployment entry is manual, without misleading model auto-discovery.
4. URL tests cover trailing slash, whitespace, path/query escaping, invalid
   scheme/host, embedded credentials, query/fragment, and unexpected paths.
5. Request tests verify `api-key`, absence of Bearer authentication, deployment
   routing, API version, chat body options, multipart fields, and language hints.
6. Local HTTP fixtures or equivalent request-construction tests verify the actual
   request contract without contacting Azure or transmitting user data.
7. Provider-factory, dictation/Ask configuration, diagnostics, benchmark, warm-up,
   and recording-limit tests cover Azure routing.
8. Configuration defaults load older settings. Nonsecret Azure configuration
   survives backup/restore, while all keys stay excluded.
9. Frontend tests cover Azure fields, required-field gating, provider switching,
   credential isolation, and connection-test parameters.
10. Related existing-provider regression tests, frontend type/build checks, and
    targeted lint/format checks pass, or environmental/pre-existing blockers are
    explicitly recorded.

A live Azure test is separate from automated validation. It requires a user-owned
resource, compatible chat and transcription deployments, and locally configured
keys. Never request keys in chat or claim live verification without running it.

## References

- [Azure transcription quickstart](https://learn.microsoft.com/en-us/azure/foundry/openai/whisper-quickstart)
- [Azure API lifecycle and v1](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
- [Azure endpoint and deployment differences](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/switching-endpoints)
