package metrics

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// Paths points the collectors at the host's pseudo-filesystems. In Docker the
// host root is mounted at /host; on bare metal every field is the default.
type Paths struct {
	Proc string // /proc (with pid: host this is the host's procfs)
	Sys  string // /sys
	Root string // host root filesystem, "" on bare metal
}

func DefaultPaths() Paths {
	p := Paths{Proc: "/proc", Sys: "/sys", Root: ""}
	if v := os.Getenv("HOST_PROC"); v != "" {
		p.Proc = v
	}
	if v := os.Getenv("HOST_SYS"); v != "" {
		p.Sys = v
	}
	if v := os.Getenv("HOST_ROOT"); v != "" {
		p.Root = strings.TrimRight(v, "/")
	}
	return p
}

func (p Paths) proc(parts ...string) string {
	return filepath.Join(append([]string{p.Proc}, parts...)...)
}

func (p Paths) sys(parts ...string) string {
	return filepath.Join(append([]string{p.Sys}, parts...)...)
}

// host maps an absolute host path into the agent's view of it.
func (p Paths) host(path string) string {
	if p.Root == "" {
		return path
	}
	return p.Root + path
}

func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	return lines, sc.Err()
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
