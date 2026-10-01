package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// Config is /etc/bro/sandboxd.json. Every field can be left out except host and key; flags override a few
// of them for manual runs (main.go).
type Config struct {
	// The host's id and its 32-byte key in hex: HMAC(SANDBOX_SIGNING_KEY, "bro-sandbox-host:" + host) on
	// Bro's side. API tokens are signed with it (token.go).
	Host string `json:"host"`
	Key  string `json:"key"`
	// Where the API listens: loopback only, Caddy terminates TLS in front of it.
	Listen string `json:"listen"`
	// Everything of sandboxd on the host: rootfs/<version>/, sandboxes/<id>/, staging/, state.json.
	Root string `json:"root"`
	// The runsc binary and its state directory (--root): under /run, so a reboot forgets every container
	// along with the memory they lived in.
	Runsc     string `json:"runsc"`
	RunscRoot string `json:"runsc_root"`
	Platform  string `json:"platform"`
	// The rootfs directory new sandboxes start from: <root>/rootfs/<rootfs_version>.
	RootfsVersion string `json:"rootfs_version"`
	// A sandbox without requests this long is snapshotted and stopped (reaper.go).
	IdleMinutes int `json:"idle_minutes"`
	// Sandbox memory limits add up to at most MemTotal less reserve_mb, or to memory_limit_mb when that is
	// set (a test or a host shared with something else).
	ReserveMB     int `json:"reserve_mb"`
	MemoryLimitMB int `json:"memory_limit_mb"`
	MaxSandboxes  int `json:"max_sandboxes"`
	// The memoryMb of a sandbox whose PUT names none.
	MemoryMB int `json:"memory_mb"`
	// An exec stream silent this long gets a {"type":"ping"} line (exec.go).
	ExecPingSeconds int `json:"exec_ping_seconds"`
}

const (
	maxTokenLifetimeSeconds = 900
	minMemoryMB             = 256
	maxMemoryMB             = 65536
)

var (
	rootfsVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	hexKeyPattern        = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
)

func defaultConfig() Config {
	return Config{
		Listen:        "127.0.0.1:8091",
		Root:          "/srv/sandboxd",
		Runsc:         "/usr/bin/runsc",
		RunscRoot:     "/run/sandboxd/runsc",
		Platform:      "systrap",
		RootfsVersion: "current",
		IdleMinutes:   20,
		ReserveMB:     1024,
		MaxSandboxes:  16,
		MemoryMB:      1536,

		ExecPingSeconds: 15,
	}
}

// loadConfig reads the file over the defaults. Unknown keys are an error: a misspelt limit must not
// silently fall back to its default.
func loadConfig(path string) (Config, error) {
	config := defaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return config, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return config, fmt.Errorf("%s: %w", path, err)
	}
	return config, nil
}

func (c Config) validate() error {
	var problems []error
	if c.Host == "" {
		problems = append(problems, errors.New("host is required"))
	}
	if !hexKeyPattern.MatchString(c.Key) {
		problems = append(problems, errors.New("key must be 64 hex characters"))
	}
	if c.Listen == "" || c.Runsc == "" || c.RunscRoot == "" {
		problems = append(problems, errors.New("listen, runsc and runsc_root are required"))
	}
	if !filepath.IsAbs(c.Root) || !filepath.IsAbs(c.RunscRoot) {
		problems = append(problems, errors.New("root and runsc_root must be absolute paths"))
	}
	if !rootfsVersionPattern.MatchString(c.RootfsVersion) {
		problems = append(problems, errors.New("rootfs_version must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}"))
	}
	switch c.Platform {
	case "systrap", "ptrace", "kvm":
	default:
		problems = append(problems, errors.New("platform must be systrap, ptrace or kvm"))
	}
	if c.IdleMinutes < 1 {
		problems = append(problems, errors.New("idle_minutes must be at least 1"))
	}
	if c.ExecPingSeconds < 1 {
		problems = append(problems, errors.New("exec_ping_seconds must be at least 1"))
	}
	if c.MaxSandboxes < 1 {
		problems = append(problems, errors.New("max_sandboxes must be at least 1"))
	}
	if c.MemoryMB < minMemoryMB || c.MemoryMB > maxMemoryMB {
		problems = append(problems, fmt.Errorf("memory_mb must be %d to %d", minMemoryMB, maxMemoryMB))
	}
	if c.ReserveMB < 0 || c.MemoryLimitMB < 0 {
		problems = append(problems, errors.New("reserve_mb and memory_limit_mb must not be negative"))
	}
	return errors.Join(problems...)
}

func (c Config) keyBytes() []byte {
	key, _ := hex.DecodeString(c.Key) // validate() checked it
	return key
}

func (c Config) rootfsDir() string    { return filepath.Join(c.Root, "rootfs", c.RootfsVersion) }
func (c Config) sandboxesDir() string { return filepath.Join(c.Root, "sandboxes") }
func (c Config) stagingDir() string   { return filepath.Join(c.Root, "staging") }
func (c Config) statePath() string    { return filepath.Join(c.Root, "state.json") }

// sandboxPaths are the host side of one sandbox: <root>/sandboxes/<id>/.
type sandboxPaths struct {
	dir    string
	bundle string // OCI bundle: config.json
	run    string // bind-mounted read-only at /run/bro: tools.sock lives here
	socket string
	log    string // runsc's and the sandbox's own stdio: a file, never a pipe
}

func (c Config) paths(id string) sandboxPaths {
	dir := filepath.Join(c.sandboxesDir(), id)
	return sandboxPaths{
		dir:    dir,
		bundle: filepath.Join(dir, "bundle"),
		run:    filepath.Join(dir, "run"),
		socket: filepath.Join(dir, "run", "tools.sock"),
		log:    filepath.Join(dir, "runtime.log"),
	}
}
