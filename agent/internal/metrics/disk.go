package metrics

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

var realFS = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true,
	"zfs": true, "f2fs": true, "jfs": true, "reiserfs": true, "bcachefs": true,
}

var skipMountPrefixes = []string{"/boot", "/snap", "/var/lib/docker", "/var/lib/containerd", "/var/lib/kubelet", "/run", "/host"}

type mountEntry struct {
	devID, mount, source, fs string
}

// readMounts lists the host's mounts. With pid: host, PID 1 is the host init
// and its mountinfo describes the host's mount namespace.
func readMounts(p Paths) []mountEntry {
	var lines []string
	for _, path := range []string{p.proc("1", "mountinfo"), p.proc("self", "mountinfo")} {
		if l, err := readLines(path); err == nil && len(l) > 0 {
			lines = l
			break
		}
	}
	var out []mountEntry
	for _, line := range lines {
		left, right, ok := strings.Cut(line, " - ")
		if !ok {
			continue
		}
		lf, rf := strings.Fields(left), strings.Fields(right)
		if len(lf) < 5 || len(rf) < 2 {
			continue
		}
		out = append(out, mountEntry{devID: lf[2], mount: unescapeMount(lf[4]), fs: rf[0], source: rf[1]})
	}
	return out
}

func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

func readDisks(p Paths) []Disk {
	seen := map[string]bool{}
	var out []Disk
	for _, m := range readMounts(p) {
		if !realFS[m.fs] || seen[m.devID] || skipMount(m.mount) {
			continue
		}
		var st syscall.Statfs_t
		if err := syscall.Statfs(p.host(m.mount), &st); err != nil {
			continue
		}
		total := st.Blocks * uint64(st.Bsize)
		if total == 0 {
			continue
		}
		seen[m.devID] = true
		free := st.Bavail * uint64(st.Bsize)
		// "used" as df shows it: blocks reserved for root count as used.
		used := total - st.Bfree*uint64(st.Bsize)
		out = append(out, Disk{
			Mount: m.mount, Dev: filepath.Base(m.source), FS: m.fs,
			Total: used + free, Used: used,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Mount == "/" {
			return true
		}
		if out[j].Mount == "/" {
			return false
		}
		return out[i].Mount < out[j].Mount
	})
	return out
}

func skipMount(mount string) bool {
	if mount == "/" {
		return false
	}
	for _, pre := range skipMountPrefixes {
		if mount == pre || strings.HasPrefix(mount, pre+"/") {
			return true
		}
	}
	return false
}

// diskIO returns cumulative read/write bytes over whole physical disks.
func diskIO(p Paths) (read, write uint64) {
	lines, err := readLines(p.proc("diskstats"))
	if err != nil {
		return 0, 0
	}
	for _, line := range lines {
		f := strings.Fields(line)
		if len(f) < 10 || !physicalDisk(p, f[2]) {
			continue
		}
		r, _ := strconv.ParseUint(f[5], 10, 64)
		w, _ := strconv.ParseUint(f[9], 10, 64)
		read += r * 512
		write += w * 512
	}
	return read, write
}

func physicalDisk(p Paths, name string) bool {
	for _, pre := range []string{"loop", "ram", "zram", "dm-", "md", "sr", "fd", "nbd"} {
		if strings.HasPrefix(name, pre) {
			return false
		}
	}
	// whole disks have /sys/block/<name>; partitions do not
	_, err := os.Stat(p.sys("block", name))
	return err == nil
}
