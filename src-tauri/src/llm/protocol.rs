use reqwest::RequestBuilder;
use serde_json::{json, Value};
use std::time::Duration;

const ANTHROPIC_API_HOST: &str = "api.anthropic.com";
const OPENAI_API_HOST: &str = "api.openai.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[cfg(test)]
mod azure_tests {
    use super::*;

    #[test]
    fn azure_opaque_deployments_use_completion_tokens_without_sampling() {
        for deployment in ["production", "glm-4.7", "gpt-4", "reasoning"] {
            let body = build_chat_body(
                "azure-openai",
                "https://resource.example",
                deployment,
                vec![json!({"role": "user", "content": "hi"})],
                128,
                0.3,
                true,
            );
            assert_eq!(body["max_completion_tokens"], 128);
            assert!(body.get("max_tokens").is_none());
            assert!(body.get("temperature").is_none());
            assert!(body.get("thinking").is_none());
            assert!(body.get("top_p").is_none());
        }
    }

    #[test]
    fn azure_auth_uses_trimmed_api_key_without_bearer() {
        let request = apply_auth_headers(
            reqwest::Client::new().post("https://resource.example"),
            "azure-openai",
            "https://resource.example",
            " test-key ",
        )
        .build()
        .unwrap();
        assert_eq!(request.headers().get("api-key").unwrap(), "test-key");
        assert!(!request.headers().contains_key("authorization"));
    }

    #[test]
    fn azure_timeout_does_not_infer_model_from_deployment() {
        assert_eq!(
            request_timeout("azure-openai", "https://resource.example", "production"),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn azure_model_discovery_requires_manual_deployment_names() {
        let error = models_endpoint("azure-openai", "https://resource.example").unwrap_err();
        assert!(error.contains("deployment"));
    }

    #[test]
    fn azure_configured_chat_endpoint_requires_version_and_deployment() {
        assert_eq!(configured_chat_endpoint("azure-openai", "https://resource.example", "prod", Some("2024-10-21")).unwrap(),
            "https://resource.example/openai/deployments/prod/chat/completions?api-version=2024-10-21");
        assert!(
            configured_chat_endpoint("azure-openai", "https://resource.example", "prod", None)
                .unwrap_err()
                .contains("version")
        );
        assert!(configured_chat_endpoint(
            "azure-openai",
            "https://resource.example",
            "",
            Some("2024-10-21")
        )
        .unwrap_err()
        .contains("deployment"));
        assert_eq!(
            configured_chat_endpoint("openai", "https://api.openai.com/v1", "gpt-4", None).unwrap(),
            chat_endpoint("openai", "https://api.openai.com/v1").unwrap()
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlmApiKind {
    OpenAiCompatible,
    AnthropicMessages,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct StreamEvent {
    pub text: Option<String>,
    pub reasoning: Option<String>,
    pub error: Option<String>,
    pub done: bool,
}

pub fn detect_api_kind(provider: &str, base_url: &str) -> LlmApiKind {
    let provider = provider.trim().to_ascii_lowercase();
    let host = url::Url::parse(base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase));

    if matches!(provider.as_str(), "claude" | "anthropic")
        && host.as_deref() == Some(ANTHROPIC_API_HOST)
    {
        LlmApiKind::AnthropicMessages
    } else {
        LlmApiKind::OpenAiCompatible
    }
}

fn parse_http_url(base_url: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(base_url.trim())
        .map_err(|error| format!("Invalid LLM base URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("LLM base URL must use http or https scheme".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("LLM base URL must not include credentials".to_string());
    }
    if url.fragment().is_some() {
        return Err("LLM base URL must not include a fragment".to_string());
    }
    url.set_fragment(None);
    Ok(url)
}

fn replace_or_append_path(url: &mut url::Url, current_suffix: &str, target_suffix: &str) {
    let path = url.path().trim_end_matches('/');
    let root = path.strip_suffix(current_suffix).unwrap_or(path);
    url.set_path(&format!("{root}{target_suffix}"));
}

fn anthropic_api_root(path: &str) -> String {
    let path = path.trim_end_matches('/');
    if let Some(root) = path.strip_suffix("/messages") {
        return root.to_string();
    }
    if let Some(root) = path.strip_suffix("/models") {
        return root.to_string();
    }
    if path.is_empty() {
        "/v1".to_string()
    } else {
        path.to_string()
    }
}

pub fn configured_chat_endpoint(
    provider: &str,
    base_url: &str,
    deployment: &str,
    api_version: Option<&str>,
) -> Result<String, String> {
    if crate::azure_openai::is_azure(provider) {
        return crate::azure_openai::AzureOpenAiConfig {
            endpoint: base_url.to_string(),
            deployment: deployment.to_string(),
            api_version: api_version.unwrap_or_default().to_string(),
        }
        .chat_endpoint();
    }
    chat_endpoint(provider, base_url)
}

pub fn chat_endpoint(provider: &str, base_url: &str) -> Result<String, String> {
    if super::agent_maestro::is_provider(provider) {
        return super::agent_maestro::endpoints(base_url).map(|(chat, _)| chat);
    }
    let kind = detect_api_kind(provider, base_url);
    let mut url = parse_http_url(base_url)?;
    match kind {
        LlmApiKind::AnthropicMessages => {
            let root = anthropic_api_root(url.path());
            url.set_path(&format!("{root}/messages"));
        }
        LlmApiKind::OpenAiCompatible => {
            let path = url.path().trim_end_matches('/');
            if !path.ends_with("/chat/completions") {
                url.set_path(&format!("{path}/chat/completions"));
            }
        }
    }
    Ok(url.to_string())
}

pub fn models_endpoint(provider: &str, base_url: &str) -> Result<String, String> {
    if super::agent_maestro::is_provider(provider) {
        return super::agent_maestro::endpoints(base_url).map(|(_, discovery)| discovery);
    }
    if crate::azure_openai::is_azure(provider) {
        return Err(
            "Azure OpenAI uses manual deployment names; model discovery is not supported"
                .to_string(),
        );
    }
    let kind = detect_api_kind(provider, base_url);
    let mut url = parse_http_url(base_url)?;
    match kind {
        LlmApiKind::AnthropicMessages => {
            let root = anthropic_api_root(url.path());
            url.set_path(&format!("{root}/models"));
        }
        LlmApiKind::OpenAiCompatible => {
            replace_or_append_path(&mut url, "/chat/completions", "/models");
        }
    }
    Ok(url.to_string())
}

fn is_direct_openai(provider: &str, base_url: &str) -> bool {
    provider.trim().eq_ignore_ascii_case("openai")
        && url::Url::parse(base_url.trim())
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .as_deref()
            == Some(OPENAI_API_HOST)
}

fn is_reasoning_model_without_sampling_controls(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    model.starts_with("gpt-5")
        || model == "o1"
        || model.starts_with("o1-")
        || model == "o3"
        || model.starts_with("o3-")
        || model == "o4"
        || model.starts_with("o4-")
}

pub fn request_timeout(provider: &str, base_url: &str, model: &str) -> Duration {
    if super::agent_maestro::is_provider(provider) {
        super::agent_maestro::GENERATION_TIMEOUT
    } else if crate::azure_openai::is_azure(provider)
        || detect_api_kind(provider, base_url) == LlmApiKind::AnthropicMessages
        || is_reasoning_model_without_sampling_controls(model)
    {
        Duration::from_secs(60)
    } else {
        Duration::from_secs(30)
    }
}

fn normalize_anthropic_model(model: &str) -> String {
    let model = model
        .trim()
        .strip_prefix("anthropic/")
        .unwrap_or(model.trim());
    match model {
        "claude-sonnet-4" => "claude-sonnet-4-0".to_string(),
        "claude-opus-4" => "claude-opus-4-0".to_string(),
        _ => model.to_string(),
    }
}

pub fn build_chat_body(
    provider: &str,
    base_url: &str,
    model: &str,
    messages: Vec<Value>,
    max_tokens: u32,
    temperature: f64,
    stream: bool,
) -> Value {
    let model = if super::agent_maestro::is_provider(provider) {
        model.trim()
    } else {
        model
    };

    match detect_api_kind(provider, base_url) {
        LlmApiKind::AnthropicMessages => {
            let mut system_parts = Vec::new();
            let mut anthropic_messages = Vec::new();
            for message in messages {
                if message["role"].as_str() == Some("system") {
                    if let Some(content) = message["content"].as_str() {
                        if !content.trim().is_empty() {
                            system_parts.push(content.to_string());
                        }
                    }
                } else {
                    anthropic_messages.push(message);
                }
            }

            let mut body = json!({
                "model": normalize_anthropic_model(model),
                "messages": anthropic_messages,
                "max_tokens": max_tokens,
                "temperature": temperature.clamp(0.0, 1.0),
                "stream": stream
            });
            if !system_parts.is_empty() {
                body.as_object_mut().unwrap().insert(
                    "system".to_string(),
                    Value::String(system_parts.join("\n\n")),
                );
            }
            body
        }
        LlmApiKind::OpenAiCompatible => {
            let mut body = json!({
                "model": model,
                "messages": messages,
                "stream": stream
            });
            let object = body.as_object_mut().unwrap();
            if crate::azure_openai::is_azure(provider) {
                object.insert("max_completion_tokens".to_string(), json!(max_tokens));
            } else if is_direct_openai(provider, base_url) {
                object.insert("max_completion_tokens".to_string(), json!(max_tokens));
                if !is_reasoning_model_without_sampling_controls(model) {
                    object.insert("temperature".to_string(), json!(temperature));
                }
            } else {
                object.insert("max_tokens".to_string(), json!(max_tokens));
                object.insert("temperature".to_string(), json!(temperature));
            }
            body
        }
    }
}

pub fn apply_auth_headers(
    request: RequestBuilder,
    provider: &str,
    base_url: &str,
    api_key: &str,
) -> RequestBuilder {
    let api_key = api_key.trim();
    if crate::azure_openai::is_azure(provider) {
        return request.header("api-key", api_key);
    }
    match detect_api_kind(provider, base_url) {
        LlmApiKind::AnthropicMessages => request
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        LlmApiKind::OpenAiCompatible => {
            if super::provider_requires_api_key(provider) || !api_key.is_empty() {
                request.header("Authorization", format!("Bearer {api_key}"))
            } else {
                request
            }
        }
    }
}

pub fn response_text(kind: LlmApiKind, body: &Value) -> String {
    match kind {
        LlmApiKind::AnthropicMessages => body["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|block| block["type"].as_str() == Some("text"))
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        LlmApiKind::OpenAiCompatible => {
            let message = &body["choices"][0]["message"];
            message["content"]
                .as_str()
                .filter(|content| !content.is_empty())
                .or_else(|| message["reasoning_content"].as_str())
                .unwrap_or("")
                .to_string()
        }
    }
}

pub fn parse_stream_event(kind: LlmApiKind, body: &Value) -> StreamEvent {
    match kind {
        LlmApiKind::AnthropicMessages => {
            if body["type"].as_str() == Some("error") {
                return StreamEvent {
                    error: body["error"]["message"].as_str().map(str::to_string),
                    ..StreamEvent::default()
                };
            }
            if body["type"].as_str() == Some("message_stop") {
                return StreamEvent {
                    done: true,
                    ..StreamEvent::default()
                };
            }
            if body["type"].as_str() == Some("content_block_delta")
                && body["delta"]["type"].as_str() == Some("text_delta")
            {
                return StreamEvent {
                    text: body["delta"]["text"].as_str().map(str::to_string),
                    ..StreamEvent::default()
                };
            }
            StreamEvent::default()
        }
        LlmApiKind::OpenAiCompatible => {
            if body.get("error").is_some() {
                let message = body
                    .get("error")
                    .and_then(|error| {
                        error
                            .get("message")
                            .and_then(|message| message.as_str())
                            .or_else(|| error.as_str())
                    })
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| "Stream returned an error".to_string());
                return StreamEvent {
                    error: Some(message),
                    ..StreamEvent::default()
                };
            }
            let delta = &body["choices"][0]["delta"];
            StreamEvent {
                text: delta["content"].as_str().map(str::to_string),
                reasoning: delta["reasoning_content"].as_str().map(str::to_string),
                ..StreamEvent::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn messages() -> Vec<Value> {
        vec![
            json!({"role": "system", "content": "Be concise."}),
            json!({"role": "user", "content": "Hello"}),
        ]
    }

    #[test]
    fn native_anthropic_uses_messages_endpoint_without_double_appending() {
        for base_url in [
            "https://api.anthropic.com",
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/v1/messages",
        ] {
            assert_eq!(
                chat_endpoint("claude", base_url).unwrap(),
                "https://api.anthropic.com/v1/messages"
            );
        }
        assert_eq!(
            models_endpoint("claude", "https://api.anthropic.com/v1/messages").unwrap(),
            "https://api.anthropic.com/v1/models"
        );
    }

    #[test]
    fn claude_on_openrouter_stays_openai_compatible() {
        assert_eq!(
            detect_api_kind("claude", "https://openrouter.ai/api/v1"),
            LlmApiKind::OpenAiCompatible
        );
        assert_eq!(
            chat_endpoint("claude", "https://openrouter.ai/api/v1").unwrap(),
            "https://openrouter.ai/api/v1/chat/completions"
        );
    }

    #[test]
    fn native_anthropic_body_moves_system_prompt_and_normalizes_old_default_model() {
        let body = build_chat_body(
            "claude",
            "https://api.anthropic.com/v1/messages",
            "anthropic/claude-sonnet-4",
            messages(),
            256,
            0.3,
            true,
        );

        assert_eq!(body["model"], "claude-sonnet-4-0");
        assert_eq!(body["system"], "Be concise.");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["max_tokens"], 256);
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn direct_openai_gpt5_uses_compatible_token_field_and_omits_temperature() {
        let body = build_chat_body(
            "openai",
            "https://api.openai.com/v1",
            "gpt-5",
            messages(),
            4096,
            0.3,
            false,
        );

        assert_eq!(body["max_completion_tokens"], 4096);
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn openai_compatible_proxies_keep_legacy_fields_for_compatibility() {
        let body = build_chat_body(
            "openrouter",
            "https://openrouter.ai/api/v1",
            "openai/gpt-5",
            messages(),
            4096,
            0.3,
            false,
        );

        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["temperature"], 0.3);
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn slow_reasoning_apis_get_a_longer_timeout_without_a_new_setting() {
        assert_eq!(
            request_timeout("openai", "https://api.openai.com/v1", "gpt-5"),
            Duration::from_secs(60)
        );
        assert_eq!(
            request_timeout(
                "claude",
                "https://api.anthropic.com/v1",
                "claude-sonnet-4-0"
            ),
            Duration::from_secs(60)
        );
        assert_eq!(
            request_timeout(
                "openrouter",
                "https://openrouter.ai/api/v1",
                "gemini-2.5-flash"
            ),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn auth_headers_match_native_anthropic_and_openai_protocols() {
        let anthropic = apply_auth_headers(
            reqwest::Client::new().post("https://api.anthropic.com/v1/messages"),
            "claude",
            "https://api.anthropic.com/v1",
            "anthropic-key",
        )
        .build()
        .unwrap();
        assert_eq!(anthropic.headers()["x-api-key"], "anthropic-key");
        assert_eq!(anthropic.headers()["anthropic-version"], ANTHROPIC_VERSION);
        assert!(anthropic.headers().get("Authorization").is_none());

        let openai = apply_auth_headers(
            reqwest::Client::new().post("https://api.openai.com/v1/chat/completions"),
            "openai",
            "https://api.openai.com/v1",
            "openai-key",
        )
        .build()
        .unwrap();
        assert_eq!(openai.headers()["Authorization"], "Bearer openai-key");
    }

    #[test]
    fn response_parsers_support_anthropic_json_and_streaming_events() {
        let response = json!({
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": " world"}
            ]
        });
        assert_eq!(
            response_text(LlmApiKind::AnthropicMessages, &response),
            "Hello world"
        );

        let event = parse_stream_event(
            LlmApiKind::AnthropicMessages,
            &json!({
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "Hello"}
            }),
        );
        assert_eq!(event.text.as_deref(), Some("Hello"));
        assert!(!event.done);
    }

    #[test]
    fn agent_maestro_openai_stream_events_surface_errors_instead_of_silent_empty_deltas() {
        let with_message = parse_stream_event(
            LlmApiKind::OpenAiCompatible,
            &json!({
                "error": {"message": "boom"},
                "choices": [{"delta": {"content": "ignored"}}]
            }),
        );
        assert_eq!(with_message.error.as_deref(), Some("boom"));
        assert!(with_message.text.is_none());

        let generic = parse_stream_event(
            LlmApiKind::OpenAiCompatible,
            &json!({
                "error": {"type": "server_error"},
                "choices": [{"delta": {}}]
            }),
        );
        assert!(generic
            .error
            .as_deref()
            .is_some_and(|message| !message.is_empty()));

        let anthropic = parse_stream_event(
            LlmApiKind::AnthropicMessages,
            &json!({
                "type": "message_stop"
            }),
        );
        assert!(anthropic.done);
        assert!(anthropic.error.is_none());
    }
    #[test]
    fn agent_maestro_protocol_uses_adapter_endpoints_and_fixed_timeout() {
        assert_eq!(
            chat_endpoint("agent-maestro", "https://example.com/prefix/api/openai/v1/").unwrap(),
            "https://example.com/prefix/api/openai/v1/chat/completions"
        );
        assert_eq!(
            models_endpoint("agent-maestro", "https://example.com/prefix/api/openai/v1/").unwrap(),
            "https://example.com/prefix/api/v1/lm/chatModels"
        );
        assert_eq!(
            request_timeout(
                "agent-maestro",
                "https://example.com/prefix/api/openai/v1/",
                "exact-id"
            ),
            Duration::from_secs(120)
        );
    }

    #[test]
    fn agent_maestro_protocol_trims_model_and_uses_proxy_fields() {
        let body = build_chat_body(
            "agent-maestro",
            "https://example.com/prefix/api/openai/v1/",
            " exact-id ",
            messages(),
            128,
            0.9,
            true,
        );

        assert_eq!(body["model"], "exact-id");
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(body["temperature"], 0.9);
        assert_eq!(body["stream"], true);
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn agent_maestro_protocol_omits_blank_optional_key_and_bears_trimmed_key() {
        let empty = apply_auth_headers(
            reqwest::Client::new()
                .post("https://example.com/prefix/api/openai/v1/chat/completions"),
            "agent-maestro",
            "https://example.com/prefix/api/openai/v1/",
            "   ",
        )
        .build()
        .unwrap();
        assert!(empty.headers().get("Authorization").is_none());

        let trimmed = apply_auth_headers(
            reqwest::Client::new()
                .post("https://example.com/prefix/api/openai/v1/chat/completions"),
            "agent-maestro",
            "https://example.com/prefix/api/openai/v1/",
            " fake-key ",
        )
        .build()
        .unwrap();
        assert_eq!(trimmed.headers()["Authorization"], "Bearer fake-key");
    }
}
