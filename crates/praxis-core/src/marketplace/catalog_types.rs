//! Shared types for the add-on marketplace (`catalogTypes.ts` port).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Installable add-on kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum AddonKind {
    #[serde(rename = "theme")]
    Theme,
    #[serde(rename = "surface-pack")]
    SurfacePack,
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "skill")]
    Skill,
    #[serde(rename = "workflow-template")]
    WorkflowTemplate,
}

impl AddonKind {
    /// Canonical string representation (`theme`, `surface-pack`, `agent`, `skill`, `workflow-template`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Theme => "theme",
            Self::SurfacePack => "surface-pack",
            Self::Agent => "agent",
            Self::Skill => "skill",
            Self::WorkflowTemplate => "workflow-template",
        }
    }

    /// Parses an [`AddonKind`] from its string representation.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "theme" => Some(Self::Theme),
            "surface-pack" => Some(Self::SurfacePack),
            "agent" => Some(Self::Agent),
            "skill" => Some(Self::Skill),
            "workflow-template" => Some(Self::WorkflowTemplate),
            _ => None,
        }
    }

    /// Returns `true` when this kind only describes appearance/config and is safe to activate immediately.
    #[must_use]
    pub const fn is_declarative(self) -> bool {
        matches!(
            self,
            Self::Theme | Self::SurfacePack | Self::WorkflowTemplate
        )
    }
}

impl std::fmt::Display for AddonKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// All supported add-on kinds in canonical discovery order.
pub const ADDON_KINDS: &[AddonKind] = &[
    AddonKind::Theme,
    AddonKind::SurfacePack,
    AddonKind::Agent,
    AddonKind::Skill,
    AddonKind::WorkflowTemplate,
];

/// Declarative add-on kinds that activate on install without requiring execution trust.
pub const DECLARATIVE_ADDON_KINDS: &[AddonKind] = &[
    AddonKind::Theme,
    AddonKind::SurfacePack,
    AddonKind::WorkflowTemplate,
];

/// Returns `true` if `value` is a valid [`AddonKind`] string.
#[must_use]
pub fn is_addon_kind(value: &str) -> bool {
    AddonKind::parse(value).is_some()
}

/// Relative path inside the npm tarball's `package/` root that holds the payload.
pub const ADDON_PAYLOAD_DIR: &str = "addon";

/// File written alongside an unpacked payload recording how it was installed.
pub const INSTALL_RECORD_FILE: &str = ".praxis-addon.json";

/// Appearance mode for a theme preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddonDisplayMode {
    Light,
    Dark,
}

/// Optional display hints rendered by the per-kind marketplace UI before install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonDisplay {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<AddonDisplayMode>,
}

/// The `praxis` block every add-on package declares in its `package.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonManifest {
    pub schema_version: u32,
    pub kind: AddonKind,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<AddonDisplay>,
}

/// One installable add-on resolved from a registry package's latest version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub manifest: AddonManifest,
    pub package_name: String,
    pub latest_version: String,
    pub versions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    pub incompatible: bool,
    pub warnings: Vec<String>,
}

/// Recorded on disk (`INSTALL_RECORD_FILE`) for each installed add-on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAddon {
    pub manifest: AddonManifest,
    pub package_name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    pub installed_at: String,
    pub enabled: bool,
}

/// The `addon/theme.json` payload of a `theme` add-on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonThemeContent {
    pub id: String,
    pub name: String,
    pub mode: AddonDisplayMode,
    pub description: String,
    pub preview: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<BTreeMap<String, String>>,
}

/// The `addon/pack.json` payload of a `surface-pack` add-on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonSurfacePackContent {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_pack_id: Option<String>,
    pub tokens: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<BTreeMap<String, Value>>,
}

/// Declarative appearance content contributed by enabled add-ons.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAppearanceAddons {
    pub themes: Vec<AddonThemeContent>,
    pub surface_packs: Vec<AddonSurfacePackContent>,
}

/// An installed add-on that has a newer version available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonUpdate {
    pub id: String,
    pub kind: AddonKind,
    pub package_name: String,
    pub installed_version: String,
    pub latest_version: String,
}
