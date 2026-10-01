//! GraphQL over the broker socket: `query { tools }` and
//! `mutation { toolExecute }`. The broker (`sandboxd`) adds the router token
//! and forwards the body as is; the sandbox holds no secrets.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::{http, Fail};

pub const DEFAULT_SOCKET: &str = "/run/bro/tools.sock";

const EXECUTE: &str = "mutation ToolExecute($name: String!, $input: JSON!) { \
    toolExecute(name: $name, input: $input) { ok output error } }";

pub struct Broker {
    pub socket: PathBuf,
}

pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

pub struct Outcome {
    pub ok: bool,
    pub output: Value,
    pub error: Option<String>,
}

impl Broker {
    /// `BRO_TOOLS_SOCKET`, or the socket `sandboxd` mounts in every sandbox.
    pub fn from_env() -> Self {
        let socket = std::env::var_os("BRO_TOOLS_SOCKET")
            .filter(|value| !value.is_empty())
            .map_or_else(|| PathBuf::from(DEFAULT_SOCKET), PathBuf::from);
        Self { socket }
    }

    pub fn tools(&self, with_schema: bool) -> Result<Vec<Tool>, Fail> {
        let query = if with_schema {
            "query Tools { tools { name description inputSchema } }"
        } else {
            "query Tools { tools { name description } }"
        };
        let data = self.request(query, json!({}))?;
        let list = data["tools"]
            .as_array()
            .ok_or_else(|| Fail::error("malformed broker response: no tools list"))?;
        Ok(list
            .iter()
            .filter_map(|tool| {
                Some(Tool {
                    name: tool["name"].as_str()?.to_string(),
                    description: tool["description"].as_str().unwrap_or("").to_string(),
                    // A JSON scalar may come serialized as a string.
                    input_schema: match &tool["inputSchema"] {
                        Value::String(text) => serde_json::from_str(text).unwrap_or(Value::Null),
                        schema => schema.clone(),
                    },
                })
            })
            .collect())
    }

    pub fn execute(&self, name: &str, input: Value) -> Result<Outcome, Fail> {
        let mut data = self.request(EXECUTE, json!({"name": name, "input": input}))?;
        let result = data["toolExecute"].take();
        if !result.is_object() {
            return Err(Fail::error(
                "malformed broker response: no toolExecute result",
            ));
        }
        Ok(Outcome {
            ok: result["ok"].as_bool() == Some(true),
            error: result["error"].as_str().map(str::to_string),
            output: result.get("output").cloned().unwrap_or(Value::Null),
        })
    }

    fn request(&self, query: &str, variables: Value) -> Result<Value, Fail> {
        let body = json!({"query": query, "variables": variables}).to_string();
        let agent = concat!("bro-tools/", env!("CARGO_PKG_VERSION"));
        let response = http::post(
            &self.socket,
            "/graphql",
            &[
                ("User-Agent", agent),
                ("Content-Type", "application/json"),
                (
                    "Accept",
                    "application/graphql-response+json, application/json",
                ),
                ("Accept-Encoding", "identity"),
            ],
            body.as_bytes(),
        )
        .map_err(|error| self.unreachable(error))?;

        let parsed: Option<Value> = serde_json::from_slice(&response.body).ok();
        if response.status == 429 {
            let wait = match response.header("retry-after") {
                Some(seconds) => format!("retry in {seconds} s"),
                None => "wait a minute and retry".to_string(),
            };
            // The broker forwards the router's own statuses: only its
            // `rate_limited` code means the broker's quota.
            let who = if broker_code(parsed.as_ref()) == Some("rate_limited") {
                "the broker allows 120 requests a minute per sandbox".to_string()
            } else {
                http_error(response.status, parsed.as_ref(), &response.body)
            };
            return Err(Fail::rate_limited(format!("rate limited: {who}; {wait}")));
        }
        let errors = parsed
            .as_ref()
            .and_then(|value| value["errors"].as_array())
            .filter(|errors| !errors.is_empty());
        if let Some(errors) = errors {
            return Err(Fail::error(graphql_errors(errors)));
        }
        if !(200..300).contains(&response.status) {
            return Err(Fail::error(http_error(
                response.status,
                parsed.as_ref(),
                &response.body,
            )));
        }
        match parsed {
            Some(mut value) if value["data"].is_object() => Ok(value["data"].take()),
            _ => Err(Fail::error(format!(
                "malformed broker response: {}",
                snippet(&response.body)
            ))),
        }
    }

    fn unreachable(&self, error: http::Error) -> Fail {
        let socket = self.socket.display();
        Fail::unreachable(match error {
            http::Error::NotFound => format!(
                "no broker socket at {socket}: tools work only inside a Bro sandbox (BRO_TOOLS_SOCKET overrides the path)"
            ),
            http::Error::Connect(error) => format!("cannot connect to the broker at {socket}: {error}"),
            http::Error::ConnectTimeout => format!(
                "connecting to the broker at {socket} timed out after {} s",
                http::CONNECT_TIMEOUT.as_secs()
            ),
            http::Error::Io(error) => format!("broker connection failed: {error}"),
            http::Error::Timeout => format!(
                "no answer from the broker within {} s",
                http::RESPONSE_TIMEOUT.as_secs()
            ),
            http::Error::Malformed(message) => format!("unreadable answer from the broker: {message}"),
        })
    }
}

fn graphql_errors(errors: &[Value]) -> String {
    errors
        .iter()
        .map(|error| {
            let message = match error["message"].as_str() {
                Some(message) => message.to_string(),
                None => error.to_string(),
            };
            match error["extensions"]["code"].as_str() {
                Some(code) => format!("graphql error: {message} ({code})"),
                None => format!("graphql error: {message}"),
            }
        })
        .collect::<Vec<_>>()
        .join("\ntools: ")
}

/// `sandboxd` errors are `{"error": "<code>", "message": "…"}`.
fn http_error(status: u16, parsed: Option<&Value>, body: &[u8]) -> String {
    let detail = match parsed.map(|value| (value["error"].as_str(), value["message"].as_str())) {
        Some((Some(code), Some(message))) => format!("{message} ({code})"),
        Some((Some(text), None) | (None, Some(text))) => text.to_string(),
        _ => snippet(body),
    };
    let what = match (status, broker_code(parsed)) {
        (413, Some("too_large")) => {
            "the request is too large for the broker (25 MiB at most)".to_string()
        }
        _ => format!("the broker answered HTTP {status}"),
    };
    if detail.is_empty() {
        what
    } else {
        format!("{what}: {detail}")
    }
}

/// The code of an error `sandboxd` itself wrote (`{"error": "<code>", …}`).
fn broker_code(parsed: Option<&Value>) -> Option<&str> {
    parsed.and_then(|value| value["error"].as_str())
}

fn snippet(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    match text.char_indices().nth(300) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}
