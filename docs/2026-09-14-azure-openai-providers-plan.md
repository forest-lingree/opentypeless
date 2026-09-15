# Azure OpenAI Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API-key-based, deployment-addressed Azure OpenAI LLM and buffered STT support throughout the desktop application.

**Architecture:** Reuse the existing chat and Whisper engines with a shared Azure URL/configuration helper. Keep the Rust backend and React interface aligned through the explicit configuration and Tauri contracts below. Extend existing credential storage, persistence, backups, and tests rather than adding an Azure SDK.

**Tech Stack:** Rust, Tauri, reqwest, serde, React, TypeScript, Zustand, i18next, Vitest.

**Approved specification:** [Azure provider design](2026-09-14-azure-openai-providers-design.md).

---

## Fixed cross-layer contract

Use `azure-openai` as the provider ID in both provider unions. Credential slots
remain separated by the existing `llm` and `stt` namespaces.

Extend Rust and frontend application configuration:

```typescript
stt_azure_endpoint: string       // default ''
stt_azure_deployment: string     // default ''
stt_azure_api_version: string    // default '2024-10-21'
llm_azure_api_version: string    // default '2024-10-21'
```

Azure LLM reuses `llm_base_url` for the resource root and `llm_model` for the
deployment name. Its selector defaults are empty endpoint and deployment.

Add the following public nonsecret command-options type:

```typescript
export interface AzureOpenAiConfig {
  endpoint: string
  deployment: string
  apiVersion: string
}
```

Rust uses the equivalent struct with `#[serde(rename_all = "camelCase")]`.
Append optional `azureConfig?: AzureOpenAiConfig` to the existing TypeScript
STT test, benchmark, and diagnostics wrappers. Tauri receives
`azure_config: Option<AzureOpenAiConfig>`. Do not reorder existing arguments.

Append optional `apiVersion?: string` to LLM test and benchmark wrappers.
Tauri receives `api_version: Option<String>`. Old callers remain valid;
Azure callers always send their version. Only include new invoke keys when
options are supplied so existing non-Azure command payloads stay unchanged.

## Task 1: Rust Azure integration

**Ownership:** Rust files only; do not change frontend files.

**Files:**
- Create `src-tauri/src/azure_openai.rs`: constants, serializable config, validated endpoint construction.
- Modify `src-tauri/src/lib.rs`: register the module.
- Modify `src-tauri/src/storage/mod.rs`: new settings and backward-compatible defaults.
- Modify `src-tauri/src/llm/mod.rs`: carry Azure API version into runtime LLM configuration.
- Modify `src-tauri/src/llm/protocol.rs`: Azure chat URL, authentication, token options, timeout, and no model discovery.
- Modify `src-tauri/src/llm/openai.rs`: use resolved Azure configuration without model-name-based special behavior.
- Modify `src-tauri/src/stt/config.rs`: construct Azure Whisper-compatible configuration.
- Modify `src-tauri/src/stt/whisper_compat.rs`: shared request construction, Azure key header, no multipart model field for Azure.
- Modify `src-tauri/src/stt/mod.rs`: factory routing.
- Modify `src-tauri/src/stt/capabilities.rs`: buffered recording limits.
- Modify `src-tauri/src/commands/llm.rs`: connection/benchmark command version argument and Azure model-discovery behavior.
- Modify `src-tauri/src/commands/stt.rs`: optional Azure command config, common upload logic, and diagnostics.
- Modify `src-tauri/src/commands/ask.rs`: LLM and STT Azure runtime resolution.
- Modify `src-tauri/src/pipeline.rs`: dictation/polish/translation routing and warm-up.
- Modify `src-tauri/src/commands/config.rs`: warm-up invalidation for Azure setting changes.
- Modify `src-tauri/src/credentials.rs` only if tests reveal provider-isolation changes are required.

- [x] **Step 1: Add failing endpoint and defaults tests.**

Example endpoint contract test inside the new module:

```rust
#[test]
fn azure_chat_endpoint_preserves_deployment_as_one_segment() {
    let config = AzureOpenAiConfig {
        endpoint: " https://example.openai.azure.com/ ".into(),
        deployment: "my/deployment".into(),
        api_version: "2024-10-21".into(),
    };
    assert_eq!(
        config.endpoint_for("chat/completions").unwrap(),
        "https://example.openai.azure.com/openai/deployments/my%2Fdeployment/chat/completions?api-version=2024-10-21"
    );
}
```

Also cover blank values, unsupported schemes, missing host, credentials,
queries/fragments, non-root resource paths, dot path segments, and API-version
query escaping. Deserialize old configuration and assert version defaults.

- [x] **Step 2: Run the new test and verify a behavioral or missing-implementation failure.**

Run: `cargo test --manifest-path src-tauri\Cargo.toml azure --lib`.
If dependencies or native build tools are missing, record the exact blocker
and restore only the necessary dependencies after that failure.

- [x] **Step 3: Implement the shared helper and configuration fields.**

```rust
pub const AZURE_OPENAI_PROVIDER: &str = "azure-openai";
pub const DEFAULT_API_VERSION: &str = "2024-10-21";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureOpenAiConfig {
    pub endpoint: String,
    pub deployment: String,
    pub api_version: String,
}
```

Implement `endpoint_for(&self, operation: &str) -> Result<String, String>` using
`url::Url`, HTTP resource validation from the specification, path-segment APIs,
and `query_pairs_mut`. Reject `.` and `..` deployment segments because URL
normalization would otherwise change the requested route. Allow only the
two internally supplied operation paths. Return explicit configuration errors.

- [x] **Step 4: Add failing chat/authentication/request tests.**

Assert opaque deployment names use `max_completion_tokens`, not `max_tokens`,
and omit temperature and model-specific thinking/sampling fields. Build requests
and assert the API key is trimmed, `api-key` exists, and Authorization does not.
Azure timeouts are 60 seconds independently of deployment names. Test manual
deployment behavior rather than fetching `/models`.

- [x] **Step 5: Wire LLM operations using one resolved configuration path.**

Add a configured endpoint helper that accepts provider, resource URL, deployment,
and optional Azure API version; delegate non-Azure requests to the existing
`chat_endpoint`. Carry API version in `LlmConfig`, with defaults for old data.
Use the helper for real polishing, Ask, test, benchmark, and warm-up requests.
Keep non-Azure body/auth behavior unchanged. Disable GLM-prefix special options
for Azure because deployment names are not underlying model identifiers.

- [x] **Step 6: Add failing STT factory, multipart, and capability tests.**

Verify Azure routing rejects missing config; generated multipart requests contain
`file` and the selected language but no `model`; JSON transcription responses
use the existing text contract. Assert 600/720-second buffered limits and
24 MiB maximum client audio buffer. Exercise diagnostics readiness/errors.

- [x] **Step 7: Wire STT with shared upload request construction.**

Build Azure Whisper configuration from `AzureOpenAiConfig`. Share multipart
construction and authentication between real uploads and connection/benchmark
tests rather than repeating header logic. Resolve application configuration
for both dictation and Ask. Accept optional Azure command config without changing
the behavior of existing Custom Whisper arguments. Use the same endpoint helper
for diagnostics and warm-up. Extend connection invalidation to Azure settings.

- [x] **Step 8: Run targeted Rust verification and inspect the diff.**

Run `cargo test --manifest-path src-tauri\Cargo.toml azure --lib` after each
logical implementation. At the integration checkpoint run the existing
LLM/STT/credential/configuration suites, and check compilation of all callers.
Use targeted rustfmt checking; avoid formatting unrelated pre-existing code.
Report the precise tests run and any unresolved environment blocker.

## Task 2: Frontend configuration and setup

**Ownership:** `src/` only; backend contract is fixed above.

**Files:**
- Modify `src/stores/appStore.ts`: provider unions and defaults.
- Modify `src/lib/constants.ts`: Azure constants, selector entries, LLM defaults.
- Modify `src/lib/tauri.ts`: option types and appended optional arguments.
- Modify `src/lib/backup-settings.ts`: safe scalar type, creation and restore allowlists.
- Modify `src/components/Settings/LlmPane.tsx` and `SttPane.tsx`: setup and test controls.
- Modify `src/components/Onboarding/LlmSetupStep.tsx` and `SttSetupStep.tsx`: equivalent onboarding.
- Modify `src/components/Onboarding/index.tsx` if readiness validation needs the Azure fields.
- Modify all ten `src/i18n/locales/*.json` files with translated Azure labels and hints.
- Extend matching Settings, Onboarding, store, Tauri, backup and locale tests.

- [x] **Step 1: Add failing settings/backup/command-contract tests.**

Example backup round-trip case, using the suite's existing default fixture:

```typescript
const azure = {
  ...current,
  stt_provider: 'azure-openai' as const,
  stt_azure_endpoint: 'https://speech.openai.azure.com',
  stt_azure_deployment: 'my-transcriber',
  stt_azure_api_version: '2024-10-21',
  llm_provider: 'azure-openai' as const,
  llm_base_url: 'https://text.openai.azure.com',
  llm_model: 'my-polisher',
  llm_azure_api_version: '2024-10-21',
  stt_api_key: 'test-stt-secret',
  llm_api_key: 'test-llm-secret',
}
const backup = createBackupSettings(azure)
expect(JSON.stringify(backup)).not.toContain('test-stt-secret')
expect(JSON.stringify(backup)).not.toContain('test-llm-secret')
expect(mergeBackupSettings(current, backup).stt_azure_deployment).toBe('my-transcriber')
```

- [x] **Step 2: Verify the new tests fail, then implement configuration plumbing.**

Run the existing Vitest command selecting the modified test files. If Vitest
is missing, restore dependencies with `npm ci` only after that failure.
Add the agreed fields, defaults, provider IDs and optional command arguments.
Add all four safe scalar settings to backup creation and merge allowlists.

- [x] **Step 3: Add failing Azure UI behavior tests.**

Select Azure in each setup surface and assert resource/deployment/version fields,
empty endpoint/deployment defaults, required-field gating, version forwarding,
and the STT after-recording hint. Assert no model fetch is triggered or offered
for Azure and that changing relevant fields resets stale test status.
Test switching from a non-Azure provider does not carry its key into Azure.

- [x] **Step 4: Implement the Settings and onboarding controls.**

Use existing field components and styling. For Azure LLM relabel existing
endpoint/model fields and add API version. For STT bind the three dedicated
Azure fields and pass this command option:

```typescript
{
  endpoint: config.stt_azure_endpoint,
  deployment: config.stt_azure_deployment,
  apiVersion: config.stt_azure_api_version,
}
```

Disable test/continue controls when Azure configuration is incomplete. Use
existing provider-specific credential APIs, clearing old provider drafts before
reading a newly selected provider's secret. Do not duplicate secrets into
nonsecret fields or transfer legacy drafts to a different provider. Preserve
existing onboarding persistence and credential migration semantics.

- [x] **Step 5: Add localized copy and surface Azure failures.**

Add matching keys in all existing locales for provider labels, resource endpoint,
deployment name, API version, Azure setup hints, and buffered transcription.
Use existing translation helpers. Display backend test/credential errors without
swallowing them into success-shaped defaults.

- [x] **Step 6: Verify the full changed frontend surface.**

Run one Vitest invocation selecting Settings LLM/STT, Onboarding LLM/STT/index,
Tauri, backup, store and locale-parity suites. Run `npm run build`, and ESLint and
Prettier checks limited to changed frontend files. Do not change unrelated
formatting or fix unrelated baseline failures.

## Task 3: Documentation, integration review and final verification

**Files:**
- Modify `README.md`: provider tables and Azure setup section.
- Modify `README_zh.md`: corresponding primary Chinese setup documentation.
- Update this plan's completed checkboxes and verification evidence.

- [x] **Step 1: Document setup and scope.**

Describe selecting Azure OpenAI, obtaining a resource endpoint/key, deploying
separate chat and transcription models, entering deployment names rather than
model names, editable API versions, manual LLM deployment entry, and STT results
after stopping. Explain that Azure v1, Entra and Azure AI Speech are not included.
Mention the client recording limits and secret-free backups. Use example domains
and placeholder keys only, never real credentials.

- [x] **Step 2: Check cross-layer coverage against the specification.**

Trace the four configuration fields from defaults through UI, Tauri, storage,
backup and actual dictation/Ask operations. Verify command argument naming and
optional compatibility. Check credential namespaces, provider changes, warm-up
invalidation and model-alias behavior. Address tightly coupled failures only.

- [x] **Step 3: Request a code review of the implementation diff.**

Use the code-review specialist on the completed change set. Resolve confirmed
correctness issues, then rerun affected existing tests. Do not treat an agent
summary as a substitute for inspecting the final diff and test evidence.

- [x] **Step 4: Run final targeted verification and report evidence.**

Run the combined changed frontend suites and build, targeted Rust suites,
format/lint checks on edited code, and `git diff --check`. Explicitly distinguish
automated contract coverage from an unperformed live Azure test. Leave real keys
for local user configuration. Do not claim live verification without a resource.

- [x] **Step 5: Preserve the completed work.**

Review `git status --short` and the final diff. Commit only reviewed feature
changes at a verified checkpoint if committing is part of the execution workflow;
include the required Copilot coauthor trailer. Never stage unrelated files or
commit generated build artifacts or secrets.

## Implementation and verification record

- Implemented the agreed configuration and IPC contract. The shared Rust module
  exposes `PROVIDER_ID`, `DEFAULT_API_VERSION`, and named chat/transcription
  endpoint methods; the operation-path builder remains private.
- Added a shared Azure form component and credential hook. Code review found and
  regression tests reproduced two credential lifecycle issues: losing queued
  edits on unmount and persisting an untouched loading placeholder. Both were
  fixed, and a targeted re-review found no significant remaining issues.
- Independent backend review found no significant issues.
- Frontend: 202 tests passed across the ten affected Settings, onboarding, hook,
  store, IPC, backup, and locale suites. TypeScript and production Vite build
  passed. Existing dynamic-import and large-chunk warnings remain non-fatal.
- Rust: 306 tests passed using combined `azure`, `llm::`, `stt::`,
  `commands::ask::`, `commands::config::`, `pipeline::`, and `credentials::`
  filters. `cargo check --lib` passed.
- Changed frontend files passed ESLint and Prettier checks. Changed Rust files
  passed rustfmt checks without unrelated formatting changes.
- `git diff --check` passed. No dependency manifests or lockfiles changed.
- The approved specification is committed as `7ffddb5`. Implementation and this
  plan are retained in the feature worktree pending the user's integration choice.
- No live Azure request was made. Final account-level verification requires
  locally configured Azure resource endpoints, deployments, versions, and keys.
