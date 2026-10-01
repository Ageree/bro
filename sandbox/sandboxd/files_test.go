package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"io"
	"testing"
)

func TestFiles(t *testing.T) {
	h := newHarness(t)
	const id = "sb-files"
	h.create(id, sandboxOptions{})
	// Quotes, spaces and a command substitution in the path: it goes to the sandbox in $P, never as text.
	odd := `/workspace/dir one/it's "odd" $(touch pwned) ;.txt`
	if status := h.writeFile(id, odd, []byte("hello")); status != 204 {
		t.Fatalf("write: %d", status)
	}
	if status, data := h.readFile(id, odd); status != 200 || string(data) != "hello" {
		t.Fatalf("read: %d %q", status, data)
	}
	h.sh(id, `test ! -e pwned && test ! -e "dir one/pwned"`)

	big := make([]byte, 3<<20+17)
	rand.Read(big)
	if status := h.writeFile(id, "/workspace/a/b/c/big.bin", big); status != 204 {
		t.Fatalf("write big: %d", status)
	}
	if status, data := h.readFile(id, "/workspace/a/b/c/big.bin"); status != 200 || !bytes.Equal(data, big) {
		t.Fatalf("read big: %d, %d bytes", status, len(data))
	}
	if status := h.writeFile(id, "/workspace/empty", nil); status != 204 {
		t.Fatalf("write empty: %d", status)
	}
	if status, data := h.readFile(id, "/workspace/empty"); status != 200 || len(data) != 0 {
		t.Fatalf("read empty: %d %q", status, data)
	}
	if status := h.writeFile(id, "/home/sandbox/.config/x", []byte("home")); status != 204 {
		t.Fatalf("write in home: %d", status)
	}

	for name, path := range map[string]string{
		"missing":   "/workspace/missing.txt",
		"directory": "/workspace/a",
		"device":    "/dev/zero",
	} {
		status, data := h.readFile(id, path)
		var failure map[string]string
		json.Unmarshal(data, &failure)
		if status != 404 || failure["error"] != "not_found" {
			t.Errorf("read %s: %d %s", name, status, data)
		}
	}
	for name, path := range map[string]string{"relative": "workspace/x", "root": "/", "empty": ""} {
		if status := h.writeFile(id, path, []byte("x")); status != 400 {
			t.Errorf("write %s: %d", name, status)
		}
	}
	response := h.request("GET", "/v1/sandboxes/"+id+"/files?path=/workspace/a%00b", nil)
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Errorf("a NUL byte: %d", response.StatusCode)
	}
	var failure map[string]string
	if status := h.call("PUT", "/v1/sandboxes/"+id+"/files?path="+urlQuery(odd+"/under-a-file"), "x", &failure); status != 409 ||
		failure["error"] != "write_failed" {
		t.Errorf("write under a file: %d %v", status, failure)
	}

	remove := func(path, flags string) (int, map[string]string) {
		var failure map[string]string
		status := h.call("DELETE", "/v1/sandboxes/"+id+"/files?path="+urlQuery(path)+flags, nil, &failure)
		return status, failure
	}
	if status, failure := remove("/workspace/missing", ""); status != 404 || failure["error"] != "not_found" {
		t.Errorf("delete missing: %d %v", status, failure)
	}
	if status, _ := remove("/workspace/missing", "&force=1"); status != 204 {
		t.Errorf("delete missing with force: %d", status)
	}
	if status, failure := remove("/workspace/a", ""); status != 409 || failure["error"] != "delete_failed" {
		t.Errorf("delete a directory without recursive: %d %v", status, failure)
	}
	if status, _ := remove("/workspace/a", "&recursive=1"); status != 204 {
		t.Errorf("delete a directory: %d", status)
	}
	if status, _ := h.readFile(id, "/workspace/a/b/c/big.bin"); status != 404 {
		t.Errorf("read after delete: %d", status)
	}
	if status, _ := remove(odd, ""); status != 204 {
		t.Errorf("delete a file: %d", status)
	}
	if status, _ := remove("/", "&recursive=1&force=1"); status != 400 {
		t.Errorf("delete /: %d", status)
	}
	if h.real {
		// Root's files stay root's: the sandbox user cannot read /etc/shadow, nor write outside its own.
		if status, data := h.readFile(id, "/etc/shadow"); status != 500 {
			t.Errorf("read /etc/shadow: %d %q", status, data)
		}
		if status := h.writeFile(id, "/etc/x", []byte("x")); status != 409 {
			t.Errorf("write /etc/x: %d", status)
		}
		// A symlink in the sandbox resolves in the sandbox, not on the host.
		h.sh(id, "echo inside > /tmp/target; ln -s /tmp/target /workspace/link")
		if status, data := h.readFile(id, "/workspace/link"); status != 200 || string(data) != "inside\n" {
			t.Errorf("read through a symlink: %d %q", status, data)
		}
	}
	// Not 404: Bro reads that as "no such file".
	if status := h.writeFile("sb-unknown", "/workspace/x", []byte("x")); status != 409 {
		t.Errorf("write in an unknown sandbox: %d", status)
	}
}

func TestFileBodyLimit(t *testing.T) {
	if testing.Short() {
		t.Skip("streams 512 MiB")
	}
	h := newHarness(t)
	h.create("sb-limit", sandboxOptions{memory: 2048})
	response := h.request("PUT", "/v1/sandboxes/sb-limit/files?path=/workspace/huge", io.LimitReader(zeros{}, maxFileBytes+1))
	defer response.Body.Close()
	if response.StatusCode != 413 {
		t.Fatalf("a body over 512 MiB: %d", response.StatusCode)
	}
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}
