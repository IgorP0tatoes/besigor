package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/IgorP0tatoes/besigor/agent/internal/hub"
	"github.com/IgorP0tatoes/besigor/agent/internal/metrics"
)

var version = "dev"

const interval = 10 * time.Second

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "-v":
			fmt.Println(version)
			return
		case "sample":
			printSample()
			return
		}
	}
	setupLogging()

	hubURL, err := hub.AgentURL(os.Getenv("HUB_URL"))
	if err != nil {
		fatal("HUB_URL is required, e.g. https://monitor.example.com", err)
	}
	token := readToken()
	if token == "" {
		fatal("TOKEN or TOKEN_FILE is required", nil)
	}

	paths := metrics.DefaultPaths()
	slog.Info("besigor-agent starting", "version", version, "hub", hubURL, "host_root", paths.Root)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := &hub.Client{
		URL: hubURL, Token: token, Version: version, Buffer: &hub.Buffer{},
		Hello: func() metrics.HostInfo { return metrics.ReadHostInfo(paths, version) },
	}
	go client.Run(ctx)

	sampler := metrics.NewSampler(paths)
	var agg metrics.MinuteAggregator

	// Align ticks to wall-clock multiples of the interval so minute buckets
	// always receive the same number of samples.
	next := time.Now().Truncate(interval).Add(interval)
	for {
		select {
		case <-ctx.Done():
			slog.Info("stopping")
			return
		case <-time.After(time.Until(next)):
		}
		now := time.Now()
		next = now.Truncate(interval).Add(interval)

		iv := sampler.Collect(now)
		client.SendLive(ctx, iv.Live)
		if rec, ok := agg.Add(iv); ok {
			client.Buffer.Push(rec)
			client.SendPending(ctx)
		}
	}
}

// printSample collects once over a short interval and prints what the hub
// would receive — a quick way to check mounts and permissions on a server.
func printSample() {
	paths := metrics.DefaultPaths()
	s := metrics.NewSampler(paths)
	time.Sleep(2 * time.Second)
	out := map[string]any{
		"hello": metrics.ReadHostInfo(paths, version),
		"live":  s.Collect(time.Now()).Live,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)
}

func readToken() string {
	if t := strings.TrimSpace(os.Getenv("TOKEN")); t != "" {
		return t
	}
	if f := os.Getenv("TOKEN_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			fatal("cannot read TOKEN_FILE", err)
		}
		return strings.TrimSpace(string(b))
	}
	return ""
}

func setupLogging() {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
}

func fatal(msg string, err error) {
	if err != nil {
		slog.Error(msg, "err", err)
	} else {
		slog.Error(msg)
	}
	os.Exit(1)
}
