package metrics

import "github.com/IgorP0tatoes/besigor/agent/internal/docker"

// HostInfo describes the machine once per connection.
type HostInfo struct {
	Version  string `json:"version"`
	Hostname string `json:"hostname"`
	OS       string `json:"os"`
	Kernel   string `json:"kernel"`
	Arch     string `json:"arch"`
	CPUModel string `json:"cpuModel"`
	Cores    int    `json:"cores"`
	MemTotal uint64 `json:"memTotal"`
	BootTime int64  `json:"bootTime"`
}

type Disk struct {
	Mount string `json:"mount"`
	Dev   string `json:"dev"`
	FS    string `json:"fs"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

type NetIface struct {
	Iface string `json:"iface"`
	Rx    uint64 `json:"rx"`
	Tx    uint64 `json:"tx"`
}

// Sample is both the live 10s snapshot and the per-minute record.
// See docs/protocol.md for the meaning of rate vs. byte fields.
type Sample struct {
	TS           int64      `json:"ts"`
	CPU          float64    `json:"cpu"`
	CPUUser      float64    `json:"cpuUser"`
	CPUSys       float64    `json:"cpuSys"`
	CPUIowait    float64    `json:"cpuIowait"`
	CPUSteal     float64    `json:"cpuSteal"`
	Load         [3]float64 `json:"load"`
	MemUsed      uint64     `json:"memUsed"`
	MemTotal     uint64     `json:"memTotal"`
	MemBuffCache uint64     `json:"memBuffCache"`
	SwapUsed     uint64     `json:"swapUsed"`
	SwapTotal    uint64     `json:"swapTotal"`
	Disks        []Disk     `json:"disks"`
	DiskRead     uint64     `json:"diskRead"`
	DiskWrite    uint64     `json:"diskWrite"`
	Net          []NetIface `json:"net"`
	Rx           uint64     `json:"rx"`
	Tx           uint64     `json:"tx"`
	Uptime       uint64     `json:"uptime"`
	// Containers is nil when Docker is not available on the host.
	Containers []docker.Container `json:"containers,omitempty"`
}
