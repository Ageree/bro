//! `tools`: Bro's tools from inside the sandbox. The sandbox has no network;
//! the CLI sends GraphQL over HTTP/1.1 to the broker's unix socket, and the
//! broker forwards it to Bro's tool router with the token it holds.

mod base64;
mod broker;
mod http;
mod input;

use std::fs;
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{json, Value};

use broker::{Broker, Outcome, Tool};
use input::display_name;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// An error to print on stderr and the exit code that goes with it.
pub struct Fail {
    code: u8,
    message: String,
}

impl Fail {
    /// A tool, input or request error: exit 1.
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            code: 1,
            message: format!("tools: {}", message.into()),
        }
    }

    /// The tool's own `error`, printed as is: exit 1.
    fn tool(message: String) -> Self {
        Self { code: 1, message }
    }

    /// No socket, or the broker does not answer: exit 2.
    pub fn unreachable(message: String) -> Self {
        Self {
            code: 2,
            message: format!("tools: {message}"),
        }
    }

    /// The broker's HTTP 429: exit 3.
    pub fn rate_limited(message: String) -> Self {
        Self {
            code: 3,
            message: format!("tools: {message}"),
        }
    }
}

fn main() -> ExitCode {
    let args: Result<Vec<String>, _> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string())
        .collect();
    let result = match args {
        Ok(args) => run(&args),
        Err(_) => Err(Fail::error("arguments must be UTF-8")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(fail) => {
            let _ = io::stdout().flush();
            let _ = writeln!(io::stderr(), "{}", fail.message.trim_end());
            ExitCode::from(fail.code)
        }
    }
}

fn run(args: &[String]) -> Result<(), Fail> {
    let broker = Broker::from_env();
    match args.first().map(String::as_str) {
        None => list(&broker),
        Some("list") if args.len() == 1 => list(&broker),
        Some("list") => Err(Fail::error("`tools list` takes no arguments")),
        Some("--help" | "-h") => help(&broker),
        Some("help") => match args.get(1) {
            Some(name) => tool_help(&broker, name),
            None => help(&broker),
        },
        Some("--version" | "-V") => emit(&format!("tools {VERSION}\n")),
        Some(option) if option.starts_with('-') => Err(Fail::error(format!(
            "unknown option {option}; see tools --help"
        ))),
        Some(name) => call(&broker, name, &args[1..]),
    }
}

fn help(broker: &Broker) -> Result<(), Fail> {
    emit(&format!(
        "tools {VERSION} — Bro's tools inside the sandbox, through the broker at {socket}

Usage:
  tools                          list the tools
  tools <name> --help            a tool's description and JSON input schema
  tools <name> '<json>'          call a tool with a JSON object (or pipe the JSON to stdin)
  tools <name> <value>... [--key <value>]...
                                 short form: values fill the required fields in order,
                                 --max-results sets max_results (or maxResults)
  tools download <url> [<path>]  save a file from the web into the sandbox
  tools --version

Prints the tool's output: text as is, anything else as JSON. Exit codes: 0 done,
1 tool or input error (on stderr), 2 broker unreachable, 3 rate limited.

Tools:
",
        socket = broker.socket.display()
    ))?;
    list(broker)
}

fn list(broker: &Broker) -> Result<(), Fail> {
    let tools = broker.tools(false)?;
    if tools.is_empty() {
        return emit("no tools available\n");
    }
    let names: Vec<String> = tools.iter().map(|tool| display_name(&tool.name)).collect();
    let width = names
        .iter()
        .map(|name| name.chars().count())
        .max()
        .unwrap_or(0);
    let mut text = String::new();
    for (tool, name) in tools.iter().zip(&names) {
        text.push_str(&format!(
            "{name:<width$} — {}\n",
            summary(&tool.description)
        ));
    }
    text.push_str("\nDetails and input: tools <name> --help\n");
    emit(&text)
}

/// The first line of a description, cut to fit a list row.
fn summary(description: &str) -> String {
    const LIMIT: usize = 110;
    let line = description
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= LIMIT {
        return line;
    }
    let cut: String = line.chars().take(LIMIT).collect();
    let cut = match cut.rfind(' ') {
        Some(space) if space > LIMIT / 2 => &cut[..space],
        _ => cut.as_str(),
    };
    format!("{}…", cut.trim_end_matches([',', '.', ';', ':', ' ']))
}

fn tool_help(broker: &Broker, name: &str) -> Result<(), Fail> {
    let tools = broker.tools(true)?;
    let tool = find(&tools, name)?;
    let shown = display_name(&tool.name);
    let mut text = format!("{shown} — {}\n\nUsage:\n", tool.description.trim());
    if is_download(name) {
        text.push_str(
            "  tools download <url> [<path>]     save the file at <path>; a directory, or no path,\n\
             \x20                                   keeps the file's own name\n\
             \x20 tools download '<json>' [<path>]  the same with other input fields\n",
        );
    } else {
        text.push_str(&format!(
            "  {}\n  tools {shown} '<json>'   (or the JSON on stdin)\n",
            input::usage(&tool.name, &tool.input_schema)
        ));
    }
    text.push_str(&format!(
        "\nInput schema:\n{}\n",
        pretty(&tool.input_schema)
    ));
    emit(&text)
}

fn call(broker: &Broker, name: &str, args: &[String]) -> Result<(), Fail> {
    let mut options = args.iter().take_while(|arg| *arg != "--");
    if options.any(|arg| arg == "--help" || arg == "-h") {
        return tool_help(broker, name);
    }
    if is_download(name) {
        return download(broker, name, args);
    }
    let (tool_name, input) = match json_input(args)? {
        Some(input) => (input::wire_name(name), input),
        None => {
            let tools = broker.tools(true)?;
            let tool = find(&tools, name)?;
            let input = input::build_input(&tool.input_schema, args).map_err(|error| {
                Fail::error(format!(
                    "{error}\nusage: {}\n       tools {} '<json>'",
                    input::usage(&tool.name, &tool.input_schema),
                    display_name(&tool.name)
                ))
            })?;
            (tool.name.clone(), Value::Object(input))
        }
    };
    print_outcome(broker.execute(&tool_name, input)?)
}

/// The input when it is given whole: one JSON object argument, `-` or no
/// arguments with JSON on stdin.
fn json_input(args: &[String]) -> Result<Option<Value>, Fail> {
    match args {
        [] if !io::stdin().is_terminal() => {
            let text = read_stdin()?;
            if text.trim().is_empty() {
                Ok(None)
            } else {
                parse_object(&text).map(Some)
            }
        }
        [dash] if dash == "-" => parse_object(&read_stdin()?).map(Some),
        [single] if single.trim_start().starts_with('{') => parse_object(single).map(Some),
        _ => Ok(None),
    }
}

fn read_stdin() -> Result<String, Fail> {
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| Fail::error(format!("cannot read stdin: {error}")))?;
    Ok(text)
}

fn parse_object(text: &str) -> Result<Value, Fail> {
    match serde_json::from_str::<Value>(text) {
        Ok(value @ Value::Object(_)) => Ok(value),
        Ok(_) => Err(Fail::error("the input must be a JSON object")),
        Err(error) => Err(Fail::error(format!(
            "the input is not valid JSON: {error} (a value starting with '{{' goes as --<field> <value>)"
        ))),
    }
}

fn find<'a>(tools: &'a [Tool], name: &str) -> Result<&'a Tool, Fail> {
    tools
        .iter()
        .find(|tool| input::same_tool(&tool.name, name))
        .ok_or_else(|| {
            let known: Vec<String> = tools.iter().map(|tool| display_name(&tool.name)).collect();
            Fail::error(format!(
                "unknown tool {name:?}; available: {}",
                if known.is_empty() {
                    "none".to_string()
                } else {
                    known.join(", ")
                }
            ))
        })
}

fn print_outcome(outcome: Outcome) -> Result<(), Fail> {
    if !outcome.ok {
        return Err(Fail::tool(
            outcome
                .error
                .filter(|error| !error.trim().is_empty())
                .unwrap_or_else(|| "tools: the tool failed without a message".to_string()),
        ));
    }
    match outcome.output {
        Value::String(text) if text.ends_with('\n') => emit(&text),
        Value::String(text) => emit(&text).and_then(|()| emit("\n")),
        other => emit(&format!("{}\n", pretty(&other))),
    }
}

fn is_download(name: &str) -> bool {
    input::same_tool(name, "download")
}

/// `tools download <url|json> [<path>]`: the tool returns the file as
/// base64 and the CLI writes it, so the bytes never pass through stdout.
fn download(broker: &Broker, name: &str, args: &[String]) -> Result<(), Fail> {
    let usage = || {
        Fail::error("usage: tools download <url> [<path>]\n       tools download '<json>' [<path>]")
    };
    if args.iter().any(|arg| arg.starts_with("--")) {
        return Err(Fail::error(
            "download takes no options: pass other input fields as JSON, \
             tools download '{\"url\": \"…\", …}' [<path>]",
        ));
    }
    let (input, destination) = match args {
        [] => (json_input(args)?.ok_or_else(usage)?, None),
        [source] | [source, _] => {
            let input = match json_input(std::slice::from_ref(source))? {
                Some(input) => input,
                None => json!({ "url": source }),
            };
            (input, args.get(1))
        }
        _ => return Err(usage()),
    };
    let outcome = broker.execute(&input::wire_name(name), input)?;
    if !outcome.ok {
        return print_outcome(outcome);
    }
    save(&outcome.output, destination.map(String::as_str))
}

fn save(output: &Value, destination: Option<&str>) -> Result<(), Fail> {
    let Some(encoded) = output["base64"].as_str() else {
        let shown = match output {
            Value::String(text) => text.clone(),
            other => pretty(other),
        };
        return Err(Fail::error(format!("download returned no file:\n{shown}")));
    };
    let bytes = base64::decode(encoded)
        .map_err(|error| Fail::error(format!("download returned bad base64: {error}")))?;
    if let Some(expected) = output["bytes"].as_u64() {
        if expected != bytes.len() as u64 {
            return Err(Fail::error(format!(
                "download is corrupt: {expected} bytes announced, {} decoded",
                bytes.len()
            )));
        }
    }
    let media_type = output["mediaType"]
        .as_str()
        .unwrap_or("application/octet-stream");
    let file_name = safe_file_name(output["fileName"].as_str());
    let path = match destination {
        None => PathBuf::from(&file_name),
        Some(dir) if dir.ends_with('/') || Path::new(dir).is_dir() => {
            Path::new(dir).join(&file_name)
        }
        Some(file) => PathBuf::from(file),
    };
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| Fail::error(format!("cannot create {}: {error}", parent.display())))?;
    }
    fs::write(&path, &bytes)
        .map_err(|error| Fail::error(format!("cannot write {}: {error}", path.display())))?;
    emit(&format!(
        "saved {} ({} bytes, {media_type})\n",
        path.display(),
        bytes.len()
    ))
}

/// The site's file name, reduced to one safe path component.
fn safe_file_name(name: Option<&str>) -> String {
    let base = name.unwrap_or("").rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "download".to_string();
    }
    let mut end = cleaned.len().min(200);
    while !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    cleaned[..end].to_string()
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// Writes to stdout; a closed pipe (`tools … | head`) is not an error.
fn emit(text: &str) -> Result<(), Fail> {
    let mut stdout = io::stdout().lock();
    match stdout
        .write_all(text.as_bytes())
        .and_then(|()| stdout.flush())
    {
        Err(error) if error.kind() != io::ErrorKind::BrokenPipe => {
            Err(Fail::error(format!("cannot write output: {error}")))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_takes_the_first_line_and_cuts_long_ones() {
        assert_eq!(summary("Search the web.\nMore."), "Search the web.");
        assert_eq!(summary("\n  Spaced   out  \n"), "Spaced out");
        let long = "word ".repeat(40);
        let cut = summary(&long);
        assert!(cut.ends_with('…'));
        assert!(cut.chars().count() <= 111, "{cut}");
    }

    #[test]
    fn file_names_stay_inside_the_directory() {
        assert_eq!(safe_file_name(Some("report.pdf")), "report.pdf");
        assert_eq!(safe_file_name(Some("../../etc/passwd")), "passwd");
        assert_eq!(safe_file_name(Some("a\\b\\c.txt")), "c.txt");
        assert_eq!(safe_file_name(Some("..")), "download");
        assert_eq!(safe_file_name(Some("dir/")), "download");
        assert_eq!(safe_file_name(None), "download");
        assert_eq!(safe_file_name(Some("bad\nname.txt")), "badname.txt");
    }
}
