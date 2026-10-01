//! Tool names and the short form: command-line arguments become the tool's
//! JSON input, guided by its input schema. Positional arguments fill the
//! schema's `required` properties in order; `--key value` and `--key=value`
//! set a property by name (`--max-results` finds `max_results` or
//! `maxResults`).

use serde_json::{Map, Value};

/// How a tool is shown and typed: `web_search` → `web-search`.
pub fn display_name(name: &str) -> String {
    name.replace('_', "-")
}

/// How a tool is sent when no list was fetched: `web-search` → `web_search`.
pub fn wire_name(name: &str) -> String {
    name.replace('-', "_")
}

pub fn same_tool(a: &str, b: &str) -> bool {
    display_name(a) == display_name(b)
}

/// The option that sets `property`: `max_results` and `maxResults` →
/// `max-results`.
pub fn flag_name(property: &str) -> String {
    let mut flag = String::with_capacity(property.len() + 4);
    let mut previous_lower = false;
    for c in property.chars() {
        if c.is_uppercase() && previous_lower {
            flag.push('-');
        }
        previous_lower = c.is_lowercase() || c.is_ascii_digit();
        flag.extend(c.to_lowercase());
    }
    flag.replace('_', "-")
}

/// Builds the input object from the short form.
pub fn build_input(schema: &Value, args: &[String]) -> Result<Map<String, Value>, String> {
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    let mut input = Map::new();
    let mut positional = Vec::new();
    let mut only_positional = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if only_positional || !arg.starts_with("--") {
            positional.push(arg.as_str());
            continue;
        }
        if arg == "--" {
            only_positional = true;
            continue;
        }
        let (key, inline) = match arg[2..].split_once('=') {
            Some((key, value)) => (key, Some(value)),
            None => (&arg[2..], None),
        };
        let (property, negated) = resolve_flag(schema, properties, key)?;
        let property_schema = properties.get(&property).unwrap_or(&Value::Null);
        let types = accepted_types(property_schema);
        let value = if is_boolean(&types) {
            let given = match inline {
                Some(raw) => parse_bool(raw)
                    .ok_or_else(|| format!("--{key} expects true or false, got {raw:?}"))?,
                None => match args.get(i).and_then(|next| parse_bool_word(next)) {
                    Some(word) => {
                        i += 1;
                        word
                    }
                    None => true,
                },
            };
            Value::Bool(given != negated)
        } else {
            let raw = match inline {
                Some(raw) => raw,
                None => {
                    i += 1;
                    args.get(i - 1)
                        .map(String::as_str)
                        .ok_or_else(|| format!("--{key} needs a value"))?
                }
            };
            convert(raw, property_schema)
                .map_err(|expected| format!("--{key} expects {expected}, got {raw:?}"))?
        };
        set(&mut input, &property, value, &types)?;
    }

    let open_slots: Vec<&str> = required(schema)
        .filter(|name| !input.contains_key(*name))
        .collect();
    let mut slots = open_slots.into_iter().peekable();
    let mut rest = positional.into_iter().peekable();
    while let Some(raw) = rest.next() {
        let Some(property) = slots.next() else {
            return Err(format!(
                "unexpected argument {raw:?}: quote a value with spaces, or pass JSON"
            ));
        };
        let property_schema = properties.get(property).unwrap_or(&Value::Null);
        let types = accepted_types(property_schema);
        let describe = |expected| format!("<{property}> expects {expected}, got {raw:?}");
        let value =
            if slots.peek().is_none() && types.contains(&"array") && rest.peek().is_some() {
                // The last positional array takes the remaining arguments.
                let item = &property_schema["items"];
                let mut items = vec![convert(raw, item).map_err(describe)?];
                for raw in rest.by_ref() {
                    items.push(convert(raw, item).map_err(|expected| {
                        format!("<{property}> expects {expected}, got {raw:?}")
                    })?);
                }
                Value::Array(items)
            } else {
                convert(raw, property_schema).map_err(describe)?
            };
        input.insert(property.to_string(), value);
    }
    let missing: Vec<String> = slots.map(|name| format!("<{name}>")).collect();
    if !missing.is_empty() {
        return Err(format!("missing {}", missing.join(" ")));
    }
    Ok(input)
}

/// A usage line for the short form, e.g.
/// `tools web-search <query> [--sites <string>]...`.
pub fn usage(tool: &str, schema: &Value) -> String {
    let mut line = format!("tools {}", display_name(tool));
    let required: Vec<&str> = required(schema).collect();
    let empty = Map::new();
    let properties = schema["properties"].as_object().unwrap_or(&empty);
    for name in &required {
        let types = accepted_types(properties.get(*name).unwrap_or(&Value::Null));
        line.push_str(&format!(" <{name}>"));
        if types.contains(&"array") {
            line.push_str("...");
        }
    }
    for (name, property) in properties {
        if required.contains(&name.as_str()) {
            continue;
        }
        let types = accepted_types(property);
        let flag = flag_name(name);
        if is_boolean(&types) {
            line.push_str(&format!(" [--{flag}]"));
        } else if types.contains(&"array") {
            let item = accepted_types(&property["items"]);
            line.push_str(&format!(" [--{flag} <{}>]...", type_hint(&item)));
        } else {
            line.push_str(&format!(" [--{flag} <{}>]", type_hint(&types)));
        }
    }
    line
}

/// A boolean, possibly nullable: set by a bare `--flag`.
fn is_boolean(types: &[&str]) -> bool {
    types.contains(&"boolean") && types.iter().all(|t| *t == "boolean" || *t == "null")
}

fn type_hint(types: &[&str]) -> String {
    let named: Vec<&str> = types.iter().copied().filter(|t| *t != "null").collect();
    if named.is_empty() {
        "value".to_string()
    } else {
        named.join("|")
    }
}

fn required(schema: &Value) -> impl Iterator<Item = &str> {
    schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

/// Finds the property an option names: as typed, snake_case, camelCase, or
/// ignoring case and separators; `--no-x` sets a boolean `x` to false.
fn resolve_flag(
    schema: &Value,
    properties: &Map<String, Value>,
    key: &str,
) -> Result<(String, bool), String> {
    if key.is_empty() {
        return Err("empty option name".to_string());
    }
    if let Some(property) = find_property(properties, key) {
        return Ok((property, false));
    }
    if let Some(rest) = key.strip_prefix("no-") {
        if let Some(property) = find_property(properties, rest) {
            if is_boolean(&accepted_types(&properties[&property])) {
                return Ok((property, true));
            }
        }
    }
    let open = match &schema["additionalProperties"] {
        Value::Bool(false) => false,
        Value::Null => properties.is_empty(),
        _ => true,
    };
    if open {
        return Ok((key.replace('-', "_"), false));
    }
    let known: Vec<String> = properties
        .keys()
        .map(|name| format!("--{}", flag_name(name)))
        .collect();
    Err(if known.is_empty() {
        format!("unknown option --{key}: this tool takes no options")
    } else {
        format!("unknown option --{key}; options: {}", known.join(", "))
    })
}

fn find_property(properties: &Map<String, Value>, key: &str) -> Option<String> {
    let snake = key.replace('-', "_");
    let camel = to_camel(key);
    for candidate in [key, snake.as_str(), camel.as_str()] {
        if properties.contains_key(candidate) {
            return Some(candidate.to_string());
        }
    }
    let loose = |name: &str| -> String {
        name.chars()
            .filter(|c| *c != '-' && *c != '_')
            .flat_map(char::to_lowercase)
            .collect()
    };
    let wanted = loose(key);
    let mut matches = properties.keys().filter(|name| loose(name) == wanted);
    match (matches.next(), matches.next()) {
        (Some(name), None) => Some(name.clone()),
        _ => None,
    }
}

fn to_camel(key: &str) -> String {
    let mut camel = String::with_capacity(key.len());
    let mut upper = false;
    for c in key.chars() {
        if c == '-' || c == '_' {
            upper = true;
        } else if upper {
            camel.extend(c.to_uppercase());
            upper = false;
        } else {
            camel.push(c);
        }
    }
    camel
}

/// JSON types a schema accepts, from `type`, `anyOf`/`oneOf`/`allOf`,
/// `enum` and `const`; empty when the schema says nothing.
fn accepted_types(schema: &Value) -> Vec<&'static str> {
    let mut types = Vec::new();
    collect_types(schema, &mut types);
    types
}

fn collect_types(schema: &Value, types: &mut Vec<&'static str>) {
    let mut add = |name: &str| {
        let known = match name {
            "string" => "string",
            "integer" => "integer",
            "number" => "number",
            "boolean" => "boolean",
            "array" => "array",
            "object" => "object",
            "null" => "null",
            _ => return,
        };
        if !types.contains(&known) {
            types.push(known);
        }
    };
    match &schema["type"] {
        Value::String(name) => add(name),
        Value::Array(names) => names.iter().filter_map(Value::as_str).for_each(&mut add),
        _ => {}
    }
    let constants = schema["enum"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(schema.get("const"));
    for constant in constants {
        add(match constant {
            Value::String(_) => "string",
            Value::Number(n) if n.is_f64() => "number",
            Value::Number(_) => "integer",
            Value::Bool(_) => "boolean",
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        });
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        for branch in schema[key].as_array().into_iter().flatten() {
            collect_types(branch, types);
        }
    }
}

/// Converts one command-line value to what the schema expects; the error
/// names the expected type.
fn convert(raw: &str, schema: &Value) -> Result<Value, String> {
    let types = accepted_types(schema);
    let trimmed = raw.trim();
    if types.is_empty() {
        // No type: JSON if it parses as one, otherwise the text.
        return Ok(match serde_json::from_str::<Value>(trimmed) {
            Ok(value) if !trimmed.is_empty() => value,
            _ => Value::String(raw.to_string()),
        });
    }
    let has = |name| types.contains(&name);
    if (has("array") && trimmed.starts_with('[')) || (has("object") && trimmed.starts_with('{')) {
        return serde_json::from_str(trimmed).map_err(|error| format!("valid JSON ({error})"));
    }
    if has("integer") {
        if let Ok(n) = trimmed.parse::<i64>() {
            return Ok(Value::from(n));
        }
    }
    if has("number") {
        if let Ok(Value::Number(n)) = serde_json::from_str::<Value>(trimmed) {
            return Ok(Value::Number(n));
        }
    }
    if has("boolean") {
        if let Some(value) = parse_bool(trimmed) {
            return Ok(Value::Bool(value));
        }
    }
    if has("null") && !has("string") && trimmed == "null" {
        return Ok(Value::Null);
    }
    if has("string") {
        return Ok(Value::String(raw.to_string()));
    }
    if has("array") {
        return Ok(Value::Array(vec![convert(raw, &schema["items"])?]));
    }
    if has("object") {
        return Err("a JSON object".to_string());
    }
    Err(type_hint(&types))
}

fn set(
    input: &mut Map<String, Value>,
    property: &str,
    value: Value,
    types: &[&str],
) -> Result<(), String> {
    match input.get_mut(property) {
        None => {
            input.insert(property.to_string(), value);
        }
        Some(Value::Array(items)) if types.contains(&"array") => match value {
            Value::Array(more) => items.extend(more),
            other => items.push(other),
        },
        Some(_) => return Err(format!("--{} given more than once", flag_name(property))),
    }
    Ok(())
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" => Some(true),
        "false" | "no" | "0" => Some(false),
        _ => None,
    }
}

/// A bare boolean option takes the next argument only when it is literally
/// `true` or `false`.
fn parse_bool_word(raw: &str) -> Option<bool> {
    match raw {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn search_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "max_results": {"type": "integer"},
                "sites": {"type": "array", "items": {"type": "string"}},
                "fresh": {"type": ["boolean", "null"]},
                "temperature": {"type": "number"}
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }

    fn build(schema: &Value, list: &[&str]) -> Result<Value, String> {
        build_input(schema, &args(list)).map(Value::Object)
    }

    #[test]
    fn names() {
        assert_eq!(display_name("web_search"), "web-search");
        assert_eq!(wire_name("web-search"), "web_search");
        assert!(same_tool("web_search", "web-search"));
        assert!(same_tool("web-search", "web-search"));
        assert!(!same_tool("web_search", "web-fetch"));
        assert_eq!(flag_name("max_results"), "max-results");
        assert_eq!(flag_name("maxResults"), "max-results");
        assert_eq!(flag_name("URL"), "url");
        assert_eq!(flag_name("fileURL"), "file-url");
    }

    #[test]
    fn positional_and_flags() {
        let input = build(&search_schema(), &["погода в Москве", "--max-results", "3"]).unwrap();
        assert_eq!(input, json!({"query": "погода в Москве", "max_results": 3}));
        let input = build(&search_schema(), &["--max-results=3", "q"]).unwrap();
        assert_eq!(input, json!({"query": "q", "max_results": 3}));
    }

    #[test]
    fn camel_case_properties() {
        let schema = json!({
            "type": "object",
            "properties": {"query": {"type": "string"}, "maxResults": {"type": "integer"}},
            "required": ["query"]
        });
        let input = build(&schema, &["q", "--max-results", "5"]).unwrap();
        assert_eq!(input, json!({"query": "q", "maxResults": 5}));
        let input = build(&schema, &["q", "--maxResults=5"]).unwrap();
        assert_eq!(input, json!({"query": "q", "maxResults": 5}));
    }

    #[test]
    fn flag_can_set_a_required_property() {
        let input = build(&search_schema(), &["--query", "--not-a-flag"]).unwrap();
        assert_eq!(input, json!({"query": "--not-a-flag"}));
    }

    #[test]
    fn strings_stay_strings() {
        let input = build(&search_schema(), &["42"]).unwrap();
        assert_eq!(input, json!({"query": "42"}));
        let input = build(&search_schema(), &["--", "--help"]).unwrap();
        assert_eq!(input, json!({"query": "--help"}));
        let input = build(&search_schema(), &["-5"]).unwrap();
        assert_eq!(input, json!({"query": "-5"}));
    }

    #[test]
    fn numbers_and_booleans() {
        let input = build(&search_schema(), &["q", "--temperature", "0.5", "--fresh"]).unwrap();
        assert_eq!(
            input,
            json!({"query": "q", "temperature": 0.5, "fresh": true})
        );
        let input = build(&search_schema(), &["--fresh", "false", "q"]).unwrap();
        assert_eq!(input, json!({"query": "q", "fresh": false}));
        let input = build(&search_schema(), &["--no-fresh", "q"]).unwrap();
        assert_eq!(input, json!({"query": "q", "fresh": false}));
        let input = build(&search_schema(), &["--fresh=yes", "q"]).unwrap();
        assert_eq!(input, json!({"query": "q", "fresh": true}));
        let error = build(&search_schema(), &["q", "--max-results", "three"]).unwrap_err();
        assert!(error.contains("--max-results expects integer"), "{error}");
        let error = build(&search_schema(), &["q", "--max-results", "1.5"]).unwrap_err();
        assert!(error.contains("expects integer"), "{error}");
    }

    #[test]
    fn arrays_repeat_or_take_json() {
        let input = build(
            &search_schema(),
            &["q", "--sites", "2gis.ru", "--sites", "yandex.ru/maps"],
        )
        .unwrap();
        assert_eq!(
            input,
            json!({"query": "q", "sites": ["2gis.ru", "yandex.ru/maps"]})
        );
        let input = build(&search_schema(), &["q", "--sites", r#"["a.ru","b.ru"]"#]).unwrap();
        assert_eq!(input, json!({"query": "q", "sites": ["a.ru", "b.ru"]}));
    }

    #[test]
    fn last_positional_array_takes_the_rest() {
        let schema = json!({
            "type": "object",
            "properties": {
                "mode": {"type": "string"},
                "urls": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["mode", "urls"]
        });
        let input = build(&schema, &["fast", "https://a", "https://b"]).unwrap();
        assert_eq!(
            input,
            json!({"mode": "fast", "urls": ["https://a", "https://b"]})
        );
        let input = build(&schema, &["fast", "https://a"]).unwrap();
        assert_eq!(input, json!({"mode": "fast", "urls": ["https://a"]}));
    }

    #[test]
    fn nullable_and_enum_types() {
        let schema = json!({
            "type": "object",
            "properties": {
                "limit": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                "unit": {"enum": ["c", "f"]},
                "level": {"type": ["number", "null"]},
                "extra": {}
            },
            "required": ["unit"]
        });
        let input = build(
            &schema,
            &[
                "c",
                "--limit",
                "7",
                "--level",
                "null",
                "--extra",
                "{\"a\":1}",
            ],
        )
        .unwrap();
        assert_eq!(
            input,
            json!({"unit": "c", "limit": 7, "level": null, "extra": {"a": 1}})
        );
        let input = build(&schema, &["f", "--extra", "plain text"]).unwrap();
        assert_eq!(input, json!({"unit": "f", "extra": "plain text"}));
    }

    #[test]
    fn errors_name_the_problem() {
        let error = build(&search_schema(), &[]).unwrap_err();
        assert_eq!(error, "missing <query>");
        let error = build(&search_schema(), &["погода", "в", "Москве"]).unwrap_err();
        assert!(error.contains("unexpected argument \"в\""), "{error}");
        let error = build(&search_schema(), &["q", "--colour", "red"]).unwrap_err();
        assert!(error.contains("unknown option --colour"), "{error}");
        assert!(error.contains("--max-results"), "{error}");
        let error = build(&search_schema(), &["q", "--max-results"]).unwrap_err();
        assert_eq!(error, "--max-results needs a value");
        let error = build(
            &search_schema(),
            &["q", "--max-results", "1", "--max-results", "2"],
        )
        .unwrap_err();
        assert!(error.contains("more than once"), "{error}");
        let error = build(&search_schema(), &["--query", "a", "b"]).unwrap_err();
        assert!(error.contains("unexpected argument \"b\""), "{error}");
    }

    #[test]
    fn schema_without_properties_takes_any_option() {
        let schema = json!({"type": "object"});
        let input = build(&schema, &["--page-size", "10", "--name", "x"]).unwrap();
        assert_eq!(input, json!({"page_size": 10, "name": "x"}));
        assert_eq!(build(&schema, &[]).unwrap(), json!({}));
    }

    #[test]
    fn usage_line() {
        assert_eq!(
            usage("web_search", &search_schema()),
            "tools web-search <query> [--fresh] [--max-results <integer>] [--sites <string>]... [--temperature <number>]"
        );
    }
}
