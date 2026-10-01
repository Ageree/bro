//! Minimal HTTP/1.1 client over a unix socket. One request per connection
//! (`Connection: close`); the response body is framed by Content-Length, by
//! chunked encoding, or by the server closing the connection.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The broker gives the backend 120 s; this leaves room for the transfer.
pub const RESPONSE_TIMEOUT: Duration = Duration::from_secs(150);

const MAX_HEAD: usize = 64 * 1024;
const MAX_LINE: usize = 8 * 1024;
/// The broker caps bodies at 25 MiB; chunk framing adds a little on top.
const MAX_BODY: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug)]
pub enum Error {
    /// No socket file at the path.
    NotFound,
    Connect(io::Error),
    ConnectTimeout,
    Io(io::Error),
    /// No complete response before the deadline.
    Timeout,
    Malformed(String),
}

/// Sends `POST {path}` with `body` and reads the whole response.
pub fn post(
    socket: &Path,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<Response, Error> {
    let mut stream = connect(socket, CONNECT_TIMEOUT)?;
    let deadline = Instant::now() + RESPONSE_TIMEOUT;
    stream
        .set_write_timeout(Some(RESPONSE_TIMEOUT))
        .map_err(Error::Io)?;

    let mut request = format!("POST {path} HTTP/1.1\r\nHost: localhost\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    let sent = stream
        .write_all(request.as_bytes())
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush());
    // The write half stays open: a Go server treats a half-closed connection
    // as a gone client and cancels the request.

    // A server may answer (413, 429) and close before reading the body: its
    // answer is worth more than our write error.
    match (read_response(&mut stream, deadline), sent) {
        (Err(_), Err(write_error)) => Err(Error::Io(write_error)),
        (response, _) => response,
    }
}

/// `UnixStream::connect` has no timeout; a stuck listener would hang it.
fn connect(socket: &Path, timeout: Duration) -> Result<UnixStream, Error> {
    let (sender, receiver) = mpsc::channel();
    let path: PathBuf = socket.to_path_buf();
    thread::spawn(move || {
        let _ = sender.send(UnixStream::connect(path));
    });
    match receiver.recv_timeout(timeout) {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => Err(Error::NotFound),
        Ok(Err(error)) => Err(Error::Connect(error)),
        Err(_) => Err(Error::ConnectTimeout),
    }
}

fn read_response(stream: &mut UnixStream, deadline: Instant) -> Result<Response, Error> {
    let mut parser = Parser::default();
    let mut buf = Vec::with_capacity(16 * 1024);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(Error::Timeout);
        }
        stream
            .set_read_timeout(Some(deadline - now))
            .map_err(Error::Io)?;
        match stream.read(&mut chunk) {
            Ok(0) => {
                return parser
                    .advance(&buf, true)?
                    .ok_or_else(|| Error::Malformed("connection closed early".into()))
            }
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Err(Error::Timeout)
            }
            Err(error) => return Err(Error::Io(error)),
        }
        if buf.len() > MAX_HEAD + MAX_BODY {
            return Err(Error::Malformed("response too large".into()));
        }
        if let Some(response) = parser.advance(&buf, false)? {
            return Ok(response);
        }
    }
}

/// Parses a response held entirely in `buf`; `eof` says the server closed
/// the connection after it. `Ok(None)` means more bytes are needed.
#[cfg(test)]
pub fn parse_response(buf: &[u8], eof: bool) -> Result<Option<Response>, Error> {
    Parser::default().advance(buf, eof)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Framing {
    Length(usize),
    Chunked,
    UntilClose,
    Empty,
}

#[derive(Debug)]
struct Head {
    status: u16,
    headers: Vec<(String, String)>,
    /// Offset of the body in the buffer.
    body_start: usize,
    framing: Framing,
}

/// Incremental parser: `advance` is called with the whole buffer read so
/// far and resumes where it stopped, so a large chunked body is walked once.
#[derive(Debug, Default)]
struct Parser {
    /// Offset of the current response head (after skipped 1xx responses).
    start: usize,
    head: Option<Head>,
    chunked: ChunkedBody,
}

#[derive(Debug, Default)]
struct ChunkedBody {
    /// Offset of the next chunk-size or trailer line, relative to the body.
    pos: usize,
    in_trailers: bool,
    data: Vec<u8>,
}

impl Parser {
    fn advance(&mut self, buf: &[u8], eof: bool) -> Result<Option<Response>, Error> {
        loop {
            if self.head.is_some() {
                break;
            }
            let rest = &buf[self.start..];
            let Some(end) = find(rest, b"\r\n\r\n") else {
                if rest.len() > MAX_HEAD {
                    return Err(malformed("response head too large"));
                }
                return if eof {
                    Err(malformed(if rest.is_empty() {
                        "empty response"
                    } else {
                        "truncated response head"
                    }))
                } else {
                    Ok(None)
                };
            };
            let head = parse_head(&rest[..end], self.start + end + 4)?;
            if (100..200).contains(&head.status) {
                self.start = head.body_start;
                continue;
            }
            self.head = Some(head);
        }
        let head = self.head.as_ref().expect("head parsed above");
        let body = &buf[head.body_start..];
        let data = match head.framing {
            Framing::Empty => Some(Vec::new()),
            Framing::Length(len) if body.len() >= len => Some(body[..len].to_vec()),
            Framing::Length(len) if eof => {
                return Err(malformed(&format!(
                    "body truncated: {} of {len} bytes",
                    body.len()
                )))
            }
            Framing::Length(_) => None,
            Framing::UntilClose => eof.then(|| body.to_vec()),
            Framing::Chunked => match self.chunked.advance(body)? {
                true => Some(std::mem::take(&mut self.chunked.data)),
                false if eof => return Err(malformed("chunked body truncated")),
                false => None,
            },
        };
        Ok(data.map(|body| Response {
            status: head.status,
            headers: head.headers.clone(),
            body,
        }))
    }
}

impl ChunkedBody {
    /// Consumes complete chunks; `true` once the last chunk and trailers are in.
    fn advance(&mut self, body: &[u8]) -> Result<bool, Error> {
        loop {
            let rest = &body[self.pos..];
            let Some(line_end) = find(rest, b"\r\n") else {
                if rest.len() > MAX_LINE {
                    return Err(malformed("chunk line too long"));
                }
                return Ok(false);
            };
            let line = &rest[..line_end];
            if self.in_trailers {
                self.pos += line_end + 2;
                if line.is_empty() {
                    return Ok(true);
                }
                continue;
            }
            let size = parse_chunk_size(line)?;
            if size == 0 {
                self.pos += line_end + 2;
                self.in_trailers = true;
                continue;
            }
            if self.data.len() + size > MAX_BODY {
                return Err(malformed("response too large"));
            }
            let data_start = line_end + 2;
            let Some(after) = rest.get(data_start + size..data_start + size + 2) else {
                return Ok(false);
            };
            if after != b"\r\n" {
                return Err(malformed("chunk not followed by CRLF"));
            }
            self.data
                .extend_from_slice(&rest[data_start..data_start + size]);
            self.pos += data_start + size + 2;
        }
    }
}

fn parse_chunk_size(line: &[u8]) -> Result<usize, Error> {
    let text = std::str::from_utf8(line).map_err(|_| malformed("bad chunk size"))?;
    let digits = text.split(';').next().unwrap_or("").trim();
    if digits.is_empty() || digits.len() > 15 {
        return Err(malformed("bad chunk size"));
    }
    usize::from_str_radix(digits, 16).map_err(|_| malformed("bad chunk size"))
}

fn parse_head(head: &[u8], body_start: usize) -> Result<Head, Error> {
    let text = std::str::from_utf8(head).map_err(|_| malformed("response head is not UTF-8"))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    let code = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/1.") || code.len() != 3 {
        return Err(malformed(&format!("bad status line {status_line:?}")));
    }
    let status: u16 = code
        .parse()
        .map_err(|_| malformed(&format!("bad status line {status_line:?}")))?;

    let mut headers = Vec::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(malformed(&format!("bad header line {line:?}")));
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    fn values<'a>(headers: &'a [(String, String)], name: &'a str) -> impl Iterator<Item = &'a str> {
        headers
            .iter()
            .filter(move |(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    let get = |name| values(&headers, name);

    if let Some(encoding) = get("content-encoding").find(|v| !v.eq_ignore_ascii_case("identity")) {
        return Err(malformed(&format!(
            "unsupported Content-Encoding {encoding}"
        )));
    }
    let framing = if (100..200).contains(&status) || status == 204 || status == 304 {
        Framing::Empty
    } else if let Some(coding) = get("transfer-encoding").last() {
        if !coding.eq_ignore_ascii_case("chunked") {
            return Err(malformed(&format!(
                "unsupported Transfer-Encoding {coding}"
            )));
        }
        Framing::Chunked
    } else {
        let mut lengths = get("content-length").map(|v| v.parse::<usize>());
        match lengths.next() {
            None => Framing::UntilClose,
            Some(Ok(len)) if lengths.all(|other| other == Ok(len)) => {
                if len > MAX_BODY {
                    return Err(malformed("response too large"));
                }
                Framing::Length(len)
            }
            Some(_) => return Err(malformed("bad Content-Length")),
        }
    };
    Ok(Head {
        status,
        headers,
        body_start,
        framing,
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn malformed(message: &str) -> Error {
    Error::Malformed(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete(raw: &[u8]) -> Response {
        parse_response(raw, false)
            .expect("parses")
            .expect("complete")
    }

    #[test]
    fn content_length_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"data\":{}}";
        let response = complete(raw);
        assert_eq!(response.status, 200);
        assert_eq!(response.header("content-type"), Some("application/json"));
        assert_eq!(response.header("Content-Type"), Some("application/json"));
        assert_eq!(response.body, b"{\"data\":{}}");
    }

    #[test]
    fn content_length_waits_for_the_whole_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n12345";
        assert!(parse_response(raw, false).unwrap().is_none());
        assert!(matches!(
            parse_response(raw, true),
            Err(Error::Malformed(_))
        ));
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Le", false)
            .unwrap()
            .is_none());
    }

    #[test]
    fn chunked_body_with_extensions_and_trailers() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\nX-Trailer: 1\r\n\r\n";
        assert_eq!(complete(raw).body, b"Wikipedia in\r\n\r\nchunks.");
    }

    #[test]
    fn chunked_body_fed_byte_by_byte() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na\r\n0123456789\r\n3\r\nabc\r\n0\r\n\r\n";
        let mut parser = Parser::default();
        for end in 0..raw.len() {
            assert!(
                parser.advance(&raw[..end], false).unwrap().is_none(),
                "{end}"
            );
        }
        let response = parser.advance(raw, false).unwrap().unwrap();
        assert_eq!(response.body, b"0123456789abc");
    }

    #[test]
    fn chunked_body_truncated_or_broken() {
        let truncated = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab";
        assert!(parse_response(truncated, false).unwrap().is_none());
        assert!(matches!(
            parse_response(truncated, true),
            Err(Error::Malformed(_))
        ));
        let bad_size = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n";
        assert!(matches!(
            parse_response(bad_size, false),
            Err(Error::Malformed(_))
        ));
        let no_crlf = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nabcd\r\n";
        assert!(matches!(
            parse_response(no_crlf, false),
            Err(Error::Malformed(_))
        ));
    }

    #[test]
    fn body_until_close() {
        let raw = b"HTTP/1.0 200 OK\r\n\r\n{\"data\":null}";
        assert!(parse_response(raw, false).unwrap().is_none());
        assert_eq!(
            parse_response(raw, true).unwrap().unwrap().body,
            b"{\"data\":null}"
        );
    }

    #[test]
    fn skips_informational_responses() {
        let raw = b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Length: 0\r\n\r\n";
        let response = complete(raw);
        assert_eq!(response.status, 429);
        assert_eq!(response.header("retry-after"), Some("7"));
        assert!(response.body.is_empty());
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(
            parse_response(b"SSH-2.0-OpenSSH\r\n\r\n", false),
            Err(Error::Malformed(_))
        ));
        assert!(matches!(
            parse_response(b"", true),
            Err(Error::Malformed(_))
        ));
        let gzip = b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\nx";
        assert!(matches!(
            parse_response(gzip, false),
            Err(Error::Malformed(_))
        ));
        let conflicting = b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nxy";
        assert!(matches!(
            parse_response(conflicting, false),
            Err(Error::Malformed(_))
        ));
    }
}
