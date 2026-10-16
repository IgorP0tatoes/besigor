package metrics

import (
	"time"
)

// Sampler turns cumulative kernel counters into per-interval values.
type Sampler struct {
	paths Paths

	prevAt   time.Time
	prevCPU  cpuTimes
	prevRead uint64
	prevWrt  uint64
	prevNet  map[string]ifCounters
}

func NewSampler(p Paths) *Sampler {
	s := &Sampler{paths: p}
	s.prime()
	return s
}

func (s *Sampler) prime() {
	s.prevAt = time.Now()
	s.prevCPU, _ = readCPUTimes(s.paths)
	s.prevRead, s.prevWrt = diskIO(s.paths)
	s.prevNet = readNet(s.paths)
}

// Interval is one collection: rates for the live view plus raw byte deltas
// for the minute aggregate.
type Interval struct {
	Live      Sample
	Seconds   float64
	ReadBytes uint64
	WrtBytes  uint64
	NetBytes  map[string]ifCounters
	Counted   map[string]bool
}

func (s *Sampler) Collect(now time.Time) Interval {
	p := s.paths
	secs := now.Sub(s.prevAt).Seconds()
	if secs <= 0 {
		secs = 1
	}

	cpuNow, _ := readCPUTimes(p)
	cpu := cpuDelta(s.prevCPU, cpuNow)
	mem, _ := readMem(p)
	rd, wr := diskIO(p)
	netNow := readNet(p)

	iv := Interval{
		Seconds:   secs,
		ReadBytes: sub(rd, s.prevRead),
		WrtBytes:  sub(wr, s.prevWrt),
		NetBytes:  map[string]ifCounters{},
	}
	names := sortedKeys(netNow)
	iv.Counted = countedIfaces(p, names)

	live := Sample{
		TS:  now.Unix(),
		CPU: cpu.busy, CPUUser: cpu.user, CPUSys: cpu.sys, CPUIowait: cpu.iowait, CPUSteal: cpu.steal,
		Load:    readLoad(p),
		MemUsed: mem.used, MemTotal: mem.total, MemBuffCache: mem.buffCache,
		SwapUsed: mem.swapUsed, SwapTotal: mem.swapTotal,
		Disks:     readDisks(p),
		DiskRead:  uint64(float64(iv.ReadBytes) / secs),
		DiskWrite: uint64(float64(iv.WrtBytes) / secs),
		Uptime:    uptime(p),
		Net:       make([]NetIface, 0, len(names)),
	}
	for _, n := range names {
		prev, ok := s.prevNet[n]
		if !ok {
			continue // new interface: no baseline yet
		}
		d := ifCounters{rx: sub(netNow[n].rx, prev.rx), tx: sub(netNow[n].tx, prev.tx)}
		iv.NetBytes[n] = d
		live.Net = append(live.Net, NetIface{Iface: n, Rx: uint64(float64(d.rx) / secs), Tx: uint64(float64(d.tx) / secs)})
		if iv.Counted[n] {
			live.Rx += uint64(float64(d.rx) / secs)
			live.Tx += uint64(float64(d.tx) / secs)
		}
	}
	iv.Live = live

	s.prevAt, s.prevCPU, s.prevRead, s.prevWrt, s.prevNet = now, cpuNow, rd, wr, netNow
	return iv
}
