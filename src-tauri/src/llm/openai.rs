use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use std::time::{Duration, Instant};

use crate::error::AppError;

use super::{
    agent_maestro, prompt, protocol, sse::SseDecoder, ChunkCallback, LlmConfig, LlmProvider,
    PolishRequest, PolishResponse,
};

pub struct OpenAiProvider {
    client: Client,
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

fn remaining_duration(deadline: Instant, timeout: Duration) -> Result<Duration, AppError> {
    deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| {
            AppError::Config(format!(
                "Agent Maestro request timed out after {}s",
                timeout.as_secs()
            ))
        })
}

fn agent_maestro_stream_error(message: &str, key: &str) -> String {
    let detail = agent_maestro::diagnostic(message, key);
    if detail.trim().is_empty() {
        "Agent Maestro stream returned an error".to_string()
    } else {
        format!("Agent Maestro stream returned an error: {detail}")
    }
}

fn agent_maestro_json_error(prefix: &str) -> AppError {
    AppError::Config(format!("Invalid Agent Maestro {prefix} JSON"))
}

fn handle_stream_event(
    api_kind: protocol::LlmApiKind,
    provider: &str,
    api_key: &str,
    frame: &str,
    full_text: &mut String,
    reasoning_text: &mut String,
    callback: &ChunkCallback,
) -> Result<bool, AppError> {
    if frame == "[DONE]" {
        return Ok(true);
    }

    let value: Value = match serde_json::from_str(frame) {
        Ok(value) => value,
        Err(_) if agent_maestro::is_provider(provider) => {
            return Err(agent_maestro_json_error("stream event"));
        }
        Err(error) => {
            tracing::warn!("Ignoring invalid LLM stream JSON: {error}");
            return Ok(false);
        }
    };
    let event = protocol::parse_stream_event(api_kind, &value);
    if let Some(error) = event.error {
        return Err(if agent_maestro::is_provider(provider) {
            AppError::Config(agent_maestro_stream_error(&error, api_key))
        } else {
            AppError::Config(error)
        });
    }
    if agent_maestro::is_provider(provider) {
        agent_maestro::validate_stream_event(&value).map_err(AppError::Config)?;
    }
    if let Some(content) = event.text.filter(|content| !content.is_empty()) {
        full_text.push_str(&content);
        callback(&content);
    }
    if let Some(reasoning) = event.reasoning.filter(|reasoning| !reasoning.is_empty()) {
        reasoning_text.push_str(&reasoning);
    }
    Ok(event.done)
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    async fn polish(
        &self,
        config: &LlmConfig,
        req: &PolishRequest,
        on_chunk: Option<&ChunkCallback>,
    ) -> Result<PolishResponse, AppError> {
        let is_agent_maestro = agent_maestro::is_provider(&config.provider);
        let request_timeout =
            protocol::request_timeout(&config.provider, &config.base_url, &config.model);
        let mut request_deadline = is_agent_maestro.then(|| Instant::now() + request_timeout);
        if is_agent_maestro {
            agent_maestro::validate_config(&config.base_url, &config.model)
                .map_err(AppError::Config)?;
        }

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
        let endpoint = protocol::chat_endpoint(&config.provider, &config.base_url)
            .map_err(AppError::Config)?;
        let mut body = protocol::build_chat_body(
            &config.provider,
            &config.base_url,
            &config.model,
            messages,
            config.max_tokens,
            config.temperature,
            on_chunk.is_some(),
        );

        // GLM-4.7/4.5/5 default to thinking mode, but without explicitly enabling it
        // the API may return content in reasoning_content only, leaving content empty.
        // Explicitly enable thinking so both fields are properly populated.
        // Thinking mode also requires temperature >= 0.6 (recommended 1.0).
        if config.model.starts_with("glm-") {
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "thinking".to_string(),
                    serde_json::json!({"type": "enabled"}),
                );
                obj.insert("temperature".to_string(), serde_json::json!(1.0));
                obj.insert("top_p".to_string(), serde_json::json!(0.95));
            }
        }

        // Retry the initial connection (not once streaming starts)
        #[allow(unused_assignments)]
        let mut response = None;
        let mut last_error: Option<AppError> = None;
        let mut attempt = 0u32;

        loop {
            if attempt > 0 && is_agent_maestro {
                request_deadline = Some(Instant::now() + request_timeout);
            }
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
            .timeout(if let Some(deadline) = request_deadline {
                remaining_duration(deadline, request_timeout)?
            } else {
                request_timeout
            })
            .send()
            .await
            {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        response = Some(resp);
                        break;
                    } else if status.as_u16() >= 500 && attempt < 2 {
                        let error = if is_agent_maestro {
                            let remaining = remaining_duration(
                                request_deadline.expect("Agent Maestro deadline must exist"),
                                request_timeout,
                            )?;
                            agent_maestro::read_json(resp, &config.api_key, remaining)
                                .await
                                .err()
                                .unwrap_or_else(|| {
                                    "Agent Maestro response returned an error".to_string()
                                })
                        } else {
                            resp.text().await.unwrap_or_default()
                        };
                        tracing::warn!(
                            "LLM server error {} (attempt {}/3), retrying",
                            status,
                            attempt + 1
                        );
                        last_error = Some(if is_agent_maestro {
                            AppError::Config(error)
                        } else {
                            AppError::Api {
                                status: status.as_u16(),
                                body: error,
                            }
                        });
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            1000 * 2u64.pow(attempt - 1),
                        ))
                        .await;
                        continue;
                    } else {
                        if is_agent_maestro {
                            let remaining = remaining_duration(
                                request_deadline.expect("Agent Maestro deadline must exist"),
                                request_timeout,
                            )?;
                            let error = agent_maestro::read_json(resp, &config.api_key, remaining)
                                .await
                                .err()
                                .unwrap_or_else(|| {
                                    "Agent Maestro response returned an error".to_string()
                                });
                            return Err(AppError::Config(error));
                        }
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
                    last_error = Some(if is_agent_maestro {
                        AppError::Config(agent_maestro::network_error(
                            e,
                            &config.api_key,
                            request_timeout,
                        ))
                    } else {
                        e.into()
                    });
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
                    last_error = Some(if is_agent_maestro {
                        AppError::Config(agent_maestro::network_error(
                            e,
                            &config.api_key,
                            request_timeout,
                        ))
                    } else {
                        e.into()
                    });
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        1000 * 2u64.pow(attempt - 1),
                    ))
                    .await;
                    continue;
                }
                Err(e) => {
                    return Err(if is_agent_maestro {
                        AppError::Config(agent_maestro::network_error(
                            e,
                            &config.api_key,
                            request_timeout,
                        ))
                    } else {
                        e.into()
                    })
                }
            }
        }

        let response = response.ok_or_else(|| last_error.unwrap())?;

        if let Some(callback) = on_chunk {
            let mut full_text = String::new();
            let mut reasoning_text = String::new();
            let mut stream = response.bytes_stream();
            let mut decoder = SseDecoder::default();
            let mut stream_done = false;
            while !stream_done {
                let next_chunk = if let Some(deadline) = request_deadline {
                    match tokio::time::timeout(
                        remaining_duration(deadline, request_timeout)?,
                        stream.next(),
                    )
                    .await
                    {
                        Ok(next_chunk) => next_chunk,
                        Err(_) => {
                            return Err(AppError::Config(format!(
                                "Agent Maestro request timed out after {}s",
                                request_timeout.as_secs()
                            )))
                        }
                    }
                } else {
                    stream.next().await
                };
                let Some(chunk) = next_chunk else {
                    break;
                };
                let chunk = chunk.map_err(|error| {
                    if is_agent_maestro {
                        AppError::Config(agent_maestro::network_error(
                            error,
                            &config.api_key,
                            request_timeout,
                        ))
                    } else {
                        error.into()
                    }
                })?;
                let frames = decoder.push(&chunk).map_err(AppError::Config)?;
                for frame in frames {
                    let done = handle_stream_event(
                        api_kind,
                        &config.provider,
                        &config.api_key,
                        &frame,
                        &mut full_text,
                        &mut reasoning_text,
                        callback,
                    )?;
                    stream_done = done;
                    if stream_done {
                        break;
                    }
                }
            }
            for frame in decoder.finish().map_err(AppError::Config)? {
                if stream_done {
                    break;
                }
                let done = handle_stream_event(
                    api_kind,
                    &config.provider,
                    &config.api_key,
                    &frame,
                    &mut full_text,
                    &mut reasoning_text,
                    callback,
                )?;
                stream_done = done;
            }

            if is_agent_maestro && !stream_done {
                return Err(AppError::Config(
                    "Agent Maestro stream ended before [DONE]".to_string(),
                ));
            }
            if is_agent_maestro && full_text.trim().is_empty() {
                return Err(AppError::Config(
                    "Agent Maestro response did not include assistant content".to_string(),
                ));
            }
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
            let v: serde_json::Value = if is_agent_maestro {
                let deadline = request_deadline.expect("Agent Maestro deadline must exist");
                agent_maestro::read_json(
                    response,
                    &config.api_key,
                    remaining_duration(deadline, request_timeout)?,
                )
                .await
                .map_err(AppError::Config)?
            } else {
                response.json().await?
            };
            let text = if is_agent_maestro {
                agent_maestro::response_text(&v).map_err(AppError::Config)?
            } else {
                protocol::response_text(api_kind, &v)
            };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_detector::types::{BrowserAccessStatus, ContextFamily, ContextProfileSummary};
    use crate::llm::agent_maestro;
    use crate::llm::test_http::{spawn_http_fixture, HttpResponseFixture, REQUEST_TIMEOUT};
    use crate::voice_intent::{CommandLocale, VoiceIntentKind, VoiceOutputPlacement};
    use std::sync::{Arc, Mutex};

    fn request_fixture() -> PolishRequest {
        PolishRequest {
            raw_text: "turn this into a polished sentence".to_string(),
            context: ContextProfileSummary {
                profile_id: "general.native".to_string(),
                family: ContextFamily::General,
                app_label: "Terminal".to_string(),
                icon_key: "general".to_string(),
                override_id: None,
                browser_access_status: BrowserAccessStatus::NotApplicable,
                browser_target: None,
            },
            dictionary: Vec::new(),
            correction_rules: Vec::new(),
            polish_style: "clean".to_string(),
            mapped_scene_prompt: String::new(),
            active_scene_prompt: String::new(),
            polish_custom_prompt: String::new(),
            translate_enabled: false,
            target_lang: "en".to_string(),
            selected_text: None,
            operation_id: None,
            voice_intent: crate::voice_intent::VoiceIntent::from_parts(
                VoiceIntentKind::DraftInsert,
                VoiceOutputPlacement::InsertAtCursor,
                1.0,
                None,
                Some("draft".to_string()),
                Some(CommandLocale::En),
                None,
            )
            .unwrap(),
        }
    }

    fn config_fixture(base_url: String) -> LlmConfig {
        LlmConfig {
            provider: agent_maestro::PROVIDER.to_string(),
            api_key: " fake-key ".to_string(),
            model: " model-a ".to_string(),
            base_url,
            max_tokens: 128,
            temperature: 0.3,
        }
    }

    fn sse_fixture(body: &'static str) -> HttpResponseFixture<'static> {
        HttpResponseFixture {
            status_line: "200 OK",
            content_type: "text/event-stream",
            body,
        }
    }

    #[tokio::test]
    async fn agent_maestro_polish_streaming_returns_polished_content_and_callbacks() {
        let fixture = spawn_http_fixture(sse_fixture(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n\
             data: [DONE]\n\n",
        ));
        let provider = OpenAiProvider::with_client(reqwest::Client::new());
        let request = request_fixture();
        let config = config_fixture(format!("{}/api/openai/v1", fixture.base_url));
        let chunks = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = Arc::clone(&chunks);
        let callback: ChunkCallback = Box::new(move |chunk| {
            observed.lock().unwrap().push(chunk.to_string());
        });

        let response = provider
            .polish(&config, &request, Some(&callback))
            .await
            .expect("streaming response should succeed");

        assert_eq!(response.polished_text, "Hello");
        assert_eq!(chunks.lock().unwrap().as_slice(), ["Hel", "lo"]);

        let request = fixture.requests.recv_timeout(REQUEST_TIMEOUT).unwrap();
        assert_eq!(request.path(), "/api/openai/v1/chat/completions");
        assert!(request.body().contains("\"stream\":true"));
        assert!(request.body().contains("\"model\":\"model-a\""));
    }

    #[tokio::test]
    async fn agent_maestro_polish_streaming_propagates_partial_output_then_redacted_error() {
        let fixture = spawn_http_fixture(sse_fixture(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
             data: {\"error\":{\"message\":\"upstream fake-key exploded\"}}\n\n",
        ));
        let provider = OpenAiProvider::with_client(reqwest::Client::new());
        let request = request_fixture();
        let config = config_fixture(format!("{}/api/openai/v1", fixture.base_url));
        let chunks = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed = Arc::clone(&chunks);
        let callback: ChunkCallback = Box::new(move |chunk| {
            observed.lock().unwrap().push(chunk.to_string());
        });

        let error = provider
            .polish(&config, &request, Some(&callback))
            .await
            .expect_err("streaming error frame should fail even after partial callbacks");

        assert_eq!(chunks.lock().unwrap().as_slice(), ["Hel"]);
        match error {
            AppError::Config(message) => {
                assert!(!message.contains("fake-key"));
                assert!(message.contains("[redacted]") || message.contains("upstream"));
            }
            other => panic!("expected config error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agent_maestro_polish_streaming_rejects_eof_without_done() {
        let fixture = spawn_http_fixture(sse_fixture(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
        ));
        let provider = OpenAiProvider::with_client(reqwest::Client::new());
        let request = request_fixture();
        let config = config_fixture(format!("{}/api/openai/v1", fixture.base_url));
        let callback: ChunkCallback = Box::new(|_| {});

        let error = provider
            .polish(&config, &request, Some(&callback))
            .await
            .expect_err("missing done marker must fail for Agent Maestro");

        match error {
            AppError::Config(message) => assert!(!message.is_empty()),
            other => panic!("expected config error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agent_maestro_polish_streaming_rejects_malformed_json_frames() {
        let fixture = spawn_http_fixture(sse_fixture(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]\n\n\
             data: [DONE]\n\n",
        ));
        let provider = OpenAiProvider::with_client(reqwest::Client::new());
        let request = request_fixture();
        let config = config_fixture(format!("{}/api/openai/v1", fixture.base_url));
        let callback: ChunkCallback = Box::new(|_| {});

        let error = provider
            .polish(&config, &request, Some(&callback))
            .await
            .expect_err("malformed JSON stream frame must fail for Agent Maestro");

        match error {
            AppError::Config(message) => {
                assert!(message.contains("Agent Maestro"));
                assert!(message.to_ascii_lowercase().contains("json"));
            }
            other => panic!("expected config error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agent_maestro_polish_streaming_rejects_reasoning_only_done_streams() {
        let fixture = spawn_http_fixture(sse_fixture(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\n\
             data: [DONE]\n\n",
        ));
        let provider = OpenAiProvider::with_client(reqwest::Client::new());
        let request = request_fixture();
        let config = config_fixture(format!("{}/api/openai/v1", fixture.base_url));
        let callback: ChunkCallback = Box::new(|_| {});

        let error = provider
            .polish(&config, &request, Some(&callback))
            .await
            .expect_err("reasoning-only Agent Maestro streams must not succeed");

        match error {
            AppError::Config(message) => {
                assert!(message.contains("Agent Maestro"));
                assert!(message.contains("content") || message.contains("assistant"));
            }
            other => panic!("expected config error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agent_maestro_polish_streaming_stops_on_done_before_later_same_chunk_frames() {
        let fixture = spawn_http_fixture(sse_fixture(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n\
             data: [DONE]\n\n\
             data: {\"error\":{\"message\":\"should be ignored\"}}\n\n",
        ));
        let provider = OpenAiProvider::with_client(reqwest::Client::new());
        let request = request_fixture();
        let config = config_fixture(format!("{}/api/openai/v1", fixture.base_url));
        let callback: ChunkCallback = Box::new(|_| {});

        let response = provider
            .polish(&config, &request, Some(&callback))
            .await
            .expect("frames after [DONE] in the same chunk must be ignored");

        assert_eq!(response.polished_text, "Hello");
    }
}
