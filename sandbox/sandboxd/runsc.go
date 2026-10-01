package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Runtime is everything sandboxd asks of the container runtime. runscCLI is the only implementation; tests
// run it against a fake runsc binary (fake_runsc_test.go), so the command lines themselves are under test.
type Runtime interface {
	Version(ctx context.Context) (string, error)
	// Run creates and starts a container from its bundle and returns once it runs (runsc run --detach).
	Run(ctx context.Context, id, bundle, logPath string) error
	// State is the container's status ("running", "stopped", …), or "" when the runtime does not know it.
	State(ctx context.Context, id string) (string, error)
	// List maps every container the runtime knows to its status.
	List(ctx context.Context) (map[string]string, error)
	Kill(ctx context.Context, id, signal string) error
	// Delete removes the container, stopping it first if it runs; a container that is gone already is fine.
	Delete(ctx context.Context, id string) error
	// Exec prepares (does not start) a process in the container; the caller wires its stdio.
	Exec(ctx context.Context, id string, spec ExecSpec) *exec.Cmd
}

// ExecSpec is one process in a sandbox.
type ExecSpec struct {
	User string   // uid:gid inside the sandbox
	Cwd  string   // absolute, inside the sandbox
	Env  []string // K=V on top of the container's own environment
	Argv []string
}

type runscCLI struct {
	binary   string
	root     string
	platform string
}

func newRunsc(config Config) *runscCLI {
	return &runscCLI{binary: config.Runsc, root: config.RunscRoot, platform: config.Platform}
}

// global is what every runsc command of a sandbox takes. run is the one that acts on most of them; the
// others read the container's saved state and ignore them, and passing the same set keeps it one place.
//
//	--overlay2=root:memory  the shared rootfs directory is never written: writes, /workspace included,
//	                        land in the sandbox's memory and count against its cgroup limit
//	--network=none          a loopback interface and nothing else
//	--host-uds=open         the sandbox may connect to host unix sockets on its bind mounts: /run/bro/tools.sock
//	                        (values none|open|create|all; "open" cannot create them)
func (r *runscCLI) global() []string {
	return []string{
		"--root=" + r.root,
		"--platform=" + r.platform,
		"--network=none",
		"--overlay2=root:memory",
		"--host-uds=open",
	}
}

func (r *runscCLI) command(ctx context.Context, args ...string) *exec.Cmd {
	return exec.CommandContext(ctx, r.binary, append(r.global(), args...)...)
}

// output runs a short runsc command and returns its combined output.
func (r *runscCLI) output(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := r.command(ctx, args...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	text := strings.TrimSpace(out.String())
	if err != nil {
		return text, fmt.Errorf("runsc %s: %w: %s", args[0], err, lastLine(text))
	}
	return text, nil
}

func (r *runscCLI) Version(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, r.binary, "--version").CombinedOutput()
	if err != nil {
		return "", err
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return first, nil
}

func (r *runscCLI) Run(ctx context.Context, id, bundle, logPath string) error {
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer log.Close()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := r.command(ctx, "run", "--detach", "--bundle="+bundle, id)
	// The sandbox and its gofer keep runsc's stdio for as long as they live: a file, never a pipe (a pipe
	// reader would wait for them forever), and a session of their own, out of reach of signals sent to
	// sandboxd's process group.
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("runsc run: %w (see %s)", err, logPath)
	}
	return nil
}

func (r *runscCLI) State(ctx context.Context, id string) (string, error) {
	out, err := r.output(ctx, 30*time.Second, "state", id)
	if err != nil {
		if missing(out) {
			return "", nil
		}
		return "", err
	}
	var state struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(out), &state); err != nil {
		return "", fmt.Errorf("runsc state: %w", err)
	}
	return state.Status, nil
}

func (r *runscCLI) List(ctx context.Context) (map[string]string, error) {
	out, err := r.output(ctx, 30*time.Second, "list", "--format=json")
	if err != nil {
		return nil, err
	}
	var states []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	// No containers: runsc prints "null".
	if err := json.Unmarshal([]byte(out), &states); err != nil {
		return nil, fmt.Errorf("runsc list: %w", err)
	}
	result := make(map[string]string, len(states))
	for _, state := range states {
		result[state.ID] = state.Status
	}
	return result, nil
}

func (r *runscCLI) Kill(ctx context.Context, id, signal string) error {
	_, err := r.output(ctx, 30*time.Second, "kill", id, signal)
	return err
}

func (r *runscCLI) Delete(ctx context.Context, id string) error {
	out, err := r.output(ctx, time.Minute, "delete", "--force", id)
	if err == nil || missing(out) {
		return nil
	}
	// Whatever the error, a container the runtime no longer knows is deleted.
	if state, stateErr := r.State(ctx, id); stateErr == nil && state == "" {
		return nil
	}
	return err
}

func (r *runscCLI) Exec(ctx context.Context, id string, spec ExecSpec) *exec.Cmd {
	args := []string{"exec", "--user=" + spec.User, "--cwd=" + spec.Cwd}
	for _, variable := range spec.Env {
		args = append(args, "--env="+variable)
	}
	args = append(args, id)
	args = append(args, spec.Argv...)
	return r.command(ctx, args...)
}

// missing tells runsc's "no such container" ("FetchSpec failed: loading container: file does not exist",
// runsc 20260928.0) apart from other failures: only then may sandboxd treat a container as gone.
func missing(output string) bool {
	return strings.Contains(strings.ToLower(output), "does not exist")
}

func lastLine(text string) string {
	text = strings.TrimSpace(text)
	if i := strings.LastIndexByte(text, '\n'); i >= 0 {
		text = text[i+1:]
	}
	if len(text) > 300 {
		text = text[len(text)-300:]
	}
	return text
}

// The sandbox user: every command, file operation and snapshot runs as it. It owns /workspace and
// /home/sandbox in the rootfs and has no sudo.
const (
	sandboxUser = "1000:1000"
	sandboxUID  = 1000
	sandboxGID  = 1000
	pidsLimit   = 1024
)

// containerEnv is the environment of every process in a sandbox; exec requests add to it.
var containerEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/home/sandbox",
	"USER=sandbox",
	"LOGNAME=sandbox",
	"SHELL=/bin/bash",
	"LANG=C.UTF-8",
}

// initScript is the container's PID 1: it only waits, and exits on SIGTERM (`runsc kill <id> TERM`).
const initScript = `trap "exit 0" TERM; while :; do sleep 3600 & wait $!; done`

// ociSpec is the bundle's config.json. Under gVisor the process runs on gVisor's kernel, so the limits
// below are the sandbox's whole budget: the memory limit is its cgroup's (the sentry, its page cache and
// the in-memory overlay that holds every file written), pids bound fork bombs.
func ociSpec(rootfs string, paths sandboxPaths, id string, memoryMB int) map[string]any {
	none := []string{}
	return map[string]any{
		"ociVersion": "1.0.2",
		"process": map[string]any{
			"terminal": false,
			"user":     map[string]any{"uid": sandboxUID, "gid": sandboxGID},
			"args":     []string{"/bin/sh", "-c", initScript},
			"env":      containerEnv,
			"cwd":      "/",
			// No capabilities at all: gVisor hands the spec's sets to exec'd processes too, whatever their
			// uid, and nothing in the sandbox needs one.
			"capabilities": map[string]any{
				"bounding": none, "effective": none, "inheritable": none, "permitted": none, "ambient": none,
			},
			"noNewPrivileges": true,
			"rlimits":         []map[string]any{{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}},
		},
		// Not "readonly": gVisor then mounts the root read-only even under --overlay2 (hostd, stage 1).
		// Writes go to the overlay in memory; the rootfs directory itself is never written.
		"root":     map[string]any{"path": rootfs, "readonly": false},
		"hostname": "sandbox",
		"mounts": []map[string]any{
			{"destination": "/proc", "type": "proc", "source": "proc"},
			{"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": []string{"nosuid", "mode=755"}},
			{"destination": "/dev/pts", "type": "devpts", "source": "devpts",
				"options": []string{"nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"}},
			{"destination": "/dev/shm", "type": "tmpfs", "source": "shm",
				"options": []string{"nosuid", "noexec", "nodev", "mode=1777"}},
			{"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": []string{"nosuid", "noexec", "nodev", "ro"}},
			// The broker's socket. Read-only: connecting to a socket needs no write access to the mount
			// (checked under runsc 20260928.0), and nothing in the sandbox may put files here.
			{"destination": "/run/bro", "type": "bind", "source": paths.run, "options": []string{"rbind", "ro"}},
		},
		"linux": map[string]any{
			// A network namespace of its own: with --network=none it holds a loopback interface only.
			"namespaces": []map[string]any{
				{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "network"},
			},
			// cgroupfs (runsc's default driver; its --cgroupfs flag is deprecated and does nothing): a cgroup
			// of its own outside sandboxd.service's, so restarting sandboxd leaves sandboxes running.
			"cgroupsPath": "/sandboxd/" + id,
			"resources": map[string]any{
				"memory": map[string]any{"limit": int64(memoryMB) << 20},
				"pids":   map[string]any{"limit": pidsLimit},
			},
		},
	}
}

func writeBundle(config Config, paths sandboxPaths, id string, memoryMB int) error {
	if err := os.MkdirAll(paths.bundle, 0o700); err != nil {
		return err
	}
	// A rootfs_version may be a symlink to the real directory ("current"): the sandbox keeps the one it
	// started on when the link moves.
	rootfs, err := filepath.EvalSymlinks(config.rootfsDir())
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(ociSpec(rootfs, paths, id, memoryMB), "", " ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(paths.bundle, "config.json"), data, 0o600)
}

var errNotRunning = errors.New("the sandbox is not running")
