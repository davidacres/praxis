//! Page snapshots of a Tauri webview on macOS.
//!
//! Tauri exposes the platform webview (`Webview::with_webview`) but no capture API, so this calls
//! `-[WKWebView takeSnapshotWithConfiguration:completionHandler:]` on the `WKWebView` it hands
//! over. That is the same primitive Electron's `capturePage` stood in for: it renders what the web
//! content process has painted, so it needs no screen-recording permission and works for a view
//! that is covered by another one.

#![allow(unsafe_code)]

use std::cell::Cell;
use std::time::Duration;

use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWindow};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString};
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
use tauri::{Runtime, Webview};

/// The encoding of a snapshot.
#[derive(Debug, Clone, Copy)]
pub enum Format {
    Png,
    /// JPEG at a quality between 0 and 1.
    Jpeg(f64),
}

/// A region of the page to capture, in points, and the width to scale it to.
#[derive(Debug, Clone, Copy, Default)]
pub struct Capture {
    /// `(x, y, width, height)`; the whole visible page when absent.
    pub rect: Option<(f64, f64, f64, f64)>,
    /// Output width in points; the source width when absent.
    pub width: Option<f64>,
}

fn encode(image: &NSImage, format: Format) -> Result<Vec<u8>, String> {
    let tiff = image
        .TIFFRepresentation()
        .ok_or("The page snapshot has no bitmap data.")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or("The page snapshot could not be read as a bitmap.")?;
    let data = match format {
        Format::Png => {
            let props: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
        }
        Format::Jpeg(quality) => {
            let key = NSString::from_str("NSImageCompressionFactor");
            let value: Retained<AnyObject> =
                Retained::into_super(Retained::into_super(NSNumber::new_f64(quality))).into();
            let props: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_retained_objects(&[&*key], &[value]);
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props) }
        }
    };
    data.map(|bytes| bytes.to_vec())
        .ok_or_else(|| "The page snapshot could not be encoded.".to_owned())
}

/// Takes a snapshot of `webview` and encodes it. Must be awaited off the main thread.
pub async fn snapshot<R: Runtime>(
    webview: &Webview<R>,
    capture: Capture,
    format: Format,
) -> Result<Vec<u8>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let sender = std::sync::Mutex::new(Some(sender));
    webview
        .with_webview(move |platform| {
            let finish = move |result: Result<Vec<u8>, String>| {
                if let Some(sender) = sender.lock().ok().and_then(|mut s| s.take()) {
                    let _ = sender.send(result);
                }
            };
            let Some(mtm) = MainThreadMarker::new() else {
                finish(Err("Snapshots run on the main thread.".into()));
                return;
            };
            // SAFETY: `inner()` is the `WKWebView` that wry created for this webview, and this
            // closure runs on the main thread while the webview is alive.
            let wk: &WKWebView = unsafe { &*platform.inner().cast() };
            let configuration = unsafe { WKSnapshotConfiguration::new(mtm) };
            unsafe {
                if let Some((x, y, width, height)) = capture.rect {
                    configuration
                        .setRect(CGRect::new(CGPoint::new(x, y), CGSize::new(width, height)));
                }
                if let Some(width) = capture.width {
                    configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
                }
                configuration.setAfterScreenUpdates(true);
            }
            let finish = Cell::new(Some(finish));
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Some(finish) = finish.take() else { return };
                // SAFETY: WebKit passes either null or a live object for each argument.
                let result = match unsafe { image.as_ref() } {
                    Some(image) => encode(image, format),
                    None => Err(unsafe { error.as_ref() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "The page could not be snapshotted.".into())),
                };
                finish(result);
            });
            unsafe {
                wk.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &block)
            };
        })
        .map_err(|e| e.to_string())?;
    match tokio::time::timeout(Duration::from_secs(10), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The page snapshot was abandoned.".into()),
        Err(_) => Err("The page snapshot timed out.".into()),
    }
}

/// Makes a window all but invisible and untouchable while macOS still treats it as on screen.
///
/// A hidden or far off-screen window is never painted, so a snapshot of its page is blank. A window
/// at 1% opacity that ignores the mouse is painted and cannot be seen or clicked.
pub fn make_unseen<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as usize;
    let _ = window.run_on_main_thread(move || {
        // SAFETY: this runs on the main thread, and the window it was taken from is kept alive by
        // the caller until the snapshot is done.
        let window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        window.setAlphaValue(0.01);
        window.setIgnoresMouseEvents(true);
        window.orderBack(None);
    });
}
