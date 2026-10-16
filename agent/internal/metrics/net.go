package metrics

import (
	"os"
	"sort"
	"strconv"
	"strings"
)

type ifCounters struct {
	rx, tx uint64
}

var skipIfacePrefixes = []string{"lo", "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "vxlan", "kube"}

// readNet returns cumulative byte counters per interface from /proc/net/dev
// (host's, given network_mode: host).
func readNet(p Paths) map[string]ifCounters {
	lines, err := readLines(p.proc("net", "dev"))
	if err != nil {
		return nil
	}
	out := map[string]ifCounters{}
	for _, line := range lines {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if skipIface(name) {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(f[0], 10, 64)
		tx, _ := strconv.ParseUint(f[8], 10, 64)
		out[name] = ifCounters{rx, tx}
	}
	return out
}

func skipIface(name string) bool {
	for _, pre := range skipIfacePrefixes {
		if strings.HasPrefix(name, pre) {
			return true
		}
	}
	return false
}

// tunnelIface reports interfaces whose traffic also crosses a physical NIC,
// so they are shown individually but excluded from the server's total.
func tunnelIface(name string) bool {
	for _, pre := range []string{"tun", "tap", "wg", "ppp", "ipsec", "gre", "sit", "ip6tnl", "awg", "zt", "tailscale", "nebula"} {
		if strings.HasPrefix(name, pre) {
			return true
		}
	}
	return false
}

// countedIfaces picks which interfaces add up to the server's total traffic:
// those backed by a device in sysfs, or, when there are none (venet, some
// containers), every non-tunnel interface.
func countedIfaces(p Paths, names []string) map[string]bool {
	out := map[string]bool{}
	for _, n := range names {
		if _, err := os.Stat(p.sys("class", "net", n, "device")); err == nil {
			out[n] = true
		}
	}
	if len(out) == 0 {
		for _, n := range names {
			if !tunnelIface(n) {
				out[n] = true
			}
		}
	}
	return out
}

func sortedKeys(m map[string]ifCounters) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
