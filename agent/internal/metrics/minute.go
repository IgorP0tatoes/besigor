package metrics

// MinuteAggregator folds 10-second intervals into one record per wall-clock
// minute (see docs/protocol.md for units).
type MinuteAggregator struct {
	bucket int64
	n      int
	secs   float64

	cpu, user, sys, iowait, steal float64
	load                          [3]float64
	memUsed, buffCache, swapUsed  float64
	readBytes, wrtBytes           uint64
	net                           map[string]ifCounters
	rx, tx                        uint64
	last                          Sample
}

// Add consumes one interval and returns a finished record when the interval
// starts a new minute.
func (a *MinuteAggregator) Add(iv Interval) (Sample, bool) {
	bucket := iv.Live.TS / 60 * 60
	var done Sample
	flushed := false
	if a.n > 0 && bucket != a.bucket {
		done, flushed = a.Flush(), true
	}
	if a.n == 0 {
		a.bucket = bucket
		a.net = map[string]ifCounters{}
	}
	s := iv.Live
	a.n++
	a.secs += iv.Seconds
	a.cpu += s.CPU
	a.user += s.CPUUser
	a.sys += s.CPUSys
	a.iowait += s.CPUIowait
	a.steal += s.CPUSteal
	for i := range a.load {
		a.load[i] += s.Load[i]
	}
	a.memUsed += float64(s.MemUsed)
	a.buffCache += float64(s.MemBuffCache)
	a.swapUsed += float64(s.SwapUsed)
	a.readBytes += iv.ReadBytes
	a.wrtBytes += iv.WrtBytes
	for name, d := range iv.NetBytes {
		c := a.net[name]
		c.rx += d.rx
		c.tx += d.tx
		a.net[name] = c
		if iv.Counted[name] {
			a.rx += d.rx
			a.tx += d.tx
		}
	}
	a.last = s
	return done, flushed
}

// Flush returns the record for the current minute and resets the aggregator.
func (a *MinuteAggregator) Flush() Sample {
	n := float64(a.n)
	secs := a.secs
	if secs <= 0 {
		secs = 1
	}
	out := Sample{
		TS:  a.bucket,
		CPU: round2(a.cpu / n), CPUUser: round2(a.user / n), CPUSys: round2(a.sys / n),
		CPUIowait: round2(a.iowait / n), CPUSteal: round2(a.steal / n),
		Load:    [3]float64{round2(a.load[0] / n), round2(a.load[1] / n), round2(a.load[2] / n)},
		MemUsed: uint64(a.memUsed / n), MemTotal: a.last.MemTotal, MemBuffCache: uint64(a.buffCache / n),
		SwapUsed: uint64(a.swapUsed / n), SwapTotal: a.last.SwapTotal,
		Disks:     a.last.Disks,
		DiskRead:  uint64(float64(a.readBytes) / secs),
		DiskWrite: uint64(float64(a.wrtBytes) / secs),
		Rx:        a.rx, Tx: a.tx,
		Uptime: a.last.Uptime,
	}
	for _, name := range sortedKeys(a.net) {
		c := a.net[name]
		out.Net = append(out.Net, NetIface{Iface: name, Rx: c.rx, Tx: c.tx})
	}
	*a = MinuteAggregator{}
	return out
}
