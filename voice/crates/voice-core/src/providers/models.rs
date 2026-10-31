//! Model lists for the Refresh button in Settings (`list_available_models`, `providers.py:464-526`).

use serde_json::Value;

use super::http::Http;
use super::{
    auth_headers, models_endpoint, normalize_provider, Activity, ProviderConfig, ProviderError,
    ProviderId, MODELS_TIMEOUT, ORUKEET_MODEL_ID,
};

/// The models a provider offers, deduplicated and sorted case-insensitively. Only `provider`,
/// `api_key` and `endpoint` of `cfg` are used; the call waits at most 15 seconds.
pub fn list_models(activity: Activity, cfg: &ProviderConfig) -> Result<Vec<String>, ProviderError> {
    // Differs from Ownkey on purpose: an unknown provider is an error, not silently Mistral.
    let Some(id) = ProviderId::parse(&normalize_provider(&cfg.provider, "")) else {
        return Err(ProviderError::config(
            "Choose a provider in Settings first.",
        ));
    };
    if id == ProviderId::Orukeet {
        return match activity {
            Activity::Audio => Ok(vec![ORUKEET_MODEL_ID.to_string()]),
            Activity::Rewrite => Err(ProviderError::config("Orukeet does not support rewriting.")),
        };
    }
    match activity {
        Activity::Audio if !id.supports_audio() => {
            return Err(ProviderError::config(format!(
                "{} does not provide a supported audio transcription API.",
                id.label()
            )))
        }
        Activity::Rewrite if !id.supports_rewrite() => {
            return Err(ProviderError::config(
                "This provider does not support rewriting.",
            ))
        }
        _ => {}
    }

    let url = models_endpoint(id.as_str(), &cfg.endpoint);
    let query: &[(&str, &str)] = match id {
        ProviderId::Anthropic => &[("limit", "1000")],
        ProviderId::Google => &[("pageSize", "1000")],
        _ => &[],
    };
    let http = Http::new(cfg.timeout.min(MODELS_TIMEOUT), id.label());
    let payload = http
        .get(&url, &auth_headers(id.as_str(), &cfg.api_key), query)?
        .json(id.label())?;
    Ok(sorted_unique(parse_models(id, &payload)))
}

fn parse_models(id: ProviderId, payload: &Value) -> Vec<String> {
    let items = |key: &str| -> Vec<Value> {
        payload
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    match id {
        ProviderId::Google => items("models")
            .iter()
            .filter(|item| {
                let supported = item
                    .get("supportedGenerationMethods")
                    .or_else(|| item.get("supportedActions"))
                    .and_then(Value::as_array);
                supported.is_none_or(|methods| {
                    methods.is_empty()
                        || methods
                            .iter()
                            .any(|m| m.as_str() == Some("generateContent"))
                })
            })
            .filter_map(|item| {
                let id =
                    truthy_str(item.get("baseModelId")).or_else(|| truthy_str(item.get("name")))?;
                Some(id.strip_prefix("models/").unwrap_or(id).to_string())
            })
            .collect(),
        ProviderId::Ollama => items("models")
            .iter()
            .filter_map(|item| {
                truthy_str(item.get("name")).or_else(|| truthy_str(item.get("model")))
            })
            .map(str::to_string)
            .collect(),
        _ => {
            let list = match payload {
                Value::Array(list) => list.clone(),
                _ => items("data"),
            };
            list.iter()
                .filter_map(|item| item.as_object()?.get("id"))
                .filter_map(|value| match value {
                    Value::String(id) => Some(id.clone()),
                    Value::Null => None,
                    other => Some(other.to_string()),
                })
                .collect()
        }
    }
}

fn truthy_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// Stripped, without empties or exact duplicates, sorted by lowercase and then by the original
/// text so ties have a fixed order.
fn sorted_unique(models: Vec<String>) -> Vec<String> {
    let mut models: Vec<String> = models
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect();
    models.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    models.dedup();
    models
}
