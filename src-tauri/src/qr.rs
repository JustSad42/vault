//! Wi-Fi QR code (the WIFI: format phones read): returns an SVG string made here, never user markup.
use qrcode::{render::svg, QrCode};

fn esc(s: &str) -> String { s.chars().flat_map(|c| if r#"\;,:""#.contains(c) { vec!['\\', c] } else { vec![c] }).collect() }

pub fn wifi(ssid: &str, pass: &str, security: &str) -> Result<String, String> {
    let t = if pass.is_empty() { "nopass" } else if security.to_uppercase().contains("WEP") { "WEP" } else { "WPA" };
    let payload = format!("WIFI:T:{t};S:{};P:{};;", esc(ssid), esc(pass));
    QrCode::new(payload.as_bytes()).map_err(|e| e.to_string()).map(|c| c.render::<svg::Color>().min_dimensions(220, 220).quiet_zone(true).build())
}

/// All QR codes found in an RGBA image; retries inverted (light-on-dark codes from dark themes).
pub fn decode_rgba(w: usize, h: usize, rgba: &[u8]) -> Vec<String> {
    if w == 0 || h == 0 || rgba.len() < w * h * 4 { return vec![]; }
    let run = |invert: bool| -> Vec<String> {
        let mut img = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| {
            let i = (y * w + x) * 4;
            let l = ((rgba[i] as u32 * 299 + rgba[i + 1] as u32 * 587 + rgba[i + 2] as u32 * 114) / 1000) as u8;
            if invert { 255 - l } else { l }
        });
        let grids = img.detect_grids();
        grids.into_iter().filter_map(|g| g.decode().ok().map(|(_, c)| c)).collect()
    };
    let mut found = run(false);
    if found.is_empty() { found = run(true); }
    found.sort();
    found.dedup();
    found
}

pub fn decode_image(bytes: &[u8]) -> Result<Vec<String>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("could not read that image: {e}"))?.to_rgba8();
    Ok(decode_rgba(img.width() as usize, img.height() as usize, img.as_raw()))
}

/// QR codes visible on any monitor right now.
pub fn capture_screens() -> Result<Vec<String>, String> {
    let mut found = vec![];
    for m in xcap::Monitor::all().map_err(|e| e.to_string())? {
        let img = m.capture_image().map_err(|e| e.to_string())?;
        found.extend(decode_rgba(img.width() as usize, img.height() as usize, img.as_raw()));
    }
    found.sort();
    found.dedup();
    Ok(found)
}

#[cfg(test)]
mod tests {
    fn render(payload: &str, invert: bool) -> (usize, Vec<u8>) {
        let code = qrcode::QrCode::new(payload.as_bytes()).unwrap();
        let (n, scale, quiet) = (code.width(), 6, 4);
        let side = (n + quiet * 2) * scale;
        let mut px = vec![if invert { 0u8 } else { 255 }; side * side * 4];
        for (i, c) in code.to_colors().into_iter().enumerate() {
            if c != qrcode::Color::Dark { continue; }
            let (mx, my) = ((i % n + quiet) * scale, (i / n + quiet) * scale);
            for y in my..my + scale { for x in mx..mx + scale { let o = (y * side + x) * 4; px[o..o + 3].fill(if invert { 255 } else { 0 }); } }
        }
        for a in px.chunks_mut(4) { a[3] = 255; }
        (side, px)
    }

    #[test]
    fn decodes_qr_codes_normal_and_inverted() {
        let t = "otpauth://totp/Ex:me?secret=GEZDGNBVGY3TQOJQ&issuer=Ex";
        for invert in [false, true] {
            let (side, px) = render(t, invert);
            assert_eq!(super::decode_rgba(side, side, &px), vec![t.to_string()], "invert={invert}");
        }
        assert!(super::decode_rgba(10, 10, &[255; 400]).is_empty());
        assert!(super::decode_rgba(10, 10, &[0; 4]).is_empty(), "short buffer must not panic");
    }

    use super::*;

    #[test]
    fn escapes_and_renders() {
        assert_eq!(esc(r#"a;b:c\d"e,f"#), r#"a\;b\:c\\d\"e\,f"#);
        assert!(wifi("Home", "secret pass", "WPA2").unwrap().contains("<svg"));
        assert!(wifi("", "x", "").is_ok());
    }
}
