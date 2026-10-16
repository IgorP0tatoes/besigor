package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/IgorP0tatoes/besigor/agent/internal/docker"
	"github.com/IgorP0tatoes/besigor/agent/internal/metrics"
)

type envelope struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d,omitempty"`
}

type Client struct {
	URL     string
	Token   string
	Version string
	Hello   func() metrics.HostInfo
	Buffer  *Buffer
	Docker  *docker.Client // nil when Docker is unavailable

	mu   sync.Mutex
	conn *websocket.Conn

	streamsMu sync.Mutex
	streams   map[string]context.CancelFunc // log streams by request id
}

const maxStreams = 8

// AgentURL normalises HUB_URL: https://hub → wss://hub/api/agent.
func AgentURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("HUB_URL: unsupported scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return "", errors.New("HUB_URL: no host")
	}
	if p := strings.TrimRight(u.Path, "/"); !strings.HasSuffix(p, "/api/agent") {
		u.Path = p + "/api/agent"
	}
	return u.String(), nil
}

// Run keeps a connection to the hub open until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		wait, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		if wait == 0 {
			wait = jitter(backoff)
			backoff = min(backoff*2, time.Minute)
		}
		slog.Warn("hub connection lost", "err", err, "retry_in", wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func jitter(d time.Duration) time.Duration {
	return time.Duration(float64(d) * (0.8 + 0.4*rand.Float64()))
}

// session runs one connection. A non-zero wait overrides the backoff.
func (c *Client) session(ctx context.Context) (time.Duration, error) {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+c.Token)
	h.Set("X-Besigor-Agent", c.Version)
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, resp, err := websocket.Dial(dialCtx, c.URL, &websocket.DialOptions{HTTPHeader: h})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return time.Minute, errors.New("token rejected by hub (401)")
		}
		return 0, err
	}
	conn.SetReadLimit(1 << 20)
	defer conn.CloseNow()

	sctx, stop := context.WithCancel(ctx)
	defer stop()

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
	}()

	if err := c.send(sctx, "hello", c.Hello()); err != nil {
		return 0, err
	}
	slog.Info("connected to hub", "url", c.URL)
	c.SendPending(sctx)

	errc := make(chan error, 2)
	go func() { errc <- c.readLoop(sctx, conn) }()
	go func() { errc <- pingLoop(sctx, conn) }()
	select {
	case err = <-errc:
	case <-ctx.Done():
		conn.Close(websocket.StatusGoingAway, "agent stopping")
		return 0, ctx.Err()
	}
	return 0, err
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var env envelope
		if json.Unmarshal(data, &env) != nil {
			continue
		}
		switch env.T {
		case "ack":
			var a struct {
				UpTo int64 `json:"upTo"`
			}
			if json.Unmarshal(env.D, &a) == nil {
				c.Buffer.AckUpTo(a.UpTo)
			}
		case "logs":
			var r struct {
				Req       string `json:"req"`
				Container string `json:"container"`
				Tail      int    `json:"tail"`
				Follow    bool   `json:"follow"`
			}
			if json.Unmarshal(env.D, &r) == nil && r.Req != "" {
				c.startLogs(ctx, r.Req, r.Container, r.Tail, r.Follow)
			}
		case "logs.stop":
			var r struct {
				Req string `json:"req"`
			}
			if json.Unmarshal(env.D, &r) == nil {
				c.stopLogs(r.Req)
			}
		case "config":
			// reserved for probes (stage 8)
		}
	}
}

// startLogs relays a container's log to the hub until stopped or finished.
// It lives within the connection's ctx, so a dropped link ends every stream.
func (c *Client) startLogs(ctx context.Context, req, container string, tail int, follow bool) {
	if tail <= 0 || tail > 1000 {
		tail = 200
	}
	c.streamsMu.Lock()
	if c.streams == nil {
		c.streams = map[string]context.CancelFunc{}
	}
	if c.Docker == nil || len(c.streams) >= maxStreams {
		c.streamsMu.Unlock()
		msg := "docker недоступен на сервере"
		if c.Docker != nil {
			msg = "слишком много открытых логов"
		}
		_ = c.send(ctx, "logs.end", map[string]string{"req": req, "error": msg})
		return
	}
	sctx, cancel := context.WithCancel(ctx)
	c.streams[req] = cancel
	c.streamsMu.Unlock()

	go func() {
		defer c.stopLogs(req)
		err := c.Docker.Logs(sctx, container, tail, follow, func(lines []string) {
			_ = c.send(sctx, "logs.data", map[string]any{"req": req, "lines": lines})
		})
		end := map[string]string{"req": req}
		if err != nil {
			end["error"] = err.Error()
		}
		_ = c.send(ctx, "logs.end", end)
	}()
}

func (c *Client) stopLogs(req string) {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	if cancel, ok := c.streams[req]; ok {
		cancel()
		delete(c.streams, req)
	}
}

func pingLoop(ctx context.Context, conn *websocket.Conn) error {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return fmt.Errorf("ping: %w", err)
			}
		}
	}
}

func (c *Client) send(ctx context.Context, t string, d any) error {
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	msg, _ := json.Marshal(envelope{T: t, D: raw})
	// The lock also serialises writers: one frame at a time.
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return errors.New("not connected")
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.conn.Write(wctx, websocket.MessageText, msg)
}

// SendLive pushes the 10s snapshot; it is dropped while disconnected.
func (c *Client) SendLive(ctx context.Context, s metrics.Sample) {
	_ = c.send(ctx, "live", s)
}

// SendPending pushes every unacknowledged minute record.
func (c *Client) SendPending(ctx context.Context) {
	if recs := c.Buffer.Pending(); len(recs) > 0 {
		_ = c.send(ctx, "minute", recs)
	}
}
