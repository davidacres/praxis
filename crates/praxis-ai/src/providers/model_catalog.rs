//! Model listing for API providers. Ports `modelCatalog.ts` plus the three `fetch*Models`
//! clients (`gatewayClient.ts`, `anthropicClient.ts`, `geminiClient.ts`).
//!
//! Results are cached in memory by provider, normalised URL and a hash of the key — no TTL, no
//! polling: a key or URL change is a natural miss. Callers opt into a fresh fetch.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::model_pricing::{get_known_context_length, get_model_pricing};

const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// How the API key is sent. Absent means bearer — every built-in's behaviour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAuth {
    Bearer,
    Header(String),
    None,
}

/// Connection options for one provider, carrying every per-provider wire detail.
#[derive(Debug, Clone)]
pub struct GatewayOptions {
    pub url: String,
    pub api_key: Option<String>,
    pub api_path: Option<String>,
    pub exact_path: bool,
    pub auth: KeyAuth,
    pub headers: BTreeMap<String, String>,
}

impl GatewayOptions {
    #[must_use]
    pub fn new(url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            url: url.into(),
            api_key,
            api_path: None,
            exact_path: false,
            auth: KeyAuth::Bearer,
            headers: BTreeMap::new(),
        }
    }
}

/// `<url><path><suffix>` the way the gateway client builds it.
#[must_use]
pub fn endpoint(options: &GatewayOptions, suffix: &str) -> String {
    let clean_url = options.url.trim_end_matches('/');
    if options.exact_path {
        let path = options
            .api_path
            .as_deref()
            .unwrap_or_default()
            .trim_end_matches('/');
        let path = if !path.is_empty() && !path.starts_with('/') {
            format!("/{path}")
        } else {
            path.to_owned()
        };
        return format!("{clean_url}{path}{suffix}");
    }
    let mut clean_path = options
        .api_path
        .as_deref()
        .unwrap_or("/v1")
        .trim_end_matches('/')
        .to_owned();
    if !clean_path.starts_with('/') {
        clean_path.insert(0, '/');
    }
    if let Ok(parsed) = url::Url::parse(clean_url) {
        let path = parsed.path();
        if path != "/" && !path.is_empty() {
            if clean_url
                .to_lowercase()
                .ends_with(&clean_path.to_lowercase())
            {
                return format!("{clean_url}{suffix}");
            }
            let lowered = path.to_lowercase();
            if lowered.contains("/api/") || lowered.contains("/v1") {
                return format!("{clean_url}{suffix}");
            }
        }
    }
    format!("{clean_url}{clean_path}{suffix}")
}

fn is_zai_host(url: &str) -> bool {
    let lowered = url.to_lowercase();
    lowered.contains("z.ai") || lowered.contains("bigmodel.cn")
}

fn alternate_zai_api_path(current: Option<&str>) -> &'static str {
    if current
        .unwrap_or_default()
        .to_lowercase()
        .contains("/coding/")
    {
        "/api/paas/v4"
    } else {
        "/api/coding/paas/v4"
    }
}

/// One selectable model, in the JSON shape the renderer's picker reads.
pub type ModelChoice = Value;

/// A raw `{ id, name?, context_length? }` model from a provider's listing.
#[derive(Debug, Clone, PartialEq)]
pub struct RawModel {
    pub id: String,
    pub name: Option<String>,
    pub context_length: Option<u64>,
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    headers: Vec<(String, String)>,
) -> Result<Value, String> {
    let mut request = client.get(url).header("Accept", "application/json");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("{}|{body}", status.as_u16()));
    }
    serde_json::from_str(&body).map_err(|error| format!("Failed to parse the model list: {error}"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())
}

/// `GET <url>/v1/models` — the OpenAI-compatible listing.
pub async fn fetch_models(options: &GatewayOptions) -> Result<Vec<RawModel>, String> {
    match fetch_models_once(options).await {
        // Z.ai answers 1113 on the wrong API path; retry on the other one.
        Err(error)
            if is_zai_host(&options.url) && error.starts_with("429|") && error.contains("1113") =>
        {
            let mut alternate = options.clone();
            alternate.api_path =
                Some(alternate_zai_api_path(options.api_path.as_deref()).to_owned());
            fetch_models_once(&alternate).await
        }
        other => other,
    }
}

async fn fetch_models_once(options: &GatewayOptions) -> Result<Vec<RawModel>, String> {
    let mut headers: Vec<(String, String)> = options
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(key) = options.api_key.as_deref().filter(|key| !key.is_empty()) {
        match &options.auth {
            KeyAuth::Bearer => headers.push(("Authorization".into(), format!("Bearer {key}"))),
            KeyAuth::Header(name) => headers.push((name.clone(), key.to_owned())),
            KeyAuth::None => {}
        }
    }
    let json = get_json(&client()?, &endpoint(options, "/models"), headers).await?;
    Ok(json["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(RawModel {
                        id: item["id"].as_str()?.to_owned(),
                        name: item["name"].as_str().map(str::to_owned),
                        context_length: item["context_length"].as_u64(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// `GET <url>/v1/models` with Anthropic's `x-api-key` / `anthropic-version` auth.
pub async fn fetch_anthropic_models(options: &GatewayOptions) -> Result<Vec<RawModel>, String> {
    let mut headers = vec![("anthropic-version".to_owned(), ANTHROPIC_VERSION.to_owned())];
    if let Some(key) = options.api_key.as_deref().filter(|key| !key.is_empty()) {
        headers.push(("x-api-key".into(), key.to_owned()));
    }
    let json = get_json(
        &client()?,
        &format!("{}/v1/models", options.url.trim_end_matches('/')),
        headers,
    )
    .await?;
    Ok(json["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(RawModel {
                        id: item["id"].as_str()?.to_owned(),
                        name: item["display_name"].as_str().map(str::to_owned),
                        context_length: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// `GET <url>/v1beta/models`, keeping models that support `generateContent`.
pub async fn fetch_gemini_models(options: &GatewayOptions) -> Result<Vec<RawModel>, String> {
    let base = Some(options.url.trim())
        .filter(|url| !url.is_empty())
        .unwrap_or(super::registry::DEFAULT_GEMINI_BASE_URL)
        .trim_end_matches('/')
        .to_owned();
    let mut headers = Vec::new();
    if let Some(key) = options.api_key.as_deref().filter(|key| !key.is_empty()) {
        headers.push(("x-goog-api-key".to_owned(), key.to_owned()));
    }
    let json = get_json(&client()?, &format!("{base}/v1beta/models"), headers).await?;
    Ok(json["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item["name"].as_str()?;
                    let methods = item["supportedGenerationMethods"].as_array();
                    if methods.is_some_and(|methods| {
                        !methods.is_empty() && !methods.iter().any(|m| m == "generateContent")
                    }) {
                        return None;
                    }
                    let id = name.strip_prefix("models/").unwrap_or(name).to_owned();
                    Some(RawModel {
                        name: Some(
                            item["displayName"]
                                .as_str()
                                .map_or_else(|| id.clone(), str::to_owned),
                        ),
                        id,
                        context_length: item["inputTokenLimit"].as_u64(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Known Z.ai models, used when its listing is unavailable.
#[must_use]
pub fn known_z_ai_models() -> Vec<ModelChoice> {
    let m = |value: &str, name: &str, input: f64, output: f64| json!({ "value": value, "name": name, "contextLength": 128_000, "pricing": { "inputPerMillionUsd": input, "outputPerMillionUsd": output } });
    vec![
        m("glm-5.3", "GLM-5.3 (Flagship Coding & Reasoning)", 1.4, 4.4),
        m("glm-5.3-flash", "GLM-5.3 Flash (Fast Coding)", 0.15, 0.5),
        m("glm-4.5", "GLM-4.5", 0.6, 2.2),
        m("glm-4.5-flash", "GLM-4.5 Flash", 0.0, 0.0),
        json!({ "value": "glm-4-plus", "name": "GLM-4 Plus", "contextLength": 128_000 }),
        json!({ "value": "glm-4-flash", "name": "GLM-4 Flash", "contextLength": 128_000 }),
        json!({ "value": "glm-zero-preview", "name": "GLM Zero Preview", "contextLength": 128_000 }),
    ]
}

fn normalize(raw: Vec<RawModel>) -> Vec<ModelChoice> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out: Vec<ModelChoice> = raw
        .into_iter()
        .filter(|model| !model.id.is_empty() && seen.insert(model.id.clone()))
        .map(|model| {
            let name = model
                .name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(&model.id)
                .to_owned();
            let mut choice = json!({ "value": model.id, "name": name });
            if let Some(length) = model.context_length.filter(|length| *length > 0) {
                choice["contextLength"] = json!(length);
            }
            choice
        })
        .collect();
    out.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&b["name"].as_str().unwrap_or_default().to_lowercase())
    });
    out
}

fn cache() -> &'static Mutex<HashMap<String, Vec<ModelChoice>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<ModelChoice>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cache_key(provider: &str, url: &str, api_key: &str) -> String {
    let digest = Sha256::digest(api_key.as_bytes())
        .iter()
        .fold(String::new(), |mut hex, byte| {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
            hex
        });
    format!(
        "{provider}::{}::{digest}",
        url.trim_end_matches('/').to_lowercase()
    )
}

fn enrich(provider: &str, mut choice: ModelChoice, known: Option<&ModelChoice>) -> ModelChoice {
    let value = choice["value"].as_str().unwrap_or_default().to_owned();
    let pricing = get_model_pricing(Some(provider), Some(&value))
        .and_then(|rates| serde_json::to_value(rates).ok());
    let have_length = choice["contextLength"]
        .as_u64()
        .filter(|length| *length > 0);
    if provider == "z-ai" {
        let length = have_length
            .or_else(|| known.and_then(|k| k["contextLength"].as_u64()))
            .unwrap_or(128_000);
        choice["contextLength"] = json!(length);
        if let Some(pricing) =
            pricing.or_else(|| known.map(|k| k["pricing"].clone()).filter(|p| !p.is_null()))
        {
            choice["pricing"] = pricing;
        }
        return choice;
    }
    if let Some(length) =
        have_length.or_else(|| get_known_context_length(Some(&value), Some(provider)))
    {
        choice["contextLength"] = json!(length);
    }
    if let Some(pricing) = pricing {
        choice["pricing"] = pricing;
    }
    choice
}

/// Fetches (or reuses the cached) model catalog for an API provider.
/// `manual_models` are a custom endpoint's hand-listed ids: used when the server has no listing
/// and merged in when it lists some but not all.
pub async fn list_catalog_models(
    provider: &str,
    options: &GatewayOptions,
    manual_models: &[String],
    force_refresh: bool,
) -> Result<Vec<ModelChoice>, String> {
    let key = cache_key(
        provider,
        &options.url,
        options.api_key.as_deref().unwrap_or_default(),
    );
    if !force_refresh
        && let Some(hit) = cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).cloned())
    {
        return Ok(hit);
    }
    let manual_choices = || -> Vec<ModelChoice> {
        manual_models
            .iter()
            .map(|id| json!({ "value": id, "name": id }))
            .collect()
    };
    let store = |choices: Vec<ModelChoice>| {
        if let Ok(mut cache) = cache().lock() {
            cache.insert(key.clone(), choices.clone());
        }
        choices
    };
    let fetched = match provider {
        "anthropic" => fetch_anthropic_models(options).await,
        "gemini" => fetch_gemini_models(options).await,
        _ => fetch_models(options).await,
    };
    let raw = match fetched {
        Ok(raw) => raw,
        Err(_) if provider == "z-ai" => return Ok(store(known_z_ai_models())),
        Err(_) if !manual_models.is_empty() => return Ok(store(manual_choices())),
        Err(error) => return Err(error),
    };
    let known = known_z_ai_models();
    let mut choices: Vec<ModelChoice> = normalize(raw)
        .into_iter()
        .map(|choice| {
            let known = known
                .iter()
                .find(|candidate| candidate["value"] == choice["value"]);
            enrich(provider, choice, known)
        })
        .collect();
    for extra in manual_choices() {
        if !choices
            .iter()
            .any(|choice| choice["value"] == extra["value"])
        {
            choices.push(extra);
        }
    }
    if provider == "z-ai" && choices.is_empty() {
        choices = known_z_ai_models();
    }
    Ok(store(choices))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_follow_the_gateway_clients_path_rules() {
        let plain = GatewayOptions::new("https://api.openai.com/", None);
        assert_eq!(
            endpoint(&plain, "/models"),
            "https://api.openai.com/v1/models"
        );
        let versioned = GatewayOptions::new("https://example.com/v1", None);
        assert_eq!(
            endpoint(&versioned, "/models"),
            "https://example.com/v1/models",
            "an existing /v1 is not doubled"
        );
        let mut zai = GatewayOptions::new("https://api.z.ai", None);
        zai.api_path = Some("/api/coding/paas/v4".into());
        assert_eq!(
            endpoint(&zai, "/models"),
            "https://api.z.ai/api/coding/paas/v4/models"
        );
        let mut exact = GatewayOptions::new("http://localhost:11434", None);
        exact.exact_path = true;
        exact.api_path = Some("v1".into());
        assert_eq!(
            endpoint(&exact, "/models"),
            "http://localhost:11434/v1/models"
        );
        assert_eq!(
            alternate_zai_api_path(Some("/api/coding/paas/v4")),
            "/api/paas/v4"
        );
    }

    #[test]
    fn normalisation_dedupes_sorts_by_name_and_keeps_only_real_context_lengths() {
        let raw = vec![
            RawModel {
                id: "b".into(),
                name: Some("Beta".into()),
                context_length: Some(0),
            },
            RawModel {
                id: "a".into(),
                name: Some("alpha".into()),
                context_length: Some(32_000),
            },
            RawModel {
                id: "b".into(),
                name: Some("dupe".into()),
                context_length: None,
            },
            RawModel {
                id: "c".into(),
                name: Some("  ".into()),
                context_length: None,
            },
        ];
        let out = normalize(raw);
        assert_eq!(
            out.iter()
                .map(|c| c["value"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!(out[0]["contextLength"], 32_000);
        assert!(
            out[1].get("contextLength").is_none(),
            "a zero length is not a length"
        );
        assert_eq!(out[2]["name"], "c", "a blank name falls back to the id");
    }

    #[test]
    fn z_ai_models_are_enriched_with_the_known_table() {
        let known = known_z_ai_models();
        let enriched = enrich(
            "z-ai",
            json!({ "value": "glm-4.5", "name": "GLM-4.5" }),
            known.iter().find(|k| k["value"] == "glm-4.5"),
        );
        assert_eq!(enriched["contextLength"], 128_000);
        assert!(enriched["pricing"].is_object());
    }

    #[tokio::test]
    async fn lists_from_a_local_openai_compatible_server_and_caches_it() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&hits);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buffer = [0u8; 2048];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_lowercase();
                let body = if request.contains("authorization: bearer secret-key") {
                    r#"{"data":[{"id":"m-2","name":"Zed"},{"id":"m-1","context_length":8000}]}"#
                } else {
                    "{}"
                };
                let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            }
        });
        let options = GatewayOptions::new(
            format!("http://127.0.0.1:{port}"),
            Some("secret-key".into()),
        );
        let first = list_catalog_models("vercel-gateway", &options, &[], false)
            .await
            .expect("models");
        assert_eq!(
            first
                .iter()
                .map(|c| c["value"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["m-1", "m-2"]
        );
        assert_eq!(first[0]["contextLength"], 8000);
        let again = list_catalog_models("vercel-gateway", &options, &[], false)
            .await
            .expect("cached");
        assert_eq!(again, first);
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the second call is a cache hit"
        );
        list_catalog_models("vercel-gateway", &options, &[], true)
            .await
            .expect("refresh");
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "force_refresh refetches"
        );
        // A different key is a different cache entry.
        let other = GatewayOptions::new(format!("http://127.0.0.1:{port}"), Some("another".into()));
        assert!(
            list_catalog_models("vercel-gateway", &other, &[], false)
                .await
                .expect("models")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn manual_models_stand_in_when_the_server_has_no_listing() {
        let options = GatewayOptions::new("http://127.0.0.1:9", None);
        let models = list_catalog_models("custom:local", &options, &["llama3".into()], true)
            .await
            .expect("manual");
        assert_eq!(models, vec![json!({ "value": "llama3", "name": "llama3" })]);
        assert!(
            list_catalog_models("custom:none", &options, &[], true)
                .await
                .is_err(),
            "no listing and no manual ids is an error"
        );
    }
}
