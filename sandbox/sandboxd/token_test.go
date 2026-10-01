package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// testdata/token-vector.json is shared with Bro's TypeScript signer: the same key, host and exp must give
// the same token there. SANDBOXD_WRITE_VECTOR=1 go test -run TestTokenVector writes it anew.
type tokenVector struct {
	KeyHex string `json:"keyHex"`
	Host   string `json:"host"`
	Exp    int64  `json:"exp"`
	Now    int64  `json:"now"`
	Token  string `json:"token"`
}

const vectorPath = "testdata/token-vector.json"

func TestTokenVector(t *testing.T) {
	if os.Getenv("SANDBOXD_WRITE_VECTOR") == "1" {
		key := make([]byte, 32)
		for i := range key {
			key[i] = byte(i)
		}
		vector := tokenVector{KeyHex: hex.EncodeToString(key), Host: "sbx-host-1", Exp: 1790000000, Now: 1789999400}
		vector.Token = signToken(key, vector.Host, vector.Exp)
		data, _ := json.MarshalIndent(vector, "", "  ")
		if err := os.WriteFile(vectorPath, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatal(err)
	}
	var vector tokenVector
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	key, err := hex.DecodeString(vector.KeyHex)
	if err != nil {
		t.Fatal(err)
	}
	if got := signToken(key, vector.Host, vector.Exp); got != vector.Token {
		t.Fatalf("signing the vector gives %s, want %s", got, vector.Token)
	}
	payload, _ := base64.RawURLEncoding.DecodeString(strings.Split(vector.Token, ".")[1])
	if want := `{"env":"` + vector.Host + `","exp":1790000000}`; string(payload) != want {
		t.Fatalf("payload %s, want %s", payload, want)
	}
	if err := verifyToken(vector.Token, vector.Host, key, time.Unix(vector.Now, 0)); err != nil {
		t.Fatalf("the vector does not verify: %v", err)
	}
	if err := verifyToken(vector.Token, vector.Host, key, time.Unix(vector.Exp, 0)); err == nil {
		t.Fatal("a token verifies at its exp")
	}
}

func TestTokenRejects(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	valid := signToken(testKey, testHost, now.Unix()+600)
	parts := strings.Split(valid, ".")
	otherKey := make([]byte, 32)
	cases := map[string]struct {
		token string
		want  string
	}{
		"empty":            {"", "malformed token"},
		"two parts":        {parts[0] + "." + parts[1], "malformed token"},
		"version":          {"v2." + parts[1] + "." + parts[2], "unknown token version"},
		"signature":        {parts[0] + "." + parts[1] + "." + parts[2][:len(parts[2])-2] + "AA", "bad signature"},
		"signature base64": {parts[0] + "." + parts[1] + ".!!!", "malformed token"},
		"other key":        {signToken(otherKey, testHost, now.Unix()+600), "bad signature"},
		"other host":       {signToken(testKey, "another-host", now.Unix()+600), "token for another host"},
		"expired":          {signToken(testKey, testHost, now.Unix()-1), "expired token"},
		"at now":           {signToken(testKey, testHost, now.Unix()), "expired token"},
		"too far":          {signToken(testKey, testHost, now.Unix()+901), "expired token"},
		"no exp":           {signRaw(testKey, `{"env":"`+testHost+`"}`), "expired token"},
		"string exp":       {signRaw(testKey, `{"env":"`+testHost+`","exp":"1800000600"}`), "expired token"},
		"not an object":    {signRaw(testKey, `[1]`), "malformed token"},
		"not json":         {signRaw(testKey, `{`), "malformed token"},
	}
	for name, c := range cases {
		err := verifyToken(c.token, testHost, testKey, now)
		if err == nil || err.Error() != c.want {
			t.Errorf("%s: got %v, want %q", name, err, c.want)
		}
	}
	for name, token := range map[string]string{
		"valid":         valid,
		"padded":        valid + "=",
		"at the limit":  signToken(testKey, testHost, now.Unix()+900),
		"fractional":    signRaw(testKey, `{"env":"`+testHost+`","exp":1800000600.5}`),
		"keys reversed": signRaw(testKey, `{"exp":1800000600,"env":"`+testHost+`"}`),
	} {
		if err := verifyToken(token, testHost, testKey, now); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func signRaw(key []byte, payload string) string {
	return signPayload(key, []byte(payload))
}
