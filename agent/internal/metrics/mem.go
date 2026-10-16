package metrics

import (
	"strconv"
	"strings"
)

type memInfo struct {
	total, used, buffCache, swapTotal, swapUsed uint64
}

func readMem(p Paths) (memInfo, error) {
	lines, err := readLines(p.proc("meminfo"))
	if err != nil {
		return memInfo{}, err
	}
	kv := make(map[string]uint64, len(lines))
	for _, line := range lines {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		v, _ := strconv.ParseUint(f[0], 10, 64)
		kv[name] = v * 1024 // values are in kB
	}
	m := memInfo{total: kv["MemTotal"], swapTotal: kv["SwapTotal"]}
	avail, ok := kv["MemAvailable"]
	if !ok { // kernels < 3.14
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	m.used = sub(m.total, avail)
	m.buffCache = kv["Buffers"] + kv["Cached"] + kv["SReclaimable"]
	m.swapUsed = sub(m.swapTotal, kv["SwapFree"])
	return m, nil
}
