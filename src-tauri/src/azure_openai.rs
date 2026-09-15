use serde::{Deserialize, Serialize};

pub const PROVIDER_ID: &str = "azure-openai";
pub const DEFAULT_API_VERSION: &str = "2024-10-21";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureOpenAiConfig {
    pub endpoint: String,
    pub deployment: String,
    pub api_version: String,
}

pub fn is_azure(provider: &str) -> bool {
    provider.trim().eq_ignore_ascii_case(PROVIDER_ID)
}

pub fn default_api_version() -> String {
    DEFAULT_API_VERSION.to_string()
}

impl AzureOpenAiConfig {
    pub fn chat_endpoint(&self) -> Result<String, String> {
        self.endpoint_for("chat/completions")
    }

    pub fn transcription_endpoint(&self) -> Result<String, String> {
        self.endpoint_for("audio/transcriptions")
    }

    fn endpoint_for(&self, operation: &str) -> Result<String, String> {
        let endpoint = self.endpoint.trim();
        if endpoint.is_empty() {
            return Err("Azure OpenAI resource endpoint is required".to_string());
        }
        let mut url = url::Url::parse(endpoint)
            .map_err(|_| "Azure OpenAI resource endpoint must be a valid HTTPS URL".to_string())?;
        if url.scheme() != "https" || url.host_str().is_none() {
            return Err("Azure OpenAI resource endpoint must use HTTPS with a host".to_string());
        }
        if !url.username().is_empty() || url.password().is_some() || endpoint.contains('@') {
            return Err("Azure OpenAI resource endpoint must not include credentials".to_string());
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(
                "Azure OpenAI resource endpoint must not include a query or fragment".to_string(),
            );
        }
        // Inspect the original path too: URL parsing normalizes dot segments and backslashes.
        let (_, authority) = endpoint
            .split_once("://")
            .ok_or_else(|| "Azure OpenAI resource endpoint must start with https://".to_string())?;
        let raw_path = authority
            .find('/')
            .map(|index| &authority[index..])
            .unwrap_or("");
        if !matches!(raw_path, "" | "/")
            || endpoint.contains('\\')
            || endpoint.chars().any(char::is_control)
            || url.path() != "/"
        {
            return Err("Azure OpenAI endpoint must be a resource root without a path".to_string());
        }
        let deployment = self.deployment.trim();
        if deployment.is_empty() {
            return Err("Azure OpenAI deployment is required".to_string());
        }
        if matches!(deployment, "." | "..") {
            return Err("Azure OpenAI deployment must not be a dot path segment".to_string());
        }
        let api_version = self.api_version.trim();
        if api_version.is_empty() {
            return Err("Azure OpenAI API version is required".to_string());
        }
        url.path_segments_mut()
            .map_err(|_| "Azure OpenAI resource endpoint must have a host".to_string())?
            .clear()
            .extend(["openai", "deployments", deployment])
            .extend(operation.split('/'));
        url.query_pairs_mut()
            .append_pair("api-version", api_version);
        Ok(url.to_string())
    }
}

pub fn validate_api_key(api_key: &str) -> Result<(), String> {
    if api_key.trim().is_empty() {
        Err("Azure OpenAI API key is required".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(endpoint: &str, deployment: &str, api_version: &str) -> AzureOpenAiConfig {
        AzureOpenAiConfig {
            endpoint: endpoint.to_string(),
            deployment: deployment.to_string(),
            api_version: api_version.to_string(),
        }
    }

    #[test]
    fn azure_endpoints_trim_and_use_deployment_rest_paths() {
        let config = config(" https://private.example:8443/ ", " prod ", " 2024-10-21 ");
        assert_eq!(config.chat_endpoint().unwrap(),
            "https://private.example:8443/openai/deployments/prod/chat/completions?api-version=2024-10-21");
        assert_eq!(config.transcription_endpoint().unwrap(),
            "https://private.example:8443/openai/deployments/prod/audio/transcriptions?api-version=2024-10-21");
    }

    #[test]
    fn azure_deployment_and_version_cannot_inject_url_structure() {
        let config = config("https://resource.example", "a/b ?#%雪", "v&other=secret");
        let endpoint = url::Url::parse(&config.chat_endpoint().unwrap()).unwrap();
        assert_eq!(
            endpoint.path(),
            "/openai/deployments/a%2Fb%20%3F%23%25%E9%9B%AA/chat/completions"
        );
        assert_eq!(
            endpoint.query_pairs().collect::<Vec<_>>(),
            vec![("api-version".into(), "v&other=secret".into())]
        );
    }

    #[test]
    fn azure_rejects_non_resource_roots_without_echoing_input() {
        for endpoint in [
            "",
            "http://resource.example",
            "https://user:secret@resource.example",
            "https://resource.example?secret=key",
            "https://resource.example#secret",
            "https://resource.example/openai",
            "https://resource.example//",
            "https://resource.example/a/..",
            "https://resource.example/%2e",
            "https://resource.example\\openai",
            "https:resource.example",
            "https:/resource.example",
            "https://",
            "file:///secret",
        ] {
            let error = config(endpoint, "prod", DEFAULT_API_VERSION)
                .chat_endpoint()
                .unwrap_err();
            assert!(!error.contains("secret"));
        }
    }

    #[test]
    fn azure_requires_explicit_deployment_version_and_key() {
        for deployment in ["", " ", ".", ".."] {
            assert!(
                config("https://resource.example", deployment, DEFAULT_API_VERSION)
                    .chat_endpoint()
                    .is_err()
            );
        }
        for version in ["", " "] {
            assert!(config("https://resource.example", "prod", version)
                .chat_endpoint()
                .is_err());
        }
        assert!(validate_api_key(" ").unwrap_err().contains("API key"));
        assert!(validate_api_key(" test-key ").is_ok());
    }

    #[test]
    fn azure_ipc_config_uses_camel_case() {
        let value = serde_json::to_value(config(
            "https://resource.example",
            "prod",
            DEFAULT_API_VERSION,
        ))
        .unwrap();
        assert_eq!(value["apiVersion"], DEFAULT_API_VERSION);
        assert!(value.get("api_version").is_none());
    }
}
