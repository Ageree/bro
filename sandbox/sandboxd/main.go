// sandboxd runs Bro's execution sandboxes on one Cloud.ru host: gVisor (runsc) containers with no
// network, commands and files through `runsc exec`, /workspace snapshots in Object Storage over presigned
// URLs, and a tools broker on a unix socket in each sandbox. The contract is sandbox/README.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "sandboxd:", err)
		os.Exit(1)
	}
}

func run() error {
	configPath := flag.String("config", "/etc/bro/sandboxd.json", "the config file")
	listen := flag.String("listen", "", "override listen")
	root := flag.String("root", "", "override root")
	runsc := flag.String("runsc", "", "override runsc")
	runscRoot := flag.String("runsc-root", "", "override runsc_root")
	rootfs := flag.String("rootfs-version", "", "override rootfs_version")
	platform := flag.String("platform", "", "override platform")
	idle := flag.Int("idle-minutes", 0, "override idle_minutes")
	maxSandboxes := flag.Int("max-sandboxes", 0, "override max_sandboxes")
	flag.Parse()

	config, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	for _, override := range []struct {
		value  string
		target *string
	}{{*listen, &config.Listen}, {*root, &config.Root}, {*runsc, &config.Runsc}, {*runscRoot, &config.RunscRoot},
		{*rootfs, &config.RootfsVersion}, {*platform, &config.Platform}} {
		if override.value != "" {
			*override.target = override.value
		}
	}
	if *idle > 0 {
		config.IdleMinutes = *idle
	}
	if *maxSandboxes > 0 {
		config.MaxSandboxes = *maxSandboxes
	}
	if err := config.validate(); err != nil {
		return err
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	manager := newManager(config, newRunsc(config), logger)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if manager.runsc, err = manager.rt.Version(ctx); err != nil {
		return fmt.Errorf("runsc --version: %w", err)
	}
	if err := manager.prepare(); err != nil {
		return err
	}
	if err := manager.reconcile(ctx); err != nil {
		return fmt.Errorf("reconcile with runsc: %w", err)
	}
	go manager.reaper(ctx, time.Minute)

	api := &API{m: manager, now: time.Now}
	server := &http.Server{
		Addr:              config.Listen,
		Handler:           api.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		// No write timeout: an exec stream lives as long as its command.
	}
	errs := make(chan error, 1)
	go func() { errs <- server.ListenAndServe() }()
	logger.Info("sandboxd listening", "version", version, "listen", config.Listen, "runsc", manager.runsc,
		"rootfs", config.RootfsVersion, "sandboxes", manager.liveCount())
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	// Sandboxes stay up: the next sandboxd adopts them. Open exec streams end with this process.
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutdown)
	manager.save()
	logger.Info("sandboxd stopped")
	if err := <-errs; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
