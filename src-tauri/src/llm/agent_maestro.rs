use serde::Deserialize;
use std::collections::BTreeSet;
use std::time::Duration;

use crate::llm::protocol;

pub const PROVIDER: &str = "agent-maestro";
pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:23333/api/openai/v1";
pub const GENERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
pub const DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Deserialize)]
struct RemoteModel {
    id: String,
    vendor: String,
}

fn parse_http_url(base_url: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(base_url.trim())
        .map_err(|_| "Invalid Agent Maestro base URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Agent Maestro base URL must use http or https".to_string());
    }
    if url.host_str().is_none() {
        return Err("Agent Maestro base URL must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Agent Maestro base URL must not include credentials".to_string());
    }
    if url.query().is_some() {
        return Err("Agent Maestro base URL must not include a query string".to_string());
    }
    if url.fragment().is_some() {
        return Err("Agent Maestro base URL must not include a fragment".to_string());
    }
    Ok(url)
}

fn normalized_prefix(path: &str) -> Result<String, String> {
    let trimmed = path.trim_end_matches('/');
    if let Some(prefix) = trimmed.strip_suffix("/api/openai/v1/chat/completions") {
        return Ok(prefix.to_string());
    }
    if let Some(prefix) = trimmed.strip_suffix("/api/openai/v1") {
        return Ok(prefix.to_string());
    }
    Err(
        "Agent Maestro base URL must end with /api/openai/v1 or /api/openai/v1/chat/completions"
            .to_string(),
    )
}

fn set_path(url: &mut url::Url, prefix: &str, suffix: &str) {
    url.set_path(&format!("{prefix}{suffix}"));
}

pub fn diagnostic(message: &str, key: &str) -> String {
    let redacted = match key.trim() {
        "" => message.to_string(),
        trimmed_key => message.replace(trimmed_key, "[redacted]"),
    };
    redacted.chars().take(200).collect()
}

pub fn network_error(error: reqwest::Error, key: &str, timeout: Duration) -> String {
    if error.is_timeout() {
        return format!(
            "Agent Maestro request timed out after {}s",
            timeout.as_secs()
        );
    }
    if error.is_connect() {
        return "Unable to connect to the Agent Maestro API server. Start the API server and check the configured address and port.".to_string();
    }
    diagnostic(&error.without_url().to_string(), key)
}

pub async fn read_json(
    response: reqwest::Response,
    key: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = match tokio::time::timeout(timeout, response.text()).await {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => return Err(network_error(error, key, timeout)),
        Err(_) => {
            return Err(format!(
                "Agent Maestro request timed out after {}s",
                timeout.as_secs()
            ))
        }
    };

    if !status.is_success() {
        let mut error = format!("HTTP {status}");
        let detail = diagnostic(body.trim(), key);
        if !detail.is_empty() {
            error.push_str(": ");
            error.push_str(&detail);
        }
        if matches!(status.as_u16(), 401 | 403) {
            error.push_str(". Check your API key and Copilot access.");
        }
        if status.as_u16() == 404 {
            error.push_str(". Check the configured URL and API version.");
        }
        return Err(error);
    }

    serde_json::from_str(&body).map_err(|_| "Invalid Agent Maestro JSON response".to_string())
}

pub fn response_text(value: &serde_json::Value) -> Result<String, String> {
    if value.get("error").is_some() {
        return Err("Agent Maestro response returned an error".to_string());
    }

    let choices = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .ok_or_else(|| "Agent Maestro response did not include choices".to_string())?;
    let choice = choices
        .first()
        .and_then(|choice| choice.as_object())
        .ok_or_else(|| "Agent Maestro response did not include choices".to_string())?;
    let message = choice
        .get("message")
        .and_then(|message| message.as_object())
        .ok_or_else(|| "Agent Maestro response did not include assistant content".to_string())?;
    let content = message
        .get("content")
        .and_then(|content| content.as_str())
        .ok_or_else(|| "Agent Maestro response did not include assistant content".to_string())?;
    if content.trim().is_empty() {
        return Err("Agent Maestro response did not include assistant content".to_string());
    }
    Ok(content.to_string())
}

pub fn validate_stream_event(value: &serde_json::Value) -> Result<(), String> {
    let choices = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .ok_or_else(|| "Invalid Agent Maestro stream event".to_string())?;

    for choice in choices {
        let choice = choice
            .as_object()
            .ok_or_else(|| "Invalid Agent Maestro stream event".to_string())?;
        let delta = choice
            .get("delta")
            .and_then(|delta| delta.as_object())
            .ok_or_else(|| "Invalid Agent Maestro stream event".to_string())?;

        for field in ["content", "reasoning_content"] {
            if let Some(value) = delta.get(field) {
                if !value.is_null() && !value.is_string() {
                    return Err("Invalid Agent Maestro stream event".to_string());
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
    let (_, discovery_url) = endpoints(base_url)?;
    let response = protocol::apply_auth_headers(client.get(discovery_url), PROVIDER, base_url, key)
        .timeout(DISCOVERY_TIMEOUT)
        .send()
        .await
        .map_err(|error| network_error(error, key, DISCOVERY_TIMEOUT))?;
    let body = read_json(response, key, DISCOVERY_TIMEOUT).await?;
    parse_models(body)
}

pub async fn probe(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    key: &str,
) -> Result<u32, String> {
    validate_config(base_url, model)?;
    let chat_url = endpoints(base_url)?.0;
    let body = protocol::build_chat_body(
        PROVIDER,
        base_url,
        model,
        vec![serde_json::json!({"role": "user", "content": "Reply briefly with OK."})],
        128,
        0.3,
        false,
    );
    let start = std::time::Instant::now();
    let response = protocol::apply_auth_headers(client.post(chat_url), PROVIDER, base_url, key)
        .json(&body)
        .timeout(GENERATION_TIMEOUT)
        .send()
        .await
        .map_err(|error| network_error(error, key, GENERATION_TIMEOUT))?;
    let body = read_json(response, key, GENERATION_TIMEOUT).await?;
    let _ = response_text(&body)?;
    Ok(start.elapsed().as_millis().min(u128::from(u32::MAX)) as u32)
}

pub fn is_provider(provider: &str) -> bool {
    provider.trim().eq_ignore_ascii_case(PROVIDER)
}

pub fn endpoints(base_url: &str) -> Result<(String, String), String> {
    let url = parse_http_url(base_url)?;
    let prefix = normalized_prefix(url.path())?;

    let mut chat_url = url.clone();
    set_path(&mut chat_url, &prefix, "/api/openai/v1/chat/completions");

    let mut discovery_url = url;
    set_path(&mut discovery_url, &prefix, "/api/v1/lm/chatModels");

    Ok((chat_url.to_string(), discovery_url.to_string()))
}

pub fn validate_config(base_url: &str, model: &str) -> Result<(), String> {
    let _ = endpoints(base_url)?;
    if model.trim().is_empty() {
        return Err("Select or enter an Agent Maestro model ID".to_string());
    }
    Ok(())
}

pub fn parse_models(value: serde_json::Value) -> Result<Vec<String>, String> {
    let models: Vec<RemoteModel> = serde_json::from_value(value)
        .map_err(|_| "Invalid Agent Maestro models response".to_string())?;
    let mut supported = BTreeSet::new();

    for model in models {
        if model.vendor == "copilot" {
            let id = model.id.trim();
            if id.is_empty() {
                return Err("Agent Maestro Copilot model IDs must not be blank".to_string());
            }
            supported.insert(id.to_string());
        }
    }

    Ok(supported.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::test_http::{spawn_http_fixture, HttpResponseFixture, REQUEST_TIMEOUT};
    use serde_json::json;

    fn test_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("test HTTP client must build")
    }

    #[test]
    fn agent_maestro_provider_identity_is_trimmed_and_case_insensitive() {
        assert!(is_provider("agent-maestro"));
        assert!(is_provider(" Agent-Maestro "));
        assert!(is_provider("AGENT-MAESTRO"));
        assert!(!is_provider("openai"));
    }

    #[test]
    fn agent_maestro_endpoints_support_default_custom_prefix_and_chat_suffixes() {
        let (chat, discovery) = endpoints(DEFAULT_BASE_URL).unwrap();
        assert_eq!(
            chat,
            "http://127.0.0.1:23333/api/openai/v1/chat/completions"
        );
        assert_eq!(discovery, "http://127.0.0.1:23333/api/v1/lm/chatModels");

        let (chat, discovery) = endpoints("http://localhost:4444/deploy/api/openai/v1").unwrap();
        assert_eq!(
            chat,
            "http://localhost:4444/deploy/api/openai/v1/chat/completions"
        );
        assert_eq!(
            discovery,
            "http://localhost:4444/deploy/api/v1/lm/chatModels"
        );

        let (chat, discovery) = endpoints("https://example.com/prefix/api/openai/v1/").unwrap();
        assert_eq!(
            chat,
            "https://example.com/prefix/api/openai/v1/chat/completions"
        );
        assert_eq!(discovery, "https://example.com/prefix/api/v1/lm/chatModels");

        let (chat, discovery) =
            endpoints("https://example.com/prefix/api/openai/v1/chat/completions///").unwrap();
        assert_eq!(
            chat,
            "https://example.com/prefix/api/openai/v1/chat/completions"
        );
        assert_eq!(discovery, "https://example.com/prefix/api/v1/lm/chatModels");
    }

    #[test]
    fn agent_maestro_endpoints_reject_invalid_urls_and_incomplete_paths() {
        for error in [
            endpoints("file:///api/openai/v1").unwrap_err(),
            endpoints("http://127.0.0.1/").unwrap_err(),
            endpoints("http://user:pass@127.0.0.1/api/openai/v1").unwrap_err(),
            endpoints("http://127.0.0.1/api/openai/v1?token=secret").unwrap_err(),
            endpoints("http://127.0.0.1/api/openai/v1#secret").unwrap_err(),
        ] {
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn agent_maestro_validate_config_rejects_blank_models() {
        let error = validate_config(DEFAULT_BASE_URL, "   ").unwrap_err();
        assert_eq!(error, "Select or enter an Agent Maestro model ID");
    }

    #[test]
    fn agent_maestro_validate_config_accepts_manual_model_ids() {
        validate_config(DEFAULT_BASE_URL, "manual-id").unwrap();
    }

    #[test]
    fn agent_maestro_parse_models_filters_copilot_and_sorts_deduplicates() {
        let models = parse_models(json!([
            {"id": " beta ", "vendor": "copilot", "extra": true},
            {"id": "alpha", "vendor": "copilot"},
            {"id": "ignored", "vendor": "anthropic"},
            {"id": "alpha", "vendor": "copilot"},
            {"id": "gamma", "vendor": "copilot"}
        ]))
        .unwrap();

        assert_eq!(models, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn agent_maestro_parse_models_allows_empty_server_lists() {
        let models = parse_models(json!([])).unwrap();
        assert!(models.is_empty());
    }

    #[test]
    fn agent_maestro_parse_models_rejects_malformed_responses() {
        assert!(parse_models(json!({"data": []})).is_err());
        assert!(parse_models(json!([{"id": "model-only"}])).is_err());
        assert!(parse_models(json!([{"id": "", "vendor": "copilot"}])).is_err());
    }

    #[test]
    fn agent_maestro_diagnostic_redacts_keys_and_truncates_on_char_boundaries() {
        let message = format!("prefix fake-key suffix {}", "é".repeat(300));
        let redacted = diagnostic(&message, " fake-key ");

        assert!(!redacted.contains("fake-key"));
        assert!(redacted.chars().count() <= 200);
    }

    #[test]
    fn agent_maestro_response_text_accepts_content_and_rejects_blank_and_reasoning_only() {
        assert_eq!(
            response_text(&json!({
                "choices": [{"message": {"content": "Hello"}}]
            }))
            .unwrap(),
            "Hello"
        );
        assert!(response_text(&json!({})).is_err());
        assert_eq!(
            response_text(&json!({"error": {"message": "boom"}})).unwrap_err(),
            "Agent Maestro response returned an error"
        );
        assert!(response_text(&json!({
            "choices": [{"message": {"content": "   "}}]
        }))
        .is_err());
        assert!(response_text(&json!({
            "choices": [{"message": {"reasoning_content": "thinking"}}]
        }))
        .is_err());
    }

    #[test]
    fn agent_maestro_response_text_redacts_top_level_errors() {
        let error = response_text(&json!({
            "error": {"message": "bad key sk-agent-maestro-secret"}
        }))
        .unwrap_err();

        assert_eq!(error, "Agent Maestro response returned an error");
        assert!(!error.contains("sk-agent-maestro-secret"));
    }

    #[test]
    fn agent_maestro_validate_stream_event_checks_choices_and_delta_shapes() {
        assert!(validate_stream_event(&json!({"choices": []})).is_ok());
        assert!(validate_stream_event(&json!({
            "choices": [{"delta": {"content": "hi", "reasoning_content": null}}]
        }))
        .is_ok());
        assert!(validate_stream_event(&json!({"choices": "oops"})).is_err());
        assert!(validate_stream_event(&json!({"choices": [{"delta": 1}]})).is_err());
        assert!(validate_stream_event(&json!({
            "choices": [{"delta": {"content": 1}}]
        }))
        .is_err());
    }

    #[tokio::test]
    async fn agent_maestro_fetch_models_uses_prefixed_discovery_route_and_optional_auth() {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(
            r#"[{"id":"beta","vendor":"copilot"},{"id":"ignored","vendor":"other"},{"id":"alpha","vendor":"copilot"},{"id":"beta","vendor":"copilot"}]"#,
        ));
        let client = test_client();

        let models = fetch_models(
            &client,
            &format!("{}/deployment/api/openai/v1/", fixture.base_url),
            "   ",
        )
        .await
        .unwrap();

        assert_eq!(models, vec!["alpha".to_string(), "beta".to_string()]);
        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert_eq!(request.path(), "/deployment/api/v1/lm/chatModels");
        assert!(request
            .as_text()
            .starts_with("GET /deployment/api/v1/lm/chatModels HTTP/1.1"));
        assert!(!request
            .as_text()
            .to_ascii_lowercase()
            .contains("\r\nauthorization:"));

        let fixture = spawn_http_fixture(HttpResponseFixture::json("[]"));
        let models = fetch_models(
            &client,
            &format!("{}/api/openai/v1", fixture.base_url),
            " fake-key ",
        )
        .await
        .unwrap();
        assert!(models.is_empty());

        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert!(request
            .as_text()
            .to_ascii_lowercase()
            .contains("\r\nauthorization: bearer fake-key\r\n"));
    }

    #[tokio::test]
    async fn agent_maestro_fetch_models_reports_statuses_with_redacted_diagnostics() {
        for (status_line, status, expected_hint) in [
            ("401 Unauthorized", "401", "API key"),
            ("403 Forbidden", "403", "API key"),
            ("404 Not Found", "404", "URL"),
            ("500 Internal Server Error", "500", "HTTP"),
        ] {
            let fixture = spawn_http_fixture(HttpResponseFixture {
                status_line,
                content_type: "application/json",
                body: r#"{"error":"fake-key rejected"}"#,
            });
            let error = fetch_models(
                &test_client(),
                &format!("{}/api/openai/v1", fixture.base_url),
                "fake-key",
            )
            .await
            .unwrap_err();

            assert!(error.contains(status), "{status_line}: {error}");
            assert!(error.contains(expected_hint), "{status_line}: {error}");
            assert!(!error.contains("fake-key"), "{status_line}: {error}");
        }
    }

    #[tokio::test]
    async fn agent_maestro_fetch_models_rejects_invalid_responses() {
        for body in ["not json", r#"{"models":[]}"#] {
            let fixture = spawn_http_fixture(HttpResponseFixture::json(body));
            let error = fetch_models(
                &test_client(),
                &format!("{}/api/openai/v1", fixture.base_url),
                "",
            )
            .await
            .unwrap_err();
            assert!(error.contains("Invalid Agent Maestro"));
        }
    }

    #[tokio::test]
    async fn agent_maestro_probe_uses_prefixed_chat_route_and_expected_body() {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(
            r#"{"choices":[{"message":{"content":"OK"}}]}"#,
        ));
        let client = test_client();

        let elapsed = probe(
            &client,
            &format!(
                "{}/deployment/api/openai/v1/chat/completions///",
                fixture.base_url
            ),
            " model-a ",
            " fake-key ",
        )
        .await
        .unwrap();

        assert!(elapsed > 0);
        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert_eq!(request.path(), "/deployment/api/openai/v1/chat/completions");
        assert!(request
            .as_text()
            .starts_with("POST /deployment/api/openai/v1/chat/completions HTTP/1.1"));
        assert!(request
            .as_text()
            .to_ascii_lowercase()
            .contains("\r\nauthorization: bearer fake-key\r\n"));
        let body: serde_json::Value = serde_json::from_str(request.body()).unwrap();
        assert_eq!(body["model"], "model-a");
        assert_eq!(body["max_tokens"], 128);
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["content"], "Reply briefly with OK.");
    }

    #[tokio::test]
    async fn agent_maestro_probe_reports_statuses_with_redacted_diagnostics() {
        for (status_line, status) in [
            ("401 Unauthorized", "401"),
            ("403 Forbidden", "403"),
            ("404 Not Found", "404"),
            ("500 Internal Server Error", "500"),
        ] {
            let fixture = spawn_http_fixture(HttpResponseFixture {
                status_line,
                content_type: "application/json",
                body: r#"{"error":"fake-key rejected"}"#,
            });
            let error = probe(
                &test_client(),
                &format!("{}/api/openai/v1", fixture.base_url),
                "model-a",
                "fake-key",
            )
            .await
            .unwrap_err();

            assert!(error.contains(status), "{status_line}: {error}");
            assert!(!error.contains("fake-key"), "{status_line}: {error}");
        }
    }

    #[tokio::test]
    async fn agent_maestro_probe_rejects_invalid_success_payloads() {
        for body in [
            "not json",
            r#"{"error":{"message":"upstream failed"}}"#,
            r#"{"choices":[]}"#,
            r#"{"choices":[{"message":{"content":7}}]}"#,
            r#"{"choices":[{"message":{"content":" "}}]}"#,
            r#"{"choices":[{"message":{"reasoning_content":"thinking"}}]}"#,
        ] {
            let fixture = spawn_http_fixture(HttpResponseFixture::json(body));
            let error = probe(
                &test_client(),
                &format!("{}/api/openai/v1", fixture.base_url),
                "model-a",
                "",
            )
            .await
            .unwrap_err();

            assert!(error.contains("Agent Maestro"), "{body}: {error}");
        }
    }
}
