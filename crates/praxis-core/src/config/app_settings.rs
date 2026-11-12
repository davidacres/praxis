//! Typed `AppSettings` shape, defaults, `sanitize_app_settings`, `merge_app_settings`,
//! and shared settings file persistence (`packages/core/src/config/appSettings.ts`).

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::network_address::normalize_mobile_subnet;
use crate::ui::parse_hex_rgb;

use super::custom_providers::{CustomProviderConfig, sanitize_custom_providers};
use super::mcp_servers::{McpServerConfig, sanitize_mcp_servers};

/// Ordered priority levels customized by the Appearance section.
pub const PRIORITY_NAMES: &[&str] = &["Critical", "Highest", "High", "Medium", "Low", "Lowest"];

/// Default working habits Praxis asks AI runtimes to follow.
pub const DEFAULT_WORKING_STYLE: &str = concat!(
    "- Before a multi-step change, state a short plan and keep it up to date as a checklist while you work.\n",
    "- Before anything that is hard to undo — deleting files, rewriting history, publishing, changing shared systems — say what you are about to do and wait for approval.\n",
    "- Make small, reviewable changes that read like the surrounding code.\n",
    "- Verify your work with the project’s own build and tests, and say plainly when you could not.\n",
    "- Finish with a short summary: what changed, how you verified it, and anything left for the user."
);

const KNOWN_AI_PROVIDERS: &[&str] = &[
    "vercel-gateway",
    "openai",
    "anthropic",
    "gemini",
    "z-ai",
    "claude-code-cli",
    "codex-cli",
    "copilot-cli",
    "antigravity-cli",
    "cursor-cli",
];

const NATIVE_ECOSYSTEMS: &[&str] = &["claude", "codex", "agents", "copilot", "gemini", "cursor"];

const REASONING_EFFORT_LEVELS: &[&str] = &["off", "low", "medium", "high"];

const SURFACE_TOKEN_KEYS: &[&str] = &[
    "--surface-app-bg-image",
    "--surface-app-bg-size",
    "--surface-app-bg-blend",
    "--surface-texture-image",
    "--surface-texture-size",
    "--surface-texture-opacity",
    "--surface-texture-blend",
    "--surface-panel-border-color",
    "--surface-radius-boost",
    "--surface-accent-glow",
    "--surface-panel-opacity",
    "--surface-panel-blur",
    "--surface-panel-saturate",
];

const SURFACE_BLEND_KEYWORDS: &[&str] = &[
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "soft-light",
    "hard-light",
];

const SURFACE_ANCHORS: &[&str] = &["top-left", "top-right", "bottom-left", "bottom-right"];

const SURFACE_MOTIF_ANIMATIONS: &[&str] = &[
    "none",
    "draw",
    "plot",
    "iterate",
    "shimmer",
    "glow",
    "drift",
    "ripple",
    "neon",
    "cyberpunk",
];

const BUILT_IN_LOOK_IDS: &[&str] = &[
    "look-parchment",
    "look-blueprint",
    "look-aurora",
    "look-flat",
];

/// Desktop alerts for managed AI sessions and workflow runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotificationSettings {
    pub completed: bool,
    pub failed: bool,
    pub needs_attention: bool,
    pub sound: bool,
    pub suppress_when_viewing: bool,
}

/// Jira MCP settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSettings {
    pub site_url: String,
    pub default_project_key: String,
    pub epic_key: String,
    pub epic_board_name: String,
    pub board_jql: String,
    pub board_name: String,
}

/// Request timeout and pagination settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSettings {
    pub request_timeout_ms: u64,
    pub default_page_size: u32,
}

/// Delivery workflow settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySettings {
    pub default_base_branch: String,
    pub auto_merge_sub_tasks: bool,
    pub enabled: bool,
    pub publish_command: String,
    pub artifact_pattern: String,
    pub run_confirm_agent_sessions: u32,
}

/// MCP server reference settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSettings {
    pub workspace_server_name: String,
    pub user_server_ref: String,
}

/// Startup settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSettings {
    pub reopen_last_workspace: bool,
}

/// Marketplace settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSettings {
    pub enabled: bool,
    pub owner: String,
    pub owner_type: String,
    pub package_name_prefix: String,
    pub api_base_url: String,
    pub registry_base_url: String,
    pub check_on_launch: bool,
}

/// Preview feature flags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSettings {
    pub enable_easy_mode: bool,
    pub enable_deployments: bool,
}

/// Per-provider non-secret configuration override.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled_model_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_model_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_reasoning_defaults: Option<BTreeMap<String, String>>,
}

impl AiProviderConfig {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.base_url.is_none()
            && self.default_model.is_none()
            && self.cli_path.is_none()
            && self.enabled_model_ids.is_none()
            && self.known_model_ids.is_none()
            && self.enabled.is_none()
            && self.added.is_none()
            && self.model_reasoning_defaults.is_none()
    }
}

/// Model tier mapping (`fast` / `standard` / `strong`) for a single provider.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTierConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standard: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strong: Option<String>,
}

impl ModelTierConfig {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.fast.is_none() && self.standard.is_none() && self.strong.is_none()
    }
}

/// In-app AI browser tool settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolsSettings {
    pub enabled: bool,
    pub allowed_hosts: Vec<String>,
}

/// Native agent/skill/instruction discovery settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSourceSettings {
    pub ecosystems: BTreeMap<String, bool>,
    pub approved_projects: Vec<String>,
    pub inject_instructions: bool,
    pub instruction_source: String,
    pub extra_skill_paths: Vec<String>,
    pub extra_agent_paths: Vec<String>,
}

/// AI working style prompt settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStyleSettings {
    pub enabled: bool,
    pub text: String,
}

/// Local code intelligence settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIntelligenceSettings {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_overrides: Option<BTreeMap<String, bool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_search_modes: Option<BTreeMap<String, String>>,
}

/// AI provider, routing, and runtime settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub gateway_url: String,
    pub default_model: String,
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_words: Option<Vec<String>>,
    pub working_directory: String,
    pub analysis_prompt: String,
    pub analysis_gate_enabled: bool,
    pub spend_limit: f64,
    pub provider_handover_percent: u32,
    pub active_provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommendation_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_analysis_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_analysis_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_tiers: Option<BTreeMap<String, ModelTierConfig>>,
    pub providers: BTreeMap<String, AiProviderConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_providers: Option<Vec<CustomProviderConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    pub browser_tools: BrowserToolsSettings,
    pub native_sources: NativeSourceSettings,
    pub working_style: WorkingStyleSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_intelligence: Option<CodeIntelligenceSettings>,
}

/// Watermark motif configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceMotifSettings {
    pub id: String,
    pub scale: f64,
    pub opacity: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ink_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spread: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline_ink: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation_repeat: Option<bool>,
}

/// Surface pack intensity and material dials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSettings {
    pub intensity: f64,
    pub translucency: bool,
    pub texture: bool,
    pub window_vibrancy: bool,
    pub animate_motifs: bool,
    pub plain_chat_surface: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motif: Option<SurfaceMotifSettings>,
}

/// User-created theme stored in the shared settings document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub description: String,
    pub preview: BTreeMap<String, String>,
}

/// User-created surface pack stored in the shared settings document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSurfacePack {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_pack_id: Option<String>,
    pub tokens: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<SurfaceMotifSettings>,
}

/// Saved appearance preset ("Look").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceLook {
    pub id: String,
    pub name: String,
    pub theme_id: String,
    pub theme_mode: String,
    pub surface_pack_id: String,
    pub surface: SurfaceSettings,
    pub priority_colors: BTreeMap<String, String>,
    pub show_brand_artwork: bool,
}

/// Appearance and theme settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    pub display_mode: String,
    pub show_brand_artwork: bool,
    pub priority_colors: BTreeMap<String, String>,
    pub theme_id: String,
    pub theme_mode: String,
    pub accent_color: String,
    pub installed_theme_ids: Vec<String>,
    pub custom_themes: Vec<CustomTheme>,
    pub surface_pack_id: String,
    pub surface: SurfaceSettings,
    pub installed_surface_pack_ids: Vec<String>,
    pub custom_surface_packs: Vec<CustomSurfacePack>,
    pub looks: Vec<AppearanceLook>,
    pub active_look_id: String,
    pub zoom_factor: f64,
}

/// Built-in terminal settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    pub default_profile_id: String,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub copy_on_selection: bool,
    pub confirm_paste: bool,
    pub bell_sound: bool,
    pub shell_integration: bool,
    pub gpu_acceleration: bool,
}

/// Git CLI settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    pub executable_path: String,
    pub default_branch: String,
    pub fetch_interval_minutes: u32,
}

/// Git graph visual settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitVisualSettings {
    pub branch_colors_enabled: bool,
    pub merge_markers_enabled: bool,
    pub orientation: String,
    pub performance_mode: bool,
}

/// Mobile companion access policy settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAccessSettings {
    pub mode: String,
    pub host_name: String,
    pub allowed_interfaces: Vec<String>,
    pub allowed_subnets: Vec<String>,
    pub listen_port: u16,
    pub remote_sign_in_required: bool,
}

/// Top-level `AppSettings` document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub notifications: TaskNotificationSettings,
    pub ai: AiSettings,
    pub jira: JiraSettings,
    pub performance: PerformanceSettings,
    pub delivery: DeliverySettings,
    pub mcp_server: McpServerSettings,
    pub startup: StartupSettings,
    pub marketplace: MarketplaceSettings,
    pub preview: PreviewSettings,
    pub appearance: AppearanceSettings,
    pub terminal: TerminalSettings,
    pub git: GitSettings,
    pub git_visual: GitVisualSettings,
    pub mobile_access: MobileAccessSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        default_app_settings()
    }
}

/// Returns the default priority colour map.
#[must_use]
pub fn default_priority_colors() -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    map.insert("Critical".to_string(), "#DC2626".to_string());
    map.insert(
        "Highest".to_string(),
        "linear-gradient(to bottom, #DC2626, #EA580C)".to_string(),
    );
    map.insert("High".to_string(), "#F59E0B".to_string());
    map.insert(
        "Medium".to_string(),
        "linear-gradient(to bottom, #F59E0B, #3B82F6)".to_string(),
    );
    map.insert(
        "Low".to_string(),
        "linear-gradient(to bottom, #3B82F6, #22C55E)".to_string(),
    );
    map.insert("Lowest".to_string(), "#22C55E".to_string());
    map
}

fn built_in_look(
    id: &str,
    name: &str,
    surface_pack_id: &str,
    motif: Option<SurfaceMotifSettings>,
) -> AppearanceLook {
    AppearanceLook {
        id: id.to_string(),
        name: name.to_string(),
        theme_id: "praxis-dark".to_string(),
        theme_mode: "dark".to_string(),
        surface_pack_id: surface_pack_id.to_string(),
        surface: SurfaceSettings {
            intensity: 1.0,
            translucency: true,
            texture: true,
            window_vibrancy: false,
            animate_motifs: true,
            plain_chat_surface: false,
            motif,
        },
        priority_colors: default_priority_colors(),
        show_brand_artwork: true,
    }
}

/// Returns the four shipped appearance Looks.
#[must_use]
pub fn built_in_looks() -> Vec<AppearanceLook> {
    vec![
        built_in_look("look-parchment", "Parchment", "parchment", None),
        built_in_look(
            "look-blueprint",
            "Blueprint",
            "parchment",
            Some(SurfaceMotifSettings {
                id: "grid".to_string(),
                scale: 104.0,
                opacity: 0.3,
                ink: Some("accent".to_string()),
                ink_color: None,
                weight: None,
                blend: None,
                placement: None,
                anchor: None,
                anchors: None,
                spread: None,
                fade: None,
                fill: None,
                outline: None,
                outline_ink: None,
                animation: None,
                animation_speed: None,
                animation_repeat: None,
            }),
        ),
        built_in_look("look-aurora", "Aurora", "aurora-glass", None),
        built_in_look("look-flat", "Flat", "flat", None),
    ]
}

/// Returns the default `AppSettings` document (`DEFAULT_APP_SETTINGS`).
#[must_use]
pub fn default_app_settings() -> AppSettings {
    AppSettings {
        notifications: TaskNotificationSettings {
            completed: true,
            failed: true,
            needs_attention: true,
            sound: true,
            suppress_when_viewing: true,
        },
        ai: AiSettings {
            gateway_url: String::new(),
            default_model: String::new(),
            agent_name: String::new(),
            activity_words: Some(vec![
                "Thinking".to_string(),
                "Working".to_string(),
                "Pondering".to_string(),
            ]),
            working_directory: String::new(),
            analysis_prompt: String::new(),
            analysis_gate_enabled: false,
            spend_limit: 0.0,
            provider_handover_percent: 95,
            active_provider: "vercel-gateway".to_string(),
            recommendation_provider: None,
            prompt_analysis_provider: None,
            prompt_analysis_model: None,
            model_tiers: None,
            providers: BTreeMap::new(),
            custom_providers: None,
            mcp_servers: None,
            browser_tools: BrowserToolsSettings {
                enabled: false,
                allowed_hosts: Vec::new(),
            },
            native_sources: NativeSourceSettings {
                ecosystems: BTreeMap::new(),
                approved_projects: Vec::new(),
                inject_instructions: true,
                instruction_source: "all".to_string(),
                extra_skill_paths: Vec::new(),
                extra_agent_paths: Vec::new(),
            },
            working_style: WorkingStyleSettings {
                enabled: true,
                text: String::new(),
            },
            code_intelligence: Some(CodeIntelligenceSettings {
                enabled: true,
                project_overrides: Some(BTreeMap::new()),
                search_mode: None,
                project_search_modes: None,
            }),
        },
        jira: JiraSettings {
            site_url: String::new(),
            default_project_key: String::new(),
            epic_key: String::new(),
            epic_board_name: String::new(),
            board_jql: String::new(),
            board_name: String::new(),
        },
        performance: PerformanceSettings {
            request_timeout_ms: 30000,
            default_page_size: 25,
        },
        delivery: DeliverySettings {
            default_base_branch: String::new(),
            auto_merge_sub_tasks: true,
            enabled: false,
            publish_command: String::new(),
            artifact_pattern: String::new(),
            run_confirm_agent_sessions: 40,
        },
        mcp_server: McpServerSettings {
            workspace_server_name: String::new(),
            user_server_ref: String::new(),
        },
        startup: StartupSettings {
            reopen_last_workspace: true,
        },
        marketplace: MarketplaceSettings {
            enabled: false,
            owner: String::new(),
            owner_type: "user".to_string(),
            package_name_prefix: "praxis-addon-".to_string(),
            api_base_url: "https://api.github.com".to_string(),
            registry_base_url: "https://npm.pkg.github.com".to_string(),
            check_on_launch: true,
        },
        preview: PreviewSettings {
            enable_easy_mode: false,
            enable_deployments: false,
        },
        appearance: AppearanceSettings {
            display_mode: "compact".to_string(),
            show_brand_artwork: true,
            priority_colors: default_priority_colors(),
            theme_id: "praxis-light".to_string(),
            theme_mode: "light".to_string(),
            accent_color: String::new(),
            installed_theme_ids: vec![
                "praxis-light".to_string(),
                "praxis-dark".to_string(),
                "tm-default-1".to_string(),
                "tm-default-2".to_string(),
                "simple".to_string(),
            ],
            custom_themes: Vec::new(),
            surface_pack_id: "parchment".to_string(),
            surface: SurfaceSettings {
                intensity: 1.0,
                translucency: true,
                texture: true,
                window_vibrancy: false,
                animate_motifs: true,
                plain_chat_surface: false,
                motif: None,
            },
            installed_surface_pack_ids: vec![
                "flat".to_string(),
                "parchment".to_string(),
                "graphite".to_string(),
                "aurora-glass".to_string(),
                "noir".to_string(),
            ],
            custom_surface_packs: Vec::new(),
            looks: built_in_looks(),
            active_look_id: "look-parchment".to_string(),
            zoom_factor: 1.0,
        },
        terminal: TerminalSettings {
            default_profile_id: String::new(),
            font_family: "Menlo, Monaco, 'SF Mono', 'Courier New', monospace".to_string(),
            font_size: 13.0,
            line_height: 1.1,
            cursor_style: "block".to_string(),
            cursor_blink: true,
            scrollback: 5000,
            copy_on_selection: false,
            confirm_paste: true,
            bell_sound: false,
            shell_integration: true,
            gpu_acceleration: true,
        },
        git: GitSettings {
            executable_path: String::new(),
            default_branch: String::new(),
            fetch_interval_minutes: 0,
        },
        git_visual: GitVisualSettings {
            branch_colors_enabled: true,
            merge_markers_enabled: true,
            orientation: "vertical".to_string(),
            performance_mode: false,
        },
        mobile_access: MobileAccessSettings {
            mode: "off".to_string(),
            host_name: String::new(),
            allowed_interfaces: Vec::new(),
            allowed_subnets: Vec::new(),
            listen_port: 43100,
            remote_sign_in_required: false,
        },
    }
}

fn is_accepted_color(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    if let Some(after_prefix) = trimmed.strip_prefix("linear-gradient")
        && after_prefix.trim_start().starts_with('(')
    {
        return true;
    }
    if parse_hex_rgb(Some(trimmed)).is_some() {
        return true;
    }
    if (trimmed.len() == 3 || trimmed.len() == 6) && trimmed.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return true;
    }
    false
}

/// Normalizes a single priority color value — strips whitespace; passes through hex or gradients.
#[must_use]
pub fn normalize_priority_color(value: &Value) -> Option<String> {
    let s = value.as_str()?.trim();
    if s.is_empty() || !is_accepted_color(s) {
        return None;
    }
    Some(s.to_string())
}

fn clamp_f64(value: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    let Some(num) = value.and_then(Value::as_f64) else {
        return fallback;
    };
    if !num.is_finite() {
        return fallback;
    }
    num.clamp(min, max)
}

fn read_string(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map_or_else(|| fallback.to_string(), ToString::to_string)
}

fn read_bool(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn read_accent_color(value: Option<&Value>) -> String {
    let Some(s) = value.and_then(Value::as_str) else {
        return String::new();
    };
    if s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        s.to_ascii_lowercase()
    } else {
        String::new()
    }
}

fn read_theme_mode(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some("light" | "dark" | "system") => value
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
        _ => fallback.to_string(),
    }
}

fn read_display_mode(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some("compact" | "large") => value
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
        _ => fallback.to_string(),
    }
}

fn read_mobile_access_mode(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some("off" | "local-only" | "internet") => value
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
        _ => fallback.to_string(),
    }
}

fn read_string_list(value: Option<&Value>, fallback: &[String]) -> Vec<String> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return fallback.to_vec();
    };
    if !arr.iter().all(Value::is_string) {
        return fallback.to_vec();
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty())
            && seen.insert(s.to_string())
        {
            out.push(s.to_string());
        }
    }
    out
}

fn read_mobile_subnets(value: Option<&Value>, fallback: &[String]) -> Vec<String> {
    let list = read_string_list(value, fallback);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in list {
        if let Some(normalized) = normalize_mobile_subnet(&item)
            && seen.insert(normalized.clone())
        {
            out.push(normalized);
        }
    }
    out
}

fn read_theme_ids(value: Option<&Value>, fallback: &[String]) -> Vec<String> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return fallback.to_vec();
    };
    if !arr.iter().all(Value::is_string) {
        return fallback.to_vec();
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str()
            && seen.insert(s.to_string())
        {
            out.push(s.to_string());
        }
    }
    out
}

fn sanitize_activity_words(value: Option<&Value>) -> Vec<String> {
    let default_words = vec![
        "Thinking".to_string(),
        "Working".to_string(),
        "Pondering".to_string(),
    ];
    let Some(arr) = value.and_then(Value::as_array) else {
        return default_words;
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in arr {
        let Some(raw_str) = item.as_str() else {
            continue;
        };
        let cleaned: String = raw_str
            .chars()
            .map(|c| {
                if ('\x00'..='\x1f').contains(&c) || c == '\x7f' {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let trimmed: String = cleaned.trim().chars().take(32).collect();
        if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
            out.push(trimmed);
            if out.len() >= 20 {
                break;
            }
        }
    }
    if out.is_empty() { default_words } else { out }
}

fn is_slug_with_prefix(s: &str, prefix: &str) -> bool {
    let Some(rest) = s.strip_prefix(prefix) else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_plain_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn is_valid_chat_background_image(value: &str) -> bool {
    if value.len() > 2_800_000 {
        return false;
    }
    let rest = if let Some(r) = value.strip_prefix("data:image/png;base64,") {
        r
    } else if let Some(r) = value.strip_prefix("data:image/jpeg;base64,") {
        r
    } else if let Some(r) = value.strip_prefix("data:image/webp;base64,") {
        r
    } else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let trimmed_eq = rest.trim_end_matches('=');
    let eq_count = rest.len() - trimmed_eq.len();
    if eq_count > 2 || trimmed_eq.is_empty() {
        return false;
    }
    trimmed_eq
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn read_custom_themes(value: Option<&Value>) -> Vec<CustomTheme> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(id) = obj.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !is_slug_with_prefix(id, "custom-") {
            continue;
        }
        let Some(name_raw) = obj.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name_raw.trim().is_empty() {
            continue;
        }
        let Some(mode) = obj.get("mode").and_then(Value::as_str) else {
            continue;
        };
        if mode != "light" && mode != "dark" {
            continue;
        }
        let Some(desc_raw) = obj.get("description").and_then(Value::as_str) else {
            continue;
        };
        let Some(preview_obj) = obj.get("preview").and_then(Value::as_object) else {
            continue;
        };

        let mut preview = BTreeMap::new();
        for (k, v) in preview_obj {
            if preview.len() >= 40 {
                break;
            }
            let Some(val_str) = v.as_str() else {
                continue;
            };
            if k == "chatBackground" {
                if !(val_str.len() == 7
                    && val_str.starts_with('#')
                    && val_str[1..].bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    continue;
                }
            } else if k == "chatBackgroundImage" && !is_valid_chat_background_image(val_str) {
                continue;
            }
            preview.insert(k.clone(), val_str.to_string());
        }

        out.push(CustomTheme {
            id: id.to_string(),
            name: name_raw.trim().chars().take(80).collect(),
            mode: mode.to_string(),
            description: desc_raw.chars().take(240).collect(),
            preview,
        });
    }
    out
}

fn is_hex_3_to_8(s: &str) -> bool {
    let Some(hex) = s.strip_prefix('#') else {
        return false;
    };
    (3..=8).contains(&hex.len()) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_surface_pattern_spec(value: Option<&Value>) -> Option<SurfaceMotifSettings> {
    let obj = value?.as_object()?;
    let id = obj.get("id")?.as_str()?;
    if id.is_empty() || id.len() > 32 || !is_plain_slug(id) {
        return None;
    }

    let blend = obj
        .get("blend")
        .and_then(Value::as_str)
        .filter(|b| SURFACE_BLEND_KEYWORDS.contains(b))
        .map(ToString::to_string);

    let ink_color = obj
        .get("inkColor")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| is_hex_3_to_8(c))
        .map(ToString::to_string);

    let outline_ink = obj
        .get("outlineInk")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| is_hex_3_to_8(c))
        .map(ToString::to_string);

    let anchor = obj
        .get("anchor")
        .and_then(Value::as_str)
        .filter(|a| SURFACE_ANCHORS.contains(a))
        .map(ToString::to_string);

    let anchors = obj
        .get("anchors")
        .and_then(Value::as_array)
        .and_then(|arr| {
            let mut list = Vec::new();
            for item in arr {
                if let Some(s) = item.as_str()
                    && SURFACE_ANCHORS.contains(&s)
                    && !list.iter().any(|existing| existing == s)
                {
                    list.push(s.to_string());
                    if list.len() >= 4 {
                        break;
                    }
                }
            }
            (!list.is_empty()).then_some(list)
        });

    let animation = obj
        .get("animation")
        .and_then(Value::as_str)
        .filter(|a| SURFACE_MOTIF_ANIMATIONS.contains(a))
        .map(ToString::to_string);

    let ink = match obj.get("ink").and_then(Value::as_str) {
        Some("text") => "text",
        Some("custom") => "custom",
        _ => "accent",
    };

    let placement = match obj.get("placement").and_then(Value::as_str) {
        Some("corner") => "corner",
        _ => "tile",
    };

    Some(SurfaceMotifSettings {
        id: id.to_string(),
        scale: clamp_f64(obj.get("scale"), 8.0, 400.0, 120.0),
        opacity: clamp_f64(obj.get("opacity"), 0.0, 1.0, 0.08),
        ink: Some(ink.to_string()),
        ink_color,
        weight: Some(clamp_f64(obj.get("weight"), 0.005, 1.0, 0.055)),
        blend,
        placement: Some(placement.to_string()),
        anchor,
        anchors,
        spread: Some(clamp_f64(obj.get("spread"), 120.0, 2400.0, 720.0)),
        fade: Some(clamp_f64(obj.get("fade"), 0.05, 1.0, 0.62)),
        fill: Some(clamp_f64(obj.get("fill"), 0.0, 1.0, 0.0)),
        outline: Some(clamp_f64(obj.get("outline"), 0.0, 1.0, 0.0)),
        outline_ink,
        animation,
        animation_speed: Some(clamp_f64(obj.get("animationSpeed"), 0.25, 4.0, 1.0)),
        animation_repeat: Some(read_bool(obj.get("animationRepeat"), false)),
    })
}

fn read_surface(value: Option<&Value>, fallback: &SurfaceSettings) -> SurfaceSettings {
    let Some(obj) = value.and_then(Value::as_object) else {
        return fallback.clone();
    };
    let motif = read_surface_pattern_spec(obj.get("motif"));
    SurfaceSettings {
        intensity: clamp_f64(obj.get("intensity"), 0.0, 1.0, fallback.intensity),
        translucency: read_bool(obj.get("translucency"), fallback.translucency),
        texture: read_bool(obj.get("texture"), fallback.texture),
        window_vibrancy: read_bool(obj.get("windowVibrancy"), fallback.window_vibrancy),
        animate_motifs: read_bool(obj.get("animateMotifs"), fallback.animate_motifs),
        plain_chat_surface: read_bool(obj.get("plainChatSurface"), fallback.plain_chat_surface),
        motif,
    }
}

fn read_custom_surface_packs(value: Option<&Value>) -> Vec<CustomSurfacePack> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(id) = obj.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !is_slug_with_prefix(id, "custom-") {
            continue;
        }
        let Some(name_raw) = obj.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name_raw.trim().is_empty() {
            continue;
        }
        let Some(desc_raw) = obj.get("description").and_then(Value::as_str) else {
            continue;
        };
        let Some(tokens_obj) = obj.get("tokens").and_then(Value::as_object) else {
            continue;
        };

        let base_pack_id = obj
            .get("basePackId")
            .and_then(Value::as_str)
            .filter(|s| is_plain_slug(s))
            .map(ToString::to_string);

        let pattern = read_surface_pattern_spec(obj.get("pattern"));

        let mut tokens = BTreeMap::new();
        for (k, v) in tokens_obj {
            if SURFACE_TOKEN_KEYS.contains(&k.as_str())
                && let Some(val_str) = v.as_str()
            {
                tokens.insert(k.clone(), val_str.to_string());
            }
        }

        out.push(CustomSurfacePack {
            id: id.to_string(),
            name: name_raw.trim().chars().take(80).collect(),
            description: desc_raw.chars().take(240).collect(),
            base_pack_id,
            tokens,
            pattern,
        });
    }
    out
}

fn legacy_surface_motif(value: Option<&Value>) -> Option<SurfaceMotifSettings> {
    match value.and_then(Value::as_str) {
        Some("blueprint") => Some(SurfaceMotifSettings {
            id: "grid".to_string(),
            scale: 104.0,
            opacity: 0.3,
            ink: Some("accent".to_string()),
            ink_color: None,
            weight: None,
            blend: None,
            placement: None,
            anchor: None,
            anchors: None,
            spread: None,
            fade: None,
            fill: None,
            outline: None,
            outline_ink: None,
            animation: None,
            animation_speed: None,
            animation_repeat: None,
        }),
        Some("binary") => Some(SurfaceMotifSettings {
            id: "binary".to_string(),
            scale: 112.0,
            opacity: 0.2,
            ink: Some("accent".to_string()),
            ink_color: None,
            weight: None,
            blend: None,
            placement: None,
            anchor: None,
            anchors: None,
            spread: None,
            fade: None,
            fill: None,
            outline: None,
            outline_ink: None,
            animation: None,
            animation_speed: None,
            animation_repeat: None,
        }),
        _ => None,
    }
}

fn read_priority_colors(value: Option<&Value>) -> BTreeMap<String, String> {
    let defaults = default_priority_colors();
    let Some(obj) = value.and_then(Value::as_object) else {
        return defaults;
    };
    let mut next = BTreeMap::new();
    for &name in PRIORITY_NAMES {
        if let Some(raw) = obj.get(name).and_then(Value::as_str)
            && is_accepted_color(raw)
        {
            next.insert(name.to_string(), raw.trim().to_string());
        } else if let Some(def) = defaults.get(name) {
            next.insert(name.to_string(), def.clone());
        }
    }
    next
}

fn read_looks(value: Option<&Value>, fallback: &[AppearanceLook]) -> Vec<AppearanceLook> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return fallback.to_vec();
    };
    let default_appearance = default_app_settings().appearance;
    let mut out = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(id) = obj.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !is_slug_with_prefix(id, "look-") {
            continue;
        }
        let Some(name_raw) = obj.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name_raw.trim().is_empty() {
            continue;
        }
        let Some(theme_id) = obj.get("themeId").and_then(Value::as_str) else {
            continue;
        };
        if !is_plain_slug(theme_id) {
            continue;
        }
        let Some(surface_pack_id) = obj.get("surfacePackId").and_then(Value::as_str) else {
            continue;
        };
        if !is_plain_slug(surface_pack_id) {
            continue;
        }

        let legacy_motif = legacy_surface_motif(obj.get("surfacePackId"));
        let mut surface = read_surface(obj.get("surface"), &default_appearance.surface);
        if let Some(motif) = legacy_motif.clone()
            && surface.motif.is_none()
        {
            surface.motif = Some(motif);
        }

        out.push(AppearanceLook {
            id: id.to_string(),
            name: name_raw.trim().chars().take(80).collect(),
            theme_id: theme_id.to_string(),
            theme_mode: read_theme_mode(obj.get("themeMode"), &default_appearance.theme_mode),
            surface_pack_id: if legacy_motif.is_some() {
                "parchment".to_string()
            } else {
                surface_pack_id.to_string()
            },
            surface,
            priority_colors: read_priority_colors(obj.get("priorityColors")),
            show_brand_artwork: read_bool(
                obj.get("showBrandArtwork"),
                default_appearance.show_brand_artwork,
            ),
        });
    }
    out
}

fn migrated_surface_pack_id(appearance: &Map<String, Value>) -> String {
    let d = default_app_settings().appearance;
    let custom_themes_empty = appearance
        .get("customThemes")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    let untouched = read_string(appearance.get("themeId"), &d.theme_id) == d.theme_id
        && read_theme_mode(appearance.get("themeMode"), &d.theme_mode) == d.theme_mode
        && read_bool(appearance.get("showBrandArtwork"), d.show_brand_artwork)
            == d.show_brand_artwork
        && custom_themes_empty
        && read_priority_colors(appearance.get("priorityColors")) == d.priority_colors;
    if untouched {
        d.surface_pack_id
    } else {
        "flat".to_string()
    }
}

fn read_surface_pack_id(value: Option<&Value>, appearance: &Map<String, Value>) -> String {
    if let Some(s) = value.and_then(Value::as_str)
        && is_plain_slug(s)
    {
        return if legacy_surface_motif(value).is_some() {
            "parchment".to_string()
        } else {
            s.to_string()
        };
    }
    migrated_surface_pack_id(appearance)
}

fn read_terminal_cursor_style(value: Option<&Value>, fallback: &str) -> String {
    match value.and_then(Value::as_str) {
        Some("block" | "underline" | "bar") => value
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
        _ => fallback.to_string(),
    }
}

fn known_provider_ids(custom_providers: &[CustomProviderConfig]) -> Vec<String> {
    let mut ids: Vec<String> = KNOWN_AI_PROVIDERS
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    for cp in custom_providers {
        ids.push(cp.id.clone());
    }
    ids
}

fn read_ai_provider(value: Option<&Value>, fallback: &str, known: &[String]) -> String {
    if let Some(s) = value.and_then(Value::as_str)
        && known.iter().any(|k| k == s)
    {
        return s.to_string();
    }
    fallback.to_string()
}

fn read_optional_ai_provider(value: Option<&Value>, known: &[String]) -> Option<String> {
    let s = value?.as_str()?;
    known.iter().any(|k| k == s).then(|| s.to_string())
}

fn read_model_tiers(value: Option<&Value>) -> BTreeMap<String, ModelTierConfig> {
    let mut result = BTreeMap::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return result;
    };
    for (provider, raw) in obj {
        let Some(raw_obj) = raw.as_object() else {
            continue;
        };
        let fast = raw_obj
            .get("fast")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let standard = raw_obj
            .get("standard")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let strong = raw_obj
            .get("strong")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let entry = ModelTierConfig {
            fast,
            standard,
            strong,
        };
        if !entry.is_empty() {
            result.insert(provider.clone(), entry);
        }
    }
    result
}

fn read_ai_provider_configs(
    value: Option<&Value>,
    known: &[String],
) -> BTreeMap<String, AiProviderConfig> {
    let mut out = BTreeMap::new();
    let Some(obj) = value.and_then(Value::as_object) else {
        return out;
    };
    for id in known {
        let Some(raw) = obj.get(id).and_then(Value::as_object) else {
            continue;
        };
        let mut config = AiProviderConfig::default();
        if let Some(s) = raw.get("baseUrl").and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            config.base_url = Some(s.to_string());
        }
        if let Some(s) = raw.get("defaultModel").and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            config.default_model = Some(s.to_string());
        }
        if let Some(s) = raw.get("cliPath").and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            config.cli_path = Some(s.to_string());
        }
        if let Some(arr) = raw.get("enabledModelIds").and_then(Value::as_array)
            && arr.iter().all(Value::is_string)
        {
            config.enabled_model_ids = Some(
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect(),
            );
        }
        if let Some(arr) = raw.get("knownModelIds").and_then(Value::as_array)
            && arr.iter().all(Value::is_string)
        {
            config.known_model_ids = Some(
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect(),
            );
        }
        if let Some(b) = raw.get("enabled").and_then(Value::as_bool) {
            config.enabled = Some(b);
        }
        if let Some(b) = raw.get("added").and_then(Value::as_bool) {
            config.added = Some(b);
        }
        if let Some(defaults_obj) = raw.get("modelReasoningDefaults").and_then(Value::as_object) {
            let mut levels = BTreeMap::new();
            for (model_id, level) in defaults_obj {
                if let Some(level_str) = level.as_str()
                    && REASONING_EFFORT_LEVELS.contains(&level_str)
                {
                    levels.insert(model_id.clone(), level_str.to_string());
                }
            }
            if !levels.is_empty() {
                config.model_reasoning_defaults = Some(levels);
            }
        }
        if !config.is_empty() {
            out.insert(id.clone(), config);
        }
    }
    out
}

fn read_browser_tools(value: Option<&Value>) -> BrowserToolsSettings {
    let fallback = default_app_settings().ai.browser_tools;
    let Some(obj) = value.and_then(Value::as_object) else {
        return fallback;
    };
    let mut allowed_hosts = Vec::new();
    let mut seen = HashSet::new();
    if let Some(arr) = obj.get("allowedHosts").and_then(Value::as_array) {
        for item in arr {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                let lower = s.to_ascii_lowercase();
                if seen.insert(lower.clone()) {
                    allowed_hosts.push(lower);
                }
            }
        }
    }
    BrowserToolsSettings {
        enabled: read_bool(obj.get("enabled"), fallback.enabled),
        allowed_hosts,
    }
}

fn read_native_sources(value: Option<&Value>) -> NativeSourceSettings {
    let fallback = default_app_settings().ai.native_sources;
    let Some(obj) = value.and_then(Value::as_object) else {
        return fallback;
    };
    let mut ecosystems = BTreeMap::new();
    if let Some(eco_obj) = obj.get("ecosystems").and_then(Value::as_object) {
        for &eco in NATIVE_ECOSYSTEMS {
            if let Some(b) = eco_obj.get(eco).and_then(Value::as_bool) {
                ecosystems.insert(eco.to_string(), b);
            }
        }
    }
    let instruction_source = match obj.get("instructionSource").and_then(Value::as_str) {
        Some(s) if s == "all" || NATIVE_ECOSYSTEMS.contains(&s) => s.to_string(),
        _ => fallback.instruction_source,
    };
    NativeSourceSettings {
        ecosystems,
        approved_projects: read_string_list(obj.get("approvedProjects"), &[]),
        inject_instructions: read_bool(obj.get("injectInstructions"), fallback.inject_instructions),
        instruction_source,
        extra_skill_paths: read_string_list(obj.get("extraSkillPaths"), &[]),
        extra_agent_paths: read_string_list(obj.get("extraAgentPaths"), &[]),
    }
}

fn read_working_style(value: Option<&Value>) -> WorkingStyleSettings {
    let fallback = default_app_settings().ai.working_style;
    let Some(obj) = value.and_then(Value::as_object) else {
        return fallback;
    };
    WorkingStyleSettings {
        enabled: read_bool(obj.get("enabled"), fallback.enabled),
        text: read_string(obj.get("text"), &fallback.text),
    }
}

fn read_code_intelligence(value: Option<&Value>) -> CodeIntelligenceSettings {
    let Some(obj) = value.and_then(Value::as_object) else {
        return CodeIntelligenceSettings {
            enabled: true,
            project_overrides: Some(BTreeMap::new()),
            search_mode: None,
            project_search_modes: None,
        };
    };
    let enabled = read_bool(obj.get("enabled"), true);
    let mut project_overrides = BTreeMap::new();
    if let Some(po_obj) = obj.get("projectOverrides").and_then(Value::as_object) {
        for (k, v) in po_obj {
            if let Some(b) = v.as_bool() {
                project_overrides.insert(k.clone(), b);
            }
        }
    }
    let search_mode = match obj.get("searchMode").and_then(Value::as_str) {
        Some(s @ ("hybrid" | "lexical" | "vector")) => Some(s.to_string()),
        _ => None,
    };
    let mut project_search_modes = BTreeMap::new();
    if let Some(psm_obj) = obj.get("projectSearchModes").and_then(Value::as_object) {
        for (k, v) in psm_obj {
            if let Some(s @ ("hybrid" | "lexical" | "vector")) = v.as_str() {
                project_search_modes.insert(k.clone(), s.to_string());
            }
        }
    }
    CodeIntelligenceSettings {
        enabled,
        project_overrides: Some(project_overrides),
        search_mode,
        project_search_modes: (!project_search_modes.is_empty()).then_some(project_search_modes),
    }
}

/// Coerces an arbitrary JSON value into a valid [`AppSettings`], filling missing or invalid
/// fields from [`default_app_settings`] and running migrations (`sanitizeAppSettings`).
#[must_use]
pub fn sanitize_app_settings(raw: &Value) -> AppSettings {
    let defaults = default_app_settings();
    let root = raw.as_object();

    let raw_ai = root.and_then(|r| r.get("ai")).and_then(Value::as_object);
    let custom_providers = raw_ai
        .map(|ai| sanitize_custom_providers(ai.get("customProviders")))
        .unwrap_or_default();
    let mcp_servers = raw_ai
        .map(|ai| sanitize_mcp_servers(ai.get("mcpServers")))
        .unwrap_or_default();
    let known_providers = known_provider_ids(&custom_providers);

    let ai = if let Some(ai_obj) = raw_ai {
        let prompt_analysis_model = read_string(ai_obj.get("promptAnalysisModel"), "")
            .trim()
            .to_string();
        let handover = clamp_f64(
            ai_obj.get("providerHandoverPercent"),
            50.0,
            100.0,
            f64::from(defaults.ai.provider_handover_percent),
        )
        .round() as u32;
        AiSettings {
            gateway_url: read_string(ai_obj.get("gatewayUrl"), &defaults.ai.gateway_url),
            default_model: read_string(ai_obj.get("defaultModel"), &defaults.ai.default_model),
            agent_name: read_string(ai_obj.get("agentName"), &defaults.ai.agent_name),
            activity_words: Some(sanitize_activity_words(ai_obj.get("activityWords"))),
            working_directory: read_string(
                ai_obj.get("workingDirectory"),
                &defaults.ai.working_directory,
            ),
            analysis_prompt: read_string(
                ai_obj.get("analysisPrompt"),
                &defaults.ai.analysis_prompt,
            ),
            analysis_gate_enabled: read_bool(
                ai_obj.get("analysisGateEnabled"),
                defaults.ai.analysis_gate_enabled,
            ),
            spend_limit: clamp_f64(
                ai_obj.get("spendLimit"),
                0.0,
                9_007_199_254_740_991.0,
                defaults.ai.spend_limit,
            ),
            provider_handover_percent: handover,
            active_provider: read_ai_provider(
                ai_obj.get("activeProvider"),
                &defaults.ai.active_provider,
                &known_providers,
            ),
            recommendation_provider: read_optional_ai_provider(
                ai_obj.get("recommendationProvider"),
                &known_providers,
            ),
            prompt_analysis_provider: read_optional_ai_provider(
                ai_obj.get("promptAnalysisProvider"),
                &known_providers,
            ),
            prompt_analysis_model: (!prompt_analysis_model.is_empty())
                .then_some(prompt_analysis_model),
            model_tiers: Some(read_model_tiers(ai_obj.get("modelTiers"))),
            providers: read_ai_provider_configs(ai_obj.get("providers"), &known_providers),
            custom_providers: (!custom_providers.is_empty()).then_some(custom_providers),
            mcp_servers: (!mcp_servers.is_empty()).then_some(mcp_servers),
            browser_tools: read_browser_tools(ai_obj.get("browserTools")),
            native_sources: read_native_sources(ai_obj.get("nativeSources")),
            working_style: read_working_style(ai_obj.get("workingStyle")),
            code_intelligence: Some(read_code_intelligence(ai_obj.get("codeIntelligence"))),
        }
    } else {
        defaults.ai.clone()
    };

    let jira = if let Some(jira_obj) = root.and_then(|r| r.get("jira")).and_then(Value::as_object) {
        JiraSettings {
            site_url: read_string(jira_obj.get("siteUrl"), &defaults.jira.site_url),
            default_project_key: read_string(
                jira_obj.get("defaultProjectKey"),
                &defaults.jira.default_project_key,
            ),
            epic_key: read_string(jira_obj.get("epicKey"), &defaults.jira.epic_key),
            epic_board_name: read_string(
                jira_obj.get("epicBoardName"),
                &defaults.jira.epic_board_name,
            ),
            board_jql: read_string(jira_obj.get("boardJql"), &defaults.jira.board_jql),
            board_name: read_string(jira_obj.get("boardName"), &defaults.jira.board_name),
        }
    } else {
        defaults.jira
    };

    let performance = if let Some(perf_obj) = root
        .and_then(|r| r.get("performance"))
        .and_then(Value::as_object)
    {
        PerformanceSettings {
            request_timeout_ms: clamp_f64(
                perf_obj.get("requestTimeoutMs"),
                1000.0,
                9_007_199_254_740_991.0,
                defaults.performance.request_timeout_ms as f64,
            ) as u64,
            default_page_size: clamp_f64(
                perf_obj.get("defaultPageSize"),
                5.0,
                100.0,
                f64::from(defaults.performance.default_page_size),
            ) as u32,
        }
    } else {
        defaults.performance
    };

    let delivery = if let Some(del_obj) = root
        .and_then(|r| r.get("delivery"))
        .and_then(Value::as_object)
    {
        DeliverySettings {
            default_base_branch: read_string(
                del_obj.get("defaultBaseBranch"),
                &defaults.delivery.default_base_branch,
            ),
            auto_merge_sub_tasks: read_bool(
                del_obj.get("autoMergeSubTasks"),
                defaults.delivery.auto_merge_sub_tasks,
            ),
            enabled: read_bool(del_obj.get("enabled"), defaults.delivery.enabled),
            publish_command: read_string(
                del_obj.get("publishCommand"),
                &defaults.delivery.publish_command,
            ),
            artifact_pattern: read_string(
                del_obj.get("artifactPattern"),
                &defaults.delivery.artifact_pattern,
            ),
            run_confirm_agent_sessions: clamp_f64(
                del_obj.get("runConfirmAgentSessions"),
                1.0,
                1000.0,
                f64::from(defaults.delivery.run_confirm_agent_sessions),
            ) as u32,
        }
    } else {
        defaults.delivery
    };

    let mcp_server = if let Some(mcp_obj) = root
        .and_then(|r| r.get("mcpServer"))
        .and_then(Value::as_object)
    {
        McpServerSettings {
            workspace_server_name: read_string(
                mcp_obj.get("workspaceServerName"),
                &defaults.mcp_server.workspace_server_name,
            ),
            user_server_ref: read_string(
                mcp_obj.get("userServerRef"),
                &defaults.mcp_server.user_server_ref,
            ),
        }
    } else {
        defaults.mcp_server
    };

    let startup = if let Some(startup_obj) = root
        .and_then(|r| r.get("startup"))
        .and_then(Value::as_object)
    {
        StartupSettings {
            reopen_last_workspace: read_bool(
                startup_obj.get("reopenLastWorkspace"),
                defaults.startup.reopen_last_workspace,
            ),
        }
    } else {
        defaults.startup
    };

    let marketplace = if let Some(mp_obj) = root
        .and_then(|r| r.get("marketplace"))
        .and_then(Value::as_object)
    {
        let owner_type = match mp_obj.get("ownerType").and_then(Value::as_str) {
            Some("org") => "org".to_string(),
            _ => "user".to_string(),
        };
        MarketplaceSettings {
            enabled: read_bool(mp_obj.get("enabled"), defaults.marketplace.enabled),
            owner: read_string(mp_obj.get("owner"), &defaults.marketplace.owner),
            owner_type,
            package_name_prefix: read_string(
                mp_obj.get("packageNamePrefix"),
                &defaults.marketplace.package_name_prefix,
            ),
            api_base_url: read_string(mp_obj.get("apiBaseUrl"), &defaults.marketplace.api_base_url),
            registry_base_url: read_string(
                mp_obj.get("registryBaseUrl"),
                &defaults.marketplace.registry_base_url,
            ),
            check_on_launch: read_bool(
                mp_obj.get("checkOnLaunch"),
                defaults.marketplace.check_on_launch,
            ),
        }
    } else {
        defaults.marketplace
    };

    let preview = if let Some(prev_obj) = root
        .and_then(|r| r.get("preview"))
        .and_then(Value::as_object)
    {
        PreviewSettings {
            enable_easy_mode: read_bool(
                prev_obj.get("enableEasyMode"),
                defaults.preview.enable_easy_mode,
            ),
            enable_deployments: read_bool(
                prev_obj.get("enableDeployments"),
                defaults.preview.enable_deployments,
            ),
        }
    } else {
        defaults.preview
    };

    let raw_appearance = root
        .and_then(|r| r.get("appearance"))
        .and_then(Value::as_object);
    let appearance_looks = match raw_appearance {
        Some(app_obj) => read_looks(app_obj.get("looks"), &defaults.appearance.looks),
        None => read_looks(None, &defaults.appearance.looks),
    };
    let requested_look_id = match raw_appearance {
        Some(app_obj) => read_string(app_obj.get("activeLookId"), ""),
        None => defaults.appearance.active_look_id.clone(),
    };
    // A profile that chose a theme other than the default and other than its active Look's has
    // left that Look (editing the theme detaches it), so the Look must not override the choice.
    let chose_other_theme = raw_appearance
        .and_then(|a| a.get("themeId"))
        .and_then(Value::as_str)
        .filter(|theme| *theme != defaults.appearance.theme_id)
        .is_some_and(|theme| {
            appearance_looks
                .iter()
                .find(|look| look.id == requested_look_id)
                .is_some_and(|look| look.theme_id != theme)
        });
    let appearance_active_look_id = if !chose_other_theme
        && appearance_looks
            .iter()
            .any(|look| look.id == requested_look_id)
    {
        requested_look_id
    } else {
        String::new()
    };

    let raw_surface_pack_id = raw_appearance.and_then(|a| a.get("surfacePackId"));
    let legacy_active_motif = legacy_surface_motif(raw_surface_pack_id);
    let mut appearance_surface = read_surface(
        raw_appearance.and_then(|a| a.get("surface")),
        &defaults.appearance.surface,
    );
    if let Some(motif) = legacy_active_motif
        && appearance_surface.motif.is_none()
    {
        appearance_surface.motif = Some(motif);
    }

    let appearance = if let Some(app_obj) = raw_appearance {
        AppearanceSettings {
            display_mode: read_display_mode(
                app_obj.get("displayMode"),
                &defaults.appearance.display_mode,
            ),
            show_brand_artwork: read_bool(
                app_obj.get("showBrandArtwork"),
                defaults.appearance.show_brand_artwork,
            ),
            priority_colors: read_priority_colors(app_obj.get("priorityColors")),
            theme_id: read_string(app_obj.get("themeId"), &defaults.appearance.theme_id),
            theme_mode: read_theme_mode(app_obj.get("themeMode"), &defaults.appearance.theme_mode),
            accent_color: read_accent_color(app_obj.get("accentColor")),
            installed_theme_ids: read_theme_ids(
                app_obj.get("installedThemeIds"),
                &defaults.appearance.installed_theme_ids,
            ),
            custom_themes: read_custom_themes(app_obj.get("customThemes")),
            surface_pack_id: read_surface_pack_id(app_obj.get("surfacePackId"), app_obj),
            surface: appearance_surface,
            installed_surface_pack_ids: read_theme_ids(
                app_obj.get("installedSurfacePackIds"),
                &defaults.appearance.installed_surface_pack_ids,
            ),
            custom_surface_packs: read_custom_surface_packs(app_obj.get("customSurfacePacks")),
            looks: appearance_looks,
            active_look_id: appearance_active_look_id,
            zoom_factor: clamp_f64(
                app_obj.get("zoomFactor"),
                0.7,
                1.5,
                defaults.appearance.zoom_factor,
            ),
        }
    } else {
        AppearanceSettings {
            looks: appearance_looks,
            active_look_id: appearance_active_look_id,
            ..defaults.appearance
        }
    };

    let git = if let Some(git_obj) = root.and_then(|r| r.get("git")).and_then(Value::as_object) {
        GitSettings {
            executable_path: read_string(
                git_obj.get("executablePath"),
                &defaults.git.executable_path,
            ),
            default_branch: read_string(git_obj.get("defaultBranch"), &defaults.git.default_branch),
            fetch_interval_minutes: clamp_f64(
                git_obj.get("fetchIntervalMinutes"),
                0.0,
                1440.0,
                f64::from(defaults.git.fetch_interval_minutes),
            ) as u32,
        }
    } else {
        defaults.git
    };

    let git_visual = if let Some(gv_obj) = root
        .and_then(|r| r.get("gitVisual"))
        .and_then(Value::as_object)
    {
        let orientation = match gv_obj.get("orientation").and_then(Value::as_str) {
            Some("horizontal") => "horizontal".to_string(),
            _ => "vertical".to_string(),
        };
        GitVisualSettings {
            branch_colors_enabled: read_bool(
                gv_obj.get("branchColorsEnabled"),
                defaults.git_visual.branch_colors_enabled,
            ),
            merge_markers_enabled: read_bool(
                gv_obj.get("mergeMarkersEnabled"),
                defaults.git_visual.merge_markers_enabled,
            ),
            orientation,
            performance_mode: read_bool(
                gv_obj.get("performanceMode"),
                defaults.git_visual.performance_mode,
            ),
        }
    } else {
        defaults.git_visual
    };

    let mobile_access = if let Some(ma_obj) = root
        .and_then(|r| r.get("mobileAccess"))
        .and_then(Value::as_object)
    {
        MobileAccessSettings {
            mode: read_mobile_access_mode(ma_obj.get("mode"), &defaults.mobile_access.mode),
            host_name: read_string(ma_obj.get("hostName"), &defaults.mobile_access.host_name),
            allowed_interfaces: read_string_list(
                ma_obj.get("allowedInterfaces"),
                &defaults.mobile_access.allowed_interfaces,
            ),
            allowed_subnets: read_mobile_subnets(
                ma_obj.get("allowedSubnets"),
                &defaults.mobile_access.allowed_subnets,
            ),
            listen_port: clamp_f64(
                ma_obj.get("listenPort"),
                1024.0,
                65535.0,
                f64::from(defaults.mobile_access.listen_port),
            ) as u16,
            remote_sign_in_required: read_bool(
                ma_obj.get("remoteSignInRequired"),
                defaults.mobile_access.remote_sign_in_required,
            ),
        }
    } else {
        defaults.mobile_access
    };

    let terminal = if let Some(term_obj) = root
        .and_then(|r| r.get("terminal"))
        .and_then(Value::as_object)
    {
        TerminalSettings {
            default_profile_id: read_string(
                term_obj.get("defaultProfileId"),
                &defaults.terminal.default_profile_id,
            ),
            font_family: read_string(term_obj.get("fontFamily"), &defaults.terminal.font_family),
            font_size: clamp_f64(
                term_obj.get("fontSize"),
                9.0,
                32.0,
                defaults.terminal.font_size,
            ),
            line_height: clamp_f64(
                term_obj.get("lineHeight"),
                0.9,
                2.0,
                defaults.terminal.line_height,
            ),
            cursor_style: read_terminal_cursor_style(
                term_obj.get("cursorStyle"),
                &defaults.terminal.cursor_style,
            ),
            cursor_blink: read_bool(term_obj.get("cursorBlink"), defaults.terminal.cursor_blink),
            scrollback: clamp_f64(
                term_obj.get("scrollback"),
                100.0,
                100_000.0,
                f64::from(defaults.terminal.scrollback),
            ) as u32,
            copy_on_selection: read_bool(
                term_obj.get("copyOnSelection"),
                defaults.terminal.copy_on_selection,
            ),
            confirm_paste: read_bool(
                term_obj.get("confirmPaste"),
                defaults.terminal.confirm_paste,
            ),
            bell_sound: read_bool(term_obj.get("bellSound"), defaults.terminal.bell_sound),
            shell_integration: read_bool(
                term_obj.get("shellIntegration"),
                defaults.terminal.shell_integration,
            ),
            gpu_acceleration: read_bool(
                term_obj.get("gpuAcceleration"),
                defaults.terminal.gpu_acceleration,
            ),
        }
    } else {
        defaults.terminal
    };

    let notifications = if let Some(notif_obj) = root
        .and_then(|r| r.get("notifications"))
        .and_then(Value::as_object)
    {
        TaskNotificationSettings {
            completed: read_bool(notif_obj.get("completed"), defaults.notifications.completed),
            failed: read_bool(notif_obj.get("failed"), defaults.notifications.failed),
            needs_attention: read_bool(
                notif_obj.get("needsAttention"),
                defaults.notifications.needs_attention,
            ),
            sound: read_bool(notif_obj.get("sound"), defaults.notifications.sound),
            suppress_when_viewing: read_bool(
                notif_obj.get("suppressWhenViewing"),
                defaults.notifications.suppress_when_viewing,
            ),
        }
    } else {
        defaults.notifications
    };

    AppSettings {
        notifications,
        ai,
        jira,
        performance,
        delivery,
        mcp_server,
        startup,
        marketplace,
        preview,
        appearance,
        terminal,
        git,
        git_visual,
        mobile_access,
    }
}

fn merge_json_objects(base: &mut Map<String, Value>, patch: &Map<String, Value>) {
    for (k, v) in patch {
        if v.is_null() {
            base.remove(k);
        } else {
            base.insert(k.clone(), v.clone());
        }
    }
}

fn mirror_active_look(
    appearance: &mut AppearanceSettings,
    patch_appearance: Option<&Map<String, Value>>,
) {
    let Some(patch_app) = patch_appearance else {
        return;
    };
    if !patch_app.is_empty() && patch_app.keys().all(|k| k == "accentColor") {
        return;
    }
    if patch_app.get("activeLookId").is_some_and(|v| !v.is_null())
        || patch_app.get("looks").is_some_and(|v| !v.is_null())
    {
        return;
    }
    let id = appearance.active_look_id.clone();
    if id.is_empty() {
        return;
    }
    if BUILT_IN_LOOK_IDS.contains(&id.as_str()) {
        appearance.active_look_id.clear();
        return;
    }
    if let Some(look) = appearance.looks.iter_mut().find(|l| l.id == id) {
        look.theme_id = appearance.theme_id.clone();
        look.theme_mode = appearance.theme_mode.clone();
        look.surface_pack_id = appearance.surface_pack_id.clone();
        look.surface = appearance.surface.clone();
        look.priority_colors = appearance.priority_colors.clone();
        look.show_brand_artwork = appearance.show_brand_artwork;
    }
}

/// Deep-merges a partial JSON patch over `base` (`mergeAppSettings`), returning a new
/// [`AppSettings`] without mutating `base`.
#[must_use]
pub fn merge_app_settings(base: &AppSettings, patch: &Value) -> AppSettings {
    let Some(patch_root) = patch.as_object() else {
        return base.clone();
    };

    let mut base_val = serde_json::to_value(base).unwrap_or_else(|_| json!({}));
    let Some(base_root) = base_val.as_object_mut() else {
        return base.clone();
    };

    // Merge simple 1-level sections
    for section in [
        "notifications",
        "jira",
        "performance",
        "delivery",
        "mcpServer",
        "startup",
        "marketplace",
        "preview",
        "terminal",
        "git",
        "gitVisual",
        "mobileAccess",
    ] {
        if let Some(patch_sec) = patch_root.get(section).and_then(Value::as_object)
            && let Some(base_sec) = base_root.get_mut(section).and_then(Value::as_object_mut)
        {
            merge_json_objects(base_sec, patch_sec);
        }
    }

    // Merge `ai` section
    if let Some(patch_ai) = patch_root.get("ai").and_then(Value::as_object)
        && let Some(base_ai) = base_root.get_mut("ai").and_then(Value::as_object_mut)
    {
        let custom_providers = if patch_ai.contains_key("customProviders") {
            sanitize_custom_providers(patch_ai.get("customProviders"))
        } else {
            base.ai.custom_providers.clone().unwrap_or_default()
        };
        let known_ids = known_provider_ids(&custom_providers);

        for (k, v) in patch_ai {
            if matches!(
                k.as_str(),
                "providers"
                    | "browserTools"
                    | "nativeSources"
                    | "workingStyle"
                    | "codeIntelligence"
                    | "customProviders"
                    | "mcpServers"
            ) {
                continue;
            }
            if v.is_null() {
                base_ai.remove(k);
            } else {
                base_ai.insert(k.clone(), v.clone());
            }
        }

        if let Some(patch_providers) = patch_ai.get("providers").and_then(Value::as_object)
            && let Some(base_providers) =
                base_ai.get_mut("providers").and_then(Value::as_object_mut)
        {
            for id in &known_ids {
                if let Some(patch_cfg) = patch_providers.get(id).and_then(Value::as_object) {
                    let entry = base_providers
                        .entry(id.clone())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Some(entry_obj) = entry.as_object_mut() {
                        merge_json_objects(entry_obj, patch_cfg);
                    }
                }
            }
        }

        if let Some(patch_bt) = patch_ai.get("browserTools").and_then(Value::as_object)
            && let Some(base_bt) = base_ai
                .get_mut("browserTools")
                .and_then(Value::as_object_mut)
        {
            merge_json_objects(base_bt, patch_bt);
        }

        if let Some(patch_ns) = patch_ai.get("nativeSources").and_then(Value::as_object)
            && let Some(base_ns) = base_ai
                .get_mut("nativeSources")
                .and_then(Value::as_object_mut)
        {
            let mut merged_ecosystems = base_ns
                .get("ecosystems")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(patch_eco) = patch_ns.get("ecosystems").and_then(Value::as_object) {
                merge_json_objects(&mut merged_ecosystems, patch_eco);
            }
            merge_json_objects(base_ns, patch_ns);
            base_ns.insert("ecosystems".to_string(), Value::Object(merged_ecosystems));
        }

        if let Some(patch_ws) = patch_ai.get("workingStyle").and_then(Value::as_object)
            && let Some(base_ws) = base_ai
                .get_mut("workingStyle")
                .and_then(Value::as_object_mut)
        {
            merge_json_objects(base_ws, patch_ws);
        }

        if let Some(patch_ci) = patch_ai.get("codeIntelligence").and_then(Value::as_object) {
            let base_ci = base_ai
                .entry("codeIntelligence".to_string())
                .or_insert_with(|| json!({ "enabled": true, "projectOverrides": {} }));
            if let Some(base_ci_obj) = base_ci.as_object_mut() {
                if let Some(enabled) = patch_ci.get("enabled").and_then(Value::as_bool) {
                    base_ci_obj.insert("enabled".to_string(), Value::Bool(enabled));
                }
                if let Some(po) = patch_ci.get("projectOverrides").and_then(Value::as_object) {
                    let target_po = base_ci_obj
                        .entry("projectOverrides".to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Some(target_po_obj) = target_po.as_object_mut() {
                        merge_json_objects(target_po_obj, po);
                    }
                }
                if let Some(sm) = patch_ci.get("searchMode") {
                    if sm.is_null() {
                        base_ci_obj.remove("searchMode");
                    } else {
                        base_ci_obj.insert("searchMode".to_string(), sm.clone());
                    }
                }
                if let Some(psm) = patch_ci
                    .get("projectSearchModes")
                    .and_then(Value::as_object)
                {
                    let target_psm = base_ci_obj
                        .entry("projectSearchModes".to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Some(target_psm_obj) = target_psm.as_object_mut() {
                        merge_json_objects(target_psm_obj, psm);
                    }
                }
            }
        }

        if custom_providers.is_empty() {
            base_ai.remove("customProviders");
        } else if let Ok(cp_val) = serde_json::to_value(&custom_providers) {
            base_ai.insert("customProviders".to_string(), cp_val);
        }

        let mcp_servers = if patch_ai.contains_key("mcpServers") {
            sanitize_mcp_servers(patch_ai.get("mcpServers"))
        } else {
            base.ai.mcp_servers.clone().unwrap_or_default()
        };
        if mcp_servers.is_empty() {
            base_ai.remove("mcpServers");
        } else if let Ok(mcp_val) = serde_json::to_value(&mcp_servers) {
            base_ai.insert("mcpServers".to_string(), mcp_val);
        }

        // Clean up references to removed custom endpoints
        let removed_ids: Vec<String> = base
            .ai
            .custom_providers
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter(|old| !custom_providers.iter().any(|kept| kept.id == old.id))
            .map(|old| old.id.clone())
            .collect();

        if !removed_ids.is_empty() {
            for id in &removed_ids {
                if let Some(providers) = base_ai.get_mut("providers").and_then(Value::as_object_mut)
                {
                    providers.remove(id);
                }
                if base_ai.get("activeProvider").and_then(Value::as_str) == Some(id.as_str()) {
                    base_ai.insert(
                        "activeProvider".to_string(),
                        Value::String("vercel-gateway".to_string()),
                    );
                }
                if base_ai
                    .get("recommendationProvider")
                    .and_then(Value::as_str)
                    == Some(id.as_str())
                {
                    base_ai.remove("recommendationProvider");
                }
                if base_ai
                    .get("promptAnalysisProvider")
                    .and_then(Value::as_str)
                    == Some(id.as_str())
                {
                    base_ai.remove("promptAnalysisProvider");
                    base_ai.remove("promptAnalysisModel");
                }
                if let Some(tiers) = base_ai.get_mut("modelTiers").and_then(Value::as_object_mut) {
                    tiers.remove(id);
                }
            }
        }
    }

    // Merge `appearance` section
    if let Some(patch_app) = patch_root.get("appearance").and_then(Value::as_object)
        && let Some(base_app) = base_root
            .get_mut("appearance")
            .and_then(Value::as_object_mut)
    {
        for (k, v) in patch_app {
            if matches!(
                k.as_str(),
                "surface" | "priorityColors" | "accentColor" | "zoomFactor"
            ) {
                continue;
            }
            if v.is_null() {
                base_app.remove(k);
            } else {
                base_app.insert(k.clone(), v.clone());
            }
        }
        if let Some(accent) = patch_app.get("accentColor") {
            base_app.insert(
                "accentColor".to_string(),
                Value::String(read_accent_color(Some(accent))),
            );
        }
        if let Some(zf) = patch_app.get("zoomFactor").and_then(Value::as_f64)
            && zf.is_finite()
        {
            let rounded = ((zf * 10.0).round() / 10.0).clamp(0.7, 1.5);
            base_app.insert("zoomFactor".to_string(), json!(rounded));
        }
        if let Some(patch_surface) = patch_app.get("surface").and_then(Value::as_object)
            && let Some(base_surface) = base_app.get_mut("surface").and_then(Value::as_object_mut)
        {
            merge_json_objects(base_surface, patch_surface);
        }
        if let Some(patch_pc) = patch_app.get("priorityColors").and_then(Value::as_object)
            && let Some(base_pc) = base_app
                .get_mut("priorityColors")
                .and_then(Value::as_object_mut)
        {
            merge_json_objects(base_pc, patch_pc);
        }
    }

    let mut next: AppSettings =
        serde_json::from_value(base_val).unwrap_or_else(|_| sanitize_app_settings(&Value::Null));

    // Deduplicate installedThemeIds / installedSurfacePackIds if patched
    if let Some(patch_app) = patch_root.get("appearance").and_then(Value::as_object) {
        if patch_app.contains_key("installedThemeIds") {
            let mut seen = HashSet::new();
            next.appearance
                .installed_theme_ids
                .retain(|id| seen.insert(id.clone()));
        }
        if patch_app.contains_key("installedSurfacePackIds") {
            let mut seen = HashSet::new();
            next.appearance
                .installed_surface_pack_ids
                .retain(|id| seen.insert(id.clone()));
        }
        mirror_active_look(&mut next.appearance, Some(patch_app));
    }

    next
}

/// Computes the platform-specific shared `settings.json` file path (`resolveSharedSettingsPath`).
#[must_use]
pub fn resolve_shared_settings_path(
    platform: &str,
    app_data: Option<&str>,
    xdg_config_home: Option<&str>,
    home: &str,
) -> String {
    let sep = if platform == "win32" { "\\" } else { "/" };
    let join = |parts: &[&str]| -> String {
        parts
            .iter()
            .copied()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(sep)
            .trim_end_matches(['\\', '/'])
            .to_string()
    };

    if platform == "win32" {
        let base = app_data
            .map(ToString::to_string)
            .unwrap_or_else(|| join(&[home, "AppData", "Roaming"]));
        return join(&[&base, "praxis", "settings.json"]);
    }
    if platform == "darwin" {
        return join(&[
            home,
            "Library",
            "Application Support",
            "praxis",
            "settings.json",
        ]);
    }
    let base = xdg_config_home
        .map(ToString::to_string)
        .unwrap_or_else(|| join(&[home, ".config"]));
    join(&[&base, "praxis", "settings.json"])
}

/// Atomic file-backed store for the shared `settings.json` document.
/// Preserves non-`AppSettings` root keys (such as `connections` and `boards`) on write.
#[derive(Debug, Clone)]
pub struct SharedSettingsStore {
    file_path: PathBuf,
}

impl SharedSettingsStore {
    /// Creates a store targeting `file_path`.
    #[must_use]
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
        }
    }

    /// Returns the underlying `settings.json` path.
    #[must_use]
    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// Reads and sanitizes the current `AppSettings` from disk, falling back to defaults if absent or corrupt.
    #[must_use]
    pub fn read(&self) -> AppSettings {
        let raw = self.read_raw_disk();
        sanitize_app_settings(&raw)
    }

    /// Merges `patch` over the current settings, sanitizes the result, and persists atomically to disk.
    ///
    /// # Errors
    /// Returns an error if `patch` contains invalid mobile subnets or if disk persistence fails.
    pub fn write(&self, patch: &Value) -> io::Result<AppSettings> {
        if let Some(subnets) = patch
            .get("mobileAccess")
            .and_then(|m| m.get("allowedSubnets"))
            .and_then(Value::as_array)
        {
            for item in subnets {
                let Some(s) = item.as_str() else {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Allowed mobile subnets must be IP addresses or CIDRs, for example 192.168.1.0/24.",
                    ));
                };
                if normalize_mobile_subnet(s).is_none() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "Allowed mobile subnets must be IP addresses or CIDRs, for example 192.168.1.0/24.",
                    ));
                }
            }
        }

        let current = self.read();
        let merged = merge_app_settings(&current, patch);
        let merged_val = serde_json::to_value(&merged).unwrap_or_else(|_| json!({}));
        let sanitized = sanitize_app_settings(&merged_val);
        self.persist(&sanitized)?;
        Ok(sanitized)
    }

    fn read_raw_disk(&self) -> Value {
        let Ok(raw) = fs::read_to_string(&self.file_path) else {
            return Value::Null;
        };
        serde_json::from_str(&raw).unwrap_or(Value::Null)
    }

    fn persist(&self, settings: &AppSettings) -> io::Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let disk = self.read_raw_disk();
        let settings_val =
            serde_json::to_value(settings).map_err(|err| io::Error::other(err.to_string()))?;

        let next = if let (Value::Object(mut disk_map), Value::Object(settings_map)) =
            (disk, settings_val.clone())
        {
            for (k, v) in settings_map {
                disk_map.insert(k, v);
            }
            Value::Object(disk_map)
        } else {
            settings_val
        };

        let text =
            serde_json::to_string_pretty(&next).map_err(|err| io::Error::other(err.to_string()))?;
        let tmp_path = PathBuf::from(format!("{}.tmp", self.file_path.display()));
        fs::write(&tmp_path, text)?;
        fs::rename(&tmp_path, &self.file_path)?;
        Ok(())
    }
}
