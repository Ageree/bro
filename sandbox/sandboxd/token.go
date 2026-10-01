package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// verifyToken checks an API token in hostd's format (browser-vm/host/hostd.py, verify_token):
// v1.<payload>.<sig>, payload = base64url JSON {"env": <host id>, "exp": <unix seconds>}, sig = base64url
// HMAC-SHA256(host key, "v1.<payload>"), expiring at most 15 minutes ahead. The error text is safe to
// return to the caller: it never echoes the token.
func verifyToken(token, host string, key []byte, now time.Time) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("malformed token")
	}
	if parts[0] != "v1" {
		return errors.New("unknown token version")
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	signature, err := unbase64url(parts[2])
	if err != nil {
		return errors.New("malformed token")
	}
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return errors.New("bad signature")
	}
	raw, err := unbase64url(parts[1])
	if err != nil {
		return errors.New("malformed token")
	}
	var payload map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return errors.New("malformed token")
	}
	if env, _ := payload["env"].(string); env != host {
		return errors.New("token for another host")
	}
	number, ok := payload["exp"].(json.Number)
	if !ok {
		return errors.New("expired token")
	}
	expires, err := number.Float64()
	seconds := float64(now.UnixNano()) / 1e9
	if err != nil || expires <= seconds || expires > seconds+maxTokenLifetimeSeconds {
		return errors.New("expired token")
	}
	return nil
}

// unbase64url decodes base64url with or without padding, as Python's urlsafe_b64decode after re-padding.
func unbase64url(text string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(text, "="))
}
