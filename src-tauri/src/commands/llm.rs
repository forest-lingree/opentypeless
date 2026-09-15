use crate::credentials::{resolve_config_secret, SystemCredentialVault};
use crate::llm::agent_maestro;
use crate::SessionTokenStore;
use crate::{api_base_url, with_desktop_client_version};

#[tauri::command]
pub fn get_llm_model_capability(
    provider: String,
    base_url: String,
    model: String,
) -> crate::llm::model_capabilities::ModelCapability {
    crate::llm::model_capabilities::model_capability(
        &provider,
        &base_url,
        &model,
        crate::llm::prompt::CONTEXT_PROMPT_VERSION,
    )
}

fn synthetic_operation_id() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (now >> 96) as u32,
        (now >> 80) as u16,
        (now >> 64) as u16,
        (now >> 48) as u16,
        now & 0x0000_ffff_ffff_ffff_ffffu128
    )
}

fn has_managed_cloud_access(body: &serde_json::Value) -> bool {
    if matches!(
        body["licenseStatus"].as_str(),
        Some("refunded") | Some("deactivated")
    ) {
        return false;
    }

    let source = body["source"].as_str().unwrap_or_default();
    let plan = body["plan"].as_str().unwrap_or_default();
    let cloud_words_limit = body["cloudWordsLimit"].as_i64().unwrap_or_default();
    let display_words_limit = body["displayWordsLimit"].as_i64().unwrap_or_default();
    if source == "appsumo" {
        return cloud_words_limit > 0 && body["licenseStatus"].as_str() == Some("active");
    }
    if source == "lifetime" {
        return cloud_words_limit > 0 || display_words_limit > 0 || plan == "lifetime_starter";
    }
    if source == "creem" && (cloud_words_limit > 0 || display_words_limit > 0) {
        return true;
    }

    matches!(plan, "pro" | "lifetime_starter")
}

#[tauri::command]
pub async fn test_llm_connection(
    api_key: String,
    provider: String,
    base_url: String,
    model: String,
    token_store: tauri::State<'_, SessionTokenStore>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<bool, String> {
    if provider.is_empty() {
        return Ok(false);
    }

    // Cloud provider: verify session token + managed cloud entitlement via API.
    if provider == "cloud" {
        let token = token_store
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if token.is_empty() {
            return Ok(false);
        }
        let api_base = api_base_url();
        let resp = with_desktop_client_version(
            client.get(format!("{}/api/subscription/status", api_base)),
        )
        .header("Authorization", format!("Bearer {}", token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Ok(false);
        }
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        return Ok(has_managed_cloud_access(&body));
    }

    if agent_maestro::is_provider(&provider) {
        return agent_maestro_test_connection(
            &client,
            &api_key,
            &base_url,
            &model,
            &SystemCredentialVault,
        )
        .await;
    }

    let api_key = resolve_config_secret(&api_key, "llm", &provider, &SystemCredentialVault)
        .map_err(|e| e.to_string())?;

    if base_url.is_empty() || !crate::llm::has_usable_provider_credentials(&provider, &api_key) {
        return Ok(false);
    }

    // Validate base_url is a proper HTTP(S) URL
    let parsed = url::Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Base URL must use http or https scheme".to_string());
    }

    let url = crate::llm::protocol::chat_endpoint(&provider, &base_url)?;
    let body = crate::llm::protocol::build_chat_body(
        &provider,
        &base_url,
        &model,
        vec![serde_json::json!({"role": "user", "content": "hi"})],
        1,
        0.3,
        false,
    );

    let request = client.post(&url).header("Content-Type", "application/json");
    let resp = crate::llm::protocol::apply_auth_headers(request, &provider, &base_url, &api_key)
        .json(&body)
        .timeout(crate::llm::protocol::request_timeout(
            &provider, &base_url, &model,
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp.status().is_success())
}

fn build_fetch_models_request(
    client: &reqwest::Client,
    provider: &str,
    base_url: &str,
    api_key: &str,
    url: &str,
) -> reqwest::RequestBuilder {
    crate::llm::protocol::apply_auth_headers(client.get(url), provider, base_url, api_key)
}

fn resolve_agent_maestro_secret<V: crate::credentials::CredentialSecretReader>(
    api_key: &str,
    vault: &V,
) -> Result<String, String> {
    resolve_config_secret(api_key, "llm", agent_maestro::PROVIDER, vault)
        .map_err(|_| "Agent Maestro credential vault unavailable".to_string())
}

async fn agent_maestro_fetch_models<V: crate::credentials::CredentialSecretReader>(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    vault: &V,
) -> Result<Vec<String>, String> {
    let api_key = resolve_agent_maestro_secret(api_key, vault)?;
    agent_maestro::fetch_models(client, base_url, &api_key).await
}

async fn agent_maestro_test_connection<V: crate::credentials::CredentialSecretReader>(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    vault: &V,
) -> Result<bool, String> {
    let api_key = resolve_agent_maestro_secret(api_key, vault)?;
    agent_maestro::probe(client, base_url, model, &api_key)
        .await
        .map(|_| true)
}

async fn agent_maestro_bench_connection<V: crate::credentials::CredentialSecretReader>(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
    model: &str,
    vault: &V,
) -> Result<u32, String> {
    let api_key = resolve_agent_maestro_secret(api_key, vault)?;
    agent_maestro::probe(client, base_url, model, &api_key).await
}

#[tauri::command]
pub async fn fetch_llm_models(
    api_key: String,
    provider: String,
    base_url: String,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<Vec<String>, String> {
    if agent_maestro::is_provider(&provider) {
        return agent_maestro_fetch_models(&client, &api_key, &base_url, &SystemCredentialVault)
            .await;
    }

    if base_url.is_empty() {
        return Ok(vec![]);
    }
    if !crate::llm::has_usable_provider_credentials(&provider, &api_key) {
        return Ok(vec![]);
    }

    // Validate base_url is a proper HTTP(S) URL
    let parsed = url::Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Base URL must use http or https scheme".to_string());
    }

    let url = crate::llm::protocol::models_endpoint(&provider, &base_url)?;

    let resp = build_fetch_models_request(&client, &provider, &base_url, &api_key, &url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    // OpenAI-compatible: { data: [{ id: "model-name" }] }
    // Ollama-compatible: { models: [{ name: "model-name" }] }
    let mut models: Vec<String> = Vec::new();

    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    } else if let Some(data) = body.get("models").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                models.push(name.to_string());
            }
        }
    }

    models.sort();
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::CredentialSecretReader;
    use crate::llm::test_http::{spawn_http_fixture, HttpResponseFixture, REQUEST_TIMEOUT};
    use anyhow::anyhow;
    use std::sync::Mutex;
    use tauri::Manager;

    struct MemoryVault {
        secret: Mutex<Result<Option<String>, anyhow::Error>>,
        lookups: Mutex<Vec<(String, String)>>,
    }

    impl MemoryVault {
        fn with_secret(secret: Option<&str>) -> Self {
            Self {
                secret: Mutex::new(Ok(secret.map(str::to_string))),
                lookups: Mutex::new(Vec::new()),
            }
        }

        fn with_error(message: &str) -> Self {
            Self {
                secret: Mutex::new(Err(anyhow!(message.to_string()))),
                lookups: Mutex::new(Vec::new()),
            }
        }
        fn lookups(&self) -> Vec<(String, String)> {
            self.lookups.lock().unwrap().clone()
        }
    }

    impl CredentialSecretReader for MemoryVault {
        fn get_secret(&self, namespace: &str, provider: &str) -> anyhow::Result<Option<String>> {
            self.lookups
                .lock()
                .unwrap()
                .push((namespace.to_string(), provider.to_string()));
            match &*self.secret.lock().unwrap() {
                Ok(value) => Ok(value.clone()),
                Err(error) => Err(anyhow!(error.to_string())),
            }
        }
    }

    #[test]
    fn managed_cloud_access_requires_active_appsumo_license() {
        let active = serde_json::json!({
            "plan": "appsumo_tier1",
            "source": "appsumo",
            "cloudWordsLimit": 200000,
            "licenseStatus": "active"
        });
        let pending = serde_json::json!({
            "plan": "appsumo_tier1",
            "source": "appsumo",
            "cloudWordsLimit": 200000,
            "licenseStatus": "pending"
        });
        let missing = serde_json::json!({
            "plan": "appsumo_tier1",
            "source": "appsumo",
            "cloudWordsLimit": 200000
        });

        assert!(has_managed_cloud_access(&active));
        assert!(!has_managed_cloud_access(&pending));
        assert!(!has_managed_cloud_access(&missing));
    }

    #[test]
    fn managed_cloud_access_allows_direct_lifetime_license() {
        let lifetime_legacy_quota = serde_json::json!({
            "plan": "lifetime_starter",
            "source": "lifetime",
            "cloudWordsLimit": 0,
            "licenseStatus": "active"
        });
        let lifetime_cloud_words = serde_json::json!({
            "plan": "lifetime_starter",
            "source": "lifetime",
            "cloudWordsLimit": 100000
        });

        assert!(has_managed_cloud_access(&lifetime_legacy_quota));
        assert!(has_managed_cloud_access(&lifetime_cloud_words));
    }

    #[test]
    fn model_request_omits_authorization_for_keyless_ollama() {
        let request = build_fetch_models_request(
            &reqwest::Client::new(),
            "ollama",
            "http://localhost:11434/v1",
            "",
            "http://localhost:11434/v1/models",
        )
        .build()
        .unwrap();

        assert!(request.headers().get("Authorization").is_none());
    }

    #[test]
    fn model_request_keeps_authorization_for_keyed_providers() {
        let request = build_fetch_models_request(
            &reqwest::Client::new(),
            "openai",
            "https://api.openai.com/v1",
            "sk-test",
            "https://api.openai.com/v1/models",
        )
        .build()
        .unwrap();

        assert_eq!(
            request.headers().get("Authorization").unwrap(),
            "Bearer sk-test"
        );
    }

    #[tokio::test]
    async fn agent_maestro_fetch_models_helper_normalizes_provider_and_uses_canonical_vault_account(
    ) {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(
            r#"[{"id":"beta","vendor":"copilot"},{"id":"alpha","vendor":"copilot"}]"#,
        ));
        let client = reqwest::Client::new();
        let vault = MemoryVault::with_secret(Some("vault-key"));

        let models = agent_maestro_fetch_models(
            &client,
            "",
            &format!("{}/api/openai/v1", fixture.base_url),
            &vault,
        )
        .await
        .unwrap();

        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert_eq!(models, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(request.path(), "/api/v1/lm/chatModels");
        assert!(request
            .as_text()
            .contains("GET /api/v1/lm/chatModels HTTP/1.1"));
        assert_eq!(
            vault.lookups(),
            vec![("llm".to_string(), agent_maestro::PROVIDER.to_string())]
        );
    }

    #[tokio::test]
    async fn fetch_llm_models_normalizes_agent_maestro_provider_for_discovery() {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(
            r#"[{"id":"beta","vendor":"copilot"},{"id":"alpha","vendor":"copilot"}]"#,
        ));
        let app = tauri::test::mock_builder()
            .manage(reqwest::Client::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();

        let models = fetch_llm_models(
            "typed-key".to_string(),
            " Agent-Maestro ".to_string(),
            format!("{}/api/openai/v1", fixture.base_url),
            app.state::<reqwest::Client>(),
        )
        .await
        .unwrap();

        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert_eq!(models, vec!["alpha".to_string(), "beta".to_string()]);
        assert_eq!(request.path(), "/api/v1/lm/chatModels");
    }

    #[test]
    fn agent_maestro_secret_resolution_reports_generic_vault_errors() {
        let vault = MemoryVault::with_error("vault exploded");
        let error = resolve_agent_maestro_secret("", &vault).unwrap_err();

        assert!(error.contains("Agent Maestro credential vault unavailable"));
    }

    #[tokio::test]
    async fn agent_maestro_test_connection_helper_uses_probe_contract() {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(
            r#"{"choices":[{"message":{"content":"OK"}}]}"#,
        ));
        let client = reqwest::Client::new();
        let vault = MemoryVault::with_secret(Some("vault-key"));

        let result = agent_maestro_test_connection(
            &client,
            "",
            &format!("{}/api/openai/v1", fixture.base_url),
            "model-a",
            &vault,
        )
        .await
        .unwrap();

        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert!(result);
        assert_eq!(request.path(), "/api/openai/v1/chat/completions");
        assert!(request.body().contains("Reply briefly with OK."));
    }

    #[tokio::test]
    async fn agent_maestro_bench_connection_helper_returns_latency() {
        let fixture = spawn_http_fixture(HttpResponseFixture::json(
            r#"{"choices":[{"message":{"content":"OK"}}]}"#,
        ));
        let client = reqwest::Client::new();
        let vault = MemoryVault::with_secret(Some("vault-key"));

        let latency = agent_maestro_bench_connection(
            &client,
            "",
            &format!("{}/api/openai/v1", fixture.base_url),
            "model-a",
            &vault,
        )
        .await
        .unwrap();

        assert!(latency > 0);
    }
}

#[tauri::command]
pub async fn bench_llm_connection(
    api_key: String,
    provider: String,
    base_url: String,
    model: String,
    token_store: tauri::State<'_, SessionTokenStore>,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<u32, String> {
    if provider.is_empty() {
        return Err("No provider specified".to_string());
    }

    if provider == "cloud" {
        let token = token_store
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if token.is_empty() {
            return Err("Not signed in".to_string());
        }
        let api_base = api_base_url();
        let operation_id = synthetic_operation_id();
        let body = serde_json::json!({
            "messages": [{"role": "user", "content": "hi"}],
            "stream": false,
            "context": {
                "operationId": operation_id.clone(),
                "stageKey": format!("{operation_id}:llm"),
                "requestType": "connection_benchmark",
                "clientVersion": crate::desktop_client_version(),
                "rawTextChars": 2,
                "selectedTextChars": 0,
                "hasSelectedText": false,
                "translateEnabled": false
            }
        });
        let t0 = std::time::Instant::now();
        let resp = with_desktop_client_version(client.post(format!("{}/api/proxy/llm", api_base)))
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let elapsed = t0.elapsed().as_millis() as u32;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        return Ok(elapsed);
    }

    if agent_maestro::is_provider(&provider) {
        return agent_maestro_bench_connection(
            &client,
            &api_key,
            &base_url,
            &model,
            &SystemCredentialVault,
        )
        .await;
    }

    let api_key = resolve_config_secret(&api_key, "llm", &provider, &SystemCredentialVault)
        .map_err(|e| e.to_string())?;

    if base_url.is_empty() || !crate::llm::has_usable_provider_credentials(&provider, &api_key) {
        return Err("API key or base URL is empty".to_string());
    }

    let parsed = url::Url::parse(&base_url).map_err(|e| format!("Invalid base URL: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Base URL must use http or https scheme".to_string());
    }

    let url = crate::llm::protocol::chat_endpoint(&provider, &base_url)?;
    let body = crate::llm::protocol::build_chat_body(
        &provider,
        &base_url,
        &model,
        vec![serde_json::json!({"role": "user", "content": "hi"})],
        1,
        0.3,
        false,
    );

    let t0 = std::time::Instant::now();
    let request = client.post(&url).header("Content-Type", "application/json");
    let resp = crate::llm::protocol::apply_auth_headers(request, &provider, &base_url, &api_key)
        .json(&body)
        .timeout(crate::llm::protocol::request_timeout(
            &provider, &base_url, &model,
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let elapsed = t0.elapsed().as_millis() as u32;

    if !resp.status().is_success() {
        let status = resp.status();
        let details: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        return Err(if details.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {details}")
        });
    }

    Ok(elapsed)
}
