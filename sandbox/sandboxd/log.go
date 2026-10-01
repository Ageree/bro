package main

import (
	"errors"
	"net/url"
	"strings"
)

// redact is a URL fit for a log line: its origin only. Presigned URLs carry their signature in the query,
// a token may sit in userinfo or in a path segment (/api/<token>/graphql); a dropped path shows as "/…".
func redact(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "<invalid url>"
	}
	origin := parsed.Scheme + "://" + parsed.Host
	if strings.Trim(parsed.EscapedPath(), "/") != "" {
		origin += "/…"
	}
	return origin
}

// redactError is an HTTP client error without the URL it names (*url.Error prints it whole).
func redactError(err error) string {
	var urlError *url.Error
	if errors.As(err, &urlError) {
		return urlError.Op + " " + redact(urlError.URL) + ": " + urlError.Err.Error()
	}
	text := err.Error()
	if i := strings.Index(text, "?"); i >= 0 {
		text = text[:i] + "?…"
	}
	return text
}
