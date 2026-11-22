//! Wi-Fi QR code (the WIFI: format phones read): returns an SVG string made here, never user markup.
use qrcode::{render::svg, QrCode};

fn esc(s: &str) -> String { s.chars().flat_map(|c| if r#"\;,:""#.contains(c) { vec!['\\', c] } else { vec![c] }).collect() }

pub fn wifi(ssid: &str, pass: &str, security: &str) -> Result<String, String> {
    let t = if pass.is_empty() { "nopass" } else if security.to_uppercase().contains("WEP") { "WEP" } else { "WPA" };
    let payload = format!("WIFI:T:{t};S:{};P:{};;", esc(ssid), esc(pass));
    QrCode::new(payload.as_bytes()).map_err(|e| e.to_string()).map(|c| c.render::<svg::Color>().min_dimensions(220, 220).quiet_zone(true).build())
}

fn grids(w: usize, h: usize, px: &[u8]) -> Vec<String> {
    let mut img = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| px[y * w + x]);
    img.detect_grids().into_iter().filter_map(|g| g.decode().ok().map(|(_, c)| c)).collect()
}

/// 3x3 mean: averages out sensor noise.
fn box3(w: usize, h: usize, l: &[u8]) -> Vec<u8> {
    let mut o = l.to_vec();
    for y in 1..h - 1 { for x in 1..w - 1 {
        let mut t = 0u32;
        for dy in 0..3 { for dx in 0..3 { t += l[(y + dy - 1) * w + x + dx - 1] as u32; } }
        o[y * w + x] = (t / 9) as u8;
    } }
    o
}

/// Bilinear 2x upscale: gives the detector more samples per module on small, dense codes.
fn up2(w: usize, h: usize, l: &[u8]) -> (usize, usize, Vec<u8>) {
    let (w2, h2) = (w * 2, h * 2);
    let mut o = vec![0u8; w2 * h2];
    let at = |x: usize, y: usize| l[y.min(h - 1) * w + x.min(w - 1)] as u32;
    for y in 0..h { for x in 0..w {
        let (p, r, d, rd) = (at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1));
        o[2 * y * w2 + 2 * x] = p as u8;
        o[2 * y * w2 + 2 * x + 1] = ((p + r) / 2) as u8;
        o[(2 * y + 1) * w2 + 2 * x] = ((p + d) / 2) as u8;
        o[(2 * y + 1) * w2 + 2 * x + 1] = ((p + r + d + rd) / 4) as u8;
    } }
    (w2, h2, o)
}

/// Unsharp mask: undoes some of the blur from focus and compression.
fn sharpen(w: usize, h: usize, l: &[u8]) -> Vec<u8> {
    let b = box3(w, h, l);
    l.iter().zip(&b).map(|(&o, &b)| (o as i32 + (o as i32 - b as i32) * 2).clamp(0, 255) as u8).collect()
}

/// All QR codes found in an 8-bit grayscale image. Phone screens seen by a webcam are blurry, noisy and moire-patterned,
/// so on a miss it tries other versions of the picture: inverted, denoised, half size, upscaled, sharpened.
pub fn decode_luma(w: usize, h: usize, luma: &[u8]) -> Vec<String> {
    if w < 16 || h < 16 || luma.len() < w * h { return vec![]; }
    let luma = &luma[..w * h];
    let both = |w: usize, h: usize, px: &[u8]| -> Vec<String> {
        let f = grids(w, h, px);
        if !f.is_empty() { return f; }
        let inv: Vec<u8> = px.iter().map(|v| 255 - v).collect();
        grids(w, h, &inv)
    };
    let mut found = both(w, h, luma);
    if found.is_empty() { let d = box3(w, h, luma); found = both(w, h, &d); }
    if found.is_empty() && w >= 128 && h >= 128 {
        let (w2, h2) = (w / 2, h / 2);
        let half: Vec<u8> = (0..w2 * h2).map(|i| { let (x, y) = (i % w2, i / w2); let j = 2 * y * w + 2 * x; ((luma[j] as u16 + luma[j + 1] as u16 + luma[j + w] as u16 + luma[j + w + 1] as u16) / 4) as u8 }).collect();
        found = both(w2, h2, &half);
    }
    if found.is_empty() && w * h <= 2_200_000 { let (w2, h2, u) = up2(w, h, &box3(w, h, luma)); found = both(w2, h2, &u); }
    if found.is_empty() { let sh = sharpen(w, h, &box3(w, h, luma)); found = both(w, h, &sh); }
    found.sort();
    found.dedup();
    found
}

/// All QR codes found in an RGBA image.
pub fn decode_rgba(w: usize, h: usize, rgba: &[u8]) -> Vec<String> {
    if w == 0 || h == 0 || rgba.len() < w * h * 4 { return vec![]; }
    let luma: Vec<u8> = rgba.chunks_exact(4).take(w * h).map(|p| ((p[0] as u32 * 299 + p[1] as u32 * 587 + p[2] as u32 * 114) / 1000) as u8).collect();
    decode_luma(w, h, &luma)
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

    /// A webcam looking at a phone: dense QR, a few pixels per module, blur and sensor noise.
    #[test]
    fn decodes_a_dense_blurry_noisy_webcam_style_qr() {
        let payload: String = (0..560).map(|i| (b'A' + (i * 7 % 26) as u8) as char).collect();
        let (side, px) = render_scaled(&payload, 5);
        let src: Vec<u8> = px.chunks(4).map(|p| p[0]).collect();
        let mut tmp = src.clone();
        for y in 0..side { for x in 1..side - 1 { tmp[y * side + x] = ((src[y * side + x - 1] as u32 + 2 * src[y * side + x] as u32 + src[y * side + x + 1] as u32) / 4) as u8; } }
        let mut luma = tmp.clone();
        for y in 1..side - 1 { for x in 0..side { luma[y * side + x] = ((tmp[(y - 1) * side + x] as u32 + 2 * tmp[y * side + x] as u32 + tmp[(y + 1) * side + x] as u32) / 4) as u8; } } // [1 2 1] blur both ways
        let mut seed = 12345u32;
        for v in luma.iter_mut() { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); *v = (*v as i32 + ((seed >> 24) as i32 % 31) - 15).clamp(0, 255) as u8; }
        assert_eq!(super::decode_luma(side, side, &luma), vec![payload]);
    }

    fn render_scaled(payload: &str, scale: usize) -> (usize, Vec<u8>) {
        let code = qrcode::QrCode::new(payload.as_bytes()).unwrap();
        let (n, quiet) = (code.width(), 4);
        let side = (n + quiet * 2) * scale;
        let mut px = vec![255u8; side * side * 4];
        for (i, c) in code.to_colors().into_iter().enumerate() {
            if c != qrcode::Color::Dark { continue; }
            let (mx, my) = ((i % n + quiet) * scale, (i / n + quiet) * scale);
            for y in my..my + scale { for x in mx..mx + scale { let o = (y * side + x) * 4; px[o..o + 3].fill(0); } }
        }
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
