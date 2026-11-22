//! Chrome/Edge native messaging: the browser starts `vault.exe --native-host`, which relays each message to the running app
//! over the local bridge (starting the app minimized if it is not running) and returns the answer.
use std::{io::{BufRead, BufReader, Read, Write}, net::{SocketAddr, TcpStream}, time::{Duration, Instant}};

fn connect() -> Option<TcpStream> {
    let port = |_: ()| std::fs::read(crate::vault_dir().join("bridge.json")).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).and_then(|v| v["port"].as_u64());
    let try_once = || port(()).and_then(|p| TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], p as u16)), Duration::from_millis(500)).ok());
    if let Some(c) = try_once() { return Some(c); }
    // not running: start it hidden in the tray and wait for it to open the bridge
    let mut cmd = std::process::Command::new(std::env::current_exe().ok()?);
    cmd.arg("--minimized").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0008); } // no console, detached
    cmd.spawn().ok()?;
    let until = Instant::now() + Duration::from_secs(12);
    while Instant::now() < until { std::thread::sleep(Duration::from_millis(250)); if let Some(c) = try_once() { return Some(c); } }
    None
}

fn read_msg(r: &mut impl Read) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len).ok()?;
    let n = u32::from_le_bytes(len) as usize;
    if n > 4 * 1024 * 1024 { return None; }
    let mut b = vec![0u8; n];
    r.read_exact(&mut b).ok()?;
    Some(b)
}

fn write_msg(w: &mut impl Write, b: &[u8]) -> bool { w.write_all(&(b.len() as u32).to_le_bytes()).and_then(|_| w.write_all(b)).and_then(|_| w.flush()).is_ok() }

pub fn run() {
    let (mut stdin, mut stdout) = (std::io::stdin().lock(), std::io::stdout().lock());
    let mut conn: Option<(TcpStream, BufReader<TcpStream>)> = None;
    while let Some(msg) = read_msg(&mut stdin) {
        let id = serde_json::from_slice::<serde_json::Value>(&msg).ok().map(|v| v["rid"].clone()).unwrap_or_default();
        let fail = |e: &str| serde_json::json!({ "rid": id, "error": e }).to_string().into_bytes();
        if conn.is_none() { conn = connect().and_then(|c| { let r = c.try_clone().ok()?; Some((c, BufReader::new(r))) }); }
        let Some((w, r)) = conn.as_mut() else { if !write_msg(&mut stdout, &fail("app_not_running")) { break; } continue };
        let one_line: String = String::from_utf8_lossy(&msg).replace('\n', " ");
        let mut resp = String::new();
        let ok = writeln!(w, "{one_line}").is_ok() && r.read_line(&mut resp).map(|n| n > 0).unwrap_or(false);
        if !ok { conn = None; if !write_msg(&mut stdout, &fail("app_not_running")) { break; } continue; }
        if !write_msg(&mut stdout, resp.trim_end().as_bytes()) { break; }
    }
}
