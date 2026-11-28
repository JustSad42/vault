//! A window hidden in the tray keeps its web view fully awake. A little later it is put to sleep
//! (WebView2 TrySuspend: page timers stop and its memory can be reclaimed) and woken before it is
//! shown again. A sleeping page may miss events: wake it before telling it anything.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tauri::{Manager, WebviewWindow};

/// Per window, bumped on every hide and wake, so a pending sleep is dropped when the window comes back.
static GENERATIONS: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

fn bump(label: &str) -> u64 {
    let mut g = GENERATIONS.lock().unwrap();
    let n = g.entry(label.to_string()).or_default();
    *n += 1;
    *n
}

fn current(label: &str) -> u64 {
    GENERATIONS.lock().unwrap().get(label).copied().unwrap_or(0)
}

/// Call right after hiding `window`: it goes to sleep after `delay` if it's still hidden.
pub fn later(window: &WebviewWindow, delay: Duration) {
    let label = window.label().to_string();
    let mine = bump(&label);
    let app = window.app_handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(w) = a.get_webview_window(&label) else { return };
            if current(&label) == mine && !w.is_visible().unwrap_or(true) {
                set_asleep(&w, true);
            }
        });
    });
}

/// Call before showing `window`. Does no harm to one that's awake.
pub fn wake(window: &WebviewWindow) {
    bump(window.label());
    set_asleep(window, false);
}

/// For the window's focus events: Windows can report focus for a hidden window (it did right after
/// suspending one), which must not wake it.
pub fn focused(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(true) {
        wake(window);
    }
}

#[cfg(windows)]
fn set_asleep(window: &WebviewWindow, asleep: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::Interface;
    let _ = window.with_webview(move |wv| unsafe {
        let controller = wv.controller();
        let Ok(core) = controller.CoreWebView2() else { return };
        let level = if asleep { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
            let _ = c19.SetMemoryUsageTargetLevel(level);
        }
        // Edge only suspends a page that isn't shown.
        let _ = controller.SetIsVisible(!asleep);
        if let Ok(c3) = core.cast::<ICoreWebView2_3>() {
            if asleep {
                let _ = c3.TrySuspend(&webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(()))));
            } else {
                let _ = c3.Resume();
            }
        }
    });
}

#[cfg(not(windows))]
fn set_asleep(_: &WebviewWindow, _: bool) {}
