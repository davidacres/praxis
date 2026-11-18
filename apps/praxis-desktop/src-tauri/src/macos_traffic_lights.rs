//! macOS traffic lights, centred on the renderer's title bar.
//!
//! The static `trafficLightPosition` in `tauri.conf.json` is a single logical inset that tao
//! re-applies verbatim on redraws, resizes and fullscreen exits — so it can only ever be
//! right for one combination of display size and zoom. The title bar is
//! `calc(40px * var(--ui-scale))` tall and grows with the Large display size
//! (`--ui-scale: 1.16`) and with application zoom, while a fixed `y` leaves the lights
//! squashed against the top of the taller bar.
//!
//! This module keeps the three standard window buttons vertically centred on the title
//! bar. The bar's height is measured by the renderer (a `ResizeObserver` on `.titlebar`,
//! reported through `window:setTitlebarHeight`), so it stays correct whatever theme,
//! display size or zoom produced that height; until the first report arrives, the height
//! is derived from the saved appearance settings. AppKit and tao both reset the buttons
//! on their own schedule, so the centring is re-asserted on window resize/focus events
//! and shortly after every change.

#![allow(unsafe_code)]

use std::sync::Mutex;

use objc2_app_kit::{NSWindow, NSWindowButton};
use objc2_core_foundation::CGPoint;

/// Mirrors `theme.css`: `--titlebar-height: calc(40px * var(--ui-scale))`, and the Large
/// display size sets `--ui-scale: 1.16`. Only used before the renderer's first measurement.
const TITLEBAR_BASE_HEIGHT: f64 = 40.0;
const DISPLAY_SIZE_LARGE_SCALE: f64 = 1.16;

/// The horizontal inset from `tauri.conf.json`'s `trafficLightPosition`.
const TRAFFIC_LIGHT_X: f64 = 12.0;

/// The latest title bar height in points (logical pixels), reported by the renderer.
static TITLEBAR_HEIGHT: Mutex<Option<f64>> = Mutex::new(None);

/// Vertical inset (points from the window top) that centres a button cluster of
/// `button_height` inside a title bar of `titlebar_height`.
pub fn inset_y(titlebar_height: f64, button_height: f64) -> f64 {
    ((titlebar_height - button_height) / 2.0).max(0.0)
}

/// Fallback title bar height in points before the renderer has measured it:
/// base height × display-size scale × application zoom.
pub fn fallback_titlebar_height(display_mode: &str, zoom_factor: f64) -> f64 {
    let scale = if display_mode == "large" {
        DISPLAY_SIZE_LARGE_SCALE
    } else {
        1.0
    };
    TITLEBAR_BASE_HEIGHT * scale * zoom_factor.clamp(0.5, 3.0)
}

/// Records the renderer's measurement. CSS pixels are points here: application zoom is
/// applied by the webview itself, so a zoomed layout reports its on-screen size already.
pub fn report_height(height: f64) {
    if height.is_finite() && height > 0.0 {
        *TITLEBAR_HEIGHT.lock().expect("titlebar height") = Some(height);
    }
}

/// Centres the close/minimise/zoom buttons on the title bar. `fallback_height` is used
/// until the renderer has reported a measurement. No-op off macOS builds that call it.
pub fn center(window: &tauri::WebviewWindow, fallback_height: f64) {
    let height = TITLEBAR_HEIGHT
        .lock()
        .expect("titlebar height")
        .unwrap_or(fallback_height);
    let Ok(ptr) = window.ns_window() else { return };
    let ptr = ptr as usize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: main thread; the window handle keeps the NSWindow alive for this call.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        apply(ns_window, height);
    });
}

/// The AppKit part, factored out so it can be re-run cheaply. Main thread only.
fn apply(ns_window: &NSWindow, titlebar_height: f64) {
    let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
    else {
        return;
    };
    let Some(zoom) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return;
    };

    let close_frame = close.frame();
    let space_between = miniaturize.frame().origin.x - close_frame.origin.x;
    // The button frame is 14pt but the drawn circle is ~12pt, inset ~1pt inside the
    // frame. Centring the full frame leaves the visible cluster a point high, so
    // centre the drawn circle instead.
    let visual_height = close_frame.size.height - 2.0;
    let y = inset_y(titlebar_height, visual_height);

    // Same container adjustment tao's `inset_traffic_lights` makes, so the buttons stay
    // hittable: AppKit clips them to the title bar container's frame.
    // SAFETY: standard window buttons live in the window's title bar view hierarchy.
    let Some(container) = (unsafe { close.superview().and_then(|v| v.superview()) }) else {
        return;
    };
    let container_height = close_frame.size.height + y;
    let mut container_frame = container.frame();
    container_frame.size.height = container_height;
    container_frame.origin.y = ns_window.frame().size.height - container_height;
    container.setFrame(container_frame);

    // AppKit's origin is bottom-left: the container is `button_height + y` tall, so a
    // button at origin.y 0 sits exactly `y` below the container's top. A stock window
    // starts its buttons at a non-zero origin.y, so it must be reset, not preserved.
    for (index, button) in [close, miniaturize, zoom].iter().enumerate() {
        button.setFrameOrigin(CGPoint::new(
            TRAFFIC_LIGHT_X + index as f64 * space_between,
            0.0,
        ));
    }
}

/// Centres now and re-asserts twice more: tao re-applies its static inset from
/// `drawRect:`, and AppKit resets the buttons on events like leaving fullscreen, both
/// after this call returns.
pub fn center_and_hold(window: &tauri::WebviewWindow, fallback_height: f64) {
    center(window, fallback_height);
    for delay_ms in [120_u64, 400] {
        let window = window.clone();
        let _ = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            center(&window, fallback_height);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{fallback_titlebar_height, inset_y};

    #[test]
    fn inset_centres_the_cluster_in_the_bar() {
        // 40pt bar, 12pt drawn circles → 14pt inset for the visible cluster.
        assert_eq!(inset_y(40.0, 12.0), 14.0);
        // Large display size grows the bar; the inset follows.
        assert!((inset_y(46.4, 12.0) - 17.2).abs() < 1e-9);
        // A bar shorter than the buttons never goes negative.
        assert_eq!(inset_y(8.0, 12.0), 0.0);
    }

    #[test]
    fn fallback_tracks_display_size_and_zoom() {
        assert_eq!(fallback_titlebar_height("compact", 1.0), 40.0);
        assert!((fallback_titlebar_height("large", 1.0) - 46.4).abs() < 1e-9);
        assert_eq!(fallback_titlebar_height("compact", 1.2), 48.0);
        // Out-of-range zoom cannot produce an absurd bar.
        assert_eq!(fallback_titlebar_height("compact", 0.0), 20.0);
        assert_eq!(fallback_titlebar_height("compact", 9.0), 120.0);
    }

    /// The configured static inset must agree with the centring math for the default
    /// appearance, so the first paint (before any measurement) is already centred.
    /// The static inset positions the button *frame* (14pt), so it centres the frame:
    /// (40 − 14) / 2 = 13. The runtime centring uses the ~12pt drawn circle instead.
    #[test]
    fn configured_inset_matches_the_default_centring() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let y = config["app"]["windows"][0]["trafficLightPosition"]["y"]
            .as_f64()
            .expect("trafficLightPosition.y");
        assert_eq!(y, inset_y(fallback_titlebar_height("compact", 1.0), 14.0));
    }
}
