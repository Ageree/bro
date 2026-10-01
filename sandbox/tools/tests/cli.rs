//! Runs the built `tools` binary against a fake broker: a thread with a
//! `UnixListener` on a temporary socket that answers canned GraphQL.
//! `TOOLS_BIN` points the tests at another build (the static musl one).

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

fn binary() -> PathBuf {
    std::env::var_os("TOOLS_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_tools")))
}

fn temp_dir(label: &str) -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("bro-tools-{label}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

struct Request {
    head: String,
    body: Value,
}

enum Reply {
    Json(u16, Value),
    Chunked(Value),
    Raw(&'static str),
}

struct Broker {
    dir: PathBuf,
    socket: PathBuf,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Broker {
    fn start(handler: impl Fn(&Value) -> Reply + Send + 'static) -> Self {
        let dir = temp_dir("broker");
        let socket = dir.join("tools.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let request = read_request(&stream);
                let reply = handler(&request.body);
                seen.lock().unwrap().push(request);
                write_reply(stream, reply);
            }
        });
        Self {
            dir,
            socket,
            requests,
        }
    }

    fn run(&self, args: &[&str]) -> Output {
        run(&self.socket, args, None, &self.dir)
    }

    fn run_in(&self, args: &[&str], cwd: &Path) -> Output {
        run(&self.socket, args, None, cwd)
    }

    fn bodies(&self) -> Vec<Value> {
        let requests = self.requests.lock().unwrap();
        requests
            .iter()
            .map(|request| request.body.clone())
            .collect()
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn read_request(stream: &UnixStream) -> Request {
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" || line.is_empty() {
            break;
        }
        head.push_str(&line);
    }
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .expect("Content-Length")
        .trim()
        .parse()
        .unwrap();
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    Request {
        head,
        body: serde_json::from_slice(&body).expect("JSON body"),
    }
}

fn write_reply(mut stream: UnixStream, reply: Reply) {
    let bytes = match reply {
        Reply::Json(status, value) => {
            let body = value.to_string();
            format!(
                "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_bytes()
        }
        Reply::Chunked(value) => {
            let mut bytes = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
            for chunk in value.to_string().as_bytes().chunks(7) {
                bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                bytes.extend_from_slice(chunk);
                bytes.extend_from_slice(b"\r\n");
            }
            bytes.extend_from_slice(b"0\r\n\r\n");
            bytes
        }
        Reply::Raw(text) => text.as_bytes().to_vec(),
    };
    let _ = stream.write_all(&bytes);
}

fn run(socket: &Path, args: &[&str], stdin: Option<&str>, cwd: &Path) -> Output {
    let mut child = Command::new(binary())
        .args(args)
        .env("BRO_TOOLS_SOCKET", socket)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("tools binary runs");
    if let Some(text) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
    }
    child.wait_with_output().unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).unwrap()
}

fn stderr(output: &Output) -> String {
    String::from_utf8(output.stderr.clone()).unwrap()
}

/// A file with every byte value, for the download round trip.
fn file_bytes() -> Vec<u8> {
    let mut bytes: Vec<u8> = "привет, файл\n".as_bytes().to_vec();
    bytes.extend(0..=255u8);
    bytes
}

fn base64(bytes: &[u8]) -> String {
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

fn tool_list() -> Value {
    json!({"data": {"tools": [
        {
            "name": "web_search",
            "description": "Search the web.\nUse it for fresh facts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for."},
                    "max_results": {"type": "integer"}
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "web_fetch",
            "description": "Read a web page.",
            "inputSchema": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"]
            }
        },
        {
            "name": "download",
            "description": "Download a file by URL.",
            "inputSchema": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"]
            }
        }
    ]}})
}

/// Answers `tools` with the list above and `toolExecute` per tool name.
fn backend(body: &Value) -> Reply {
    let query = body["query"].as_str().unwrap_or("");
    if !query.contains("toolExecute") {
        return Reply::Json(200, tool_list());
    }
    let name = body["variables"]["name"].as_str().unwrap_or("");
    let input = &body["variables"]["input"];
    let result = match name {
        "web_search" => json!({
            "ok": true,
            "output": format!("results for {}", input["query"].as_str().unwrap_or("?")),
            "error": null
        }),
        "web_fetch" => {
            json!({"ok": true, "output": {"title": "Пример", "status": 200}, "error": null})
        }
        "download" => {
            let bytes = file_bytes();
            json!({"ok": true, "error": null, "output": {
                "base64": base64(&bytes),
                "mediaType": "text/plain",
                "bytes": bytes.len(),
                "fileName": "../hello.txt"
            }})
        }
        "broken" => json!({"ok": false, "output": null, "error": "upstream exploded"}),
        _ => {
            return Reply::Json(
                200,
                json!({"data": null, "errors": [{"message": format!("unknown tool {name}")}]}),
            )
        }
    };
    Reply::Json(200, json!({"data": {"toolExecute": result}}))
}

#[test]
fn lists_tools() {
    let broker = Broker::start(backend);
    for args in [&[][..], &["list"][..]] {
        let output = broker.run(args);
        assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
        let text = stdout(&output);
        assert!(text.starts_with("web-search — Search the web.\n"), "{text}");
        assert!(text.contains("web-fetch  — Read a web page.\n"), "{text}");
        assert!(
            text.contains("download   — Download a file by URL.\n"),
            "{text}"
        );
        assert!(!text.contains("fresh facts"), "{text}");
    }
    let requests = broker.requests.lock().unwrap();
    let request = &requests[0];
    assert!(
        request.head.starts_with("POST /graphql HTTP/1.1\r\n"),
        "{}",
        request.head
    );
    assert!(
        request.head.contains("Host: localhost\r\n"),
        "{}",
        request.head
    );
    assert!(
        request.head.contains("Connection: close\r\n"),
        "{}",
        request.head
    );
    assert!(
        request.head.contains("Content-Type: application/json\r\n"),
        "{}",
        request.head
    );
    assert!(request.body["query"].as_str().unwrap().contains("tools"));
}

#[test]
fn general_help_lists_tools_too() {
    let broker = Broker::start(backend);
    let output = broker.run(&["--help"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    let text = stdout(&output);
    assert!(text.contains("Usage:"), "{text}");
    assert!(text.contains("web-search — Search the web."), "{text}");
}

#[test]
fn calls_with_a_json_argument_in_one_request() {
    let broker = Broker::start(backend);
    let output = broker.run(&["web-search", r#"{"query": "погода"}"#]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "results for погода\n");
    let bodies = broker.bodies();
    assert_eq!(bodies.len(), 1);
    assert_eq!(
        bodies[0]["variables"],
        json!({"name": "web_search", "input": {"query": "погода"}})
    );
}

#[test]
fn short_form_maps_onto_the_schema() {
    let broker = Broker::start(backend);
    let output = broker.run(&["web-search", "погода в Москве", "--max-results", "3"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "results for погода в Москве\n");
    let bodies = broker.bodies();
    assert_eq!(bodies.len(), 2, "the schema first, then the call");
    assert_eq!(
        bodies[1]["variables"],
        json!({"name": "web_search", "input": {"query": "погода в Москве", "max_results": 3}})
    );
}

#[test]
fn prints_json_output_pretty() {
    let broker = Broker::start(backend);
    let output = broker.run(&["web_fetch", "https://example.com"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "{\n  \"status\": 200,\n  \"title\": \"Пример\"\n}\n"
    );
}

#[test]
fn reads_json_from_stdin() {
    let broker = Broker::start(backend);
    let output = run(
        &broker.socket,
        &["web-search"],
        Some(r#"{"query": "из stdin"}"#),
        &broker.dir,
    );
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "results for из stdin\n");
}

#[test]
fn tool_help_shows_usage_and_schema() {
    let broker = Broker::start(backend);
    let output = broker.run(&["web-search", "--help"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    let text = stdout(&output);
    assert!(
        text.starts_with("web-search — Search the web.\nUse it for fresh facts."),
        "{text}"
    );
    assert!(
        text.contains("  tools web-search <query> [--max-results <integer>]\n"),
        "{text}"
    );
    assert!(
        text.contains("\"required\": [\n    \"query\"\n  ]"),
        "{text}"
    );
}

#[test]
fn tool_error_goes_to_stderr_with_exit_1() {
    let broker = Broker::start(backend);
    let output = broker.run(&["broken", "{}"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(stdout(&output), "");
    assert_eq!(stderr(&output), "upstream exploded\n");
}

#[test]
fn graphql_errors_exit_1() {
    let broker = Broker::start(backend);
    let output = broker.run(&["nope", "{}"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(
        stderr(&output).contains("graphql error: unknown tool nope"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn input_errors_exit_1_with_usage() {
    let broker = Broker::start(backend);
    let output = broker.run(&["web-search"]);
    assert_eq!(output.status.code(), Some(1));
    let text = stderr(&output);
    assert!(text.contains("missing <query>"), "{text}");
    assert!(text.contains("usage: tools web-search <query>"), "{text}");

    let output = broker.run(&["no-such-tool", "x"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("available: web-search, web-fetch, download"));

    let output = broker.run(&["web-search", "{not json"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr(&output).contains("not valid JSON"));
}

#[test]
fn download_writes_the_file() {
    let broker = Broker::start(backend);
    let cwd = temp_dir("download");
    let expected = file_bytes();

    let output = broker.run_in(
        &[
            "download",
            "https://example.com/hello.txt",
            "out/dir/file.txt",
        ],
        &cwd,
    );
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(
        stdout(&output),
        format!(
            "saved out/dir/file.txt ({} bytes, text/plain)\n",
            expected.len()
        )
    );
    assert_eq!(fs::read(cwd.join("out/dir/file.txt")).unwrap(), expected);
    assert_eq!(
        broker.bodies()[0]["variables"],
        json!({"name": "download", "input": {"url": "https://example.com/hello.txt"}})
    );

    // A directory keeps the site's file name, stripped of any path.
    let output = broker.run_in(&["download", "https://example.com/hello.txt", "out/"], &cwd);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(fs::read(cwd.join("out/hello.txt")).unwrap(), expected);

    let output = broker.run_in(&["download", "https://example.com/hello.txt"], &cwd);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(fs::read(cwd.join("hello.txt")).unwrap(), expected);
    assert!(!cwd.parent().unwrap().join("hello.txt").exists());
    let _ = fs::remove_dir_all(cwd);
}

#[test]
fn missing_socket_exits_2() {
    let dir = temp_dir("missing");
    let output = run(&dir.join("absent.sock"), &["list"], None, &dir);
    assert_eq!(output.status.code(), Some(2));
    assert!(
        stderr(&output).contains("no broker socket at"),
        "{}",
        stderr(&output)
    );

    // A socket file nobody listens on: connection refused.
    let socket = dir.join("dead.sock");
    drop(UnixListener::bind(&socket).unwrap());
    let output = run(&socket, &["web-search", "{}"], None, &dir);
    assert_eq!(output.status.code(), Some(2));
    assert!(
        stderr(&output).contains("cannot connect to the broker"),
        "{}",
        stderr(&output)
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rate_limit_exits_3() {
    let broker = Broker::start(|_| {
        Reply::Raw("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 12\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    });
    let output = broker.run(&["web-search", r#"{"query": "q"}"#]);
    assert_eq!(output.status.code(), Some(3));
    let text = stderr(&output);
    assert!(text.contains("rate limited"), "{text}");
    assert!(text.contains("retry in 12 s"), "{text}");
}

#[test]
fn broker_http_errors_exit_1() {
    let broker = Broker::start(|_| {
        Reply::Json(
            502,
            json!({"error": "upstream_failed", "message": "router unreachable"}),
        )
    });
    let output = broker.run(&["list"]);
    assert_eq!(output.status.code(), Some(1));
    let text = stderr(&output);
    assert!(text.contains("HTTP 502"), "{text}");
    assert!(
        text.contains("router unreachable (upstream_failed)"),
        "{text}"
    );
}

#[test]
fn reads_chunked_responses() {
    let broker = Broker::start(|body| match backend(body) {
        Reply::Json(_, value) => Reply::Chunked(value),
        other => other,
    });
    let output = broker.run(&["web-search", "chunked", "--max-results=1"]);
    assert_eq!(output.status.code(), Some(0), "{}", stderr(&output));
    assert_eq!(stdout(&output), "results for chunked\n");
}

#[test]
fn prints_the_version() {
    let dir = temp_dir("version");
    let output = run(&dir.join("unused.sock"), &["--version"], None, &dir);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        stdout(&output),
        format!("tools {}\n", env!("CARGO_PKG_VERSION"))
    );
    let _ = fs::remove_dir_all(dir);
}
