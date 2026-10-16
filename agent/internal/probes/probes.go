// Package probes runs the network checks the hub assigns to this agent:
// ICMP ping, TCP connect, HTTP(S) request and DNS lookup.
package probes

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type Config struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // icmp, tcp, http, dns
	Target   string `json:"target"`
	Port     int    `json:"port,omitempty"`
	Interval int    `json:"interval"` // seconds
	Server   string `json:"server,omitempty"`
}

// Result of one check. Ms is the average response time of the check.
type Result struct {
	ID          string  `json:"id"`
	TS          int64   `json:"ts"`
	OK          bool    `json:"ok"`
	Ms          float64 `json:"ms"`
	Loss        float64 `json:"loss"` // % of lost ICMP packets
	Error       string  `json:"error,omitempty"`
	CertExpires int64   `json:"certExpires,omitempty"`
}

const timeout = 10 * time.Second

// Manager keeps one goroutine per probe and collects their results.
type Manager struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
	configs map[string]Config
	results []Result
	http    *http.Client
}

func NewManager() *Manager {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DisableKeepAlives = true // measure a full connection every time
	return &Manager{
		running: map[string]context.CancelFunc{},
		configs: map[string]Config{},
		http: &http.Client{
			Timeout:   timeout,
			Transport: tr,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse // a redirect is an answer
			},
		},
	}
}

// Sync replaces the set of probes; unchanged ones keep running.
func (m *Manager) Sync(ctx context.Context, list []Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	want := map[string]Config{}
	for _, c := range list {
		if c.ID == "" || c.Target == "" {
			continue
		}
		if c.Interval < 10 {
			c.Interval = 10
		}
		want[c.ID] = c
	}
	for id, cancel := range m.running {
		if c, ok := want[id]; !ok || c != m.configs[id] {
			cancel()
			delete(m.running, id)
			delete(m.configs, id)
		}
	}
	for id, c := range want {
		if _, ok := m.running[id]; ok {
			continue
		}
		pctx, cancel := context.WithCancel(ctx)
		m.running[id] = cancel
		m.configs[id] = c
		go m.loop(pctx, c)
	}
}

// Drain returns and clears the results gathered since the last call.
func (m *Manager) Drain() []Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.results
	m.results = nil
	return out
}

// Requeue puts back results that could not be delivered.
func (m *Manager) Requeue(rs []Result) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.results = append(rs, m.results...)
	if len(m.results) > 2000 {
		m.results = m.results[len(m.results)-2000:]
	}
}

func (m *Manager) loop(ctx context.Context, c Config) {
	t := time.NewTicker(time.Duration(c.Interval) * time.Second)
	defer t.Stop()
	for {
		r := m.check(ctx, c)
		if ctx.Err() != nil {
			return
		}
		m.mu.Lock()
		m.results = append(m.results, r)
		if len(m.results) > 2000 { // hub away for long: keep the newest
			m.results = m.results[len(m.results)-2000:]
		}
		m.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (m *Manager) check(ctx context.Context, c Config) Result {
	ctx, cancel := context.WithTimeout(ctx, timeout+2*time.Second)
	defer cancel()
	r := Result{ID: c.ID, TS: time.Now().Unix()}
	var err error
	switch c.Type {
	case "icmp":
		r.Ms, r.Loss, err = ping(ctx, c.Target, 3)
	case "tcp":
		r.Ms, err = tcpCheck(ctx, c.Target, c.Port)
	case "http":
		r.Ms, r.CertExpires, err = m.httpCheck(ctx, c.Target)
	case "dns":
		r.Ms, err = dnsCheck(ctx, c.Target, c.Server)
	default:
		err = fmt.Errorf("unknown probe type %q", c.Type)
	}
	r.OK = err == nil
	if err != nil {
		r.Error = err.Error()
		if c.Type != "icmp" {
			r.Loss = 100
		}
	}
	r.Ms = float64(int64(r.Ms*100+0.5)) / 100
	return r
}

func tcpCheck(ctx context.Context, host string, port int) (float64, error) {
	if port <= 0 {
		return 0, fmt.Errorf("no port")
	}
	start := time.Now()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return 0, err
	}
	ms := msSince(start)
	conn.Close()
	return ms, nil
}

func (m *Manager) httpCheck(ctx context.Context, url string) (float64, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, 0, err
	}
	req.Header.Set("User-Agent", "besigor-agent")
	start := time.Now()
	resp, err := m.http.Do(req)
	if err != nil {
		return 0, 0, err
	}
	ms := msSince(start)
	resp.Body.Close()
	var expires int64
	if resp.TLS != nil {
		expires = certExpiry(resp.TLS)
	}
	if resp.StatusCode >= 400 {
		return ms, expires, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return ms, expires, nil
}

func certExpiry(st *tls.ConnectionState) int64 {
	if len(st.PeerCertificates) == 0 {
		return 0
	}
	return st.PeerCertificates[0].NotAfter.Unix()
}

func dnsCheck(ctx context.Context, name, server string) (float64, error) {
	r := net.DefaultResolver
	if server != "" {
		if _, _, err := net.SplitHostPort(server); err != nil {
			server = net.JoinHostPort(server, "53")
		}
		r = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, server)
		}}
	}
	start := time.Now()
	addrs, err := r.LookupHost(ctx, name)
	if err != nil {
		return 0, err
	}
	if len(addrs) == 0 {
		return 0, fmt.Errorf("no addresses")
	}
	return msSince(start), nil
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}
