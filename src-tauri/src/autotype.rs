//! Auto-type for desktop apps and games the browser extension cannot reach: a global hotkey (Ctrl+Alt+A) looks at the
//! window in front, finds the matching login and types the username, Tab and the password into it.
//! Matching: a login's "Auto-type window" field (text the window title must contain) wins; otherwise the item title or
//! its website's name appearing in the window title.
use crate::{domain, vault::Item};

pub const WINDOW_FIELD: &str = "Auto-type window";

fn field<'a>(i: &'a Item, l: &str) -> &'a str { i.fields.iter().find(|f| f.label == l).map(|f| f.value.as_str()).unwrap_or("") }

/// Logins that fit a window title, best first. Explicit "Auto-type window" matches hide the guesses.
pub fn candidates<'a>(items: &'a [Item], title: &str) -> Vec<&'a Item> {
    let t = title.to_lowercase();
    if t.trim().is_empty() { return vec![]; }
    let logins = || items.iter().filter(|i| i.deleted == 0 && i.kind == "login" && !field(i, "Password").is_empty());
    let explicit: Vec<&Item> = logins().filter(|i| { let w = field(i, WINDOW_FIELD).trim().to_lowercase(); !w.is_empty() && t.contains(&w) }).collect();
    if !explicit.is_empty() { return explicit; }
    let word = |s: &str| s.len() >= 3 && t.split(|c: char| !c.is_alphanumeric()).any(|w| w == s);
    let mut guess: Vec<&Item> = logins().filter(|i| {
        let name = i.title.trim().to_lowercase();
        let site = domain::host_of(field(i, "Website")).map(|h| domain::etld1(&h)).and_then(|d| d.split('.').next().map(str::to_string)).unwrap_or_default();
        (name.len() >= 3 && t.contains(&name)) || word(&site)
    }).collect();
    guess.sort_by_key(|i| (!t.contains(&i.title.trim().to_lowercase()), i.title.to_lowercase()));
    guess
}

#[cfg(windows)]
mod imp {
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_TAB},
        WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, SetForegroundWindow},
    };

    /// The window in front and its title.
    pub fn foreground() -> (isize, String) {
        // SAFETY: plain Win32 reads into a local buffer.
        unsafe {
            let h = GetForegroundWindow();
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
            (h as isize, String::from_utf16_lossy(&buf[..n]))
        }
    }

    fn key(vk: u16, scan: u16, flags: u32) -> INPUT {
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn send(inputs: &[INPUT]) {
        // SAFETY: the slice is valid for the call.
        unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32); }
    }

    fn text(s: &str) {
        for u in s.encode_utf16() {
            send(&[key(0, u, KEYEVENTF_UNICODE), key(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
            std::thread::sleep(Duration::from_millis(4));
        }
    }

    /// Waits (up to 3 s) until the hotkey's Ctrl/Alt/Shift/Win are released, or they would turn letters into shortcuts.
    fn modifiers_released() -> bool {
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            // SAFETY: reads the key state only.
            let down = [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN].iter().any(|&k| unsafe { GetAsyncKeyState(k as i32) } as u16 & 0x8000 != 0);
            if !down { return true; }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// Brings `hwnd` to the front and types `user` Tab `pass` (or just the password when there is no username).
    /// Nothing is typed if that window cannot be brought back to the front.
    pub fn type_into(hwnd: isize, user: &str, pass: &str) -> Result<(), String> {
        if !modifiers_released() { return Err("release Ctrl and Alt to let Vault type".into()); }
        // SAFETY: plain Win32 calls with a window handle we got from Windows.
        unsafe { SetForegroundWindow(hwnd as _); }
        std::thread::sleep(Duration::from_millis(250));
        if unsafe { GetForegroundWindow() } as isize != hwnd { return Err("could not switch back to that window, so nothing was typed".into()); }
        if !user.is_empty() { text(user); send(&[key(VK_TAB, 0, 0), key(VK_TAB, 0, KEYEVENTF_KEYUP)]); std::thread::sleep(Duration::from_millis(60)); }
        text(pass);
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn foreground() -> (isize, String) { (0, String::new()) }
    pub fn type_into(_: isize, _: &str, _: &str) -> Result<(), String> { Err("auto-type needs Windows".into()) }
}

pub use imp::{foreground, type_into};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Field;

    fn login(title: &str, site: &str, window: &str) -> Item {
        let f = |l: &str, v: &str| Field { label: l.into(), value: v.into(), kind: "text".into() };
        let mut fields = vec![f("Username", "me"), Field { label: "Password".into(), value: "pw".into(), kind: "secret".into() }, f("Website", site)];
        if !window.is_empty() { fields.push(f(WINDOW_FIELD, window)); }
        Item { id: title.into(), kind: "login".into(), title: title.into(), fields, ..Default::default() }
    }

    #[test]
    fn matches_window_titles() {
        let items = vec![login("Steam", "https://store.steampowered.com", ""), login("Riot", "https://riotgames.com", "Riot Client"), login("GitHub", "https://github.com", ""), login("Bank", "https://bank.example", "")];
        let ids = |t: &str| candidates(&items, t).iter().map(|i| i.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids("Riot Client Main"), ["Riot"], "explicit window field");
        assert_eq!(ids("Steam Login"), ["Steam"], "item title");
        assert_eq!(ids("Sign in to GitHub · GitHub - Mozilla Firefox"), ["GitHub"]);
        assert_eq!(ids("steampowered - Store"), ["Steam"], "website name as a word");
        assert!(ids("Untitled - Notepad").is_empty());
        assert!(ids("").is_empty());
    }
}
