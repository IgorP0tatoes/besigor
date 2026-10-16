package hub

import (
	"testing"

	"github.com/IgorP0tatoes/besigor/agent/internal/metrics"
)

func TestAgentURL(t *testing.T) {
	cases := map[string]string{
		"https://mon.example.com":         "wss://mon.example.com/api/agent",
		"https://mon.example.com/":        "wss://mon.example.com/api/agent",
		"http://hub:8090":                 "ws://hub:8090/api/agent",
		"https://example.com/besigor":     "wss://example.com/besigor/api/agent",
		"wss://mon.example.com/api/agent": "wss://mon.example.com/api/agent",
	}
	for in, want := range cases {
		got, err := AgentURL(in)
		if err != nil || got != want {
			t.Errorf("AgentURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := AgentURL("ftp://x"); err == nil {
		t.Error("ftp must be rejected")
	}
}

func TestBuffer(t *testing.T) {
	var b Buffer
	for i := int64(0); i < MaxBuffered+5; i++ {
		b.Push(metrics.Sample{TS: i * 60})
	}
	if b.Len() != MaxBuffered || b.Pending()[0].TS != 5*60 {
		t.Fatalf("overflow must drop oldest: len=%d first=%d", b.Len(), b.Pending()[0].TS)
	}
	b.AckUpTo(10 * 60)
	if b.Pending()[0].TS != 11*60 {
		t.Fatalf("ack failed, first=%d", b.Pending()[0].TS)
	}
}
