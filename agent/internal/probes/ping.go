package probes

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"time"
)

// ping sends count ICMP echo requests over a raw socket (needs CAP_NET_RAW)
// and returns the average round trip of the answered ones and the loss in %.
func ping(ctx context.Context, host string, count int) (float64, float64, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return 0, 100, err
	}
	if len(ips) == 0 {
		return 0, 100, fmt.Errorf("no address for %s", host)
	}
	ip := ips[0].IP
	v4 := ip.To4() != nil
	network, echo, reply := "ip4:icmp", byte(8), byte(0)
	if !v4 {
		network, echo, reply = "ip6:ipv6-icmp", byte(128), byte(129)
	}
	conn, err := net.ListenPacket(network, "")
	if err != nil {
		return 0, 100, fmt.Errorf("raw socket (нужен NET_RAW): %w", err)
	}
	defer conn.Close()

	id := uint16(rand.IntN(0xffff))
	var total time.Duration
	got := 0
	buf := make([]byte, 1500)
	for seq := 1; seq <= count; seq++ {
		if ctx.Err() != nil {
			break
		}
		pkt := make([]byte, 16)
		pkt[0] = echo
		binary.BigEndian.PutUint16(pkt[4:], id)
		binary.BigEndian.PutUint16(pkt[6:], uint16(seq))
		if v4 { // the kernel fills the ICMPv6 checksum itself
			binary.BigEndian.PutUint16(pkt[2:], checksum(pkt))
		}
		start := time.Now()
		if _, err := conn.WriteTo(pkt, &net.IPAddr{IP: ip}); err != nil {
			return 0, 100, err
		}
		deadline := start.Add(2 * time.Second)
		_ = conn.SetReadDeadline(deadline)
		for {
			n, _, err := conn.ReadFrom(buf)
			if err != nil {
				break // timeout: lost
			}
			msg := buf[:n]
			// raw IPv4 sockets deliver the IP header too
			if v4 && n > 20 && msg[0]>>4 == 4 {
				msg = msg[int(msg[0]&0x0f)*4:]
			}
			if len(msg) >= 8 && msg[0] == reply && binary.BigEndian.Uint16(msg[4:]) == id && binary.BigEndian.Uint16(msg[6:]) == uint16(seq) {
				total += time.Since(start)
				got++
				break
			}
			if time.Now().After(deadline) {
				break
			}
		}
		if seq < count {
			time.Sleep(200 * time.Millisecond)
		}
	}
	loss := float64(count-got) / float64(count) * 100
	if got == 0 {
		return 0, 100, errors.New("нет ответа")
	}
	return float64(total.Microseconds()) / 1000 / float64(got), loss, nil
}

func checksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}
