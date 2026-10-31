//! Provider request shapes, parsing and errors, against a local fake server. No real keys and
//! no provider is ever contacted. Vectors from ownkey-providers.md sections 2-7.

mod support;

use std::time::Duration;

use base64::Engine as _;
use serde_json::json;
use support::{closed_port, FakeServer, Reply, TempDir};
use voice_core::local::{LocalEngine, LocalOptions};
use voice_core::providers::{
    auth_headers, default_endpoint, describe_api_error, endpoint_reachable, list_models, model_url,
    models_endpoint, normalize_provider, provider_endpoints, provider_from_endpoint,
    provider_label, provider_requires_key, rewriter, speech_to_text, wav_bytes, Activity,
    ErrorKind, Hints, ProviderConfig, ProviderError, Purpose, RewriteRequest, SpeechToText,
    AUDIO_PROVIDER_IDS, PRESETS, REWRITE_PROVIDER_IDS,
};
use voice_core::ModelRegistry;

fn cfg(provider: &str, key: &str, endpoint: &str, model: &str) -> ProviderConfig {
    ProviderConfig {
        provider: provider.into(),
        api_key: key.into(),
        endpoint: endpoint.into(),
        model: model.into(),
        timeout: Duration::from_secs(5),
        purpose: Purpose::Dictation,
    }
}

fn pcm() -> Vec<i16> {
    (0..1600).map(|i| ((i % 64) as i16 - 32) * 100).collect()
}

fn hints(vocabulary: &[&str], language: Option<&str>) -> Hints {
    Hints {
        vocabulary: vocabulary.iter().map(|term| term.to_string()).collect(),
        language: language.map(str::to_string),
    }
}

/// A local engine that never finds a model; cloud providers don't use it.
fn idle_engine(dir: &TempDir) -> LocalEngine {
    LocalEngine::new(LocalOptions::new(
        ModelRegistry::new(dir.path()).with_ownkey_models(None),
    ))
}

fn stt(config: &ProviderConfig) -> Box<dyn SpeechToText> {
    let dir = TempDir::new("stt");
    match speech_to_text(config, &idle_engine(&dir)) {
        Ok(stt) => stt,
        Err(error) => panic!("speech_to_text failed: {error}"),
    }
}

fn stt_error(config: &ProviderConfig) -> ProviderError {
    let dir = TempDir::new("stt-error");
    speech_to_text(config, &idle_engine(&dir))
        .err()
        .expect("speech_to_text should fail")
}

fn rewrite(config: &ProviderConfig, system: &str, user: &str) -> Result<String, ProviderError> {
    rewriter(config)?.rewrite(&RewriteRequest {
        system: system.into(),
        user: user.into(),
        max_tokens: None,
    })
}

fn chat_reply(text: &str) -> Reply {
    Reply::json(200, json!({"choices": [{"message": {"content": text}}]}))
}

#[test]
fn registry_order_and_presets() {
    assert_eq!(
        AUDIO_PROVIDER_IDS,
        ["openai", "google", "mistral", "custom", "orukeet"]
    );
    assert_eq!(
        REWRITE_PROVIDER_IDS,
        [
            "openai",
            "anthropic",
            "google",
            "mistral",
            "ollama",
            "openrouter",
            "custom"
        ]
    );
    let labels: Vec<&str> = PRESETS.iter().map(|preset| preset.label).collect();
    assert_eq!(
        labels,
        [
            "OpenAI",
            "Anthropic",
            "Google",
            "Mistral",
            "Ollama",
            "OpenRouter",
            "Custom (OpenAI-compatible)",
            "Local (Orukeet)"
        ]
    );
    assert_eq!(
        provider_endpoints("ollama", Activity::Rewrite),
        [
            "http://localhost:11434/api/chat",
            "https://ollama.com/api/chat"
        ]
    );
    assert_eq!(
        provider_endpoints("openai", Activity::Rewrite),
        [
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/chat/completions"
        ]
    );
    assert_eq!(default_endpoint("anthropic", Activity::Audio), "");
    assert_eq!(
        default_endpoint("mistral", Activity::Audio),
        "https://api.mistral.ai/v1/audio/transcriptions"
    );
    assert_eq!(provider_label("google"), "Google");
}

#[test]
fn normalize_provider_vectors() {
    let cases = [
        ("OpenAI", "openai", "openai"),
        ("openai ", "openai", "openai"),
        (" Custom (OpenAI-compatible)", "custom", "custom"),
        ("Local (Orukeet)", "orukeet", "orukeet"),
        ("google gemini", "mistral", ""),
        ("", "mistral", ""),
        ("foo", "mistral", ""),
    ];
    for (input, with_default, with_empty) in cases {
        assert_eq!(
            normalize_provider(input, "mistral"),
            with_default,
            "{input:?}"
        );
        assert_eq!(normalize_provider(input, ""), with_empty, "{input:?}");
    }
}

#[test]
fn provider_from_endpoint_vectors() {
    let cases = [
        ("https://api.openai.com/v1/audio/transcriptions", "openai"),
        (
            "https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=1",
            "openai",
        ),
        ("https://api.anthropic.com/v1/messages", "anthropic"),
        (
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            "google",
        ),
        ("https://api.mistral.ai/v1/chat/completions", "mistral"),
        (
            "https://openrouter.ai/api/v1/chat/completions",
            "openrouter",
        ),
        ("http://localhost:1234/v1/chat/completions", "custom"),
        ("http://127.0.0.1:8080/v1/responses", "custom"),
        ("https://example.test/proxy/v1/responses", "custom"),
        ("http://localhost:11434/api/chat", "ollama"),
        ("https://ollama.com/api/chat", "ollama"),
        ("http://my-ollama-box:11434/api/chat", "ollama"),
        ("http://[::1]:11434/api/chat", "ollama"),
        ("https://example.test/whatever", "mistral"),
        ("", "mistral"),
    ];
    for (endpoint, expected) in cases {
        assert_eq!(
            provider_from_endpoint(endpoint, "mistral"),
            expected,
            "{endpoint}"
        );
    }
}

#[test]
fn which_providers_need_a_key() {
    assert!(!provider_requires_key(
        "ollama",
        "http://localhost:11434/api/chat"
    ));
    assert!(provider_requires_key(
        "ollama",
        "https://ollama.com/api/chat"
    ));
    assert!(!provider_requires_key("ollama", ""));
    assert!(!provider_requires_key(
        "custom",
        "https://example.test/v1/chat/completions"
    ));
    assert!(!provider_requires_key("orukeet", "https://example.invalid"));
    assert!(provider_requires_key("openai", ""));
    assert!(provider_requires_key("foo", ""));
}

#[test]
fn auth_header_vectors() {
    assert_eq!(
        auth_headers("anthropic", " k "),
        vec![
            ("anthropic-version", "2023-06-01".to_string()),
            ("x-api-key", "k".to_string())
        ]
    );
    assert_eq!(
        auth_headers("anthropic", ""),
        vec![("anthropic-version", "2023-06-01".to_string())]
    );
    assert_eq!(
        auth_headers("google", "k"),
        vec![("x-goog-api-key", "k".to_string())]
    );
    assert!(auth_headers("google", "  ").is_empty());
    for provider in [
        "openai",
        "mistral",
        "ollama",
        "openrouter",
        "custom",
        "unknown",
    ] {
        assert_eq!(
            auth_headers(provider, "secret"),
            vec![("Authorization", "Bearer secret".to_string())]
        );
        assert!(auth_headers(provider, "").is_empty());
    }
}

#[test]
fn gemini_model_url_vectors() {
    assert_eq!(
        model_url(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            "models/gemini-2.5-flash"
        ),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
    assert_eq!(
        model_url("https://generativelanguage.googleapis.com/v1beta/", "gemini x/y~z:1"),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini%20x%2Fy~z:1:generateContent"
    );
    // Ownkey's quirk for an endpoint that already names a model, kept: Settings offers the
    // {model} form only.
    assert_eq!(
        model_url("https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent", "other"),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent/models/other:generateContent"
    );
}

#[test]
fn models_endpoint_vectors() {
    let cases = [
        (
            "openai",
            "https://api.openai.com/v1/audio/transcriptions",
            "https://api.openai.com/v1/models",
        ),
        (
            "openai",
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/models",
        ),
        (
            "openai",
            "https://api.openai.com/v1",
            "https://api.openai.com/v1/models",
        ),
        (
            "openai",
            "https://api.openai.com/v1/",
            "https://api.openai.com/v1/models",
        ),
        (
            "anthropic",
            "https://api.anthropic.com/v1/messages",
            "https://api.anthropic.com/v1/models",
        ),
        (
            "google",
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            "https://generativelanguage.googleapis.com/v1beta/models",
        ),
        (
            "google",
            "https://generativelanguage.googleapis.com/v1beta",
            "https://generativelanguage.googleapis.com/v1beta/models",
        ),
        (
            "mistral",
            "https://api.mistral.ai/v1/chat/completions",
            "https://api.mistral.ai/v1/models",
        ),
        (
            "mistral",
            "https://api.mistral.ai/v1/audio/transcriptions",
            "https://api.mistral.ai/v1/models",
        ),
        (
            "ollama",
            "https://ollama.com/api/chat",
            "https://ollama.com/api/tags",
        ),
        (
            "ollama",
            "http://localhost:11434/api/chat",
            "http://localhost:11434/api/tags",
        ),
        (
            "ollama",
            "http://localhost:11434",
            "http://localhost:11434/api/tags",
        ),
        (
            "ollama",
            "http://localhost:11434/v1/chat/completions",
            "http://localhost:11434/v1/chat/completions/api/tags",
        ),
        (
            "openrouter",
            "https://openrouter.ai/api/v1/chat/completions",
            "https://openrouter.ai/api/v1/models",
        ),
        (
            "custom",
            "http://localhost:1234/v1/chat/completions",
            "http://localhost:1234/v1/models",
        ),
        (
            "custom",
            "https://example.test/proxy/v2/chat/completions",
            "https://example.test/proxy/v2/models",
        ),
        (
            "custom",
            "https://example.test/proxy/v2/chat/completions?x=1#f",
            "https://example.test/proxy/v2/models",
        ),
        (
            "google",
            "",
            "https://generativelanguage.googleapis.com/v1beta/models",
        ),
        ("anthropic", "", "https://api.anthropic.com/v1/models"),
        ("orukeet", "", ""),
    ];
    for (provider, endpoint, expected) in cases {
        assert_eq!(
            models_endpoint(provider, endpoint),
            expected,
            "{provider} {endpoint}"
        );
    }
}

#[test]
fn describe_api_error_vectors() {
    let age = r#"{"error":{"message":"This model requires 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences."}}"#;
    let message = describe_api_error(Some(403), Some("Forbidden"), age);
    assert!(message.contains("API error 403"));
    assert!(message.contains("18+ age confirmation"));
    assert!(message.contains("https://openrouter.ai/settings/preferences"));
    assert!(
        describe_api_error(Some(502), None, "Upstream temporarily unavailable")
            .contains("Upstream temporarily unavailable")
    );
    assert!(describe_api_error(None, None, "").contains("No response"));
    let cases = [
        (
            401,
            r#"{"error":{"message":"Invalid  API\nkey"}}"#,
            "API error 401: Invalid API key",
        ),
        (
            400,
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#,
            "API error 400: bad",
        ),
        (
            404,
            r#"{"error":"model 'x' not found"}"#,
            "API error 404: model 'x' not found",
        ),
        (
            422,
            r#"{"object":"error","message":"Mistral says no","type":"invalid_request_error"}"#,
            "API error 422: Mistral says no",
        ),
        (
            422,
            r#"{"detail": "fastapi detail"}"#,
            r#"API error 422: {"detail": "fastapi detail"}"#,
        ),
        (
            400,
            r#"["list", "payload"]"#,
            r#"API error 400: ["list", "payload"]"#,
        ),
        (
            400,
            r#"{"error": {"code": 400}}"#,
            r#"API error 400: {"error": {"code": 400}}"#,
        ),
    ];
    for (status, body, expected) in cases {
        assert_eq!(
            describe_api_error(Some(status), None, body),
            expected,
            "{body}"
        );
    }
    assert_eq!(
        describe_api_error(Some(500), Some("Internal Server Error"), ""),
        "API error 500: Internal Server Error"
    );
    assert_eq!(
        describe_api_error(Some(500), None, ""),
        "API error 500: Request rejected"
    );
    let long = format!(r#"{{"error":{{"message":"{}"}}}}"#, "x".repeat(500));
    assert_eq!(
        describe_api_error(Some(400), None, &long).chars().count(),
        235
    );
}

#[test]
fn custom_transcription_has_optional_auth_and_multipart() {
    let server = FakeServer::always(Reply::json(200, json!({"text": " hello "})));
    let audio = pcm();
    let config = cfg(
        "custom",
        "",
        &server.url("/v1/audio/transcriptions"),
        "whisper",
    );
    let result = stt(&config)
        .transcribe(&audio, &hints(&[], Some("nl")))
        .unwrap();
    assert_eq!(result.text, "hello");
    let request = server.only_request();
    assert_eq!(request.method, "POST");
    assert_eq!(request.path(), "/v1/audio/transcriptions");
    assert!(request.header("authorization").is_none());
    assert_eq!(
        request.form_fields(),
        vec![
            ("model".to_string(), "whisper".to_string()),
            ("language".to_string(), "nl".to_string())
        ]
    );
    let file = request
        .parts()
        .into_iter()
        .find(|part| part.name == "file")
        .expect("file part");
    assert_eq!(file.filename.as_deref(), Some("audio.wav"));
    assert_eq!(file.content_type.as_deref(), Some("audio/wav"));
    assert_eq!(file.data, wav_bytes(&audio, 16_000));
    assert!(!provider_requires_key("custom", ""));
}

#[test]
fn openai_style_endpoints_send_terms_as_prompt() {
    let server = FakeServer::always(Reply::json(200, json!({"text": "ok"})));
    let config = cfg(
        "openai",
        "secret",
        &server.url("/v1/audio/transcriptions"),
        "whisper-1",
    );
    stt(&config)
        .transcribe(&pcm(), &hints(&["Ownkey", " Orukeet "], Some("auto")))
        .unwrap();
    let request = server.only_request();
    assert_eq!(request.header("authorization"), Some("Bearer secret"));
    assert_eq!(
        request.form_fields(),
        vec![
            ("model".to_string(), "whisper-1".to_string()),
            ("prompt".to_string(), "Ownkey, Orukeet".to_string())
        ]
    );
}

#[test]
fn mistral_sends_terms_as_repeated_context_bias() {
    let server = FakeServer::always(Reply::json(200, json!({"text": "hoi", "language": "nl"})));
    let config = cfg(
        "mistral",
        "key",
        &server.url("/v1/audio/transcriptions"),
        "voxtral-mini-latest",
    );
    let result = stt(&config)
        .transcribe(&pcm(), &hints(&["Ownkey", "Orukeet"], Some("nl")))
        .unwrap();
    assert_eq!(result.text, "hoi");
    assert_eq!(result.language.as_deref(), Some("nl"));
    let request = server.only_request();
    assert_eq!(
        request.form_fields(),
        vec![
            ("model".to_string(), "voxtral-mini-latest".to_string()),
            ("language".to_string(), "nl".to_string()),
            ("context_bias".to_string(), "Ownkey".to_string()),
            ("context_bias".to_string(), "Orukeet".to_string()),
        ]
    );
    // The wire form, part by part, as Python's requests wrote it.
    let content_type = request.header("content-type").unwrap();
    let boundary = content_type
        .strip_prefix("multipart/form-data; boundary=")
        .unwrap();
    let expected_start = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nvoxtral-mini-latest\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nnl\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"context_bias\"\r\n\r\nOwnkey\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"context_bias\"\r\n\r\nOrukeet\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF"
    );
    assert!(request.body.starts_with(expected_start.as_bytes()));
    assert!(request
        .body
        .ends_with(format!("\r\n--{boundary}--\r\n").as_bytes()));
}

#[test]
fn empty_vocabulary_changes_nothing() {
    let server = FakeServer::always(Reply::json(200, json!({"text": "x"})));
    let config = cfg(
        "custom",
        "",
        &server.url("/v1/audio/transcriptions"),
        "whisper",
    );
    stt(&config)
        .transcribe(&pcm(), &hints(&[], Some("nl")))
        .unwrap();
    assert_eq!(
        server.only_request().form_fields(),
        vec![
            ("model".to_string(), "whisper".to_string()),
            ("language".to_string(), "nl".to_string())
        ]
    );
}

#[test]
fn null_transcript_is_empty() {
    // Ownkey turned "text": null into the word "None".
    let server = FakeServer::always(Reply::json(200, json!({"text": null})));
    let config = cfg(
        "custom",
        "",
        &server.url("/v1/audio/transcriptions"),
        "whisper",
    );
    assert_eq!(
        stt(&config)
            .transcribe(&pcm(), &Hints::default())
            .unwrap()
            .text,
        ""
    );
}

#[test]
fn google_transcription_uses_inline_wav_and_the_model_url() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"candidates": [{"content": {"parts": [{"text": "hello "}, "skip me", {"text": "world"}]}}]}),
    ));
    let audio = pcm();
    let config = cfg(
        "google",
        "gemini-key",
        &server.url("/v1beta/models/{model}:generateContent"),
        "gemini-test",
    );
    let result = stt(&config)
        .transcribe(&audio, &hints(&["Ownkey", "Bart"], Some("en")))
        .unwrap();
    assert_eq!(result.text, "hello world");
    let request = server.only_request();
    assert_eq!(request.path(), "/v1beta/models/gemini-test:generateContent");
    assert_eq!(request.header("x-goog-api-key"), Some("gemini-key"));
    assert!(request.header("authorization").is_none());
    let body = request.json();
    assert_eq!(body["contents"][0]["role"], "user");
    assert_eq!(
        body["contents"][0]["parts"][0]["text"],
        "Transcribe the speech in this audio exactly. Return only the transcript, without timestamps, labels, or commentary. The expected language is en. Expected names and terms: Ownkey, Bart."
    );
    let inline = &body["contents"][0]["parts"][1]["inline_data"];
    assert_eq!(inline["mime_type"], "audio/wav");
    assert_eq!(
        inline["data"].as_str().unwrap(),
        base64::engine::general_purpose::STANDARD.encode(wav_bytes(&audio, 16_000))
    );
    assert_eq!(body["generationConfig"], json!({"temperature": 0}));
}

#[test]
fn google_transcription_detects_language_without_terms() {
    let server = FakeServer::always(Reply::json(200, json!({"candidates": []})));
    let config = cfg(
        "google",
        "k",
        &server.url("/v1beta/models/{model}:generateContent"),
        "gemini-test",
    );
    assert_eq!(
        stt(&config)
            .transcribe(&pcm(), &hints(&[], None))
            .unwrap()
            .text,
        ""
    );
    assert_eq!(
        server.only_request().json()["contents"][0]["parts"][0]["text"],
        "Transcribe the speech in this audio exactly. Return only the transcript, without timestamps, labels, or commentary. Detect the language automatically."
    );
}

#[test]
fn orukeet_never_posts_audio_and_never_falls_back() {
    let server = FakeServer::always(Reply::json(200, json!({"text": "cloud"})));
    let dir = TempDir::new("orukeet-route");
    let engine = idle_engine(&dir);
    let config = cfg(
        "orukeet",
        "key",
        &server.url("/v1/audio/transcriptions"),
        "orukeet-onnx-int8",
    );
    let stt = match speech_to_text(&config, &engine) {
        Ok(stt) => stt,
        Err(error) => panic!("{error}"),
    };
    let error = stt
        .transcribe(&pcm(), &hints(&["Bart"], Some("ja")))
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::LocalMissingModel);
    assert_eq!(
        error.message,
        "Model missing. Download it in Settings > Transcription."
    );
    assert!(server.requests().is_empty());
    assert_eq!(
        rewriter(&cfg("orukeet", "", "", "x"))
            .err()
            .unwrap()
            .message,
        "This provider does not support rewriting."
    );
}

#[test]
fn transcription_setup_errors() {
    let error = stt_error(&cfg(
        "anthropic",
        "k",
        "https://api.anthropic.com/v1/messages",
        "m",
    ));
    assert_eq!(error.kind, ErrorKind::Config);
    assert_eq!(
        error.message,
        "Anthropic does not provide a supported audio transcription API."
    );
    // An unknown provider is an error, not Mistral.
    assert_eq!(
        stt_error(&cfg("foo", "k", "https://example.test", "m")).kind,
        ErrorKind::Config
    );
    assert_eq!(
        stt_error(&cfg(
            "openai",
            "k",
            "https://api.openai.com/v1/audio/transcriptions",
            " "
        ))
        .message,
        "Select an audio model in Settings."
    );
    let missing_key = stt_error(&cfg(
        "openai",
        " ",
        "https://api.openai.com/v1/audio/transcriptions",
        "whisper-1",
    ));
    assert_eq!(missing_key.kind, ErrorKind::Auth);
    assert_eq!(
        missing_key.message,
        "No audio API key set. Open Settings > Transcription and add a key."
    );
    let meeting = ProviderConfig {
        purpose: Purpose::Meetings,
        ..cfg(
            "mistral",
            "",
            "https://api.mistral.ai/v1/audio/transcriptions",
            "voxtral-mini-latest",
        )
    };
    assert_eq!(
        stt_error(&meeting).message,
        "No API key set for meeting transcription. Open Settings > Meetings > Transcription and add a key."
    );
}

#[test]
fn small_context_server_accepts_the_rewrite_budget() {
    let server = FakeServer::start(|request| {
        let budget = request.json()["max_tokens"].as_u64().unwrap_or(u64::MAX);
        if 3072 + budget > 4096 {
            Reply::json(
                400,
                json!({"error": {"message": "context length exceeded"}}),
            )
        } else {
            chat_reply("edited")
        }
    });
    let config = cfg(
        "custom",
        "",
        &server.url("/v1/chat/completions"),
        "small-context-model",
    );
    assert_eq!(rewrite(&config, "edit", "source text").unwrap(), "edited");
}

#[test]
fn compatible_rewrites_keep_url_model_and_auth() {
    for (provider, path, key) in [
        ("openrouter", "/api/v1/chat/completions", "router-key"),
        ("custom", "/v1/chat/completions", ""),
        ("custom", "/proxy/v2/chat/completions", "custom-key"),
    ] {
        let server = FakeServer::always(chat_reply("edited"));
        let config = cfg(provider, key, &server.url(path), "vendor/model");
        assert_eq!(rewrite(&config, "edit", "hello").unwrap(), "edited");
        let request = server.only_request();
        assert_eq!(request.path(), path);
        assert_eq!(request.header("content-type"), Some("application/json"));
        let body = request.json();
        assert_eq!(body["model"], "vendor/model");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["temperature"], 0.2);
        assert_eq!(
            body["messages"],
            json!([{"role": "system", "content": "edit"}, {"role": "user", "content": "hello"}])
        );
        match key {
            "" => assert!(request.header("authorization").is_none()),
            key => assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {key}").as_str())
            ),
        }
        assert_eq!(
            models_endpoint(provider, &server.url(path)),
            server.url(&path.replace("/chat/completions", "/models"))
        );
    }
}

#[test]
fn openai_and_mistral_chat_send_no_token_budget() {
    for provider in ["openai", "mistral"] {
        let server = FakeServer::always(chat_reply("ok"));
        let config = cfg(provider, "k", &server.url("/v1/chat/completions"), "m");
        rewrite(&config, "s", "u").unwrap();
        assert!(
            server.only_request().json().get("max_tokens").is_none(),
            "{provider}"
        );
    }
}

#[test]
fn chat_output_limit_is_never_returned_as_text() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"choices": [{"finish_reason": "length", "message": {"content": "partial"}}]}),
    ));
    let config = cfg(
        "openrouter",
        "k",
        &server.url("/api/v1/chat/completions"),
        "model",
    );
    let error = rewrite(&config, "edit", "long text").unwrap_err();
    assert_eq!(error.kind, ErrorKind::Provider);
    assert!(error.message.contains("output limit"));
}

#[test]
fn chat_content_parts_are_joined() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"choices": [{"message": {"content": [{"type": "text", "text": "a"}, {"text": "b"}, {"type": "image", "text": "x"}, "c"]}}]}),
    ));
    let config = cfg("custom", "", &server.url("/v1/chat/completions"), "m");
    assert_eq!(rewrite(&config, "s", "u").unwrap(), "ab");
}

#[test]
fn responses_api_shape() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"status": "completed", "output": [
            {"type": "reasoning", "content": [{"type": "output_text", "text": "hidden"}]},
            {"type": "message", "content": [{"type": "output_text", "text": "rewritten "}, {"type": "refusal", "text": "no"}, {"type": "output_text", "text": "response"}]}
        ]}),
    ));
    let config = cfg("openai", "key", &server.url("/v1/responses"), "gpt-test");
    assert_eq!(
        rewrite(&config, "system guidance", "user text").unwrap(),
        "rewritten response"
    );
    let request = server.only_request();
    assert_eq!(request.path(), "/v1/responses");
    assert_eq!(request.header("authorization"), Some("Bearer key"));
    assert_eq!(
        request.json(),
        json!({"model": "gpt-test", "instructions": "system guidance", "input": "user text", "store": false})
    );
}

#[test]
fn custom_responses_api() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"output": [{"type": "message", "content": [{"type": "output_text", "text": "edited"}]}]}),
    ));
    let config = cfg("custom", "", &server.url("/v1/responses"), "model");
    assert_eq!(rewrite(&config, "edit", "hello").unwrap(), "edited");
    assert_eq!(server.only_request().json()["instructions"], "edit");
}

#[test]
fn responses_never_insert_unfinished_output() {
    for provider in ["openai", "custom"] {
        for status in ["incomplete", "failed", "cancelled", "queued", "in_progress"] {
            let server = FakeServer::always(Reply::json(
                200,
                json!({"status": status, "incomplete_details": {"reason": "max_output_tokens"},
                       "output": [{"type": "message", "content": [{"type": "output_text", "text": "partial"}]}]}),
            ));
            let config = cfg(provider, "k", &server.url("/v1/responses"), "model");
            let error = rewrite(&config, "edit", "hello").unwrap_err();
            assert_eq!(
                error.message,
                format!("Rewrite response is {status}. No partial text was inserted; try a shorter selection.")
            );
        }
    }
}

#[test]
fn openrouter_and_mistral_never_use_the_responses_shape() {
    let server = FakeServer::always(chat_reply("ok"));
    let config = cfg("openrouter", "k", &server.url("/api/v1/responses"), "m");
    rewrite(&config, "s", "u").unwrap();
    assert!(server.only_request().json().get("messages").is_some());
}

#[test]
fn anthropic_messages_shape() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"content": [{"type": "text", "text": "rewritten"}, {"type": "tool_use", "text": "no"}], "stop_reason": "end_turn"}),
    ));
    let config = cfg(
        "anthropic",
        "key",
        &server.url("/v1/messages"),
        "claude-test",
    );
    assert_eq!(rewrite(&config, "system", "user").unwrap(), "rewritten");
    let request = server.only_request();
    assert_eq!(request.header("x-api-key"), Some("key"));
    assert_eq!(request.header("anthropic-version"), Some("2023-06-01"));
    assert!(request.header("authorization").is_none());
    let body = request.json();
    assert_eq!(body["system"], "system");
    assert_eq!(
        body["messages"],
        json!([{"role": "user", "content": "user"}])
    );
    assert_eq!(body["max_tokens"], 4096);
    assert_eq!(body["temperature"], 0.2);
    assert_eq!(body["model"], "claude-test");
}

#[test]
fn google_rewrite_shape() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"candidates": [{"content": {"parts": [{"text": " better "}]}}]}),
    ));
    let config = cfg(
        "google",
        "gk",
        &server.url("/v1beta/models/{model}:generateContent"),
        "models/gemini-x",
    );
    assert_eq!(rewrite(&config, "sys", "usr").unwrap(), "better");
    let request = server.only_request();
    assert_eq!(request.path(), "/v1beta/models/gemini-x:generateContent");
    assert_eq!(
        request.json(),
        json!({
            "system_instruction": {"parts": [{"text": "sys"}]},
            "contents": [{"role": "user", "parts": [{"text": "usr"}]}],
            "generationConfig": {"temperature": 0.2}
        })
    );
}

#[test]
fn ollama_uses_its_native_chat_api() {
    let server = FakeServer::always(Reply::json(
        200,
        json!({"message": {"content": "local rewrite"}, "done_reason": "stop"}),
    ));
    let config = cfg(
        "ollama",
        "",
        &server.url("/api/chat"),
        "user-selected-model",
    );
    assert_eq!(rewrite(&config, "system", "user").unwrap(), "local rewrite");
    let request = server.only_request();
    assert!(request.header("authorization").is_none());
    assert_eq!(
        request.json(),
        json!({
            "model": "user-selected-model",
            "stream": false,
            "options": {"temperature": 0.2},
            "messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "user"}]
        })
    );
}

#[test]
fn every_provider_refuses_a_truncated_rewrite() {
    // Differs from Ownkey on purpose: Anthropic, Gemini and Ollama returned partial text.
    let cases = [
        (
            "anthropic",
            "/v1/messages",
            json!({"content": [{"type": "text", "text": "partial"}], "stop_reason": "max_tokens"}),
        ),
        (
            "google",
            "/v1beta/models/{model}:generateContent",
            json!({"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": "partial"}]}}]}),
        ),
        (
            "ollama",
            "/api/chat",
            json!({"message": {"content": "partial"}, "done_reason": "length"}),
        ),
    ];
    for (provider, path, reply) in cases {
        let server = FakeServer::always(Reply::json(200, reply));
        let config = cfg(provider, "k", &server.url(path), "m");
        let error = rewrite(&config, "s", "u").unwrap_err();
        assert_eq!(
            error.message, "Rewrite reached the output limit. Try rewriting a shorter selection.",
            "{provider}"
        );
    }
}

#[test]
fn an_explicit_budget_reaches_every_provider() {
    // (provider, endpoint path, reply, where the budget sits in the request body)
    let cases = [
        (
            "openai",
            "/v1/chat/completions",
            json!({"choices": [{"message": {"content": "ok"}}]}),
            "/max_tokens",
        ),
        (
            "openai",
            "/v1/responses",
            json!({"output": []}),
            "/max_output_tokens",
        ),
        (
            "anthropic",
            "/v1/messages",
            json!({"content": []}),
            "/max_tokens",
        ),
        (
            "google",
            "/v1beta/models/{model}:generateContent",
            json!({"candidates": []}),
            "/generationConfig/maxOutputTokens",
        ),
        (
            "ollama",
            "/api/chat",
            json!({"message": {"content": "ok"}}),
            "/options/num_predict",
        ),
    ];
    for (provider, path, reply, pointer) in cases {
        let server = FakeServer::always(Reply::json(200, reply));
        let config = cfg(provider, "k", &server.url(path), "m");
        let request = RewriteRequest {
            system: "s".into(),
            user: "u".into(),
            max_tokens: Some(3000),
        };
        rewriter(&config).unwrap().rewrite(&request).unwrap();
        assert_eq!(
            server.only_request().json().pointer(pointer),
            Some(&json!(3000)),
            "{provider} {path}"
        );
    }
}

#[test]
fn rewrite_setup_errors() {
    // The retired local rewrite provider is refused before anything is sent.
    let retired = rewriter(&cfg("local_rewrite", "", "https://example.invalid", "m"))
        .err()
        .unwrap();
    assert_eq!(retired.message, "This provider does not support rewriting.");
    assert_eq!(
        rewriter(&cfg(
            "openai",
            "k",
            "https://api.openai.com/v1/responses",
            ""
        ))
        .err()
        .unwrap()
        .message,
        "Select a rewrite model in Settings."
    );
    // Auto-rewrite gets the key check too, instead of an unauthenticated request.
    let missing = rewriter(&cfg(
        "openai",
        "",
        "https://api.openai.com/v1/responses",
        "gpt",
    ))
    .err()
    .unwrap();
    assert_eq!(missing.kind, ErrorKind::Auth);
    assert_eq!(
        missing.message,
        "No rewrite API key set. Open Settings > Rewriting and add a key."
    );
    assert!(rewriter(&cfg(
        "ollama",
        "",
        "http://localhost:11434/api/chat",
        "llama"
    ))
    .is_ok());
    assert_eq!(
        rewriter(&cfg("ollama", "", "https://ollama.com/api/chat", "llama"))
            .err()
            .unwrap()
            .kind,
        ErrorKind::Auth
    );
}

#[test]
fn model_lists_for_openai_style_and_anthropic() {
    let cases = [
        ("openai", Activity::Audio, "/v1/audio/transcriptions"),
        ("anthropic", Activity::Rewrite, "/v1/messages"),
        ("mistral", Activity::Rewrite, "/v1/chat/completions"),
        ("openrouter", Activity::Rewrite, "/api/v1/chat/completions"),
        ("custom", Activity::Rewrite, "/v1/chat/completions"),
        ("custom", Activity::Audio, "/v1/audio/transcriptions"),
    ];
    for (provider, activity, path) in cases {
        let server = FakeServer::always(Reply::json(
            200,
            json!({"data": [{"id": "z"}, {"id": "a"}, "junk"]}),
        ));
        let config = cfg(provider, "secret", &server.url(path), "");
        assert_eq!(
            list_models(activity, &config).unwrap(),
            vec!["a", "z"],
            "{provider}"
        );
        let request = server.only_request();
        assert_eq!(request.method, "GET");
        assert!(request.path().ends_with("/models"), "{}", request.target);
        if provider == "anthropic" {
            assert_eq!(request.header("x-api-key"), Some("secret"));
            assert_eq!(request.header("anthropic-version"), Some("2023-06-01"));
            assert_eq!(request.target, "/v1/models?limit=1000");
        } else {
            assert_eq!(request.header("authorization"), Some("Bearer secret"));
            assert!(!request.target.contains('?'));
        }
    }
}

#[test]
fn model_lists_for_google_and_ollama() {
    let google = FakeServer::always(Reply::json(
        200,
        json!({"models": [
            {"name": "models/gemini-a", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/embed-only", "supportedGenerationMethods": ["embedContent"]},
            {"name": "models/gemini-b-001", "baseModelId": "gemini-b"},
        ]}),
    ));
    let config = cfg(
        "google",
        "gemini-key",
        &google.url("/v1beta/models/{model}:generateContent"),
        "",
    );
    assert_eq!(
        list_models(Activity::Rewrite, &config).unwrap(),
        vec!["gemini-a", "gemini-b"]
    );
    let request = google.only_request();
    assert_eq!(request.target, "/v1beta/models?pageSize=1000");
    assert_eq!(request.header("x-goog-api-key"), Some("gemini-key"));

    let ollama = FakeServer::always(Reply::json(
        200,
        json!({"models": [{"name": "local-b"}, {"model": "local-a"}, {"name": ""}]}),
    ));
    let config = cfg("ollama", "", &ollama.url("/api/chat"), "");
    assert_eq!(
        list_models(Activity::Rewrite, &config).unwrap(),
        vec!["local-a", "local-b"]
    );
    assert_eq!(ollama.only_request().path(), "/api/tags");
}

#[test]
fn model_lists_are_unique_and_sorted() {
    let server = FakeServer::always(Reply::json(
        200,
        json!([{"id": "b"}, {"id": "B"}, {"id": " a "}, {"id": "a"}, {"id": null}, {"id": ""}]),
    ));
    let config = cfg("custom", "", &server.url("/v1/chat/completions"), "");
    assert_eq!(
        list_models(Activity::Rewrite, &config).unwrap(),
        vec!["a", "B", "b"]
    );
}

#[test]
fn orukeet_model_list_needs_no_request() {
    let config = cfg("orukeet", "", "", "");
    assert_eq!(
        list_models(Activity::Audio, &config).unwrap(),
        vec!["orukeet-onnx-int8"]
    );
    assert_eq!(
        list_models(Activity::Rewrite, &config).unwrap_err().message,
        "Orukeet does not support rewriting."
    );
    assert_eq!(
        list_models(Activity::Audio, &cfg("anthropic", "", "", ""))
            .unwrap_err()
            .message,
        "Anthropic does not provide a supported audio transcription API."
    );
}

#[test]
fn http_errors_keep_the_providers_explanation() {
    let server = FakeServer::always(Reply::json(
        401,
        json!({"error": {"message": "Invalid  API\nkey"}}),
    ));
    let error = rewrite(
        &cfg("openai", "bad", &server.url("/v1/responses"), "m"),
        "s",
        "u",
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Auth);
    assert_eq!(error.message, "API error 401: Invalid API key");

    let server = FakeServer::always(Reply::json(
        403,
        json!({"error": {"message": "This model requires 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences."}}),
    ));
    let error = rewrite(
        &cfg(
            "openrouter",
            "k",
            &server.url("/api/v1/chat/completions"),
            "m",
        ),
        "s",
        "u",
    )
    .unwrap_err();
    assert!(error
        .message
        .starts_with("API error 403: This model requires 18+ age confirmation."));

    let server = FakeServer::always(Reply::text(502, "Upstream temporarily unavailable"));
    let error = stt(&cfg(
        "custom",
        "",
        &server.url("/v1/audio/transcriptions"),
        "w",
    ))
    .transcribe(&pcm(), &Hints::default())
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Provider);
    assert_eq!(
        error.message,
        "API error 502: Upstream temporarily unavailable"
    );

    let server = FakeServer::always(Reply::json(401, json!({"error": {"message": "no key"}})));
    let error = list_models(
        Activity::Rewrite,
        &cfg("mistral", "bad", &server.url("/v1/chat/completions"), ""),
    )
    .unwrap_err();
    assert_eq!(error.message, "API error 401: no key");
}

#[test]
fn unreadable_success_is_a_provider_error() {
    let server = FakeServer::always(Reply::text(200, "<html>proxy login</html>"));
    let error = rewrite(
        &cfg("custom", "", &server.url("/v1/chat/completions"), "m"),
        "s",
        "u",
    )
    .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Provider);
    assert_eq!(
        error.message,
        "Custom (OpenAI-compatible) sent a response Voice couldn't read."
    );
}

#[test]
fn a_local_server_that_is_down_is_named() {
    let port = closed_port();
    let config = cfg(
        "ollama",
        "",
        &format!("http://127.0.0.1:{port}/api/chat"),
        "llama",
    );
    let error = rewrite(&config, "s", "u").unwrap_err();
    assert_eq!(error.kind, ErrorKind::Network);
    assert_eq!(
        error.message,
        format!("Couldn't connect to 127.0.0.1:{port}. Check that the server is running.")
    );
}

#[test]
fn an_unknown_host_is_a_network_error() {
    let config = cfg(
        "custom",
        "",
        "http://voice-core-test.invalid/v1/chat/completions",
        "m",
    );
    let error = rewrite(&config, "s", "u").unwrap_err();
    assert_eq!(error.kind, ErrorKind::Network);
    assert_eq!(
        error.message,
        "Couldn't reach voice-core-test.invalid. Check your internet connection."
    );
}

#[test]
fn a_slow_provider_is_a_timeout() {
    let server = FakeServer::always(Reply::hang());
    let config = ProviderConfig {
        timeout: Duration::from_millis(300),
        ..cfg(
            "custom",
            "",
            &server.url("/v1/audio/transcriptions"),
            "whisper",
        )
    };
    let error = stt(&config)
        .transcribe(&pcm(), &Hints::default())
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert_eq!(
        error.message,
        "Custom (OpenAI-compatible) didn't answer within 1 second. Try again."
    );
}

#[test]
fn the_connection_check_only_opens_a_connection() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let timeout = Duration::from_millis(1500);
    assert!(endpoint_reachable(
        &format!("http://127.0.0.1:{port}/v1/audio/transcriptions"),
        timeout
    ));
    assert!(!endpoint_reachable(
        &format!("http://127.0.0.1:{}/v1/audio/transcriptions", closed_port()),
        timeout
    ));
    assert!(!endpoint_reachable("", timeout));
    assert!(!endpoint_reachable("http://127.0.0.1:99999/", timeout));
}
