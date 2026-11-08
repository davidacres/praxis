//! Golden parity tests matching `packages/core/src/config/appSettings.test.ts` and `mcpServerConfig.test.ts`.

use serde_json::{Value, json};

use super::*;

#[test]
fn custom_theme_chat_backgrounds_accept_only_hex_colors_and_remain_optional() {
    for (value, accepted) in [
        ("#123456", true),
        ("#ABCDEF", true),
        ("red", false),
        ("url(https://example.com)", false),
        ("", false),
    ] {
        let settings = sanitize_app_settings(&json!({
            "appearance": {
                "customThemes": [{
                    "id": "custom-chat",
                    "name": "Chat",
                    "mode": "dark",
                    "description": "",
                    "preview": { "chatBackground": value }
                }]
            }
        }));
        assert_eq!(
            settings.appearance.custom_themes[0]
                .preview
                .get("chatBackground")
                .map(String::as_str),
            accepted.then_some(value)
        );
    }

    let settings = sanitize_app_settings(&json!({
        "appearance": {
            "customThemes": [{
                "id": "custom-chat",
                "name": "Chat",
                "mode": "dark",
                "description": "",
                "preview": { "canvas": "#123456" }
            }]
        }
    }));
    assert_eq!(
        settings.appearance.custom_themes[0]
            .preview
            .get("chatBackground"),
        None
    );
}

#[test]
fn custom_theme_chat_images_accept_bounded_embedded_raster_images_only() {
    let huge = format!("data:image/png;base64,{}", "a".repeat(2_800_000));
    let cases: [(&str, bool); 7] = [
        ("data:image/png;base64,YQ==", true),
        ("data:image/jpeg;base64,YQ==", true),
        ("data:image/webp;base64,YQ==", true),
        ("https://example.com/image.png", false),
        ("data:image/svg+xml;base64,YQ==", false),
        ("data:image/png;base64,YQ==\")", false),
        (huge.as_str(), false),
    ];
    for (value, accepted) in cases {
        let settings = sanitize_app_settings(&json!({
            "appearance": {
                "customThemes": [{
                    "id": "custom-image",
                    "name": "Image",
                    "mode": "dark",
                    "description": "",
                    "preview": { "chatBackgroundImage": value }
                }]
            }
        }));
        assert_eq!(
            settings.appearance.custom_themes[0]
                .preview
                .get("chatBackgroundImage")
                .map(String::as_str),
            accepted.then_some(value)
        );
    }
}

#[test]
fn startup_defaults_to_reopening_last_workspace_and_merges_cleanly() {
    assert!(
        sanitize_app_settings(&json!({}))
            .startup
            .reopen_last_workspace
    );
    assert!(
        !sanitize_app_settings(&json!({ "startup": { "reopenLastWorkspace": false } }))
            .startup
            .reopen_last_workspace
    );
    assert!(
        sanitize_app_settings(&json!({ "startup": { "reopenLastWorkspace": "yes" } }))
            .startup
            .reopen_last_workspace
    );

    let defaults = default_app_settings();
    let merged = merge_app_settings(
        &defaults,
        &json!({ "startup": { "reopenLastWorkspace": false } }),
    );
    assert!(!merged.startup.reopen_last_workspace);
    assert_eq!(merged.preview, defaults.preview);
}

#[test]
fn provider_handover_defaults_to_95_and_clamps_between_50_and_100() {
    assert_eq!(
        sanitize_app_settings(&json!({}))
            .ai
            .provider_handover_percent,
        95
    );
    assert_eq!(
        sanitize_app_settings(&json!({ "ai": {} }))
            .ai
            .provider_handover_percent,
        95
    );
    let at = |value: Value| {
        sanitize_app_settings(&json!({ "ai": { "providerHandoverPercent": value } }))
            .ai
            .provider_handover_percent
    };
    assert_eq!(at(json!(80)), 80);
    assert_eq!(at(json!(10)), 50);
    assert_eq!(at(json!(150)), 100);
    assert_eq!(at(json!(87.6)), 88);
    assert_eq!(at(json!("90")), 95);
    assert_eq!(at(Value::Null), 95);

    let defaults = default_app_settings();
    let merged_raw = merge_app_settings(
        &defaults,
        &json!({ "ai": { "providerHandoverPercent": 85 } }),
    );
    let merged = sanitize_app_settings(&serde_json::to_value(&merged_raw).unwrap_or_default());
    assert_eq!(merged.ai.provider_handover_percent, 85);
    assert_eq!(merged.ai.active_provider, defaults.ai.active_provider);
}

#[test]
fn mobile_access_is_off_by_default_and_validates_modes_and_subnets() {
    assert_eq!(sanitize_app_settings(&json!({})).mobile_access.mode, "off");
    assert_eq!(
        sanitize_app_settings(&json!({ "mobileAccess": { "mode": "local-only" } }))
            .mobile_access
            .mode,
        "local-only"
    );
    assert_eq!(
        sanitize_app_settings(&json!({ "mobileAccess": { "mode": "relay" } }))
            .mobile_access
            .mode,
        "off"
    );

    let trimmed = sanitize_app_settings(
        &json!({ "mobileAccess": { "allowedInterfaces": ["en0", " en0 ", ""] } }),
    )
    .mobile_access
    .allowed_interfaces;
    assert_eq!(trimmed, vec!["en0".to_string()]);

    let rejected =
        sanitize_app_settings(&json!({ "mobileAccess": { "allowedSubnets": ["10.0.0.", 42] } }))
            .mobile_access
            .allowed_subnets;
    assert!(rejected.is_empty());

    let subnets = sanitize_app_settings(&json!({
        "mobileAccess": {
            "allowedSubnets": ["192.168.1", "192.168.1.", "192.168.1.0/24", "10.0.0.0/33", "fd00::/8", "lan"]
        }
    }))
    .mobile_access
    .allowed_subnets;
    assert_eq!(
        subnets,
        vec!["192.168.1.0/24".to_string(), "fd00::/8".to_string()]
    );

    assert_eq!(
        sanitize_app_settings(&json!({})).mobile_access.listen_port,
        43100
    );
    assert_eq!(
        sanitize_app_settings(&json!({ "mobileAccess": { "listenPort": 80 } }))
            .mobile_access
            .listen_port,
        1024
    );
    assert_eq!(
        sanitize_app_settings(&json!({ "mobileAccess": { "listenPort": 43101 } }))
            .mobile_access
            .listen_port,
        43101
    );

    let defaults = default_app_settings();
    let merged = merge_app_settings(
        &defaults,
        &json!({ "mobileAccess": { "mode": "internet" } }),
    );
    assert_eq!(merged.mobile_access.mode, "internet");
    assert_eq!(
        merged.mobile_access.host_name,
        defaults.mobile_access.host_name
    );
    assert_eq!(merged.git.executable_path, defaults.git.executable_path);
}

#[test]
fn surface_pack_migrations_and_dials_match_ts_behavior() {
    let settings = sanitize_app_settings(&json!({}));
    assert_eq!(settings.appearance.surface_pack_id, "parchment");
    assert_eq!(
        settings.appearance.surface,
        SurfaceSettings {
            intensity: 1.0,
            translucency: true,
            texture: true,
            window_vibrancy: false,
            animate_motifs: true,
            plain_chat_surface: false,
            motif: None,
        }
    );
    assert!(settings.appearance.custom_surface_packs.is_empty());
    assert!(
        settings
            .appearance
            .installed_surface_pack_ids
            .contains(&"flat".to_string())
    );
    assert!(
        settings
            .appearance
            .installed_surface_pack_ids
            .contains(&"aurora-glass".to_string())
    );
    assert!(
        settings
            .appearance
            .installed_surface_pack_ids
            .contains(&"noir".to_string())
    );

    let d = default_app_settings().appearance;
    let untouched = sanitize_app_settings(&json!({
        "appearance": {
            "themeId": d.theme_id,
            "themeMode": d.theme_mode,
            "showBrandArtwork": d.show_brand_artwork,
            "customThemes": [],
            "priorityColors": d.priority_colors
        }
    }));
    assert_eq!(untouched.appearance.surface_pack_id, "parchment");

    let customized = sanitize_app_settings(&json!({
        "appearance": { "themeId": "github-dark", "themeMode": "dark" }
    }));
    assert_eq!(customized.appearance.surface_pack_id, "flat");

    let custom_priority = sanitize_app_settings(&json!({
        "appearance": { "priorityColors": { "Critical": "#000000" } }
    }));
    assert_eq!(custom_priority.appearance.surface_pack_id, "flat");

    let explicit = sanitize_app_settings(&json!({
        "appearance": { "surfacePackId": "graphite", "themeId": "github-dark" }
    }));
    assert_eq!(explicit.appearance.surface_pack_id, "graphite");

    let clamped = sanitize_app_settings(&json!({
        "appearance": { "surface": { "intensity": 5, "texture": "yes", "translucency": false } }
    }));
    assert_eq!(clamped.appearance.surface.intensity, 1.0);
    assert!(clamped.appearance.surface.texture);
    assert!(!clamped.appearance.surface.translucency);

    let blueprint =
        sanitize_app_settings(&json!({ "appearance": { "surfacePackId": "blueprint" } }));
    assert_eq!(blueprint.appearance.surface_pack_id, "parchment");
    assert_eq!(
        blueprint
            .appearance
            .surface
            .motif
            .as_ref()
            .map(|m| m.id.as_str()),
        Some("grid")
    );

    let binary = sanitize_app_settings(&json!({ "appearance": { "surfacePackId": "binary" } }));
    assert_eq!(binary.appearance.surface_pack_id, "parchment");
    assert_eq!(
        binary
            .appearance
            .surface
            .motif
            .as_ref()
            .map(|m| m.id.as_str()),
        Some("binary")
    );
}

#[test]
fn custom_surface_packs_and_motifs_enforce_strict_css_whitelists() {
    let settings = sanitize_app_settings(&json!({
        "appearance": {
            "customSurfacePacks": [{
                "id": "custom-glass",
                "name": "Glass",
                "description": "test",
                "tokens": {
                    "--surface-panel-blur": "18px",
                    "--surface-texture-opacity": "0.2",
                    "color": "red",
                    "--evil": "url(http://x)"
                }
            }]
        }
    }));
    let tokens = &settings.appearance.custom_surface_packs[0].tokens;
    assert_eq!(tokens.len(), 2);
    assert_eq!(
        tokens.get("--surface-panel-blur"),
        Some(&"18px".to_string())
    );
    assert_eq!(
        tokens.get("--surface-texture-opacity"),
        Some(&"0.2".to_string())
    );

    let hex_pack = sanitize_app_settings(&json!({
        "appearance": {
            "customSurfacePacks": [{
                "id": "custom-hex",
                "name": "Hex",
                "description": "",
                "tokens": {},
                "pattern": { "id": "hexagon", "scale": 9999, "opacity": 5, "ink": "text", "weight": 0, "blend": "overlay" }
            }]
        }
    }));
    let pattern = hex_pack.appearance.custom_surface_packs[0]
        .pattern
        .as_ref()
        .expect("pattern");
    assert_eq!(pattern.id, "hexagon");
    assert_eq!(pattern.scale, 400.0);
    assert_eq!(pattern.opacity, 1.0);
    assert_eq!(pattern.weight, Some(0.005));
    assert_eq!(pattern.ink, Some("text".to_string()));
    assert_eq!(pattern.blend, Some("overlay".to_string()));

    let motif_override = sanitize_app_settings(&json!({
        "appearance": {
            "surface": {
                "motif": {
                    "id": "hexagon", "scale": 62, "opacity": 0.3, "ink": "custom", "inkColor": "#4ec9b0",
                    "placement": "corner", "anchor": "top-left", "spread": 99999, "fade": 2, "fill": 0.5
                }
            }
        }
    }));
    let motif = motif_override
        .appearance
        .surface
        .motif
        .as_ref()
        .expect("motif");
    assert_eq!(motif.ink, Some("custom".to_string()));
    assert_eq!(motif.ink_color, Some("#4ec9b0".to_string()));
    assert_eq!(motif.placement, Some("corner".to_string()));
    assert_eq!(motif.anchor, Some("top-left".to_string()));
    assert_eq!(motif.spread, Some(2400.0));
    assert_eq!(motif.fade, Some(1.0));
    assert_eq!(motif.fill, Some(0.5));

    // Refuses non-hex inkColor
    let bad_ink = sanitize_app_settings(&json!({
        "appearance": {
            "surface": { "motif": { "id": "hexagon", "scale": 62, "opacity": 0.3, "ink": "custom", "inkColor": "url(#x)" } }
        }
    }));
    assert_eq!(
        bad_ink
            .appearance
            .surface
            .motif
            .as_ref()
            .and_then(|m| m.ink_color.as_ref()),
        None
    );

    // Unknown anchor, animation, and unsafe pattern id/blend are dropped
    let bad_anchor_anim = sanitize_app_settings(&json!({
        "appearance": {
            "surface": {
                "motif": {
                    "id": "mandelbrot",
                    "scale": 62,
                    "opacity": 0.3,
                    "anchor": "middle-of-nowhere",
                    "anchors": ["top-right", "bottom-left", "top-right", "nowhere", "top-left", "bottom-right", "top-left"],
                    "animation": "rm -rf"
                }
            }
        }
    }));
    let m2 = bad_anchor_anim
        .appearance
        .surface
        .motif
        .as_ref()
        .expect("m2");
    assert_eq!(m2.anchor, None);
    assert_eq!(m2.animation, None);
    assert_eq!(
        m2.anchors,
        Some(vec![
            "top-right".to_string(),
            "bottom-left".to_string(),
            "top-left".to_string(),
            "bottom-right".to_string()
        ])
    );

    let unsafe_packs = sanitize_app_settings(&json!({
        "appearance": {
            "customSurfacePacks": [
                { "id": "custom-a", "name": "A", "description": "", "tokens": {}, "pattern": { "id": "url(javascript:1)", "scale": 40, "opacity": 0.1 } },
                { "id": "custom-b", "name": "B", "description": "", "tokens": {}, "pattern": { "id": "grid", "scale": 40, "opacity": 0.1, "blend": "expression(evil)" } }
            ]
        }
    }));
    assert_eq!(
        unsafe_packs.appearance.custom_surface_packs[0].pattern,
        None
    );
    assert_eq!(
        unsafe_packs.appearance.custom_surface_packs[1]
            .pattern
            .as_ref()
            .map(|p| p.id.as_str()),
        Some("grid")
    );
    assert_eq!(
        unsafe_packs.appearance.custom_surface_packs[1]
            .pattern
            .as_ref()
            .and_then(|p| p.blend.as_ref()),
        None
    );
}

#[test]
fn looks_and_active_look_mirroring_match_ts_behavior() {
    let fresh = sanitize_app_settings(&json!({}));
    assert_eq!(
        fresh
            .appearance
            .looks
            .iter()
            .map(|l| l.id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "look-parchment",
            "look-blueprint",
            "look-aurora",
            "look-flat"
        ]
    );
    assert_eq!(fresh.appearance.active_look_id, "look-parchment");

    let detached = sanitize_app_settings(
        &json!({ "appearance": { "themeId": "github-dark", "surfacePackId": "flat" } }),
    );
    assert_eq!(detached.appearance.looks.len(), 4);
    assert_eq!(detached.appearance.active_look_id, "");

    let ghost = sanitize_app_settings(&json!({ "appearance": { "activeLookId": "look-ghost" } }));
    assert_eq!(ghost.appearance.active_look_id, "");

    // Editing while a built-in Look is active detaches without changing it
    let defaults = default_app_settings();
    let detached_edit = merge_app_settings(
        &defaults,
        &json!({ "appearance": { "surfacePackId": "graphite" } }),
    );
    assert_eq!(detached_edit.appearance.active_look_id, "");
    assert_eq!(
        detached_edit
            .appearance
            .looks
            .iter()
            .find(|l| l.id == "look-parchment")
            .map(|l| l.surface_pack_id.as_str()),
        Some("parchment")
    );

    // Editing while a custom Look is active mirrors into that Look
    let mut custom_looks = serde_json::to_value(&defaults.appearance.looks)
        .unwrap_or_default()
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut custom = custom_looks[0].clone();
    if let Some(obj) = custom.as_object_mut() {
        obj.insert("id".to_string(), json!("look-mine"));
        obj.insert("name".to_string(), json!("My Look"));
    }
    custom_looks.push(custom);
    let base = merge_app_settings(
        &defaults,
        &json!({
            "appearance": {
                "looks": custom_looks,
                "activeLookId": "look-mine"
            }
        }),
    );
    let mirrored = merge_app_settings(
        &base,
        &json!({ "appearance": { "surfacePackId": "graphite" } }),
    );
    assert_eq!(mirrored.appearance.surface_pack_id, "graphite");
    assert_eq!(
        mirrored
            .appearance
            .looks
            .iter()
            .find(|l| l.id == "look-mine")
            .map(|l| l.surface_pack_id.as_str()),
        Some("graphite")
    );
    assert_eq!(
        base.appearance
            .looks
            .iter()
            .find(|l| l.id == "look-mine")
            .map(|l| l.surface_pack_id.as_str()),
        Some("parchment")
    );

    // Accent colour changes do not detach activeLookId
    let base_bp =
        sanitize_app_settings(&json!({ "appearance": { "activeLookId": "look-blueprint" } }));
    assert_eq!(base_bp.appearance.active_look_id, "look-blueprint");
    let accented = merge_app_settings(
        &base_bp,
        &json!({ "appearance": { "accentColor": "#12ABcd" } }),
    );
    assert_eq!(accented.appearance.active_look_id, "look-blueprint");
    assert_eq!(accented.appearance.accent_color, "#12abcd");
}

#[test]
fn custom_endpoints_and_mcp_servers_validate_and_cleanup_on_remove() {
    let settings = sanitize_app_settings(&json!({
        "ai": {
            "activeProvider": "custom:gone",
            "recommendationProvider": "custom:ollama",
            "providers": {
                "custom:ollama": { "defaultModel": "llama3.1", "added": true },
                "custom:gone": { "enabled": false }
            },
            "customProviders": [
                { "id": "custom:ollama", "label": "Ollama", "protocol": "openai-chat", "baseUrl": "http://localhost:11434/", "apiPath": "v1/", "auth": { "kind": "none" } },
                { "id": "custom:ollama", "label": "Duplicate", "protocol": "openai-chat", "baseUrl": "http://x", "apiPath": "", "auth": { "kind": "none" } },
                { "id": "custom:BAD ID", "label": "Bad", "protocol": "openai-chat", "baseUrl": "http://x", "apiPath": "", "auth": { "kind": "none" } },
                { "id": "custom:ftp", "label": "Ftp", "protocol": "openai-chat", "baseUrl": "ftp://x", "apiPath": "", "auth": { "kind": "none" } },
                { "id": "custom:hdr", "label": "Hdr", "protocol": "openai-chat", "baseUrl": "https://x", "apiPath": "", "auth": { "kind": "bearer" },
                  "headers": { "HTTP-Referer": "https://praxis", "X-Auth-Token": "leak", "Authorization": "Bearer leak" } }
            ]
        }
    }));
    assert_eq!(settings.ai.active_provider, "vercel-gateway");
    assert_eq!(
        settings.ai.recommendation_provider,
        Some("custom:ollama".to_string())
    );
    let cps = settings.ai.custom_providers.as_ref().expect("cps");
    assert_eq!(
        cps.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        vec!["custom:ollama", "custom:hdr"]
    );
    assert_eq!(cps[0].base_url, "http://localhost:11434");
    assert_eq!(cps[0].api_path, "/v1");
    assert_eq!(
        cps[1].headers.as_ref().and_then(|h| h.get("HTTP-Referer")),
        Some(&"https://praxis".to_string())
    );
    assert_eq!(cps[1].headers.as_ref().map(|h| h.len()), Some(1));
    assert!(settings.ai.providers.contains_key("custom:ollama"));
    assert!(!settings.ai.providers.contains_key("custom:gone"));

    // Removing a custom endpoint drops settings pointing at it
    let defaults = default_app_settings();
    let with_endpoint = merge_app_settings(
        &defaults,
        &json!({
            "ai": {
                "customProviders": [{
                    "id": "custom:lab",
                    "label": "Lab",
                    "protocol": "openai-chat",
                    "baseUrl": "http://10.0.0.2:8000",
                    "apiPath": "/v1",
                    "auth": { "kind": "none" }
                }],
                "activeProvider": "custom:lab",
                "providers": { "custom:lab": { "defaultModel": "m" } },
                "modelTiers": { "custom:lab": { "fast": "m" } }
            }
        }),
    );
    assert_eq!(with_endpoint.ai.active_provider, "custom:lab");
    assert_eq!(
        with_endpoint
            .ai
            .providers
            .get("custom:lab")
            .and_then(|p| p.default_model.as_deref()),
        Some("m")
    );
    let removed = merge_app_settings(&with_endpoint, &json!({ "ai": { "customProviders": [] } }));
    assert_eq!(removed.ai.custom_providers, None);
    assert_eq!(removed.ai.active_provider, "vercel-gateway");
    assert!(!removed.ai.providers.contains_key("custom:lab"));
    assert!(
        !removed
            .ai
            .model_tiers
            .as_ref()
            .is_some_and(|t| t.contains_key("custom:lab"))
    );
}

#[test]
fn code_intelligence_prompt_analysis_and_activity_words_round_trip() {
    let s = sanitize_app_settings(&json!({
        "ai": {
            "recommendationProvider": "openai",
            "promptAnalysisProvider": "anthropic",
            "promptAnalysisModel": "  clarity-model  ",
            "activityWords": [" Musing ", "Musing", "Hello\nthere", 42],
            "codeIntelligence": {
                "enabled": false,
                "projectOverrides": { "/repo/a": true, "/repo/b": false }
            }
        }
    }));
    assert_eq!(s.ai.prompt_analysis_provider, Some("anthropic".to_string()));
    assert_eq!(
        s.ai.prompt_analysis_model,
        Some("clarity-model".to_string())
    );
    assert_eq!(
        s.ai.activity_words,
        Some(vec!["Musing".to_string(), "Hello there".to_string()])
    );
    assert_eq!(
        s.ai.code_intelligence.as_ref().map(|c| c.enabled),
        Some(false)
    );

    let merged = merge_app_settings(
        &s,
        &json!({
            "ai": {
                "promptAnalysisProvider": null,
                "promptAnalysisModel": null,
                "codeIntelligence": {
                    "projectOverrides": { "/repo/c": true },
                    "searchMode": "lexical",
                    "projectSearchModes": { "/repo/a": "vector" }
                }
            }
        }),
    );
    assert_eq!(merged.ai.prompt_analysis_provider, None);
    assert_eq!(merged.ai.prompt_analysis_model, None);
    assert_eq!(
        merged.ai.recommendation_provider,
        Some("openai".to_string())
    );
    let ci = merged.ai.code_intelligence.expect("ci");
    assert!(!ci.enabled);
    assert_eq!(ci.search_mode, Some("lexical".to_string()));
    assert_eq!(ci.project_overrides.as_ref().map(|m| m.len()), Some(3));
}
