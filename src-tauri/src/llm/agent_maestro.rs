use serde::Deserialize;
use std::collections::BTreeSet;

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
    let url = url::Url::parse(base_url.trim()).map_err(|_| "Invalid Agent Maestro base URL".to_string())?;
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
    Err("Agent Maestro base URL must end with /api/openai/v1 or /api/openai/v1/chat/completions".to_string())
}

fn set_path(url: &mut url::Url, prefix: &str, suffix: &str) {
    url.set_path(&format!("{prefix}{suffix}"));
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
    let models: Vec<RemoteModel> =
        serde_json::from_value(value).map_err(|_| "Invalid Agent Maestro models response".to_string())?;
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
    use serde_json::json;

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

        let (chat, discovery) =
            endpoints("http://localhost:4444/deploy/api/openai/v1").unwrap();
        assert_eq!(chat, "http://localhost:4444/deploy/api/openai/v1/chat/completions");
        assert_eq!(discovery, "http://localhost:4444/deploy/api/v1/lm/chatModels");

        let (chat, discovery) = endpoints("https://example.com/prefix/api/openai/v1/").unwrap();
        assert_eq!(chat, "https://example.com/prefix/api/openai/v1/chat/completions");
        assert_eq!(discovery, "https://example.com/prefix/api/v1/lm/chatModels");

        let (chat, discovery) = endpoints(
            "https://example.com/prefix/api/openai/v1/chat/completions///",
        )
        .unwrap();
        assert_eq!(chat, "https://example.com/prefix/api/openai/v1/chat/completions");
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
}
