//! Rewriting through each provider's native API (`complete_rewrite`, `providers.py:324-424`).
//!
//! No variant ever returns text that was cut off at the output limit: a partial rewrite typed
//! over a selection loses the rest of it.

use serde_json::{json, Map, Value};

use super::cloud::gemini_text;
use super::http::Http;
use super::urls::split;
use super::{
    auth_headers, model_url, ProviderConfig, ProviderError, ProviderId, RewriteRequest, Rewriter,
};

/// Avoid reserving the model's entire output capacity for a short rewrite (Ownkey PR #3: a
/// local server with a 4,096-token context rejected anything above this).
const COMPATIBLE_MAX_TOKENS: u32 = 1024;
const ANTHROPIC_MAX_TOKENS: u32 = 4096;

pub(crate) fn output_limit_error() -> ProviderError {
    ProviderError::provider("Rewrite reached the output limit. Try rewriting a shorter selection.")
}

pub(crate) struct CloudRewriter {
    id: ProviderId,
    api_key: String,
    endpoint: String,
    model: String,
    http: Http,
}

impl CloudRewriter {
    pub fn new(id: ProviderId, cfg: &ProviderConfig) -> CloudRewriter {
        CloudRewriter {
            id,
            api_key: cfg.api_key.clone(),
            endpoint: cfg.endpoint.trim().to_string(),
            model: cfg.model.clone(),
            http: Http::new(cfg.timeout, id.label()),
        }
    }

    fn post(&self, url: &str, body: &Value) -> Result<Value, ProviderError> {
        let headers = auth_headers(self.id.as_str(), &self.api_key);
        let bytes = serde_json::to_vec(body).unwrap_or_default();
        self.http
            .post(url, &headers, "application/json", &bytes)?
            .json(self.id.label())
    }

    fn uses_responses_api(&self) -> bool {
        matches!(self.id, ProviderId::OpenAi | ProviderId::Custom)
            && split(&self.endpoint)
                .path
                .trim_end_matches('/')
                .ends_with("/responses")
    }

    fn responses(&self, req: &RewriteRequest) -> Result<String, ProviderError> {
        let mut body = json!({
            "model": self.model,
            "instructions": req.system,
            "input": req.user,
            "store": false,
        });
        if let Some(max) = req.max_tokens {
            // Differs from Ownkey on purpose: an explicit budget is passed on instead of ignored.
            body["max_output_tokens"] = json!(max);
        }
        let payload = self.post(&self.endpoint, &body)?;
        match payload.get("status") {
            None | Some(Value::Null) => {}
            Some(Value::String(status)) if status.is_empty() || status == "completed" => {}
            Some(status) => {
                let status = status
                    .as_str()
                    .map_or_else(|| status.to_string(), str::to_string);
                return Err(ProviderError::provider(format!(
                    "Rewrite response is {status}. No partial text was inserted; try a shorter selection."
                )));
            }
        }
        let text: String = array(&payload, "output")
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
            .flat_map(|item| array(item, "content"))
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect();
        Ok(text.trim().to_string())
    }

    fn chat(&self, req: &RewriteRequest) -> Result<String, ProviderError> {
        let mut body = json!({
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
        });
        let max_tokens = match (req.max_tokens, self.id) {
            (Some(max), _) => Some(max),
            (None, ProviderId::OpenRouter | ProviderId::Custom) => Some(COMPATIBLE_MAX_TOKENS),
            (None, _) => None,
        };
        if let Some(max) = max_tokens {
            body["max_tokens"] = json!(max);
        }
        let payload = self.post(&self.endpoint, &body)?;
        if array(&payload, "choices")
            .any(|choice| choice.get("finish_reason").and_then(Value::as_str) == Some("length"))
        {
            return Err(output_limit_error());
        }
        let content = payload
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"));
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter(|part| {
                    matches!(
                        part.get("type").and_then(Value::as_str),
                        None | Some("text")
                    )
                })
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect(),
            _ => String::new(),
        };
        Ok(text.trim().to_string())
    }

    fn anthropic(&self, req: &RewriteRequest) -> Result<String, ProviderError> {
        let body = json!({
            "model": self.model,
            "max_tokens": req.max_tokens.unwrap_or(ANTHROPIC_MAX_TOKENS),
            "temperature": 0.2,
            "system": req.system,
            "messages": [{"role": "user", "content": req.user}],
        });
        let payload = self.post(&self.endpoint, &body)?;
        // Differs from Ownkey on purpose: Ownkey typed the partial text of a reply cut at max_tokens.
        if payload.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
            return Err(output_limit_error());
        }
        let text: String = array(&payload, "content")
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        Ok(text.trim().to_string())
    }

    fn gemini(&self, req: &RewriteRequest) -> Result<String, ProviderError> {
        let mut generation = Map::new();
        generation.insert("temperature".into(), json!(0.2));
        if let Some(max) = req.max_tokens {
            generation.insert("maxOutputTokens".into(), json!(max));
        }
        let body = json!({
            "system_instruction": {"parts": [{"text": req.system}]},
            "contents": [{"role": "user", "parts": [{"text": req.user}]}],
            "generationConfig": generation,
        });
        let payload = self.post(&model_url(&self.endpoint, &self.model), &body)?;
        gemini_text(&payload)
    }

    fn ollama(&self, req: &RewriteRequest) -> Result<String, ProviderError> {
        let mut options = Map::new();
        options.insert("temperature".into(), json!(0.2));
        if let Some(max) = req.max_tokens {
            options.insert("num_predict".into(), json!(max));
        }
        let body = json!({
            "model": self.model,
            "stream": false,
            "options": options,
            "messages": [
                {"role": "system", "content": req.system},
                {"role": "user", "content": req.user},
            ],
        });
        let payload = self.post(&self.endpoint, &body)?;
        // Differs from Ownkey on purpose: a reply that ran out of tokens is refused, not typed.
        if payload.get("done_reason").and_then(Value::as_str) == Some("length") {
            return Err(output_limit_error());
        }
        let text = payload
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        Ok(text.trim().to_string())
    }
}

impl Rewriter for CloudRewriter {
    fn rewrite(&self, req: &RewriteRequest) -> Result<String, ProviderError> {
        match self.id {
            ProviderId::OpenAi | ProviderId::Custom if self.uses_responses_api() => {
                self.responses(req)
            }
            ProviderId::Anthropic => self.anthropic(req),
            ProviderId::Google => self.gemini(req),
            ProviderId::Ollama => self.ollama(req),
            _ => self.chat(req),
        }
    }
}

fn array<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}
