//! Launch configuration discovery (`projects/runProfileDiscovery.ts` port).
//!
//! Reads only. A manifest is parsed for the command a service already declares and never
//! executed. Nothing here writes a profile; a person reviews the proposal first.

use serde::Deserialize;
use std::collections::BTreeMap;

const NODE_SCRIPT_PRIORITY: [&str; 3] = ["dev", "start", "serve"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalSource {
    PackageJson,
    LaunchSettingsJson,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedRunService {
    pub executable: String,
    pub args: Vec<String>,
    /// The port the process binds to, when discoverable.
    pub port: Option<u32>,
    /// Where a browser should point once ready. Can differ from the bind address.
    pub browser_origin: Option<String>,
    pub source: ProposalSource,
}

#[derive(Deserialize)]
struct NodePackageJson {
    #[serde(default)]
    scripts: BTreeMap<String, serde_json::Value>,
}

/// Proposes a service from a Node `package.json`'s `scripts`. Parses only, never runs them.
#[must_use]
pub fn propose_node_run_service(package_json: &str) -> Option<ProposedRunService> {
    let pkg: NodePackageJson = serde_json::from_str(package_json).ok()?;
    let script = NODE_SCRIPT_PRIORITY.iter().find(|name| {
        pkg.scripts
            .get(**name)
            .is_some_and(serde_json::Value::is_string)
    })?;
    Some(ProposedRunService {
        executable: "npm".into(),
        args: vec!["run".into(), (*script).into()],
        port: None,
        browser_origin: None,
        source: ProposalSource::PackageJson,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchSettingsProfile {
    #[serde(default)]
    command_name: Option<String>,
    #[serde(default)]
    application_url: Option<String>,
    #[serde(default)]
    launch_browser: Option<bool>,
    #[serde(default)]
    launch_url: Option<String>,
}

#[derive(Deserialize)]
struct LaunchSettingsFile {
    #[serde(default)]
    profiles: indexmap::IndexMap<String, LaunchSettingsProfile>,
}

/// The first `;`-separated bind URL and its explicit port, read without a URL parser.
/// A port is reported only when written out; a scheme's default port is not.
fn first_port(application_url: &str) -> (Option<String>, Option<u32>) {
    let Some(bind_url) = application_url
        .split(';')
        .map(str::trim)
        .find(|url| !url.is_empty())
    else {
        return (None, None);
    };
    let port = bind_url.split_once("://").and_then(|(_, rest)| {
        let authority = rest.split('/').next().unwrap_or_default();
        let (_, port) = authority.rsplit_once(':')?;
        port.parse::<u32>().ok().filter(|p| *p > 0)
    });
    (Some(bind_url.to_string()), port)
}

/// Proposes a service from an ASP.NET `Properties/launchSettings.json`. Never runs `dotnet run`.
#[must_use]
pub fn propose_dotnet_run_service(launch_settings: &str) -> Option<ProposedRunService> {
    let parsed: LaunchSettingsFile = serde_json::from_str(launch_settings).ok()?;
    // Prefer the profile that launches the project itself over, say, IIS Express.
    let profile = parsed
        .profiles
        .values()
        .find(|p| p.command_name.as_deref() == Some("Project"))
        .or_else(|| parsed.profiles.values().next())?;
    let application_url = profile
        .application_url
        .as_deref()
        .filter(|u| !u.is_empty())?;

    let (bind_url, port) = first_port(application_url);
    let browser_origin = match (profile.launch_browser, bind_url) {
        (Some(true), Some(bind)) => Some(match profile.launch_url.as_deref() {
            Some(sub) if !sub.is_empty() => format!(
                "{}/{}",
                bind.trim_end_matches('/'),
                sub.trim_start_matches('/')
            ),
            _ => bind,
        }),
        _ => None,
    };

    Some(ProposedRunService {
        executable: "dotnet".into(),
        args: vec!["run".into()],
        port,
        browser_origin,
        source: ProposalSource::LaunchSettingsJson,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vite_style_package_json_proposes_npm_run_dev() {
        let p = propose_node_run_service(r#"{"scripts":{"dev":"vite"}}"#).expect("test setup");
        assert_eq!(p.executable, "npm");
        assert_eq!(p.args, vec!["run", "dev"]);
    }

    #[test]
    fn a_start_only_package_json_proposes_npm_run_start() {
        let p = propose_node_run_service(r#"{"scripts":{"start":"node ."}}"#).expect("test setup");
        assert_eq!(p.args, vec!["run", "start"]);
    }

    #[test]
    fn dev_is_preferred_over_start() {
        let p =
            propose_node_run_service(r#"{"scripts":{"start":"a","dev":"b"}}"#).expect("test setup");
        assert_eq!(p.args, vec!["run", "dev"]);
    }

    #[test]
    fn no_dev_start_or_serve_script_proposes_nothing() {
        assert!(propose_node_run_service(r#"{"scripts":{"build":"x"}}"#).is_none());
    }

    #[test]
    fn a_malformed_package_json_proposes_nothing_rather_than_panicking() {
        assert!(propose_node_run_service("{nope").is_none());
    }

    #[test]
    fn an_asp_net_launch_settings_proposes_dotnet_run_with_the_bind_port() {
        let p = propose_dotnet_run_service(
            r#"{"profiles":{"Project":{"commandName":"Project","applicationUrl":"http://localhost:5123"}}}"#,
        )
        .expect("test setup");
        assert_eq!(p.executable, "dotnet");
        assert_eq!(p.port, Some(5123));
        assert_eq!(p.browser_origin, None);
    }

    #[test]
    fn a_bind_address_and_a_sub_path_browser_origin_are_reported_distinctly() {
        let p = propose_dotnet_run_service(
            r#"{"profiles":{"Project":{"commandName":"Project","applicationUrl":"https://localhost:7001;http://localhost:5001","launchBrowser":true,"launchUrl":"swagger"}}}"#,
        )
        .expect("test setup");
        assert_eq!(p.port, Some(7001));
        assert_eq!(
            p.browser_origin.as_deref(),
            Some("https://localhost:7001/swagger")
        );
    }

    #[test]
    fn launch_browser_without_a_launch_url_opens_the_bind_address() {
        let p = propose_dotnet_run_service(
            r#"{"profiles":{"Project":{"commandName":"Project","applicationUrl":"http://localhost:5000","launchBrowser":true}}}"#,
        )
        .expect("test setup");
        assert_eq!(p.browser_origin.as_deref(), Some("http://localhost:5000"));
    }

    #[test]
    fn the_project_profile_is_preferred_over_iis_express() {
        let p = propose_dotnet_run_service(
            r#"{"profiles":{"IIS Express":{"commandName":"IISExpress","applicationUrl":"http://localhost:1111"},"Project":{"commandName":"Project","applicationUrl":"http://localhost:2222"}}}"#,
        )
        .expect("test setup");
        assert_eq!(p.port, Some(2222));
    }

    #[test]
    fn a_launch_settings_file_with_no_profiles_proposes_nothing() {
        assert!(propose_dotnet_run_service(r#"{"profiles":{}}"#).is_none());
        assert!(propose_dotnet_run_service("garbage").is_none());
    }
}
