// Package docker reads container state and resource usage from the Docker
// Engine API over its unix socket. It never changes anything.
package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Container is one entry of the live snapshot.
type Container struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Image    string  `json:"image"`
	State    string  `json:"state"`  // running, exited, restarting, paused, created, dead
	Health   string  `json:"health"` // healthy, unhealthy, starting or ""
	CPU      float64 `json:"cpu"`    // % of one host (all cores = 100)
	Mem      uint64  `json:"mem"`
	MemLimit uint64  `json:"memLimit"`
	Rx       uint64  `json:"rx"` // bytes/s
	Tx       uint64  `json:"tx"`
	Restarts int     `json:"restarts"`
	Started  int64   `json:"started"`
	ExitCode int     `json:"exitCode"`
}

type prevStats struct {
	cpuTotal, system uint64
	rx, tx           uint64
	at               time.Time
}

type inspectInfo struct {
	restarts int
	started  int64
	exitCode int
	tty      bool
	at       time.Time
}

// Client talks to dockerd. A nil *Client means Docker is unavailable.
type Client struct {
	http    *http.Client
	mu      sync.Mutex
	prev    map[string]prevStats
	inspect map[string]inspectInfo
}

// New returns a client when the socket exists, or nil.
func New() *Client {
	sock := "/var/run/docker.sock"
	if v, ok := os.LookupEnv("DOCKER_HOST"); ok {
		if v == "" {
			return nil // explicitly disabled
		}
		sock = strings.TrimPrefix(v, "unix://")
	}
	if _, err := os.Stat(sock); err != nil {
		return nil
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
		MaxIdleConns: 4,
	}
	return &Client{
		http:    &http.Client{Transport: tr},
		prev:    map[string]prevStats{},
		inspect: map[string]inspectInfo{},
	}
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker %s: %s", path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

type listEntry struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	Image  string   `json:"Image"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
}

type statsResp struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

type inspectResp struct {
	RestartCount int `json:"RestartCount"`
	State        struct {
		StartedAt string `json:"StartedAt"`
		ExitCode  int    `json:"ExitCode"`
		Health    *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Tty bool `json:"Tty"`
	} `json:"Config"`
}

// Collect lists all containers with usage for the running ones.
func (c *Client) Collect(ctx context.Context) ([]Container, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	var list []listEntry
	if err := c.get(ctx, "/containers/json?all=1", &list); err != nil {
		return nil, err
	}
	out := make([]Container, len(list))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i, e := range list {
		out[i] = Container{
			ID: shortID(e.ID), Name: strings.TrimPrefix(first(e.Names), "/"),
			Image: e.Image, State: e.State, Health: health(e.Status),
		}
		wg.Add(1)
		go func(i int, id string, running bool) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			c.fill(ctx, &out[i], id, running)
		}(i, e.ID, e.State == "running")
	}
	wg.Wait()
	c.forgetMissing(list)
	return out, nil
}

func (c *Client) fill(ctx context.Context, ct *Container, id string, running bool) {
	info := c.inspectCached(ctx, id)
	ct.Restarts, ct.Started, ct.ExitCode = info.restarts, info.started, info.exitCode
	if !running {
		return
	}
	var s statsResp
	if err := c.get(ctx, "/containers/"+id+"/stats?stream=false&one-shot=true", &s); err != nil {
		return
	}
	now := time.Now()
	var rx, tx uint64
	for _, n := range s.Networks {
		rx += n.RxBytes
		tx += n.TxBytes
	}
	cur := prevStats{cpuTotal: s.CPUStats.CPUUsage.TotalUsage, system: s.CPUStats.SystemUsage, rx: rx, tx: tx, at: now}

	c.mu.Lock()
	prev, ok := c.prev[id]
	c.prev[id] = cur
	c.mu.Unlock()

	// cache is reclaimable: report usage the way `docker stats` does
	mem := s.MemoryStats.Usage
	if inactive, ok := s.MemoryStats.Stats["inactive_file"]; ok && inactive < mem {
		mem -= inactive
	} else if cache, ok := s.MemoryStats.Stats["cache"]; ok && cache < mem {
		mem -= cache
	}
	ct.Mem, ct.MemLimit = mem, s.MemoryStats.Limit

	if !ok {
		return // rates need a previous sample
	}
	if dSys := sub(cur.system, prev.system); dSys > 0 {
		ct.CPU = round2(float64(sub(cur.cpuTotal, prev.cpuTotal)) / float64(dSys) * 100)
	}
	if secs := now.Sub(prev.at).Seconds(); secs > 0 {
		ct.Rx = uint64(float64(sub(rx, prev.rx)) / secs)
		ct.Tx = uint64(float64(sub(tx, prev.tx)) / secs)
	}
}

// inspectCached refreshes restart counters once a minute per container.
func (c *Client) inspectCached(ctx context.Context, id string) inspectInfo {
	c.mu.Lock()
	info, ok := c.inspect[id]
	c.mu.Unlock()
	if ok && time.Since(info.at) < time.Minute {
		return info
	}
	var r inspectResp
	if err := c.get(ctx, "/containers/"+id+"/json", &r); err != nil {
		return info
	}
	info = inspectInfo{restarts: r.RestartCount, exitCode: r.State.ExitCode, tty: r.Config.Tty, at: time.Now()}
	if t, err := time.Parse(time.RFC3339Nano, r.State.StartedAt); err == nil && t.Year() > 1 {
		info.started = t.Unix()
	}
	c.mu.Lock()
	c.inspect[id] = info
	c.mu.Unlock()
	return info
}

// Invalidate forces a fresh inspect, e.g. when a container changed state.
func (c *Client) Invalidate(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for full := range c.inspect {
		if strings.HasPrefix(full, id) {
			delete(c.inspect, full)
		}
	}
}

func (c *Client) forgetMissing(list []listEntry) {
	alive := make(map[string]bool, len(list))
	for _, e := range list {
		alive[e.ID] = true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for id := range c.prev {
		if !alive[id] {
			delete(c.prev, id)
		}
	}
	for id := range c.inspect {
		if !alive[id] {
			delete(c.inspect, id)
		}
	}
}

func health(status string) string {
	switch {
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	}
	return ""
}

func first(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func sub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}
