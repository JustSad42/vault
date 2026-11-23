//! Windows Hello (face, fingerprint or PIN) as a second step for "stay signed in". The saved key stays protected by
//! DPAPI as before; with Hello on, the app also asks Windows to confirm it is you before using it. This is a consent
//! check made by the app (like other password managers' Hello unlock), not extra encryption: a program already running
//! as your Windows user could still call DPAPI itself.

#[cfg(windows)]
mod imp {
    use windows_future::IAsyncOperation;
    use windows::{
        core::{factory, HSTRING},
        Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability},
        Win32::{Foundation::HWND, System::WinRT::{IUserConsentVerifierInterop, RoInitialize, RO_INIT_MULTITHREADED}},
    };

    fn init() { let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }; } // already initialized on this thread: fine

    /// True when this PC has Windows Hello set up (a PIN counts).
    pub fn available() -> bool {
        init();
        UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()).map(|a| a == UserConsentVerifierAvailability::Available).unwrap_or(false)
    }

    /// Shows the Windows Hello prompt over `hwnd` and waits for it. Blocks: call it off the UI thread.
    pub fn verify(hwnd: isize, message: &str) -> Result<(), String> {
        init();
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| format!("Windows Hello is not available: {e}"))?;
        // SAFETY: `hwnd` is the app's own top-level window; the call only reads it.
        let op: IAsyncOperation<UserConsentVerificationResult> = unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as *mut _), &HSTRING::from(message)) }
            .map_err(|e| format!("Windows Hello could not start: {e}"))?;
        match op.join().map_err(|e| format!("Windows Hello failed: {e}"))? {
            UserConsentVerificationResult::Verified => Ok(()),
            UserConsentVerificationResult::Canceled => Err("Windows Hello was cancelled".into()),
            UserConsentVerificationResult::DeviceNotPresent | UserConsentVerificationResult::NotConfiguredForUser => Err("Windows Hello is not set up on this PC".into()),
            UserConsentVerificationResult::RetriesExhausted => Err("too many failed Windows Hello attempts".into()),
            _ => Err("Windows Hello did not confirm it is you".into()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn available() -> bool { false }
    pub fn verify(_: isize, _: &str) -> Result<(), String> { Err("Windows Hello needs Windows".into()) }
}

pub use imp::{available, verify};
