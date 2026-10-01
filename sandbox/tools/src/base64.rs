//! Base64 decoding (RFC 4648): `download` returns the file as base64 inside
//! JSON. Accepts the standard and the URL-safe alphabet, optional padding and
//! line breaks.

const INVALID: u8 = 0xff;

const fn decode_table() -> [u8; 256] {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut table = [INVALID; 256];
    let mut i = 0;
    while i < alphabet.len() {
        table[alphabet[i] as usize] = i as u8;
        i += 1;
    }
    table[b'-' as usize] = 62;
    table[b'_' as usize] = 63;
    table
}

static TABLE: [u8; 256] = decode_table();

pub fn decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3 + 3);
    let mut group: u32 = 0;
    let mut filled = 0;
    let mut padding = 0;
    for (offset, &byte) in input.as_bytes().iter().enumerate() {
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            b'=' => {
                padding += 1;
                continue;
            }
            _ => {}
        }
        if padding > 0 {
            return Err(format!("data after padding at offset {offset}"));
        }
        let value = TABLE[byte as usize];
        if value == INVALID {
            return Err(format!("invalid character at offset {offset}"));
        }
        group = (group << 6) | u32::from(value);
        filled += 1;
        if filled == 4 {
            out.extend_from_slice(&[(group >> 16) as u8, (group >> 8) as u8, group as u8]);
            group = 0;
            filled = 0;
        }
    }
    if padding > 0 && (filled == 0 || filled + padding != 4) {
        return Err("bad padding".to_string());
    }
    match filled {
        0 => {}
        2 => out.push((group >> 4) as u8),
        3 => out.extend_from_slice(&[(group >> 10) as u8, (group >> 2) as u8]),
        _ => return Err("truncated input".to_string()),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::decode;

    fn encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn rfc4648_vectors() {
        for (plain, encoded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(decode(encoded).unwrap(), plain.as_bytes(), "{encoded}");
        }
    }

    #[test]
    fn padding_is_optional() {
        assert_eq!(decode("Zg").unwrap(), b"f");
        assert_eq!(decode("Zm9vYmE").unwrap(), b"fooba");
    }

    #[test]
    fn line_breaks_and_url_safe_alphabet() {
        assert_eq!(decode("Zm9v\r\nYmFy\n").unwrap(), b"foobar");
        assert_eq!(decode("-_-_").unwrap(), decode("+/+/").unwrap());
    }

    #[test]
    fn all_bytes_round_trip() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        for len in [0, 1, 2, 3, 254, 255, 256, 1000] {
            assert_eq!(decode(&encode(&bytes[..len])).unwrap(), &bytes[..len]);
        }
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(decode("Zm9v!").unwrap_err().contains("invalid character"));
        assert!(decode("Z").unwrap_err().contains("truncated"));
        assert!(decode("Zg==Zg==").unwrap_err().contains("after padding"));
        assert!(decode("Zg=").is_err());
        assert!(decode("Zm8==").is_err());
        assert!(decode("====").is_err());
    }
}
