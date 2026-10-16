package metrics

import (
	"errors"
	"strconv"
	"strings"
)

// cpuTimes are the aggregate jiffies from the first line of /proc/stat.
type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (t cpuTimes) total() uint64 {
	return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal
}

func readCPUTimes(p Paths) (cpuTimes, error) {
	lines, err := readLines(p.proc("stat"))
	if err != nil {
		return cpuTimes{}, err
	}
	for _, line := range lines {
		f := strings.Fields(line)
		if len(f) < 9 || f[0] != "cpu" {
			continue
		}
		v := make([]uint64, 8)
		for i := range v {
			v[i], _ = strconv.ParseUint(f[i+1], 10, 64)
		}
		return cpuTimes{v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]}, nil
	}
	return cpuTimes{}, errors.New("no cpu line in /proc/stat")
}

type cpuPercent struct {
	busy, user, sys, iowait, steal float64
}

func cpuDelta(prev, cur cpuTimes) cpuPercent {
	dt := float64(sub(cur.total(), prev.total()))
	if dt <= 0 {
		return cpuPercent{}
	}
	pct := func(v uint64) float64 { return round2(float64(v) / dt * 100) }
	idle := sub(cur.idle, prev.idle) + sub(cur.iowait, prev.iowait)
	return cpuPercent{
		busy:   round2((dt - float64(idle)) / dt * 100),
		user:   pct(sub(cur.user, prev.user) + sub(cur.nice, prev.nice)),
		sys:    pct(sub(cur.system, prev.system) + sub(cur.irq, prev.irq) + sub(cur.softirq, prev.softirq)),
		iowait: pct(sub(cur.iowait, prev.iowait)),
		steal:  pct(sub(cur.steal, prev.steal)),
	}
}

func readLoad(p Paths) [3]float64 {
	var out [3]float64
	f := strings.Fields(readTrim(p.proc("loadavg")))
	for i := 0; i < 3 && i < len(f); i++ {
		out[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return out
}

// sub returns cur-prev, or 0 when a counter went backwards (reset/wrap).
func sub(cur, prev uint64) uint64 {
	if cur < prev {
		return 0
	}
	return cur - prev
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}
