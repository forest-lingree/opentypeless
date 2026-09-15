use async_trait::async_trait;

use crate::error::AppError;

use super::{SttConfig, SttProvider, TranscriptEvent};

/// Configuration for a Whisper-compatible HTTP file-upload STT provider.
#[derive(Debug)]
pub struct WhisperCompatConfig {
    pub provider_name: String,
    pub endpoint: String,
    pub model: String,
    /// Extra form text fields (e.g. GLM-ASR needs "stream"="false").
    pub extra_fields: Vec<(String, String)>,
    /// Local OpenAI-compatible servers often do not require authentication.
    pub api_key_required: bool,
}

/// Max audio buffer: ~24 MB PCM ≈ 12.5 min at 16kHz 16-bit mono.
/// Keeps the resulting WAV under 25 MB (OpenAI/Groq limit).
const MAX_AUDIO_BYTES: usize = 24 * 1024 * 1024;

#[cfg(test)]
mod azure_tests {
    use super::*;

    fn config() -> WhisperCompatConfig {
        WhisperCompatConfig {
            provider_name: "azure-openai".to_string(),
            endpoint: "https://resource.example/openai/deployments/speech/audio/transcriptions?api-version=2024-10-21".to_string(),
            model: "opaque-deployment".to_string(),
            extra_fields: vec![("stream".to_string(), "false".to_string())],
            api_key_required: true,
        }
    }

    #[tokio::test]
    async fn azure_runtime_rejects_blank_api_key() {
        let mut provider = WhisperCompatProvider::new(config());
        assert!(provider
            .connect(&SttConfig {
                api_key: " ".to_string(),
                ..Default::default()
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn azure_upload_uses_api_key_file_and_optional_language_only() {
        for language in [None, Some("multi"), Some(""), Some(" en ")] {
            let mut request = build_upload_request(
                &reqwest::Client::new(),
                &config(),
                " test-key ",
                vec![1, 2, 3],
                language,
                std::time::Duration::from_secs(60),
            )
            .unwrap()
            .build()
            .unwrap();
            assert_eq!(request.headers().get("api-key").unwrap(), "test-key");
            assert!(!request.headers().contains_key("authorization"));
            let body = request.body_mut().take().unwrap();
            let text = reqwest::Response::from(http::Response::new(body))
                .text()
                .await
                .unwrap();
            assert!(text.contains("name=\"file\"; filename=\"audio.wav\""));
            assert!(!text.contains("name=\"model\""));
            assert!(!text.contains("name=\"stream\""));
            assert_eq!(text.contains("name=\"language\""), language == Some(" en "));
            if language == Some(" en ") {
                assert!(text.contains("\r\n\r\nen\r\n"));
            }
        }
        assert!(build_upload_request(
            &reqwest::Client::new(),
            &config(),
            " ",
            vec![],
            None,
            std::time::Duration::from_secs(60)
        )
        .is_err());
    }

    #[tokio::test]
    async fn azure_upload_refactor_preserves_known_and_keyless_provider_forms() {
        for cfg in [
            crate::stt::config::build_known_whisper_config("glm-asr").unwrap(),
            crate::stt::config::build_custom_whisper_config("http://localhost:8000/v1", "model")
                .unwrap(),
        ] {
            let key = if cfg.api_key_required { "test-key" } else { "" };
            let mut request = build_upload_request(
                &reqwest::Client::new(),
                &cfg,
                key,
                vec![1],
                Some("en"),
                std::time::Duration::from_secs(15),
            )
            .unwrap()
            .build()
            .unwrap();
            assert_eq!(
                request.headers().contains_key("authorization"),
                cfg.api_key_required
            );
            assert!(!request.headers().contains_key("api-key"));
            let text =
                reqwest::Response::from(http::Response::new(request.body_mut().take().unwrap()))
                    .text()
                    .await
                    .unwrap();
            assert!(text.contains("name=\"model\""));
            assert!(text.contains("name=\"language\""));
            assert_eq!(
                text.contains("name=\"stream\""),
                cfg.provider_name == "glm-asr"
            );
        }
    }
}

pub fn build_upload_request(
    client: &reqwest::Client,
    config: &WhisperCompatConfig,
    api_key: &str,
    wav_data: Vec<u8>,
    language: Option<&str>,
    timeout: std::time::Duration,
) -> Result<reqwest::RequestBuilder, AppError> {
    let azure = crate::azure_openai::is_azure(&config.provider_name);
    if azure {
        crate::azure_openai::validate_api_key(api_key).map_err(AppError::Auth)?;
    }
    let file_part = reqwest::multipart::Part::bytes(wav_data)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|error| AppError::Config(error.to_string()))?;
    let mut form = reqwest::multipart::Form::new().part("file", file_part);
    if !azure {
        form = form.text("model", config.model.clone());
    }
    let language = if azure {
        language
            .map(str::trim)
            .filter(|language| !language.is_empty())
    } else {
        language
    };
    if let Some(language) = language.filter(|language| *language != "multi") {
        form = form.text("language", language.to_string());
    }
    if !azure {
        for (key, value) in &config.extra_fields {
            form = form.text(key.clone(), value.clone());
        }
    }
    let mut request = client
        .post(&config.endpoint)
        .multipart(form)
        .timeout(timeout);
    if azure {
        request = request.header("api-key", api_key.trim());
    } else if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key);
    }
    Ok(request)
}

/// Generic provider for any OpenAI Whisper-compatible transcription API.
/// Works with: OpenAI, Azure OpenAI, Groq, SiliconFlow, GLM-ASR.
pub struct WhisperCompatProvider {
    provider_config: WhisperCompatConfig,
    stt_config: Option<SttConfig>,
    audio_buffer: Vec<u8>,
    client: reqwest::Client,
}

impl WhisperCompatProvider {
    pub fn new(provider_config: WhisperCompatConfig) -> Self {
        Self {
            provider_config,
            stt_config: None,
            audio_buffer: Vec::new(),
            client: reqwest::Client::new(),
        }
    }

    pub fn with_client(provider_config: WhisperCompatConfig, client: reqwest::Client) -> Self {
        Self {
            provider_config,
            stt_config: None,
            audio_buffer: Vec::new(),
            client,
        }
    }

    /// Build a WAV file from raw PCM 16-bit mono audio. Public so test helpers can reuse it.
    pub fn build_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
        let data_len = pcm.len() as u32;
        let channels: u16 = 1;
        let bits_per_sample: u16 = 16;
        let byte_rate = sample_rate * (channels as u32) * (bits_per_sample as u32) / 8;
        let block_align = channels * bits_per_sample / 8;
        let file_size = 36 + data_len;

        let mut wav = Vec::with_capacity(44 + pcm.len());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&file_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&bits_per_sample.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend_from_slice(pcm);
        wav
    }
}

#[async_trait]
impl SttProvider for WhisperCompatProvider {
    async fn connect(&mut self, config: &SttConfig) -> Result<(), AppError> {
        if crate::azure_openai::is_azure(&self.provider_config.provider_name) {
            crate::azure_openai::validate_api_key(&config.api_key).map_err(AppError::Auth)?;
        }
        if self.provider_config.api_key_required && config.api_key.is_empty() {
            return Err(AppError::Auth(format!(
                "{} API key is empty",
                self.provider_config.provider_name
            )));
        }
        self.stt_config = Some(config.clone());
        self.audio_buffer.clear();
        tracing::info!(
            "{} provider ready (buffering mode)",
            self.provider_config.provider_name
        );
        Ok(())
    }

    async fn send_audio(&mut self, chunk: &[u8]) -> Result<(), AppError> {
        if self.audio_buffer.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err(AppError::Config(format!(
                "{}: audio exceeds maximum length (~12 min)",
                self.provider_config.provider_name
            )));
        }
        self.audio_buffer.extend_from_slice(chunk);
        Ok(())
    }

    async fn recv_transcript(&mut self) -> Result<Option<TranscriptEvent>, AppError> {
        // File-based providers transcribe in disconnect(); keep this future
        // pending so the pipeline select loop does not busy-spin while recording.
        std::future::pending().await
    }

    async fn disconnect(&mut self) -> Result<Option<String>, AppError> {
        let config = match &self.stt_config {
            Some(c) => c.clone(),
            None => return Ok(None),
        };

        if self.audio_buffer.is_empty() {
            tracing::info!(
                "{}: no audio buffered, skipping",
                self.provider_config.provider_name
            );
            return Ok(None);
        }

        let audio_len_secs = self.audio_buffer.len() as f64 / (config.sample_rate as f64 * 2.0);
        let wav_data = Self::build_wav(&self.audio_buffer, config.sample_rate);
        self.audio_buffer.clear();
        tracing::info!(
            "{}: sending {:.1}s of audio for transcription",
            self.provider_config.provider_name,
            audio_len_secs
        );

        let mut attempt = 0u32;
        loop {
            let request = build_upload_request(
                &self.client,
                &self.provider_config,
                &config.api_key,
                wav_data.clone(),
                config.language.as_deref(),
                std::time::Duration::from_secs(60),
            )?;
            let resp_result = request.send().await;

            match resp_result {
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();

                    if status.is_success() {
                        let v: serde_json::Value = serde_json::from_str(&body)
                            .map_err(|e| AppError::Config(e.to_string()))?;
                        let text = v["text"].as_str().unwrap_or("").trim().to_string();

                        tracing::info!(
                            "{} transcription: {} chars",
                            self.provider_config.provider_name,
                            text.len()
                        );

                        return Ok(if text.is_empty() { None } else { Some(text) });
                    } else if status.as_u16() >= 500 && attempt < 2 {
                        let truncate_at = body
                            .char_indices()
                            .take_while(|&(i, _)| i < 200)
                            .last()
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(body.len());
                        tracing::warn!(
                            "{} server error {} (attempt {}/3): {}",
                            self.provider_config.provider_name,
                            status,
                            attempt + 1,
                            &body[..truncate_at]
                        );
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            1000 * 2u64.pow(attempt - 1),
                        ))
                        .await;
                        continue;
                    } else {
                        // Truncate at a valid UTF-8 char boundary to avoid panic on multi-byte chars
                        let truncate_at = body
                            .char_indices()
                            .take_while(|&(i, _)| i < 200)
                            .last()
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(body.len());
                        let sanitized = &body[..truncate_at];
                        tracing::error!(
                            "{} HTTP {}: {}",
                            self.provider_config.provider_name,
                            status,
                            sanitized
                        );
                        return Err(AppError::Api {
                            status: status.as_u16(),
                            body: sanitized.to_string(),
                        });
                    }
                }
                Err(e) if e.is_timeout() && attempt < 2 => {
                    tracing::warn!(
                        "{} timeout (attempt {}/3)",
                        self.provider_config.provider_name,
                        attempt + 1
                    );
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
    }

    fn name(&self) -> &str {
        &self.provider_config.provider_name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_allows_empty_api_key_when_not_required() {
        let mut provider = WhisperCompatProvider::new(WhisperCompatConfig {
            provider_name: "custom-whisper".to_string(),
            endpoint: "http://localhost:8000/v1/audio/transcriptions".to_string(),
            model: "test-model".to_string(),
            extra_fields: vec![],
            api_key_required: false,
        });

        let result = provider
            .connect(&SttConfig {
                api_key: String::new(),
                language: None,
                smart_format: true,
                sample_rate: 16000,
                resource_id: None,
                operation_id: None,
                managed_audio: None,
                provider_region: None,
            })
            .await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn recv_transcript_waits_for_file_based_provider() {
        let mut provider = WhisperCompatProvider::new(WhisperCompatConfig {
            provider_name: "test-whisper".to_string(),
            endpoint: "https://example.test/transcriptions".to_string(),
            model: "test-model".to_string(),
            extra_fields: vec![],
            api_key_required: true,
        });

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            provider.recv_transcript(),
        )
        .await;

        assert!(result.is_err());
    }
}
