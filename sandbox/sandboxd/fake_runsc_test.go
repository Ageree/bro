package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// The test binary doubles as a fake runsc: run through a symlink named "runsc" (harness.go), TestMain
// hands it the command line. It keeps containers under --root/<id>/: state.json and fs/, a copy of the
// bundle's rootfs, with fs/run/bro a symlink to the /run/bro bind mount's source. `exec` runs the command
// on the host without isolation: the cwd and every environment value that is an absolute path (P, W,
// HOME…) are moved under fs/, which is why sandboxd passes paths in the environment and never in script
// text. Processes started by `exec` carry FAKE_RUNSC_CONTAINER, so `kill` and `delete` end them as a
// container's end would. A file <root>/fail-run makes `run` fail. Every call is appended to
// <root>/calls.log as a JSON array.
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "runsc" {
		os.Exit(fakeRunsc(os.Args[1:]))
	}
	os.Exit(m.Run())
}

type fakeState struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Bundle      string `json:"bundle"`
	PID         int    `json:"pid"` // 0: no real sentry, sandboxd skips its process checks
	MemoryLimit int64  `json:"memoryLimit"`
	OverlayMB   string `json:"overlay"`
}

func fakeRunsc(args []string) int {
	globals := map[string]string{}
	i := 0
	for ; i < len(args) && strings.HasPrefix(args[i], "--"); i++ {
		name, value, _ := strings.Cut(strings.TrimPrefix(args[i], "--"), "=")
		globals[name] = value
	}
	if _, ok := globals["version"]; ok {
		fmt.Println("runsc version fake")
		fmt.Println("spec: 1.2.1")
		return 0
	}
	root := globals["root"]
	if root == "" || i >= len(args) {
		fmt.Fprintln(os.Stderr, "fake runsc: usage: --root=DIR COMMAND …")
		return 2
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if line, err := json.Marshal(args); err == nil {
		if log, err := os.OpenFile(filepath.Join(root, "calls.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			log.Write(append(line, '\n'))
			log.Close()
		}
	}
	command, rest := args[i], args[i+1:]
	var err error
	code := 0
	switch command {
	case "run":
		err = fakeRun(root, globals, rest)
	case "state":
		err = fakeStateCommand(root, rest)
	case "list":
		err = fakeList(root)
	case "kill":
		err = fakeKill(root, rest)
	case "delete":
		err = fakeDelete(root, rest)
	case "update":
		err = fakeUpdate(root, rest)
	case "exec":
		code, err = fakeExec(root, rest)
	default:
		err = fmt.Errorf("unknown command %q", command)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 128 // as runsc
	}
	return code
}

var errFakeMissing = errors.New("FetchSpec failed: loading container: file does not exist")

func fakeLoad(root, id string) (fakeState, error) {
	var state fakeState
	data, err := os.ReadFile(filepath.Join(root, id, "state.json"))
	if err != nil {
		return state, errFakeMissing
	}
	return state, json.Unmarshal(data, &state)
}

func fakeSave(root string, state fakeState) error {
	data, _ := json.Marshal(state)
	return os.WriteFile(filepath.Join(root, state.ID, "state.json"), data, 0o600)
}

type fakeSpec struct {
	Process struct {
		Env []string `json:"env"`
	} `json:"process"`
	Root struct {
		Path     string `json:"path"`
		Readonly bool   `json:"readonly"`
	} `json:"root"`
	Mounts []struct {
		Destination string `json:"destination"`
		Source      string `json:"source"`
		Type        string `json:"type"`
	} `json:"mounts"`
}

func fakeLoadSpec(bundle string) (fakeSpec, error) {
	var spec fakeSpec
	data, err := os.ReadFile(filepath.Join(bundle, "config.json"))
	if err != nil {
		return spec, err
	}
	return spec, json.Unmarshal(data, &spec)
}

func fakeRun(root string, globals map[string]string, args []string) error {
	for name, want := range map[string]string{"network": "none", "host-uds": "open"} {
		if globals[name] != want {
			return fmt.Errorf("fake runsc: run without --%s=%s", name, want)
		}
	}
	if !strings.HasPrefix(globals["overlay2"], "root:memory,size=") {
		return fmt.Errorf("fake runsc: run without --overlay2=root:memory,size=…")
	}
	if _, err := os.Stat(filepath.Join(root, "fail-run")); err == nil {
		return errors.New("fake runsc: run failed as asked")
	}
	var bundle, id string
	for _, arg := range args {
		switch {
		case arg == "--detach":
		case strings.HasPrefix(arg, "--bundle="):
			bundle = strings.TrimPrefix(arg, "--bundle=")
		default:
			id = arg
		}
	}
	if id == "" || !filepath.IsAbs(bundle) {
		return errors.New("fake runsc: run needs --bundle=<absolute dir> and an id")
	}
	if _, err := fakeLoad(root, id); err == nil {
		return fmt.Errorf("container with id %q already exists", id)
	}
	spec, err := fakeLoadSpec(bundle)
	if err != nil {
		return err
	}
	dir := filepath.Join(root, id)
	if err := fakeCopyTree(spec.Root.Path, filepath.Join(dir, "fs")); err != nil {
		return err
	}
	for _, mount := range spec.Mounts {
		if mount.Type == "bind" {
			target := filepath.Join(dir, "fs", mount.Destination)
			os.RemoveAll(target)
			os.MkdirAll(filepath.Dir(target), 0o755)
			if err := os.Symlink(mount.Source, target); err != nil {
				return err
			}
		}
	}
	return fakeSave(root, fakeState{ID: id, Status: "running", Bundle: bundle,
		OverlayMB: strings.TrimPrefix(globals["overlay2"], "root:memory,size=")})
}

func fakeCopyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(source, path)
		destination := filepath.Join(target, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		switch {
		case entry.IsDir():
			return os.MkdirAll(destination, info.Mode().Perm()|0o700)
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, destination)
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return os.WriteFile(destination, data, info.Mode().Perm())
		}
	})
}

func fakeStateCommand(root string, args []string) error {
	if len(args) != 1 {
		return errors.New("fake runsc: state <id>")
	}
	state, err := fakeLoad(root, args[0])
	if err != nil {
		return err
	}
	data, _ := json.MarshalIndent(map[string]any{"ociVersion": "1.2.1", "id": state.ID, "status": state.Status,
		"pid": state.PID, "bundle": state.Bundle}, "", "  ")
	fmt.Println(string(data))
	return nil
}

func fakeList(root string) error {
	entries, _ := os.ReadDir(root)
	var states []map[string]any
	for _, entry := range entries {
		if state, err := fakeLoad(root, entry.Name()); err == nil {
			states = append(states, map[string]any{"ociVersion": "1.2.1", "id": state.ID, "status": state.Status,
				"pid": state.PID, "bundle": state.Bundle})
		}
	}
	data, _ := json.Marshal(states) // nil: "null", as runsc
	fmt.Println(string(data))
	return nil
}

func fakeUpdate(root string, args []string) error {
	var limit int64
	var id string
	for _, arg := range args {
		if value, ok := strings.CutPrefix(arg, "--memory="); ok {
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				return err
			}
			limit = parsed
		} else {
			id = arg
		}
	}
	state, err := fakeLoad(root, id)
	if err != nil {
		return err
	}
	state.MemoryLimit = limit
	return fakeSave(root, state)
}

func fakeKill(root string, args []string) error {
	if len(args) < 1 {
		return errors.New("fake runsc: kill <id> [signal]")
	}
	state, err := fakeLoad(root, args[0])
	if err != nil {
		return err
	}
	fakeEndProcesses(filepath.Join(root, state.ID))
	state.Status = "stopped"
	return fakeSave(root, state)
}

func fakeDelete(root string, args []string) error {
	force := false
	for _, arg := range args {
		if arg == "--force" {
			force = true
			continue
		}
		state, err := fakeLoad(root, arg)
		if err != nil {
			continue // runsc delete --force of an unknown container succeeds
		}
		if state.Status == "running" && !force {
			return errors.New("cannot delete a running container without --force")
		}
		fakeEndProcesses(filepath.Join(root, arg))
		if err := os.RemoveAll(filepath.Join(root, arg)); err != nil {
			return err
		}
	}
	return nil
}

// fakeEndProcesses kills every process an exec of this container started.
func fakeEndProcesses(container string) {
	want := "FAKE_RUNSC_CONTAINER=" + container
	entries, _ := os.ReadDir("/proc")
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		environ, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "environ"))
		if err != nil {
			continue
		}
		for _, variable := range strings.Split(string(environ), "\x00") {
			if variable == want {
				syscall.Kill(pid, syscall.SIGKILL)
				break
			}
		}
	}
}

func fakeExec(root string, args []string) (int, error) {
	var user, cwd string
	var env []string
	i := 0
	for ; i < len(args) && strings.HasPrefix(args[i], "--"); i++ {
		name, value, _ := strings.Cut(strings.TrimPrefix(args[i], "--"), "=")
		switch name {
		case "user":
			user = value
		case "cwd":
			cwd = value
		case "env":
			env = append(env, value)
		default:
			return 0, fmt.Errorf("fake runsc: exec flag %q", name)
		}
	}
	if i+1 >= len(args) || user == "" || cwd == "" {
		return 0, errors.New("fake runsc: exec --user=… --cwd=… <id> <argv…>")
	}
	id, argv := args[i], args[i+1:]
	state, err := fakeLoad(root, id)
	if err != nil {
		return 0, err
	}
	if state.Status != "running" {
		return 0, fmt.Errorf("executing processes for container: cannot execute in container %q in state %s", id, state.Status)
	}
	spec, err := fakeLoadSpec(state.Bundle)
	if err != nil {
		return 0, err
	}
	container := filepath.Join(root, id)
	fsRoot := filepath.Join(container, "fs")
	values := map[string]string{}
	var order []string
	for _, variable := range append(append([]string{}, spec.Process.Env...), env...) {
		name, value, _ := strings.Cut(variable, "=")
		if _, seen := values[name]; !seen {
			order = append(order, name)
		}
		values[name] = value
	}
	environment := []string{"FAKE_RUNSC_CONTAINER=" + container}
	for _, name := range order {
		value := values[name]
		if strings.HasPrefix(value, "/") && !strings.Contains(value, ":") {
			value = fsRoot + value
		}
		environment = append(environment, name+"="+value)
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = fsRoot + cwd
	cmd.Env = environment
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	cmd.Wait()
	status := cmd.ProcessState.Sys().(syscall.WaitStatus)
	if status.Signaled() {
		return 128 + int(status.Signal()), nil
	}
	return status.ExitStatus(), nil
}
