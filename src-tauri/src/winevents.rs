//! Lock signals from Windows as they happen, instead of polling the input desktop: a hidden window registered for
//! session notifications (lock) and power broadcasts (sleep / hibernate).

#[cfg(windows)]
mod imp {
    use std::sync::{mpsc, OnceLock};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::{LibraryLoader::GetModuleHandleW, RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION}},
        UI::WindowsAndMessaging::{CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, MSG, WNDCLASSW},
    };

    const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
    const WTS_SESSION_LOCK: usize = 0x7;
    const WM_POWERBROADCAST: u32 = 0x0218;
    const PBT_APMSUSPEND: usize = 0x4;
    pub(crate) const CLASS: &str = "VaultSessionWatch";

    static ON_LOCK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if (msg == WM_WTSSESSION_CHANGE && wp == WTS_SESSION_LOCK) || (msg == WM_POWERBROADCAST && wp == PBT_APMSUSPEND) {
            if let Some(f) = ON_LOCK.get() { f(); }
        }
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    /// Calls `on_lock` whenever Windows locks or the PC goes to sleep. Returns false if the hidden window could not be
    /// set up (the caller then falls back to polling). Only the first call in a process takes effect.
    pub fn watch(on_lock: impl Fn() + Send + Sync + 'static) -> bool {
        if ON_LOCK.set(Box::new(on_lock)).is_err() { return false; }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            // SAFETY: plain Win32 window setup on this thread; the strings outlive the calls that read them.
            let class = wide(CLASS);
            let inst = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: inst, lpszClassName: class.as_ptr(), ..std::mem::zeroed() };
            RegisterClassW(&wc);
            // a top-level window that is never shown (message-only windows do not get power broadcasts)
            let hwnd = CreateWindowExW(0, class.as_ptr(), class.as_ptr(), 0, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), inst, std::ptr::null());
            let ok = !hwnd.is_null() && WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) != 0;
            let _ = tx.send(ok);
            if !ok { return; }
            let mut m: MSG = std::mem::zeroed();
            while GetMessageW(&mut m, std::ptr::null_mut(), 0, 0) > 0 { TranslateMessage(&m); DispatchMessageW(&m); }
        });
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(false)
    }

    #[cfg(test)]
    mod tests {
        use std::sync::{atomic::{AtomicUsize, Ordering}, Arc};
        use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, PostMessageW};

        #[test]
        fn lock_and_sleep_messages_reach_the_callback() {
            let n = Arc::new(AtomicUsize::new(0));
            let c = n.clone();
            assert!(super::watch(move || { c.fetch_add(1, Ordering::SeqCst); }));
            let class = super::wide(super::CLASS);
            let hwnd = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
            assert!(!hwnd.is_null());
            unsafe {
                PostMessageW(hwnd, super::WM_WTSSESSION_CHANGE, super::WTS_SESSION_LOCK, 0);
                PostMessageW(hwnd, super::WM_WTSSESSION_CHANGE, 0x8, 0); // unlock: ignored
                PostMessageW(hwnd, super::WM_POWERBROADCAST, super::PBT_APMSUSPEND, 0);
            }
            for _ in 0..50 { if n.load(Ordering::SeqCst) >= 2 { break; } std::thread::sleep(std::time::Duration::from_millis(20)); }
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert_eq!(n.load(Ordering::SeqCst), 2);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn watch(_: impl Fn() + Send + Sync + 'static) -> bool { false }
}

pub use imp::watch;
