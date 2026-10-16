package probes

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestChecksum(t *testing.T) {
	// echo request id=1 seq=1 with no payload
	pkt := []byte{8, 0, 0, 0, 0, 1, 0, 1}
	if got := checksum(pkt); got != 0xf7fd {
		t.Fatalf("checksum = %#x", got)
	}
}

func TestTCPAndHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bad" {
			w.WriteHeader(503)
		}
	}))
	defer srv.Close()
	host, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	m := NewManager()
	ctx := context.Background()

	if r := m.check(ctx, Config{ID: "t", Type: "tcp", Target: host, Port: p}); !r.OK {
		t.Fatalf("tcp failed: %+v", r)
	}
	if r := m.check(ctx, Config{ID: "h", Type: "http", Target: srv.URL}); !r.OK {
		t.Fatalf("http failed: %+v", r)
	}
	if r := m.check(ctx, Config{ID: "b", Type: "http", Target: srv.URL + "/bad"}); r.OK || r.Error != "HTTP 503" {
		t.Fatalf("503 must fail: %+v", r)
	}
	if r := m.check(ctx, Config{ID: "c", Type: "tcp", Target: host, Port: 1}); r.OK || r.Loss != 100 {
		t.Fatalf("closed port must fail: %+v", r)
	}
}
