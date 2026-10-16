package metrics

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func ReadHostInfo(p Paths, version string) HostInfo {
	h := HostInfo{
		Version: version,
		Kernel:  readTrim(p.proc("sys", "kernel", "osrelease")),
		Arch:    runtime.GOARCH,
	}
	// The UTS namespace is not shared with the host, so prefer its file.
	h.Hostname = readTrim(p.host("/etc/hostname"))
	if h.Hostname == "" {
		h.Hostname, _ = os.Hostname()
	}
	h.OS = osName(p)
	h.CPUModel, h.Cores = cpuModel(p)
	if m, err := readMem(p); err == nil {
		h.MemTotal = m.total
	}
	if up := uptime(p); up > 0 {
		h.BootTime = time.Now().Unix() - int64(up)
	}
	return h
}

func osName(p Paths) string {
	lines, _ := readLines(p.host("/etc/os-release"))
	if p.Root != "" && len(lines) == 0 {
		lines, _ = readLines(p.host("/usr/lib/os-release"))
	}
	for _, l := range lines {
		if v, ok := strings.CutPrefix(l, "PRETTY_NAME="); ok {
			return strings.Trim(v, `"'`)
		}
	}
	return "Linux"
}

func cpuModel(p Paths) (string, int) {
	lines, _ := readLines(p.proc("cpuinfo"))
	model, cores := "", 0
	for _, l := range lines {
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "processor":
			cores++
		case "model name", "Model", "cpu model":
			if model == "" {
				model = strings.TrimSpace(v)
			}
		}
	}
	if cores == 0 {
		cores = runtime.NumCPU()
	}
	return model, cores
}

func uptime(p Paths) uint64 {
	f := strings.Fields(readTrim(p.proc("uptime")))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return uint64(v)
}
