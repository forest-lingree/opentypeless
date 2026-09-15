pub mod aliyun_qwen3_asr;
pub mod apple_speech;
pub mod assemblyai;
pub mod capabilities;
pub mod cloud;
pub mod config;
pub mod deepgram;
pub mod managed_audio;
pub mod volcengine;
pub mod whisper_compat;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

use whisper_compat::{WhisperCompatConfig, WhisperCompatProvider};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SttConfig {
    pub api_key: String,
    pub language: Option<String>,
    pub smart_format: bool,
    pub sample_rate: u32,
    pub resource_id: Option<String>,
    pub operation_id: Option<String>,
    pub managed_audio: Option<managed_audio::ManagedAudioEncodingConfig>,
    pub provider_region: Option<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            language: None,
            smart_format: true,
            sample_rate: 16000,
            resource_id: None,
            operation_id: None,
            managed_audio: None,
            provider_region: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum TranscriptEvent {
    Partial { text: String },
    Final { text: String, confidence: f32 },
    SpeechStarted,
    SpeechEnded,
    Error { message: String },
}

#[async_trait]
pub trait SttProvider: Send + Sync {
    async fn connect(&mut self, config: &SttConfig) -> Result<(), AppError>;
    async fn send_audio(&mut self, chunk: &[u8]) -> Result<(), AppError>;
    async fn recv_transcript(&mut self) -> Result<Option<TranscriptEvent>, AppError>;
    /// Disconnect and optionally return a final transcript (for file-based providers).
    async fn disconnect(&mut self) -> Result<Option<String>, AppError>;
    fn recording_limit_override_seconds(&self) -> Option<u32> {
        None
    }
    fn recording_limit_override_explanation_key(&self) -> Option<&'static str> {
        None
    }
    fn name(&self) -> &str;
}

pub fn create_provider(
    provider_name: &str,
    custom_whisper_config: Option<WhisperCompatConfig>,
    client: Option<reqwest::Client>,
) -> Result<Box<dyn SttProvider>, AppError> {
    match provider_name {
        "cloud" => {
            let api_base_url = crate::api_base_url();
            Ok(match client {
                Some(ref c) => Box::new(cloud::CloudSttProvider::with_client(
                    api_base_url,
                    c.clone(),
                )),
                None => Box::new(cloud::CloudSttProvider::new(api_base_url)),
            })
        }
        "assemblyai" => Ok(Box::new(assemblyai::AssemblyAiProvider::new())),
        "deepgram" => Ok(Box::new(deepgram::DeepgramProvider::new())),
        aliyun_qwen3_asr::ALIYUN_QWEN3_ASR_PROVIDER => {
            Ok(Box::new(aliyun_qwen3_asr::AliyunQwen3AsrProvider::new()))
        }
        apple_speech::APPLE_SPEECH_PROVIDER => {
            Ok(Box::new(apple_speech::AppleSpeechProvider::new()))
        }
        volcengine::VOLCENGINE_DOUBAO_PROVIDER => {
            Ok(Box::new(volcengine::VolcengineDoubaoProvider::new()))
        }
        config::CUSTOM_WHISPER_PROVIDER | crate::azure_openai::PROVIDER_ID => {
            let wc = custom_whisper_config.ok_or_else(|| {
                AppError::Config(if provider_name == crate::azure_openai::PROVIDER_ID {
                    "Azure OpenAI requires resource endpoint, deployment, and API version"
                        .to_string()
                } else {
                    "Local / Custom Whisper is missing base URL or model".to_string()
                })
            })?;
            if wc.provider_name != provider_name {
                return Err(AppError::Config(
                    "STT provider configuration does not match the selected provider".to_string(),
                ));
            }
            Ok(match client {
                Some(ref c) => Box::new(WhisperCompatProvider::with_client(wc, c.clone())),
                None => Box::new(WhisperCompatProvider::new(wc)),
            })
        }
        name => {
            let wc = config::resolve_whisper_config(name, None, None, None)
                .map_err(AppError::Config)?
                .ok_or_else(|| AppError::Config(format!("Unknown STT provider: {}", name)))?;
            Ok(match client {
                Some(ref c) => Box::new(WhisperCompatProvider::with_client(wc, c.clone())),
                None => Box::new(WhisperCompatProvider::new(wc)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn azure_factory_requires_and_accepts_explicit_config() {
        let error = create_provider("azure-openai", None, None)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("Azure OpenAI"));
        let cfg = whisper_compat::WhisperCompatConfig {
            provider_name: "azure-openai".to_string(),
            endpoint: "https://resource.example/openai/deployments/speech/audio/transcriptions?api-version=2024-10-21".to_string(),
            model: "speech".to_string(),
            extra_fields: vec![],
            api_key_required: true,
        };
        let provider = create_provider("azure-openai", Some(cfg), None).unwrap();
        assert_eq!(provider.name(), "azure-openai");
    }

    #[test]
    fn custom_whisper_requires_explicit_config() {
        let result = create_provider(config::CUSTOM_WHISPER_PROVIDER, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn custom_whisper_uses_explicit_config() {
        let cfg = config::build_custom_whisper_config(
            "http://localhost:8000/v1",
            "Systran/faster-whisper-large-v3",
        )
        .unwrap();

        let provider = create_provider(config::CUSTOM_WHISPER_PROVIDER, Some(cfg), None).unwrap();
        assert_eq!(provider.name(), config::CUSTOM_WHISPER_PROVIDER);
    }

    #[test]
    fn creates_volcengine_doubao_realtime_provider() {
        let provider = create_provider("volcengine-doubao", None, None).unwrap();
        assert_eq!(provider.name(), "Volcengine Doubao Realtime ASR");
    }

    #[test]
    fn creates_aliyun_qwen3_realtime_provider() {
        let provider = create_provider("aliyun-qwen3-asr", None, None).unwrap();
        assert_eq!(provider.name(), "Aliyun Qwen3 Realtime ASR");
    }

    #[test]
    fn creates_apple_speech_builtin_local_provider() {
        let provider = create_provider("apple-speech", None, None).unwrap();
        assert_eq!(provider.name(), "Apple Speech");
    }

    #[test]
    fn unknown_stt_provider_returns_error() {
        let result = create_provider("not-a-provider", None, None);
        assert!(result.is_err());
    }
}
