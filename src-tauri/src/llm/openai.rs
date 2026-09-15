use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;

use crate::error::AppError;

use super::{
    prompt, protocol, ChunkCallback, LlmConfig, LlmProvider, PolishRequest, PolishResponse,
};

pub struct OpenAiProvider {
    client: Client,
}

#[cfg(test)]
mod azure_tests {
    #[test]
    fn azure_polish_body_treats_glm_alias_as_opaque() {
        let config = super::LlmConfig {
            provider: "azure-openai".to_string(),
            base_url: "https://resource.example".to_string(),
            model: "glm-production".to_string(),
            ..Default::default()
        };
        let body = super::build_polish_body(&config, vec![], true);
        assert_eq!(body["max_completion_tokens"], config.max_tokens);
        assert_eq!(body["stream"], true);
        for field in ["max_tokens", "temperature", "thinking", "top_p"] {
            assert!(body.get(field).is_none(), "{field}");
        }
    }
}

impl Default for OpenAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
        }
    }

    pub fn with_client(client: Client) -> Self {
        Self { client }
    }
}

fn build_polish_body(
    config: &LlmConfig,
    messages: Vec<serde_json::Value>,
    stream: bool,
) -> serde_json::Value {
    let mut body = protocol::build_chat_body(
        &config.provider,
        &config.base_url,
        &config.model,
        messages,
        config.max_tokens,
        config.temperature,
        stream,
    );
    // GLM thinking responses require explicit thinking and sampling controls.
    if !crate::azure_openai::is_azure(&config.provider) && config.model.starts_with("glm-") {
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "thinking".to_string(),
                serde_json::json!({"type": "enabled"}),
            );
            obj.insert("temperature".to_string(), serde_json::json!(1.0));
            obj.insert("top_p".to_string(), serde_json::json!(0.95));
        }
    }
    body
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    async fn polish(
        &self,
        config: &LlmConfig,
        req: &PolishRequest,
        on_chunk: Option<&ChunkCallback>,
    ) -> Result<PolishResponse, AppError> {
        let has_selected_text = req
            .selected_text
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty());

        let system_prompt = prompt::build_context_system_prompt(prompt::ContextPromptOptions {
            context: &req.context,
            dictionary: &req.dictionary,
            correction_rules: &req.correction_rules,
            polish_style: &req.polish_style,
            personal_style_prompt: "",
            mapped_scene_prompt: &req.mapped_scene_prompt,
            active_scene_prompt: &req.active_scene_prompt,
            polish_custom_prompt: &req.polish_custom_prompt,
            translate_enabled: req.translate_enabled,
            target_lang: &req.target_lang,
            has_selected_text,
            voice_intent: Some(&req.voice_intent),
        });

        let mut messages = vec![serde_json::json!({ "role": "system", "content": system_prompt })];
        if has_selected_text {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("<selected_text>\n{}\n</selected_text>", req.selected_text.as_ref().unwrap())
            }));
        }
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!("<transcription>\n{}\n</transcription>", req.raw_text)
        }));

        let api_kind = protocol::detect_api_kind(&config.provider, &config.base_url);
        let endpoint = protocol::configured_chat_endpoint(
            &config.provider,
            &config.base_url,
            &config.model,
            Some(&config.api_version),
        )
        .map_err(AppError::Config)?;
        if crate::azure_openai::is_azure(&config.provider) {
            crate::azure_openai::validate_api_key(&config.api_key).map_err(AppError::Auth)?;
        }
        let body = build_polish_body(config, messages, on_chunk.is_some());

        // Retry the initial connection (not once streaming starts)
        #[allow(unused_assignments)]
        let mut response = None;
        let mut last_error: Option<AppError> = None;
        let mut attempt = 0u32;

        loop {
            let request = self
                .client
                .post(&endpoint)
                .header("Content-Type", "application/json");
            match protocol::apply_auth_headers(
                request,
                &config.provider,
                &config.base_url,
                &config.api_key,
            )
            .json(&body)
            .timeout(protocol::request_timeout(
                &config.provider,
                &config.base_url,
                &config.model,
            ))
            .send()
            .await
            {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        response = Some(resp);
                        break;
                    } else if status.as_u16() >= 500 && attempt < 2 {
                        let body_text = resp.text().await.unwrap_or_default();
                        tracing::warn!(
                            "LLM server error {} (attempt {}/3), retrying",
                            status,
                            attempt + 1
                        );
                        last_error = Some(AppError::Api {
                            status: status.as_u16(),
                            body: body_text,
                        });
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            1000 * 2u64.pow(attempt - 1),
                        ))
                        .await;
                        continue;
                    } else {
                        let status = resp.status();
                        let text = resp.text().await.unwrap_or_default();
                        // Truncate at a valid UTF-8 char boundary to avoid panic on multi-byte chars
                        let truncate_at = text
                            .char_indices()
                            .take_while(|&(i, _)| i < 200)
                            .last()
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(text.len());
                        let sanitized = &text[..truncate_at];
                        return Err(AppError::Api {
                            status: status.as_u16(),
                            body: sanitized.to_string(),
                        });
                    }
                }
                Err(e) if e.is_timeout() && attempt < 2 => {
                    tracing::warn!(
                        "LLM connection timeout (attempt {}/3), retrying",
                        attempt + 1
                    );
                    last_error = Some(e.into());
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        1000 * 2u64.pow(attempt - 1),
                    ))
                    .await;
                    continue;
                }
                Err(e) if e.is_connect() && attempt < 2 => {
                    tracing::warn!(
                        "LLM connection failed (attempt {}/3), retrying",
                        attempt + 1
                    );
                    last_error = Some(e.into());
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        1000 * 2u64.pow(attempt - 1),
                    ))
                    .await;
                    continue;
                }
                Err(e) => return Err(e.into()),
            }
        }

        let response = response.ok_or_else(|| last_error.unwrap())?;

        if let Some(callback) = on_chunk {
            // Streaming mode
            let mut full_text = String::new();
            let mut reasoning_text = String::new();
            let mut stream = response.bytes_stream();

            let mut buffer = String::new();
            let mut stream_done = false;
            while !stream_done {
                let Some(chunk) = stream.next().await else {
                    break;
                };
                let chunk = chunk?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Process SSE lines
                while let Some(line_end) = buffer.find('\n') {
                    let line = buffer[..line_end].trim().to_string();
                    buffer = buffer[line_end + 1..].to_string();

                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            stream_done = true;
                            break;
                        }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                            let event = protocol::parse_stream_event(api_kind, &v);
                            if let Some(error) = event.error {
                                return Err(AppError::Config(error));
                            }
                            if let Some(content) = event.text {
                                if !content.is_empty() {
                                    full_text.push_str(&content);
                                    callback(&content);
                                }
                            }

                            // Collect reasoning_content as fallback for thinking-mode models
                            // where all output may land in this field instead of content
                            if let Some(rc) = event.reasoning {
                                if !rc.is_empty() {
                                    reasoning_text.push_str(&rc);
                                }
                            }
                            stream_done = event.done;
                        }
                    }
                }
            }

            // If content was empty but reasoning_content had text, use it as output.
            // This handles GLM thinking-mode where the API puts all output in reasoning_content.
            if full_text.is_empty() && !reasoning_text.is_empty() {
                tracing::warn!(
                    "LLM content empty, using reasoning_content ({} chars) as output",
                    reasoning_text.len()
                );
                callback(&reasoning_text);
                full_text = reasoning_text;
            } else if full_text.is_empty() {
                tracing::error!("LLM streaming returned no content and no reasoning_content");
            }

            Ok(PolishResponse {
                polished_text: full_text,
            })
        } else {
            // Non-streaming mode
            let v: serde_json::Value = response.json().await?;
            let text = protocol::response_text(api_kind, &v);

            if text.is_empty() {
                tracing::warn!(
                    "LLM non-streaming returned empty content, full response: {}",
                    v
                );
            }

            Ok(PolishResponse {
                polished_text: text,
            })
        }
    }

    fn name(&self) -> &str {
        "OpenAI"
    }
}
