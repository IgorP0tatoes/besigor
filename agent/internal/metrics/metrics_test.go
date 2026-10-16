package metrics

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeProc(t *testing.T) Paths {
	dir := t.TempDir()
	p := Paths{Proc: filepath.Join(dir, "proc"), Sys: filepath.Join(dir, "sys")}
	writeFile(t, p.proc("meminfo"), "MemTotal:  4000 kB\nMemFree: 500 kB\nMemAvailable:  1000 kB\nBuffers: 100 kB\nCached: 800 kB\nSReclaimable: 100 kB\nSwapTotal: 512 kB\nSwapFree: 112 kB\n")
	writeFile(t, p.proc("loadavg"), "0.50 0.40 0.30 1/200 1234\n")
	writeFile(t, p.proc("uptime"), "3600.5 1000.0\n")
	writeFile(t, p.proc("diskstats"), "")
	writeFile(t, p.proc("net", "dev"), "")
	return p
}

func TestCPUDelta(t *testing.T) {
	prev := cpuTimes{user: 100, system: 50, idle: 800, iowait: 50}
	cur := cpuTimes{user: 150, system: 75, idle: 900, iowait: 75, steal: 0}
	got := cpuDelta(prev, cur)
	// total delta 200, idle+iowait delta 125 → busy 37.5%
	if got.busy != 37.5 || got.user != 25 || got.sys != 12.5 || got.iowait != 12.5 {
		t.Fatalf("unexpected %+v", got)
	}
	// counters going backwards must not produce garbage
	if r := cpuDelta(cur, prev); r.busy < 0 || r.busy > 100 {
		t.Fatalf("reset produced %+v", r)
	}
}

func TestReadMem(t *testing.T) {
	m, err := readMem(fakeProc(t))
	if err != nil {
		t.Fatal(err)
	}
	if m.total != 4000*1024 || m.used != 3000*1024 || m.buffCache != 1000*1024 || m.swapUsed != 400*1024 {
		t.Fatalf("unexpected %+v", m)
	}
}

func TestNetCountersAndMinute(t *testing.T) {
	p := fakeProc(t)
	header := "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n"
	line := func(name string, rx, tx int) string {
		return name + ": " + strconv.Itoa(rx) + " 0 0 0 0 0 0 0 " + strconv.Itoa(tx) + " 0 0 0 0 0 0 0\n"
	}
	writeFile(t, p.proc("net", "dev"), header+line("lo", 5, 5)+line("eth0", 1000, 2000)+line("wg0", 100, 100))
	writeFile(t, p.proc("stat"), "cpu 100 0 50 800 50 0 0 0 0 0\n")
	writeFile(t, filepath.Join(p.Sys, "class", "net", "eth0", "device"), "")

	s := NewSampler(p)
	writeFile(t, p.proc("net", "dev"), header+line("lo", 9, 9)+line("eth0", 11000, 7000)+line("wg0", 600, 300))
	writeFile(t, p.proc("stat"), "cpu 150 0 75 900 75 0 0 0 0 0\n")

	base := time.Unix(1_700_000_040, 0) // minute boundary
	s.prevAt = base.Add(-10 * time.Second)
	iv := s.Collect(base)
	if len(iv.Live.Net) != 2 {
		t.Fatalf("lo must be skipped, got %+v", iv.Live.Net)
	}
	// only eth0 counts toward the total; wg0 traffic also crosses eth0
	if iv.Live.Rx != 1000 || iv.Live.Tx != 500 {
		t.Fatalf("live totals rx=%d tx=%d", iv.Live.Rx, iv.Live.Tx)
	}

	var agg MinuteAggregator
	if _, done := agg.Add(iv); done {
		t.Fatal("first interval must not flush")
	}
	next := iv
	next.Live.TS = base.Add(60 * time.Second).Unix()
	rec, done := agg.Add(next)
	if !done || rec.TS != base.Unix() || rec.Rx != 10000 || rec.Tx != 5000 {
		t.Fatalf("minute record wrong: done=%v %+v", done, rec)
	}
}
