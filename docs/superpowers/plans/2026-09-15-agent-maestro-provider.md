# Agent Maestro Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Maestro a first-class OpenTypeless LLM provider using its existing API, with optional credentials, accurate discovery suggestions, reliable generation, and matching onboarding/settings behavior.

**Architecture:** Add a small provider-specific Rust adapter and reuse the existing OpenAI generation path. Isolate Agent Maestro's shared configuration form and asynchronous credential/discovery behavior instead of rewriting the existing settings panes. Fix the shared SSE decoder's byte handling and OpenAI error events, while keeping stricter response validation specific to Agent Maestro.

**Tech Stack:** React 19, TypeScript, Zustand, i18next, Tauri 2, Rust, reqwest, serde, Tokio, Vitest, existing Rust unit tests.

---

## Inputs and execution rules

- Approved spec: [2026-09-15-agent-maestro-provider-design.md](../specs/2026-09-15-agent-maestro-provider-design.md), committed as `1790242`.
- Modify only this repository. Agent Maestro is a read-only protocol reference.
- Existing worktree: `C:\learning\personal\opentypeless.worktrees\llm-provider-integration-guide`.
- Execute shell commands from this worktree using PowerShell and backslash paths.
- Invoke `using-git-worktrees` when starting execution; reuse this isolated
  worktree rather than creating a nested one.
- Invoke `test-driven-development` before implementation. Each task below has a
  red/green checkpoint; do not commit tests that have only ever passed.
- No package/dependency changes are planned. Restore dependencies only after a
  selected validation command reports they are missing.
- Keep keys, synthetic HTTP fixture data, and exception diagnostics out of git
  except explicitly fake credentials inside tests.
- Every implementation commit includes:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- The plan contains insertion/replacement blocks, not instructions to replace
  entire large existing files. Keep unrelated branches and tests intact.

## File ownership

| Path | Responsibility |
| --- | --- |
| Create `src-tauri\src\llm\agent_maestro.rs` | Provider identity, URLs, configuration validation, model parsing, bounded provider errors, discovery and probe helpers |
| Modify `src-tauri\src\llm\mod.rs` | Register adapter/decoder; optional-key policy |
| Modify `src-tauri\src\llm\protocol.rs` | Agent Maestro endpoint/timeout dispatch and OpenAI error events |
| Create `src-tauri\src\llm\sse.rs` | Incremental byte-safe SSE framing |
| Modify `src-tauri\src\llm\openai.rs` | Use decoder; strict Agent Maestro completion checks |
| Modify `src-tauri\src\commands\llm.rs` | Delegate Agent Maestro discovery and connection probes |
| Modify `src-tauri\src\commands\ask.rs` | Validate Agent Maestro configuration and response on the existing BYOK path |
| Modify `src-tauri\src\pipeline.rs` | Surface Agent Maestro preflight/vault errors before output |
| Modify `src-tauri\src\credentials.rs` | Regression tests for optional provider credentials/migration |
| Create `src-tauri\src\llm\test_http.rs` | Test-only standard-library HTTP fixture used across Rust tests |
| Modify `src\lib\constants.ts`, `src\stores\appStore.ts` | Provider ID, option, defaults, and optional-key requirement |
| Create `src\hooks\useAgentMaestroCredential.ts` | Optional vault key load/write lifecycle |
| Create `src\hooks\useAgentMaestroModels.ts` | Scoped discovery with explicit states and stale-request protection |
| Create `src\components\AgentMaestroFields.tsx` | Shared provider-specific configuration controls |
| Modify `src\components\Settings\LlmPane.tsx` | Render shared form and avoid old provider effects for Agent Maestro |
| Modify `src\components\Onboarding\LlmSetupStep.tsx` | Same form and no legacy key inheritance |
| Modify `src\i18n\locales\{en,zh,de,es,fr,it,ja,ko,pt,ru}.json` | New provider label and localized hints/errors |
| Create targeted tests under `src\hooks\__tests__`, `src\components\__tests__`, `src\lib\__tests__` | Hook/form/metadata behavior |
| Extend existing pane, onboarding, backup, credential, protocol, and Ask tests | Wiring and persistence regressions |
| Modify `README.md`, `README_zh.md` | Setup and troubleshooting |

New hooks/components are Agent Maestro-specific deliberately: legacy providers
keep their existing form behavior, avoiding a wide settings refactor.

## Task 1: Provider contract and protocol dispatch

**Files:** `src-tauri\src\llm\agent_maestro.rs`,
`src-tauri\src\llm\mod.rs`, `src-tauri\src\llm\protocol.rs`.

- [ ] **1.1 Add contract tests first.** Add a test module in the new adapter,
  with the following tests. Keep all test names containing `agent_maestro`.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_maestro_urls_preserve_origin_and_prefix() {
        for suffix in ["", "/", "/chat/completions", "/chat/completions/"] {
            let base = format!("https://example.test:24444/am/api/openai/v1{suffix}");
            let (chat, models) = endpoints(&base).unwrap();
            assert_eq!(chat, "https://example.test:24444/am/api/openai/v1/chat/completions");
            assert_eq!(models, "https://example.test:24444/am/api/v1/lm/chatModels");
        }
    }

    #[test]
    fn agent_maestro_rejects_invalid_configuration() {
        for base in [
            "", "file:///tmp/models", "http://localhost:23333",
            "http://user:password@localhost:23333/api/openai/v1",
            "http://localhost:23333/api/openai/v1?q=1",
            "http://localhost:23333/api/openai/v1#fragment",
        ] {
            assert!(endpoints(base).is_err(), "{base}");
        }
        assert!(validate_config(DEFAULT_BASE_URL, "   ").is_err());
        assert!(validate_config(DEFAULT_BASE_URL, "manual-model").is_ok());
    }

    #[test]
    fn agent_maestro_discovery_is_validated_and_copilot_only() {
        let body = json!([
            {"vendor":"copilot","id":"gpt-test"},
            {"vendor":"copilot","id":"claude-test"},
            {"vendor":"copilot","id":"gpt-test"},
            {"vendor":"another-extension","id":"local-model"}
        ]);
        assert_eq!(parse_models(body).unwrap(), vec!["claude-test", "gpt-test"]);
        assert!(parse_models(json!([])).unwrap().is_empty());
        for invalid in [
            json!({"data":[]}), json!([{"id":"model"}]),
            json!([{"vendor":"copilot","id":" "}]),
            json!([{"vendor":"copilot","id":42}]),
        ] {
            assert!(parse_models(invalid).is_err());
        }
    }
}
```

- [ ] **1.2 Run red.**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
```

Initially register `pub mod agent_maestro;` so the tests are compiled. Expected:
missing functions/constants, not unrelated environment failures. Resolve build
prerequisites before treating a failure as evidence of missing behavior.

- [ ] **1.3 Implement the adapter contract.**

```rust
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;

pub const PROVIDER: &str = "agent-maestro";
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:23333/api/openai/v1";
pub const GENERATION_TIMEOUT: Duration = Duration::from_secs(120);
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

pub fn is_provider(provider: &str) -> bool {
    provider.trim().eq_ignore_ascii_case(PROVIDER)
}

pub fn endpoints(base_url: &str) -> Result<(String, String), String> {
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|_| "Invalid Agent Maestro Base URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Agent Maestro requires an HTTP(S) URL without credentials, query, or fragment".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/chat/completions").unwrap_or(path);
    let prefix = path.strip_suffix("/api/openai/v1")
        .ok_or("Agent Maestro Base URL must end in /api/openai/v1")?
        .to_string();
    url.set_path(&format!("{prefix}/api/openai/v1/chat/completions"));
    let chat = url.to_string();
    url.set_path(&format!("{prefix}/api/v1/lm/chatModels"));
    Ok((chat, url.to_string()))
}

pub fn validate_config(base_url: &str, model: &str) -> Result<(), String> {
    endpoints(base_url)?;
    if model.trim().is_empty() {
        return Err("Select or enter an Agent Maestro model ID".into());
    }
    Ok(())
}

#[derive(Deserialize)]
struct DiscoveredModel {
    id: String,
    vendor: String,
}

pub fn parse_models(value: Value) -> Result<Vec<String>, String> {
    let models: Vec<DiscoveredModel> = serde_json::from_value(value)
        .map_err(|_| "Invalid Agent Maestro model-list response".to_string())?;
    let mut ids = BTreeSet::new();
    for model in models {
        if model.vendor == "copilot" {
            if model.id.trim().is_empty() {
                return Err("Agent Maestro returned a blank Copilot model ID".into());
            }
            ids.insert(model.id.trim().to_string());
        }
    }
    Ok(ids.into_iter().collect())
}
```

- [ ] **1.4 Wire dispatch without changing other providers.** Add the module
  declaration and replace only `provider_requires_api_key` in `llm\mod.rs`:

```rust
pub mod agent_maestro;

pub fn provider_requires_api_key(provider: &str) -> bool {
    !matches!(
        provider.trim().to_ascii_lowercase().as_str(),
        "ollama" | "agent-maestro"
    )
}
```

Insert these early branches into the correspondingly named protocol functions:

```rust
// chat_endpoint, before generic URL handling:
if super::agent_maestro::is_provider(provider) {
    return super::agent_maestro::endpoints(base_url).map(|(chat, _)| chat);
}
// models_endpoint:
if super::agent_maestro::is_provider(provider) {
    return super::agent_maestro::endpoints(base_url).map(|(_, models)| models);
}
// request_timeout:
if super::agent_maestro::is_provider(provider) {
    return super::agent_maestro::GENERATION_TIMEOUT;
}
// build_chat_body, before detect_api_kind:
let model = if super::agent_maestro::is_provider(provider) {
    model.trim()
} else {
    model
};
```

Existing `apply_auth_headers` already omits an empty key when the requirement
helper returns false; do not duplicate Bearer-header construction.

- [ ] **1.5 Add dispatch/auth/body assertions and run green.**

```rust
#[test]
fn agent_maestro_protocol_uses_optional_auth_and_longer_timeout() {
    let base = crate::llm::agent_maestro::DEFAULT_BASE_URL;
    assert_eq!(request_timeout("agent-maestro", base, "claude-test"), Duration::from_secs(120));
    for key in ["", "   ", " fake-key "] {
        let request = apply_auth_headers(
            reqwest::Client::new().get(base), "agent-maestro", base, key
        ).build().unwrap();
        assert_eq!(
            request.headers().get("Authorization").map(|h| h.to_str().unwrap()),
            (!key.trim().is_empty()).then_some("Bearer fake-key")
        );
    }
    let body = build_chat_body("agent-maestro", base, " exact-id ", messages(), 128, 0.3, false);
    assert_eq!(body["model"], "exact-id");
    assert_eq!(body["max_tokens"], 128);
}
```

The test goes in `protocol.rs`'s existing `tests` module, which already imports
the protocol helpers and defines `messages()`.

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib llm::
```

Expected: adapter tests and existing OpenAI/Anthropic/keyless tests pass.
Commit these files with message `feat: add Agent Maestro provider protocol contract`.

## Task 2: Discovery and meaningful connection probes

**Files:** `src-tauri\src\llm\agent_maestro.rs`,
`src-tauri\src\commands\llm.rs`.

- [ ] **2.1 Add response-validation tests, then run red.**

```rust
#[test]
fn agent_maestro_probe_requires_real_text() {
    use serde_json::json;
    assert_eq!(
        response_text(&json!({"choices":[{"message":{"content":"OK"}}]})).unwrap(),
        "OK"
    );
    for body in [
        json!({}),
        json!({"error":{"message":"upstream failed"}}),
        json!({"choices":[{"message":{"content":" "}}]}),
        json!({"choices":[{"message":{"reasoning_content":"not an answer"}}]}),
    ] {
        assert!(response_text(&body).is_err());
    }
}
```

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
```

- [ ] **2.2 Add bounded diagnostics, discovery, and probe helpers to the adapter.**
  All errors remain errors. Do not include request bodies or URLs containing
  credentials in diagnostics.

```rust
pub fn diagnostic(message: &str, key: &str) -> String {
    let key = key.trim();
    let redacted = if key.is_empty() {
        message.to_string()
    } else {
        message.replace(key, "[redacted]")
    };
    redacted.chars().take(200).collect()
}

pub fn network_error(error: reqwest::Error, key: &str, timeout: Duration) -> String {
    if error.is_timeout() {
        format!("Agent Maestro request timed out after {} seconds", timeout.as_secs())
    } else if error.is_connect() {
        "Cannot connect to Agent Maestro. Start its API server and check the configured address and port.".into()
    } else {
        diagnostic(&format!("Agent Maestro request failed: {}", error.without_url()), key)
    }
}

pub async fn read_json(
    response: reqwest::Response,
    key: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().await.map_err(|e| network_error(e, key, timeout))?;
    if !status.is_success() {
        let hint = match status.as_u16() {
            401 | 403 => "Check the optional LLM API key and Copilot access.",
            404 => "Check the Agent Maestro Base URL and extension version.",
            _ => "Check the Agent Maestro output channel.",
        };
        return Err(format!("Agent Maestro HTTP {}. {} {}",
            status.as_u16(), hint, diagnostic(&body, key)));
    }
    serde_json::from_str(&body)
        .map_err(|_| "Agent Maestro returned invalid JSON".to_string())
}

pub fn response_text(value: &Value) -> Result<String, String> {
    if value.get("error").is_some() {
        return Err("Agent Maestro returned an error instead of a text answer".into());
    }
    let text = value["choices"][0]["message"]["content"].as_str()
        .ok_or("Agent Maestro returned no text answer")?;
    if text.trim().is_empty() {
        return Err("Agent Maestro returned an empty text answer".into());
    }
    Ok(text.to_string())
}

pub fn validate_stream_event(value: &Value) -> Result<(), String> {
    let invalid = "Agent Maestro returned an invalid stream event";
    let choices = value.get("choices").and_then(Value::as_array).ok_or(invalid)?;
    for choice in choices {
        let delta = choice.get("delta").and_then(Value::as_object).ok_or(invalid)?;
        for field in ["content", "reasoning_content"] {
            if let Some(content) = delta.get(field) {
                if !content.is_null() && !content.is_string() {
                    return Err(invalid.into());
                }
            }
        }
    }
    Ok(())
}

pub async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
    key: &str,
) -> Result<Vec<String>, String> {
    let (_, endpoint) = endpoints(base_url)?;
    let request = super::protocol::apply_auth_headers(
        client.get(endpoint), PROVIDER, base_url, key
    );
    let response = request.timeout(DISCOVERY_TIMEOUT).send().await
        .map_err(|e| network_error(e, key, DISCOVERY_TIMEOUT))?;
    parse_models(read_json(response, key, DISCOVERY_TIMEOUT).await?)
}

pub async fn probe(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    key: &str,
) -> Result<u32, String> {
    validate_config(base_url, model)?;
    let (endpoint, _) = endpoints(base_url)?;
    let body = super::protocol::build_chat_body(
        PROVIDER, base_url, model,
        vec![serde_json::json!({"role":"user","content":"Reply briefly with OK."})],
        128, 0.3, false,
    );
    let started = std::time::Instant::now();
    let response = super::protocol::apply_auth_headers(
        client.post(endpoint), PROVIDER, base_url, key
    ).json(&body).timeout(GENERATION_TIMEOUT).send().await
        .map_err(|e| network_error(e, key, GENERATION_TIMEOUT))?;
    response_text(&read_json(response, key, GENERATION_TIMEOUT).await?)?;
    Ok(started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32)
}
```

- [ ] **2.3 Wire Tauri commands before their legacy empty-key/default branches.**

In `fetch_llm_models`, insert before `if base_url.is_empty()`:

```rust
if crate::llm::agent_maestro::is_provider(&provider) {
    let key = resolve_config_secret(&api_key, "llm", &provider, &SystemCredentialVault)
        .map_err(|_| "Could not read the Agent Maestro API key from the credential vault".to_string())?;
    return crate::llm::agent_maestro::fetch_models(&client, &base_url, &key).await;
}
```

In `test_llm_connection`, before its cloud/legacy probe logic:

```rust
if crate::llm::agent_maestro::is_provider(&provider) {
    let key = resolve_config_secret(&api_key, "llm", &provider, &SystemCredentialVault)
        .map_err(|_| "Could not read the Agent Maestro API key from the credential vault".to_string())?;
    crate::llm::agent_maestro::probe(&client, &base_url, &model, &key).await?;
    return Ok(true);
}
```

In `bench_llm_connection`, use the same adapter and return its latency:

```rust
if crate::llm::agent_maestro::is_provider(&provider) {
    let key = resolve_config_secret(&api_key, "llm", &provider, &SystemCredentialVault)
        .map_err(|_| "Could not read the Agent Maestro API key from the credential vault".to_string())?;
    return crate::llm::agent_maestro::probe(&client, &base_url, &model, &key).await;
}
```

Do not change existing commands' IPC signatures or other providers' probe rules.

- [ ] **2.4 Run green and commit.**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
```

Expected: all current Agent Maestro contract/probe tests pass. HTTP wire-level
tests are added in Task 8; this task tests parsing and request construction.
Commit message: `feat: discover and test Agent Maestro models`.

## Task 3: Byte-safe SSE and failure propagation

**Files:** `src-tauri\src\llm\sse.rs`, `src-tauri\src\llm\mod.rs`,
`src-tauri\src\llm\protocol.rs`, `src-tauri\src\llm\openai.rs`.

- [ ] **3.1 Add decoder tests, register the module, and run red.**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_maestro_sse_survives_every_byte_boundary() {
        let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"\u{4e2d}\u{6587}\"}}]}\r\n\r\n";
        for split in 0..=wire.len() {
            let mut decoder = SseDecoder::default();
            let mut frames = decoder.push(&wire.as_bytes()[..split]).unwrap();
            frames.extend(decoder.push(&wire.as_bytes()[split..]).unwrap());
            assert_eq!(frames.len(), 1);
            assert!(frames[0].contains("\u{4e2d}\u{6587}"));
            assert!(!decoder.has_pending());
        }
    }

    #[test]
    fn agent_maestro_sse_ignores_comments_and_keeps_error_data() {
        let mut decoder = SseDecoder::default();
        let frames = decoder.push(
            b": keep-alive\n\nevent: error\ndata: {\"error\":{\"message\":\"failed\"}}\n\n"
        ).unwrap();
        assert_eq!(frames, vec!["{\"error\":{\"message\":\"failed\"}}"]);
        assert!(decoder.push(b"data: [DONE]\n\n").unwrap().contains(&"[DONE]".into()));
        decoder.push(b"data: incomplete").unwrap();
        assert!(decoder.has_pending());
    }
}
```

```rust
// llm/mod.rs
pub(crate) mod sse;
```

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
```

- [ ] **3.2 Implement complete event framing in `sse.rs`.**

```rust
#[derive(Default)]
pub(crate) struct SseDecoder {
    bytes: Vec<u8>,
    data: Vec<String>,
}

impl SseDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.bytes.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(end) = self.bytes.iter().position(|byte| *byte == b'\n') {
            let line = self.bytes.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "LLM stream contains invalid UTF-8".to_string())?;
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    frames.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }
        Ok(frames)
    }

    pub(crate) fn has_pending(&self) -> bool {
        !self.bytes.is_empty() || !self.data.is_empty()
    }
}
```

- [ ] **3.3 Add OpenAI error-event detection before delta extraction.**

In the OpenAI branch of `parse_stream_event`:

```rust
if let Some(error) = body.get("error") {
    return StreamEvent {
        error: Some(
            error.get("message").and_then(Value::as_str)
                .unwrap_or("LLM stream returned an error").to_string()
        ),
        ..StreamEvent::default()
    };
}
```

Add this test to the protocol tests:

```rust
#[test]
fn agent_maestro_openai_error_is_not_an_empty_delta() {
    let event = parse_stream_event(
        LlmApiKind::OpenAiCompatible,
        &json!({"error":{"message":"upstream failed","type":"server_error"}}),
    );
    assert_eq!(event.error.as_deref(), Some("upstream failed"));
    assert!(event.text.is_none());
}
```

- [ ] **3.4 Replace the string buffer loop in `OpenAiProvider::polish`.**

At entry, set `is_maestro` and perform configuration validation:

```rust
let is_maestro = super::agent_maestro::is_provider(&config.provider);
if is_maestro {
    super::agent_maestro::validate_config(&config.base_url, &config.model)
        .map_err(AppError::Config)?;
}
```

Retain the existing request/retry loop and callback/reasoning accumulation.
Replace only the SSE buffering loop with:

```rust
let mut decoder = super::sse::SseDecoder::default();
let mut stream_done = false;
while !stream_done {
    let Some(chunk) = stream.next().await else { break };
    let chunk = chunk.map_err(|e| {
        if is_maestro {
            AppError::Config(super::agent_maestro::network_error(
                e, &config.api_key, super::agent_maestro::GENERATION_TIMEOUT
            ))
        } else {
            AppError::from(e)
        }
    })?;
    for data in decoder.push(&chunk).map_err(AppError::Config)? {
        if data.trim() == "[DONE]" {
            stream_done = true;
            break;
        }
        let value = match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(value) => value,
            Err(_) if is_maestro => {
                return Err(AppError::Config("Agent Maestro returned invalid stream JSON".into()));
            }
            Err(error) => {
                tracing::warn!("Ignoring invalid LLM stream event: {error}");
                continue;
            }
        };
        let event = protocol::parse_stream_event(api_kind, &value);
        if let Some(error) = event.error {
            let message = if is_maestro {
                super::agent_maestro::diagnostic(&error, &config.api_key)
            } else {
                error
            };
            return Err(AppError::Config(message));
        }
        if is_maestro {
            super::agent_maestro::validate_stream_event(&value).map_err(AppError::Config)?;
        }
        if let Some(content) = event.text.filter(|text| !text.is_empty()) {
            full_text.push_str(&content);
            callback(&content);
        }
        if let Some(reasoning) = event.reasoning.filter(|text| !text.is_empty()) {
            reasoning_text.push_str(&reasoning);
        }
        if event.done {
            stream_done = true;
            break;
        }
    }
}
if is_maestro && (!stream_done || full_text.trim().is_empty()) {
    let message = if !stream_done {
        if decoder.has_pending() {
            "Agent Maestro stream ended inside an event"
        } else {
            "Agent Maestro stream ended without [DONE]"
        }
    } else {
        "Agent Maestro returned an empty text answer"
    };
    return Err(AppError::Config(message.into()));
}
```

For non-streaming Agent Maestro, before the existing generic JSON parsing:

```rust
if is_maestro {
    let body = super::agent_maestro::read_json(
        response, &config.api_key, super::agent_maestro::GENERATION_TIMEOUT
    ).await.map_err(AppError::Config)?;
    return Ok(PolishResponse {
        polished_text: super::agent_maestro::response_text(&body).map_err(AppError::Config)?,
    });
}
```

In initial request error branches, preserve retry predicates/attempt limits,
but map terminal Agent Maestro timeout/connect errors through `network_error`.
For terminal Agent Maestro HTTP failure, consume via `read_json` to produce a
bounded, redacted HTTP error; leave the generic provider branch unchanged.
The concrete terminal error replacement is:

```rust
Err(e) => {
    return Err(if is_maestro {
        AppError::Config(super::agent_maestro::network_error(
            e, &config.api_key, super::agent_maestro::GENERATION_TIMEOUT
        ))
    } else {
        e.into()
    });
}
```

For the final non-success `Ok(resp)` branch, insert before generic truncation:

```rust
if is_maestro {
    return match super::agent_maestro::read_json(
        resp, &config.api_key, super::agent_maestro::GENERATION_TIMEOUT
    ).await {
        Err(message) => Err(AppError::Config(message)),
        Ok(_) => Err(AppError::Config("Unexpected Agent Maestro HTTP status".into())),
    };
}
```

- [ ] **3.5 Run all LLM module tests and commit.**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib llm::
```

Expected: existing Anthropic/OpenAI/reasoning tests still pass and added framing/
error tests pass. Add regression cases for multiline SSE data, `data:` without a
space, invalid UTF-8, and multiple frames in one chunk to this same decoder
module. Commit message: `fix: handle Agent Maestro SSE framing and failures`.

## Task 4: Runtime validation and vault failure safety

**Files:** `src-tauri\src\commands\ask.rs`,
`src-tauri\src\pipeline.rs`, `src-tauri\src\credentials.rs`.

- [ ] **4.1 Add Ask routing/configuration tests and run red.**

Inside Ask's existing tests:

```rust
#[test]
fn agent_maestro_ask_is_byok_without_a_key() {
    let config = storage::AppConfig {
        llm_provider: "agent-maestro".into(),
        llm_base_url: crate::llm::agent_maestro::DEFAULT_BASE_URL.into(),
        llm_model: "manual-id".into(),
        ..Default::default()
    };
    assert!(should_use_byok(&config, ""));
    assert!(!should_use_cloud(&config));
    let body = build_byok_ask_body_for_config(&config, "Hello", None).unwrap();
    assert_eq!(body["model"], "manual-id");
    let invalid = storage::AppConfig { llm_model: " ".into(), ..config };
    assert!(build_byok_ask_body_for_config(&invalid, "Hello", None).is_err());
}
```

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
```

- [ ] **4.2 Add Agent Maestro validation to Ask body construction and dispatch.**

Insert at the beginning of `build_byok_ask_body_for_config`:

```rust
if crate::llm::agent_maestro::is_provider(&config.llm_provider) {
    crate::llm::agent_maestro::validate_config(&config.llm_base_url, &config.llm_model)?;
}
```

In `answer_question`, validate before `should_use_byok` so a blank model produces
the provider-specific message, not a cloud fallback:

```rust
if crate::llm::agent_maestro::is_provider(&config.llm_provider) {
    crate::llm::agent_maestro::validate_config(&config.llm_base_url, &config.llm_model)
        .map_err(AppError::Config)?;
}
```

In `ask_via_byok`, map Agent Maestro request errors through `network_error`;
then insert the following before generic status/body handling:

```rust
if crate::llm::agent_maestro::is_provider(&config.llm_provider) {
    let body = crate::llm::agent_maestro::read_json(
        resp, api_key, crate::llm::agent_maestro::GENERATION_TIMEOUT
    ).await?;
    return validate_ask_answer(&crate::llm::agent_maestro::response_text(&body)?);
}
```

The send-error mapper is:

```rust
let resp = request.send().await.map_err(|error| {
    if crate::llm::agent_maestro::is_provider(&config.llm_provider) {
        crate::llm::agent_maestro::network_error(
            error, api_key, crate::llm::agent_maestro::GENERATION_TIMEOUT
        )
    } else {
        error.to_string()
    }
})?;
```

- [ ] **4.3 Prevent a failed vault read becoming an empty-key request in pipeline.**

Before resolving the LLM key, when polish is enabled and Agent Maestro is active,
validate its configuration. On failure emit `pipeline:error` using
`llm_polish_user_error`, return `PolishTextOutcome::with_history_status`, and do
not change target application text. Insert:

```rust
if config.polish_enabled && llm::agent_maestro::is_provider(&config.llm_provider) {
    if let Err(message) = llm::agent_maestro::validate_config(
        &config.llm_base_url, &config.llm_model
    ) {
        let error = crate::error::AppError::Config(message.clone());
        tracing::warn!("Agent Maestro configuration is incomplete");
        let _ = self.app_handle.emit("pipeline:error", llm_polish_user_error(&error));
        return PolishTextOutcome::with_history_status(
            String::new(), std::time::Duration::ZERO, "fallback", message
        );
    }
}
```

The existing vault-error match branch must not return `String::new()` for an
enabled Agent Maestro call. Insert this conditional before the legacy fallback:

```rust
if config.polish_enabled && llm::agent_maestro::is_provider(&config.llm_provider) {
    let message = "Could not read the Agent Maestro API key from the credential vault";
    let failure = crate::error::AppError::Config(message.into());
    tracing::warn!("{message}");
    let _ = self.app_handle.emit("pipeline:error", llm_polish_user_error(&failure));
    return PolishTextOutcome::with_history_status(
        String::new(), std::time::Duration::ZERO, "fallback", message
    );
}
```

Do not log the underlying vault exception for this branch if it may contain
secret values. Leave polish-disabled/raw dictation and other providers'
pre-existing behavior unchanged.

- [ ] **4.4 Extend existing in-memory vault tests with Agent Maestro cases.**
  Use the existing `MemoryVault` helper in `credentials.rs` rather than a second
  store implementation:

```rust
#[test]
fn agent_maestro_credentials_round_trip_without_config_secrets() {
    let vault = MemoryVault::default();
    let mut config = AppConfig {
        llm_provider: "agent-maestro".into(),
        llm_api_key: "fake-maestro-key".into(),
        ..Default::default()
    };
    migrate_legacy_config_secrets(&mut config, &vault).unwrap();
    assert!(config.llm_api_key.is_empty());
    assert_eq!(resolve_llm_config_secret(&config, &vault).unwrap(), "fake-maestro-key");
    assert!(vault.get_secret("llm", "openai").unwrap().is_none());
}
```

Also add the missing-entry/read-failure regression in `credentials.rs`:

```rust
#[test]
fn agent_maestro_distinguishes_missing_credential_from_vault_failure() {
    struct FailingReader;
    impl CredentialSecretReader for FailingReader {
        fn get_secret(&self, _: &str, _: &str) -> Result<Option<String>> {
            Err(anyhow!("vault unavailable"))
        }
    }
    let config = AppConfig {
        llm_provider: "agent-maestro".into(),
        llm_api_key: String::new(),
        ..Default::default()
    };
    assert_eq!(resolve_llm_config_secret(&config, &MemoryVault::default()).unwrap(), "");
    assert!(resolve_llm_config_secret(&config, &FailingReader).is_err());
}
```

Add the event regression in `pipeline.rs`'s existing tests:

```rust
#[test]
fn agent_maestro_preflight_error_uses_llm_error_surface() {
    let message = crate::llm::agent_maestro::validate_config(
        crate::llm::agent_maestro::DEFAULT_BASE_URL, ""
    ).unwrap_err();
    let error = crate::error::AppError::Config(message.clone());
    let event = llm_polish_user_error(&error);
    assert_eq!(event.code, "llm_failed");
    assert!(event.details.unwrap().contains(&message));
}
```

- [ ] **4.5 Run green and commit.**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
```

Commit message: `fix: validate Agent Maestro runtime configuration and credentials`.

## Task 5: Frontend provider identity and scoped model discovery

**Files:** `src\lib\constants.ts`, `src\stores\appStore.ts`,
`src\hooks\useAgentMaestroModels.ts`,
`src\hooks\__tests__\useAgentMaestroModels.test.ts`,
`src\lib\__tests__\agent-maestro.test.ts`.

- [ ] **5.1 Add provider metadata and hook tests before implementation.**

```typescript
import { describe, expect, it } from 'vitest'
import { LLM_DEFAULT_CONFIG, LLM_PROVIDERS, llmProviderRequiresApiKey } from '../constants'

describe('Agent Maestro metadata', () => {
  it('has its own provider and no implicit model or required key', () => {
    expect(LLM_PROVIDERS).toContainEqual({
      value: 'agent-maestro', labelKey: 'providers.llm.agentMaestro',
    })
    expect(LLM_DEFAULT_CONFIG['agent-maestro']).toEqual({
      baseUrl: 'http://127.0.0.1:23333/api/openai/v1', model: '',
    })
    expect(llmProviderRequiresApiKey('agent-maestro')).toBe(false)
    expect(llmProviderRequiresApiKey('openai')).toBe(true)
    expect(llmProviderRequiresApiKey('ollama')).toBe(false)
  })
})
```

In the hook test file, use this setup and deferred promises to prove ordering:

```typescript
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchLlmModels } from '../../lib/tauri'
import { useAgentMaestroModels } from '../useAgentMaestroModels'

vi.mock('../../lib/tauri')
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchLlmModels).mockResolvedValue([])
})
afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('does not apply an old server response to the new scope', async () => {
  const oldRequest = deferred<string[]>()
  vi.mocked(fetchLlmModels)
    .mockReturnValueOnce(oldRequest.promise)
    .mockResolvedValueOnce(['new-model'])
  const { result, rerender } = renderHook(
    ({ url }) => useAgentMaestroModels(url, '', true),
    { initialProps: { url: 'http://localhost:23333/api/openai/v1' } },
  )
  await waitFor(() => expect(fetchLlmModels).toHaveBeenCalledTimes(1))
  rerender({ url: 'http://localhost:24444/api/openai/v1' })
  await waitFor(() => expect(result.current.models).toEqual(['new-model']))
  await act(async () => { oldRequest.resolve(['old-model']) })
  expect(result.current.models).toEqual(['new-model'])
})
```

- [ ] **5.2 Run red.**

```powershell
npm test -- src\lib\__tests__\agent-maestro.test.ts src\hooks\__tests__\useAgentMaestroModels.test.ts
```

- [ ] **5.3 Add provider metadata without changing app defaults.**

```typescript
// constants.ts: insert in LLM_PROVIDERS before cloud
{ value: 'agent-maestro', labelKey: 'providers.llm.agentMaestro' },
// constants.ts: insert in LLM_DEFAULT_CONFIG
'agent-maestro': { baseUrl: 'http://127.0.0.1:23333/api/openai/v1', model: '' },
// constants.ts: replace the requirement helper
export function llmProviderRequiresApiKey(provider: string): boolean {
  return !['ollama', 'agent-maestro'].includes(provider.trim().toLowerCase())
}
// appStore.ts: extend LlmProvider union before cloud
| 'agent-maestro'
```

- [ ] **5.4 Implement the scoped discovery hook.**

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLlmModels } from '../lib/tauri'

type DiscoveryState = {
  scope: string
  models: string[]
  status: 'idle' | 'loading' | 'success' | 'error'
  error: string | null
}

export function useAgentMaestroModels(baseUrl: string, apiKey: string, enabled: boolean) {
  const scope = JSON.stringify([baseUrl.trim(), apiKey, enabled])
  const [state, setState] = useState<DiscoveryState>({
    scope, models: [], status: 'idle', error: null,
  })
  const requestId = useRef(0)
  const mountedScope = useRef(scope)

  const refresh = useCallback(async () => {
    if (!enabled || !baseUrl.trim()) return
    const id = ++requestId.current
    setState(previous => ({
      scope, models: previous.scope === scope ? previous.models : [],
      status: 'loading', error: null,
    }))
    try {
      const models = await fetchLlmModels(apiKey, 'agent-maestro', baseUrl)
      if (id === requestId.current && mountedScope.current === scope) {
        setState({ scope, models, status: 'success', error: null })
      }
    } catch (error) {
      if (id !== requestId.current || mountedScope.current !== scope) return
      const message = error instanceof Error ? error.message : String(error)
      const safeMessage = apiKey.trim()
        ? message.split(apiKey.trim()).join('[redacted]')
        : message
      setState(previous => ({
        scope, models: previous.scope === scope ? previous.models : [],
        status: 'error', error: safeMessage.slice(0, 300),
      }))
    }
  }, [apiKey, baseUrl, enabled, scope])

  useEffect(() => {
    mountedScope.current = scope
    ++requestId.current
    const timer = setTimeout(() => { void refresh() }, 500)
    return () => {
      clearTimeout(timer)
      ++requestId.current
    }
  }, [refresh, scope])

  const visible = state.scope === scope
    ? state
    : { scope, models: [], status: 'idle' as const, error: null }
  return { ...visible, refresh }
}
```

The hook exists only while the Agent Maestro form is mounted. It does not mutate
the old global `llmModels` cache or the selected model. Empty successful results
have `status === 'success'` and `models.length === 0`, distinct from `error`.
Disabled/empty-URL auto-fetch is a normal state, not an invalid-input failure.

- [ ] **5.5 Add success/empty/error/refresh tests and run green.**
  Use the deferred helper to reject an obsolete request, trigger two explicit
  refreshes, change the API key mid-request, and unmount before resolution.
  Assert results and loading/error state belong only to the newest request.

```typescript
it('reports failure separately from an empty model list', async () => {
  vi.mocked(fetchLlmModels).mockRejectedValue(new Error('Agent Maestro HTTP 401'))
  const { result } = renderHook(() =>
    useAgentMaestroModels('http://localhost:23333/api/openai/v1', '', true))
  await waitFor(() => expect(result.current.status).toBe('error'))
  expect(result.current.error).toContain('401')
  expect(result.current.models).toEqual([])
})
```

```powershell
npm test -- src\lib\__tests__\agent-maestro.test.ts src\hooks\__tests__\useAgentMaestroModels.test.ts
```

Commit message: `feat: add Agent Maestro metadata and scoped model discovery`.

## Task 6: Optional credential lifecycle and shared configuration form

**Files:** `src\hooks\useAgentMaestroCredential.ts`,
`src\hooks\__tests__\useAgentMaestroCredential.test.ts`,
`src\components\AgentMaestroFields.tsx`,
`src\components\__tests__\AgentMaestroFields.test.tsx`.

- [ ] **6.1 Write credential lifecycle tests and run red.** Mock Tauri only;
  test absent/stored keys and failure independently of the large settings pane.
  Reuse the deferred-promise pattern from Task 5, declaring the helper in this
  test file as well.

```typescript
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readCredential, setCredential } from '../../lib/tauri'
import { useAgentMaestroCredential } from '../useAgentMaestroCredential'

vi.mock('../../lib/tauri')
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readCredential).mockResolvedValue(null)
  vi.mocked(setCredential).mockResolvedValue(undefined)
})

describe('Agent Maestro optional credential', () => {
  it('distinguishes missing from failed reads', async () => {
    const migrated = vi.fn()
    const first = renderHook(() => useAgentMaestroCredential('', migrated))
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    expect(first.result.current.value).toBe('')
    first.unmount()
    vi.mocked(readCredential).mockRejectedValue(new Error('vault unavailable'))
    const second = renderHook(() => useAgentMaestroCredential('', migrated))
    await waitFor(() => expect(second.result.current.status).toBe('error'))
    expect(second.result.current.error).toBe(true)
  })

  it('persists clearing a stored key under the Agent Maestro account', async () => {
    vi.mocked(readCredential).mockResolvedValue('fake-key')
    const migrated = vi.fn()
    const { result } = renderHook(() => useAgentMaestroCredential('', migrated))
    await waitFor(() => expect(result.current.value).toBe('fake-key'))
    act(() => result.current.update(''))
    act(() => result.current.flush())
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(setCredential).toHaveBeenLastCalledWith('llm', 'agent-maestro', '')
  })
})
```

```powershell
npm test -- src\hooks\__tests__\useAgentMaestroCredential.test.ts
```

- [ ] **6.2 Implement the optional credential hook.**
  Writes are serialized even across form remounts, and every write still reports
  its own failure. Waiting for the queue to settle before reading does not
  assume a failed write succeeded.

```typescript
import { useCallback, useEffect, useRef, useState } from 'react'
import { readCredential, setCredential } from '../lib/tauri'

let writeTail: Promise<void> = Promise.resolve()
function writeKey(value: string): Promise<void> {
  const persist = () => setCredential('llm', 'agent-maestro', value.trim())
  const operation = writeTail.then(persist, persist)
  writeTail = operation
  return operation
}

type CredentialState = {
  value: string
  status: 'loading' | 'saving' | 'ready' | 'error'
  error: boolean
}

export function useAgentMaestroCredential(
  legacyKey: string,
  onLegacySaved: (legacyKey: string) => void,
) {
  const [state, setState] = useState<CredentialState>({
    value: '', status: 'loading', error: false,
  })
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)
  const revision = useRef(0)
  const lastOperation = useRef<'read' | 'write'>('read')
  const pending = useRef<{ value: string; revision: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const entry = pending.current
    if (!entry) return
    pending.current = null
    lastOperation.current = 'write'
    void writeKey(entry.value).then(
      () => {
        if (mounted.current && entry.revision === revision.current) {
          setState({ value: entry.value, status: 'ready', error: false })
        }
      },
      () => {
        console.error('[credentials] Agent Maestro credential save failed')
        if (mounted.current && entry.revision === revision.current) {
          setState({ value: entry.value, status: 'error', error: true })
        }
      },
    )
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    const id = ++revision.current
    lastOperation.current = 'read'
    setState(previous => ({ ...previous, status: 'loading', error: false }))
    const load = async () => {
      await Promise.allSettled([writeTail])
      if (cancelled) return
      const value = legacyKey.trim() ? legacyKey : await readCredential('llm', 'agent-maestro')
      if (legacyKey.trim()) await writeKey(legacyKey)
      if (cancelled || id !== revision.current) return
      if (legacyKey.trim()) onLegacySaved(legacyKey)
      setState({ value: value ?? '', status: 'ready', error: false })
    }
    void load().catch(() => {
      console.error('[credentials] Agent Maestro credential load or migration failed')
      if (!cancelled && id === revision.current) {
        setState(previous => ({ ...previous, status: 'error', error: true }))
      }
    })
    return () => {
      cancelled = true
      mounted.current = false
      ++revision.current
      flush()
    }
  }, [flush, legacyKey, onLegacySaved, reload])

  const update = useCallback((value: string) => {
    const id = ++revision.current
    lastOperation.current = 'write'
    pending.current = { value, revision: id }
    setState({ value, status: 'saving', error: false })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 350)
  }, [flush])

  const retry = () => {
    if (lastOperation.current === 'read') {
      setReload(value => value + 1)
    } else {
      update(state.value)
      flush()
    }
  }
  return { ...state, update, flush, retry }
}
```

Add tests for late writes, remount while writing, failed save followed by retry,
legacy migration, unmount with an unsaved edit, and clearing without restoring
the old value. Fake timers may be used to advance the 350 ms debounce, but do
not use arbitrary sleeps for promise ordering.

- [ ] **6.3 Write shared form tests before implementing the component.**
  Use the real Zustand store with Tauri mocked. Reset the store before each
  test using `useAppStore.setState`, preserving the default config fields.
  Load English i18n once via `../../i18n`; do not assert untranslated key names.

```typescript
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { AgentMaestroFields } from '../AgentMaestroFields'
import { useAppStore } from '../../stores/appStore'
import * as tauri from '../../lib/tauri'

vi.mock('../../lib/tauri')
beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    config: {
      ...useAppStore.getState().config,
      llm_provider: 'agent-maestro',
      llm_api_key: '',
      llm_model: '',
      llm_base_url: 'http://localhost:23333/api/openai/v1',
    },
    llmTestStatus: 'idle',
    llmLatencyMs: null,
  })
  vi.mocked(tauri.readCredential).mockResolvedValue(null)
  vi.mocked(tauri.setCredential).mockResolvedValue(undefined)
  vi.mocked(tauri.fetchLlmModels).mockResolvedValue(['copilot-test'])
  vi.mocked(tauri.benchLlmConnection).mockResolvedValue(20)
  vi.mocked(tauri.testLlmConnection).mockResolvedValue(true)
})
afterEach(cleanup)

describe.each(['settings', 'onboarding'] as const)('Agent Maestro %s form', mode => {
  it('keeps model selection explicit and tests without a placeholder key', async () => {
    render(<AgentMaestroFields mode={mode} />)
    const button = screen.getByRole('button', { name: /^Test/ })
    expect(button).toBeDisabled()
    const model = screen.getByRole('combobox')
    await waitFor(() => expect(tauri.fetchLlmModels).toHaveBeenCalled())
    expect(model).toHaveValue('')
    fireEvent.change(model, { target: { value: 'manual-model' } })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    await waitFor(() => expect(useAppStore.getState().llmTestStatus).toBe('success'))
    const command = mode === 'settings' ? tauri.benchLlmConnection : tauri.testLlmConnection
    expect(command).toHaveBeenCalledWith(
      '', 'agent-maestro', 'http://localhost:23333/api/openai/v1', 'manual-model',
    )
  })
})
```

```powershell
npm test -- src\components\__tests__\AgentMaestroFields.test.tsx
```

- [ ] **6.4 Implement the shared form.** Use the following complete component;
  JSX classes are the existing settings input/button style. No duplicated
  provider dropdown is added here.

```tsx
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../stores/appStore'
import { benchLlmConnection, testLlmConnection } from '../lib/tauri'
import { useAgentMaestroCredential } from '../hooks/useAgentMaestroCredential'
import { useAgentMaestroModels } from '../hooks/useAgentMaestroModels'

const inputClass = 'w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-[10px] text-[13px] text-text-primary outline-none focus:border-border-focus'
const labelClass = 'block text-[13px] font-medium text-text-secondary mb-2'
const buttonClass = 'px-4 py-2.5 bg-accent text-white rounded-[10px] text-[13px] disabled:opacity-40 disabled:cursor-not-allowed'

export function AgentMaestroFields({ mode }: { mode: 'settings' | 'onboarding' }) {
  const config = useAppStore(state => state.config)
  const updateConfig = useAppStore(state => state.updateConfig)
  const testStatus = useAppStore(state => state.llmTestStatus)
  const setTestStatus = useAppStore(state => state.setLlmTestStatus)
  const latency = useAppStore(state => state.llmLatencyMs)
  const setLatency = useAppStore(state => state.setLlmLatencyMs)
  const { t } = useTranslation()
  const id = useId()
  const [testError, setTestError] = useState<string | null>(null)
  const testRevision = useRef(0)

  const onLegacySaved = useCallback((legacy: string) => {
    const current = useAppStore.getState()
    if (current.config.llm_provider === 'agent-maestro'
        && current.config.llm_api_key === legacy) {
      current.updateConfig({ llm_api_key: '' })
    }
  }, [])
  const credential = useAgentMaestroCredential(config.llm_api_key, onLegacySaved)
  const ready = credential.status === 'ready'
  const discovery = useAgentMaestroModels(config.llm_base_url, credential.value, ready)
  const hasModel = !!config.llm_model.trim()
  const hasUrl = !!config.llm_base_url.trim()

  useEffect(() => {
    ++testRevision.current
    setTestStatus('idle')
    setLatency(null)
    setTestError(null)
    return () => { ++testRevision.current }
  }, [config.llm_base_url, config.llm_model, credential.value, credential.status,
      setLatency, setTestStatus])

  const handleTest = async () => {
    const revision = ++testRevision.current
    setTestStatus('testing')
    setLatency(null)
    setTestError(null)
    try {
      if (!ready || !hasModel || !hasUrl) {
        throw new Error(t('settings.agentMaestroConfigurationRequired'))
      }
      const args = [credential.value, 'agent-maestro',
        config.llm_base_url, config.llm_model] as const
      let measured: number | null = null
      if (mode === 'settings') {
        measured = await benchLlmConnection(...args)
      } else if (!(await testLlmConnection(...args))) {
        throw new Error(t('settings.connectionFailed'))
      }
      if (revision !== testRevision.current) return
      setLatency(measured)
      setTestStatus('success')
    } catch (error) {
      if (revision !== testRevision.current) return
      const message = error instanceof Error ? error.message : String(error)
      const key = credential.value.trim()
      setTestError((key ? message.split(key).join('[redacted]') : message).slice(0, 300))
      setTestStatus('error')
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-secondary">{t('settings.agentMaestroHint')}</p>
      <div>
        <label className={labelClass} htmlFor={`${id}-key`}>{t('settings.apiKey')}</label>
        <input id={`${id}-key`} type="password" className={inputClass}
          value={credential.value} autoComplete="off"
          disabled={credential.status === 'loading'}
          onChange={event => credential.update(event.target.value)}
          onBlur={credential.flush} />
        <p className="text-[11px] text-text-tertiary mt-1">
          {t('settings.agentMaestroKeyOptional')}
        </p>
        {credential.status === 'loading' || credential.status === 'saving'
          ? <p role="status">{t('settings.agentMaestroCredentialPending')}</p>
          : null}
        {credential.error && (
          <div role="alert" className="text-error text-[12px]">
            {t('settings.agentMaestroCredentialError')}
            <button type="button" onClick={credential.retry}>
              {t('settings.agentMaestroRetry')}
            </button>
          </div>
        )}
      </div>
      <div>
        <label className={labelClass} htmlFor={`${id}-model`}>{t('settings.model')}</label>
        <div className="flex gap-2">
          <input id={`${id}-model`} list={`${id}-models`} className={inputClass}
            value={config.llm_model}
            onChange={event => updateConfig({ llm_model: event.target.value })} />
          <datalist id={`${id}-models`}>
            {discovery.models.map(model => <option key={model} value={model} />)}
          </datalist>
          <button type="button" className={buttonClass}
            disabled={!ready || !hasUrl || discovery.status === 'loading'}
            onClick={() => { void discovery.refresh() }}>
            {t('settings.fetchModels')}
          </button>
        </div>
        {discovery.status === 'loading' && (
          <p role="status">{t('settings.agentMaestroModelsLoading')}</p>
        )}
        {discovery.status === 'success' && discovery.models.length === 0 && (
          <p role="status">{t('settings.agentMaestroModelsEmpty')}</p>
        )}
        {discovery.status === 'success' && discovery.models.length > 0 && (
          <p role="status">{t('settings.modelsAvailable', { count: discovery.models.length })}</p>
        )}
        {discovery.error && <p role="alert" className="text-error">{discovery.error}</p>}
      </div>
      <div>
        <label className={labelClass} htmlFor={`${id}-url`}>{t('settings.baseUrl')}</label>
        <input id={`${id}-url`} className={inputClass}
          value={config.llm_base_url}
          placeholder="http://127.0.0.1:23333/api/openai/v1"
          onChange={event => updateConfig({ llm_base_url: event.target.value })} />
      </div>
      {(!hasModel || !hasUrl) && (
        <p role="status">{t('settings.agentMaestroConfigurationRequired')}</p>
      )}
      <button type="button" className={buttonClass} onClick={() => { void handleTest() }}
        disabled={!ready || !hasModel || !hasUrl || testStatus === 'testing'}
        aria-busy={testStatus === 'testing'}>
        {t('settings.test')}
      </button>
      {testStatus === 'success' && (
        <p role="status" className="text-success">
          {t('settings.connectionSuccess')}{latency !== null ? ` (${latency} ms)` : ''}
        </p>
      )}
      {testError && <p role="alert" className="text-error">{testError}</p>}
    </div>
  )
}
```

- [ ] **6.5 Add translated strings before green.** Task 7 provides the exact
  string set and wiring. Apply its locale additions now if needed by these
  component tests; keep the work in the same logical UI commit rather than
  deliberately committing untranslated controls.

- [ ] **6.6 Run grouped hook/form tests.**

```powershell
npm test -- src\hooks\__tests__\useAgentMaestroCredential.test.ts src\hooks\__tests__\useAgentMaestroModels.test.ts src\components\__tests__\AgentMaestroFields.test.tsx
```

Add form tests for stored optional key, key clearing, disabled probes during
vault failure, empty discovery versus failure, and stale connection-test
completion after changing URL/model/key or unmounting.
Commit with Task 7 wiring as `feat: configure Agent Maestro in settings and onboarding`.

## Task 7: Wire both UI entry points, localization, and persistence

**Files:** `src\components\Settings\LlmPane.tsx`,
`src\components\Onboarding\LlmSetupStep.tsx`, the corresponding existing tests,
`src\lib\__tests__\backup-settings.test.ts`, all ten locale JSON files.

- [ ] **7.1 Add wiring and backup regression tests first.**

In the existing settings test suite, use its `mockAppStore` and mock Tauri:

```typescript
it('selects Agent Maestro defaults without inheriting a legacy provider key', () => {
  mockAppStore.config.llm_api_key = 'old-provider-key'
  render(<LlmPane />)
  fireEvent.change(screen.getAllByRole('combobox')[0], {
    target: { value: 'agent-maestro' },
  })
  expect(mockAppStore.updateConfig).toHaveBeenCalledWith({
    llm_provider: 'agent-maestro',
    llm_base_url: 'http://127.0.0.1:23333/api/openai/v1',
    llm_model: '',
    llm_api_key: '',
  })
})
```

Add the same selection assertion to `LlmSetupStep.test.tsx` using `mockStore`,
`<LlmSetupStep />`, and its existing Tauri mocks. Also add a test rendering each
pane with Agent Maestro already selected, asserting only one model input and
one connection-test action exist. The shared component tests use the real store;
the existing pane tests may mock `AgentMaestroFields` to verify wiring only.

In the backup tests:

```typescript
it('round-trips Agent Maestro settings but never its optional API key', () => {
  const configured = {
    ...useAppStore.getState().config,
    llm_provider: 'agent-maestro' as const,
    llm_base_url: 'https://example.test/am/api/openai/v1',
    llm_model: 'manual-id',
    llm_api_key: 'fake-secret',
  }
  const backup = createBackupSettings(configured)
  const restored = mergeBackupSettings(useAppStore.getState().config, backup)
  expect(restored.llm_provider).toBe('agent-maestro')
  expect(restored.llm_base_url).toBe(configured.llm_base_url)
  expect(restored.llm_model).toBe('manual-id')
  expect(JSON.stringify(backup)).not.toContain('fake-secret')
  expect(backup).not.toHaveProperty('llm_api_key')
})
```

```powershell
npm test -- src\components\Settings\__tests__\LlmPane.test.tsx src\components\Onboarding\__tests__\LlmSetupStep.test.tsx src\lib\__tests__\backup-settings.test.ts
```

- [ ] **7.2 Wire settings.** Import and set the provider flag:

```typescript
import { AgentMaestroFields } from '../AgentMaestroFields'
const isMaestro = config.llm_provider === 'agent-maestro'
```

In the existing credential-read effect, extend the guard to
`if (isCloud || isMaestro || !requiresApiKey)` and include `isMaestro` in its
dependencies. In the existing auto-discovery effect, extend the guard to
`if (isCloud || isMaestro) return` and include that dependency.

Keep the provider selector and all polish/style controls. Apply this wrapping
edit without replacing the existing form body:

```diff
-      {!isCloud && (
+      {isMaestro && <AgentMaestroFields mode="settings" />}
+      {!isCloud && !isMaestro && (
```

Add the following property spread to the existing provider-selection
`updateConfig` object:

```typescript
...(provider === 'agent-maestro' ? { llm_api_key: '' } : {}),
```

Never copy the current provider's inline key into the Agent Maestro account.

- [ ] **7.3 Wire onboarding with the same boundary.**

```typescript
import { AgentMaestroFields } from '../AgentMaestroFields'
const isMaestro = selectedProvider === 'agent-maestro'
```

Add `isMaestro` to the auto-fetch effect dependencies and return early for it.
Keep the service dropdown, then wrap the existing legacy fields with these
two edits:

```diff
-      {requiresApiKey && (
+      {isMaestro ? <AgentMaestroFields mode="onboarding" /> : <>
+      {requiresApiKey && (
@@
         {!requiresApiKey && <TestStatusHint status={llmTestStatus} />}
       </Field>
+      </>}
```

Add the same explicit `llm_api_key: ''` spread when selecting Agent Maestro.

Verify that `setLlmTestStatus('success')` from the shared component enables
onboarding's existing step-4 Next button, and that editing the configuration
returns the status to idle. Do not change onboarding navigation requirements.

- [ ] **7.4 Add localized labels and feedback.**

Add `"agentMaestro": "Agent Maestro"` under `providers.llm` in all ten locale
files. Add these English values under `settings`:

```json
{
  "agentMaestroHint": "Keep VS Code and the Agent Maestro API server running, with Copilot signed in. The model runs through Copilot, not necessarily on your device.",
  "agentMaestroKeyOptional": "Optional. Leave blank unless you configured an LLM API key in Agent Maestro.",
  "agentMaestroConfigurationRequired": "Enter the Agent Maestro Base URL and select or enter a model ID before testing.",
  "agentMaestroCredentialPending": "Reading or saving the optional API key...",
  "agentMaestroCredentialError": "Could not read or save the Agent Maestro API key. Check your system credential vault and retry.",
  "agentMaestroRetry": "Retry",
  "agentMaestroModelsLoading": "Loading available Copilot models...",
  "agentMaestroModelsEmpty": "No eligible Copilot models were returned. Check Copilot sign-in or enter a model ID manually."
}
```

For Chinese, use these values:

```json
{
  "agentMaestroHint": "请保持 VS Code 和 Agent Maestro API 服务运行，并登录 Copilot。模型通过 Copilot 调用，不一定在本机运行。",
  "agentMaestroKeyOptional": "可选。只有在 Agent Maestro 中设置了 LLM API Key 时才需要填写。",
  "agentMaestroConfigurationRequired": "请填写 Agent Maestro Base URL，并选择或手工输入模型 ID 后再测试。",
  "agentMaestroCredentialPending": "正在读取或保存可选 API Key...",
  "agentMaestroCredentialError": "无法读取或保存 Agent Maestro API Key，请检查系统凭据库后重试。",
  "agentMaestroRetry": "重试",
  "agentMaestroModelsLoading": "正在获取可用的 Copilot 模型...",
  "agentMaestroModelsEmpty": "未返回可用的 Copilot 模型，请检查 Copilot 登录状态，或手工输入模型 ID。"
}
```

Provide equivalent translations in `de.json`, `es.json`, `fr.json`, `it.json`,
`ja.json`, `ko.json`, `pt.json`, and `ru.json` without changing any existing
strings. Preserve JSON syntax and the complete eight-key set above in each.
Keep technical labels `Agent Maestro`, `Copilot`, `Base URL`, and `API Key`
recognizable. The source values and required meaning are explicit above;
translation wording is not a behavior/design decision.

- [ ] **7.5 Run grouped UI/localization tests and commit Tasks 6-7.**

```powershell
npm test -- src\components\__tests__\AgentMaestroFields.test.tsx src\components\Settings\__tests__\LlmPane.test.tsx src\components\Onboarding\__tests__\LlmSetupStep.test.tsx src\components\Onboarding\__tests__\Onboarding.test.tsx src\hooks\__tests__\useAgentMaestroCredential.test.ts src\hooks\__tests__\useAgentMaestroModels.test.ts src\lib\__tests__\backup-settings.test.ts src\i18n\__tests__\localeParity.test.ts
```

No production backup-schema change is needed if the new round-trip test passes.
Add this Rust serialization regression in the Agent Maestro adapter test module,
without broadening backup validation:

```rust
#[test]
fn agent_maestro_configuration_round_trips() {
    let config = crate::storage::AppConfig {
        llm_provider: PROVIDER.into(),
        llm_base_url: "https://example.test/am/api/openai/v1".into(),
        llm_model: "manual-id".into(),
        llm_api_key: String::new(),
        ..Default::default()
    };
    let saved = serde_json::to_vec(&config).unwrap();
    let restored: crate::storage::AppConfig = serde_json::from_slice(&saved).unwrap();
    assert_eq!(restored.llm_provider, PROVIDER);
    assert_eq!(restored.llm_base_url, config.llm_base_url);
    assert_eq!(restored.llm_model, config.llm_model);
    assert!(restored.llm_api_key.is_empty());
}
```

## Task 8: Local HTTP integration coverage

**Files:** `src-tauri\src\llm\test_http.rs`, `src-tauri\src\llm\mod.rs`,
tests in `agent_maestro.rs`, `openai.rs`, `commands\ask.rs`.

This is integration validation, not a substitute for Tasks 1-7 red/green unit
tests. If an integration test exposes missing behavior, first record the
failure, fix the responsible component, and re-run the related targeted group.

- [ ] **8.1 Add a dependency-free, bounded test HTTP fixture.**

```rust
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

pub(crate) fn serve_once(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) -> (String, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let content_type = content_type.to_string();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
                    && Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                Err(error) => panic!("Test server accept failed: {error}"),
            }
        };
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request = Vec::new();
        let mut scratch = [0u8; 4096];
        let header_end = loop {
            if let Some(index) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                break index + 4;
            }
            let count = stream.read(&mut scratch).unwrap();
            assert!(count > 0, "request ended before headers");
            request.extend_from_slice(&scratch[..count]);
        };
        let headers = std::str::from_utf8(&request[..header_end]).unwrap();
        let length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        }).unwrap_or(0);
        while request.len() < header_end + length {
            let count = stream.read(&mut scratch).unwrap();
            assert!(count > 0, "request body ended early");
            request.extend_from_slice(&scratch[..count]);
        }
        sender.send(String::from_utf8(request).unwrap()).unwrap();
        let headers = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(headers.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
    });
    (format!("http://{address}/api/openai/v1"), receiver)
}
```

Register it without shipping it in release:

```rust
#[cfg(test)]
pub(crate) mod test_http;
```

- [ ] **8.2 Add discovery/probe wire tests.**

```rust
#[tokio::test]
async fn agent_maestro_http_discovery_and_probe_contracts() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (base, captured) = crate::llm::test_http::serve_once(
        200, "application/json",
        br#"[{"id":"copilot-test","vendor":"copilot"},{"id":"local","vendor":"other"}]"#.to_vec(),
    );
    assert_eq!(fetch_models(&client, &base, "").await.unwrap(), vec!["copilot-test"]);
    let request = captured.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(request.starts_with("GET /api/v1/lm/chatModels "));
    assert!(!request.to_ascii_lowercase().contains("authorization:"));

    let (base, captured) = crate::llm::test_http::serve_once(
        200, "application/json",
        br#"{"choices":[{"message":{"content":"OK"}}]}"#.to_vec(),
    );
    probe(&client, &base, " selected-id ", "fake-key").await.unwrap();
    let request = captured.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(request.starts_with("POST /api/openai/v1/chat/completions "));
    assert!(request.to_ascii_lowercase().contains("authorization: bearer fake-key"));
    let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["model"], "selected-id");
    assert_eq!(body["max_tokens"], 128);
    assert_eq!(body["stream"], false);
}
```

Place the test inside `agent_maestro.rs`'s tests module.

Add table-driven asynchronous cases for status 401/403/404/500, malformed JSON,
wrong discovery shape, empty/non-text probe content, and error bodies containing
the fake key. Assert the error has status and no fake key. All fixture responses
are synthetic; no live Copilot quota is used.

- [ ] **8.3 Add a real non-streaming Ask HTTP test.**

```rust
#[tokio::test]
async fn agent_maestro_ask_uses_the_local_chat_endpoint() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let (base, captured) = crate::llm::test_http::serve_once(
        200, "application/json",
        br#"{"choices":[{"message":{"content":"Synthetic answer"}}]}"#.to_vec(),
    );
    let config = storage::AppConfig {
        llm_provider: "agent-maestro".into(),
        llm_base_url: base,
        llm_model: "copilot-test".into(),
        ..Default::default()
    };
    let answer = ask_via_byok(&client, &config, "", "Hello", None).await.unwrap();
    assert_eq!(answer, "Synthetic answer");
    assert!(captured.recv_timeout(std::time::Duration::from_secs(1)).unwrap()
        .starts_with("POST /api/openai/v1/chat/completions "));
}
```

- [ ] **8.4 Add streamed polishing and translation fixtures.**

Define this request helper inside `openai.rs`'s test module:

```rust
fn agent_maestro_polish_request() -> PolishRequest {
    use crate::app_detector::types::{BrowserAccessStatus, ContextFamily, ContextProfileSummary};
    use crate::voice_intent::{VoiceIntent, VoiceIntentKind, VoiceOutputPlacement};
    PolishRequest {
        raw_text: "Synthetic dictation".into(),
        context: ContextProfileSummary {
            profile_id: "general.native".into(), family: ContextFamily::General,
            app_label: "Test".into(), icon_key: "general".into(), override_id: None,
            browser_access_status: BrowserAccessStatus::NotApplicable,
            browser_target: None,
        },
        dictionary: vec![], correction_rules: vec![],
        polish_style: "clean".into(), mapped_scene_prompt: String::new(),
        active_scene_prompt: String::new(), polish_custom_prompt: String::new(),
        translate_enabled: true, target_lang: "en".into(), selected_text: None,
        operation_id: None,
        voice_intent: VoiceIntent::from_parts(
            VoiceIntentKind::DictateInsert, VoiceOutputPlacement::InsertAtCursor,
            1.0, None, Some("Synthetic dictation".into()), None, None,
        ).unwrap(),
    }
}
```

The current `voice_intent` module re-exports these types; no production
re-export changes are needed.

```rust
#[tokio::test]
async fn agent_maestro_polish_streams_complete_text() {
    let wire = concat!(
        ": keep-alive\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
        "data: [DONE]\n\n",
    );
    let (base, captured) = crate::llm::test_http::serve_once(
        200, "text/event-stream", wire.as_bytes().to_vec(),
    );
    let config = LlmConfig {
        provider: "agent-maestro".into(), base_url: base,
        model: "copilot-test".into(), api_key: String::new(),
        ..Default::default()
    };
    let chunks = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let recorded = chunks.clone();
    let callback: ChunkCallback = Box::new(move |text| recorded.lock().unwrap().push_str(text));
    let provider = OpenAiProvider::with_client(
        reqwest::Client::builder().no_proxy().build().unwrap()
    );
    let result = provider.polish(&config, &agent_maestro_polish_request(), Some(&callback))
        .await.unwrap();
    assert_eq!(result.polished_text, "Hello world");
    assert_eq!(*chunks.lock().unwrap(), "Hello world");
    let request = captured.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], "copilot-test");
    assert!(body["messages"][0]["content"].as_str().unwrap().contains("[TRANSLATION_AND_LANGUAGE]"));
}
```

Add table-driven failures using the same helper/provider:

```rust
let failing_streams = [
    "data: [DONE]\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n\
     event: error\ndata: {\"error\":{\"message\":\"failed\"}}\n\n",
    "data: {broken-json}\n\ndata: [DONE]\n\n",
];
```

Each must return `Err`; the partial-error case must still show that the callback
received the preceding text, proving the error was not relabeled as success.
Use direct decoder tests for exact UTF-8 split boundaries; TCP writes do not
guarantee matching client chunk boundaries.

- [ ] **8.5 Run targeted Rust groups.**

```powershell
cargo test --manifest-path src-tauri\Cargo.toml --lib agent_maestro
cargo test --manifest-path src-tauri\Cargo.toml --lib llm::
```

Cargo supports one substring selector per invocation, so these two runs cover
cross-module provider tests and shared legacy LLM regressions. Do not run the
full application suite unless these runs reveal a reason to expand validation.
Commit message: `test: verify Agent Maestro integration against local HTTP fixtures`.

## Task 9: Setup docs, final verification, and handoff

**Files:** `README.md`, `README_zh.md`; no additional production files unless
targeted verification identifies a defect in the implemented integration.

- [ ] **9.1 Add setup documentation next to the existing AI Polish settings
  instructions.** English content:

```markdown
### Agent Maestro

Choose **Agent Maestro** under AI Polish. Keep its VS Code extension and API
server running, with GitHub Copilot signed in.

- Base URL: `http://127.0.0.1:23333/api/openai/v1` by default. Use the actual
  server port reported by **Agent Maestro: Get API Server Status**.
- API key: optional; enter the key set with **Agent Maestro: Set LLM API Key**
  only if server authentication is enabled. No placeholder key is needed.
- Model: refresh the model suggestions and choose an ID, or enter one manually.
  OpenTypeless does not automatically choose a model.

Suggestions include only Copilot-vendor models because that is the set the
current Agent Maestro generation API supports. This includes models from
different developers offered through Copilot. Agent Maestro may still perform
model fallback; check its output channel to confirm the resolved model.

A failed model refresh does not prevent manual configuration. For connection
refused, start the API server and check its port; for 401/403, check the key and
Copilot access; for 404, check the Base URL and extension version. Generation
requests have a 120-second per-attempt timeout; discovery has a 10-second timeout.

Agent Maestro is a local API bridge, not an offline model runtime. Requests
remain subject to Copilot availability and usage limits. STT is configured
separately.
```

Chinese content:

```markdown
### Agent Maestro

在 AI 润色中选择 **Agent Maestro**，保持其 VS Code 扩展和 API 服务运行，并登录 GitHub Copilot。

- Base URL 默认是 `http://127.0.0.1:23333/api/openai/v1`。请使用
  **Agent Maestro: Get API Server Status** 显示的实际端口。
- API Key 可选；只有启用服务端鉴权时，才需要填写通过
  **Agent Maestro: Set LLM API Key** 设置的密钥，不需要占位值。
- 模型可以从刷新后的列表中选择，也可以手工输入 ID；不会自动选择模型。

列表只展示当前 Agent Maestro 生成接口支持的 Copilot 渠道模型，其中可以包含
Claude、Gemini、GPT 等不同厂商的模型。Agent Maestro 自身仍可能回退到其他模型，
实际使用的模型可在其输出日志中确认。

模型刷新失败不影响手工配置。连接被拒绝时请检查服务与端口；401/403 请检查密钥
及 Copilot 权限；404 请检查 Base URL 和扩展版本。生成请求每次尝试超时为 120 秒，
模型发现超时为 10 秒。

Agent Maestro 是本地 API 桥接服务，并不意味着模型在本机离线运行，调用仍受
Copilot 可用性和用量限制。语音识别 STT 需要单独配置。
```

- [ ] **9.2 Check the complete diff against the spec and run verification.**
  Invoke `verification-before-completion`. Run the grouped targeted tests from
  Tasks 7-8 once on the final tree, then:

```powershell
npm run build
npx --no-install eslint src\hooks\useAgentMaestroCredential.ts src\hooks\useAgentMaestroModels.ts src\components\AgentMaestroFields.tsx src\components\Settings\LlmPane.tsx src\components\Onboarding\LlmSetupStep.tsx src\lib\constants.ts src\stores\appStore.ts
git --no-pager diff --check
git --no-pager status --short
```

If the formatter reports changed code needs formatting, use the existing
Prettier binary on only the changed frontend files. Do not format unrelated
Rust modules or the entire repository. Rust targeted tests compile the changed
Rust modules; run `cargo check` only if a relevant non-test configuration still
needs independent coverage.

- [ ] **9.3 Request read-only code review of the implementation diff.**
  Invoke `requesting-code-review` and review the range after spec commit
  `1790242` through the implementation commits plus any uncommitted edits.
  Fix confirmed defects with targeted regressions; do not broaden to unrelated
  security/style audits. Re-run the affected test groups after fixes.

- [ ] **9.4 Perform optional live validation without sensitive content.**

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:23333/api/v1/lm/chatModels' -TimeoutSec 10 |
  Where-Object vendor -eq 'copilot' |
  Select-Object id, name
```

Use a returned exact ID and a synthetic prompt such as `Reply briefly with OK.`
for one non-streaming and one streaming request through the configured provider.
If the server requires a key, use the user's configured credential flow, not
shell history or a committed fixture. Do not probe unrelated ports or start
another VS Code instance automatically. If unavailable, record the live test as
not run, with the observed connection error.

- [ ] **9.5 Commit docs and report evidence, without implying live verification
  that did not happen.**

```powershell
git add -- README.md README_zh.md
git commit -m "docs: explain Agent Maestro provider setup" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git --no-pager status --short
```

Final report: settings used, user-visible behavior, important server limitations,
exact targeted test/build results, live validation status, and local commit
summary. Do not push or create a PR unless requested.

## Plan self-review checklist

- [x] Spec scope/architecture and only-one-repository constraint: Tasks 1, 5, 7.
- [x] URL validation and optional HTTP authentication: Tasks 1, 2, 8.
- [x] Model filtering, explicit/manual selection, empty/error/race states: Tasks 2, 5, 6.
- [x] Vault persistence, absence versus failure, isolation, clearing: Tasks 4, 6, 7.
- [x] Meaningful probes and 120/10-second policy: Tasks 1, 2, 8.
- [x] SSE UTF-8, heartbeat, errors, truncation and existing protocol behavior: Task 3 and Task 8.
- [x] Ask, translation, polishing and no silent cloud fallback: Tasks 3, 4, 8.
- [x] Onboarding progression and both UI entry points: Tasks 6, 7.
- [x] Configuration/backup persistence and secret exclusion: Tasks 4, 7.
- [x] Locales, documentation, tests, build, review and live-validation disclosure: Tasks 7-9.

Reviewed the plan against the approved spec on 2026-09-15. Corrected nested Rust
test module paths, fully qualified the pipeline error type, specified discovery
test imports, added strict malformed stream-event checks, and made onboarding's
Next-button dependency explicit. These checked items describe plan coverage,
not implemented or passing behavior; execution steps remain unchecked.
