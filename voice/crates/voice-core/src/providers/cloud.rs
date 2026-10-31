//! Cloud transcription (`transcribe_audio`, `providers.py:242-321`).

use base64::Engine as _;
use serde_json::{json, Value};

use super::http::Http;
use super::multipart::Multipart;
use super::{
    auth_headers, model_url, wav_bytes, Hints, ProviderConfig, ProviderError, ProviderId,
    Recognized, SpeechToText,
};

const GEMINI_INSTRUCTION: &str =
    "Transcribe the speech in this audio exactly. Return only the transcript, without timestamps, labels, or commentary.";

pub(crate) struct CloudSpeech {
    id: ProviderId,
    api_key: String,
    endpoint: String,
    model: String,
    http: Http,
}

impl CloudSpeech {
    pub fn new(id: ProviderId, cfg: &ProviderConfig) -> CloudSpeech {
        CloudSpeech {
            id,
            api_key: cfg.api_key.clone(),
            endpoint: cfg.endpoint.trim().to_string(),
            model: cfg.model.clone(),
            http: Http::new(cfg.timeout, id.label()),
        }
    }

    fn multipart(
        &self,
        wav: &[u8],
        language: Option<&str>,
        vocabulary: &[String],
    ) -> Result<Recognized, ProviderError> {
        let mut form = Multipart::new();
        // The model goes out as typed, as Ownkey sent it.
        form.text("model", &self.model);
        if let Some(language) = language {
            form.text("language", language);
        }
        if !vocabulary.is_empty() {
            if self.id == ProviderId::Mistral {
                // Mistral takes the dictionary as one repeated field per term.
                for term in vocabulary {
                    form.text("context_bias", term);
                }
            } else {
                form.text("prompt", &vocabulary.join(", "));
            }
        }
        form.file("file", "audio.wav", "audio/wav", wav);
        let (content_type, body) = form.finish();
        let headers = auth_headers(self.id.as_str(), &self.api_key);
        let reply = self
            .http
            .post(&self.endpoint, &headers, &content_type, &body)?;
        let payload = reply.json(self.id.label())?;
        Ok(Recognized {
            text: text_field(payload.get("text")),
            language: payload
                .get("language")
                .and_then(Value::as_str)
                .filter(|code| !code.is_empty())
                .map(str::to_string),
        })
    }

    fn gemini(
        &self,
        wav: &[u8],
        language: Option<&str>,
        vocabulary: &[String],
    ) -> Result<Recognized, ProviderError> {
        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [
                    {"text": gemini_instruction(language, vocabulary)},
                    {"inline_data": {"mime_type": "audio/wav", "data": base64::engine::general_purpose::STANDARD.encode(wav)}},
                ],
            }],
            "generationConfig": {"temperature": 0},
        });
        let headers = auth_headers(self.id.as_str(), &self.api_key);
        let url = model_url(&self.endpoint, &self.model);
        let reply = self.http.post(
            &url,
            &headers,
            "application/json",
            &serde_json::to_vec(&body).unwrap_or_default(),
        )?;
        let payload = reply.json(self.id.label())?;
        Ok(Recognized {
            text: gemini_text(&payload)?,
            language: None,
        })
    }
}

impl SpeechToText for CloudSpeech {
    fn transcribe(&self, pcm: &[i16], hints: &Hints) -> Result<Recognized, ProviderError> {
        let vocabulary: Vec<String> = hints
            .vocabulary
            .iter()
            .map(|term| term.trim().to_string())
            .filter(|term| !term.is_empty())
            .collect();
        let language = hints
            .language
            .as_deref()
            .map(str::trim)
            .filter(|code| !code.is_empty() && !code.eq_ignore_ascii_case("auto"));
        let wav = wav_bytes(pcm, 16_000);
        match self.id {
            ProviderId::Google => self.gemini(&wav, language, &vocabulary),
            _ => self.multipart(&wav, language, &vocabulary),
        }
    }
}

/// The Gemini instruction: the fixed sentence, the language sentence and the dictionary.
pub(crate) fn gemini_instruction(language: Option<&str>, vocabulary: &[String]) -> String {
    let mut text = GEMINI_INSTRUCTION.to_string();
    match language {
        Some(code) => text.push_str(&format!(" The expected language is {code}.")),
        None => text.push_str(" Detect the language automatically."),
    }
    if !vocabulary.is_empty() {
        text.push_str(&format!(
            " Expected names and terms: {}.",
            vocabulary.join(", ")
        ));
    }
    text
}

/// Text of `candidates[0].content.parts`, refusing a reply cut off at the output limit.
pub(crate) fn gemini_text(payload: &Value) -> Result<String, ProviderError> {
    let candidate = payload.get("candidates").and_then(|c| c.get(0));
    // Differs from Ownkey on purpose: Ownkey returned whatever Gemini wrote before its limit.
    if candidate
        .and_then(|c| c.get("finishReason"))
        .and_then(Value::as_str)
        == Some("MAX_TOKENS")
    {
        return Err(super::rewrite::output_limit_error());
    }
    let parts = candidate
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array);
    let text: String = parts
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    Ok(text.trim().to_string())
}

/// A `text` field as a trimmed string.
fn text_field(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        // Differs from Ownkey on purpose: Python turned `"text": null` into the word "None".
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}
