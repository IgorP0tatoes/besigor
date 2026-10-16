package hub

import (
	"sync"

	"github.com/IgorP0tatoes/besigor/agent/internal/metrics"
)

// MaxBuffered minute records survive a hub outage (one hour).
const MaxBuffered = 60

// Buffer holds minute records until the hub acknowledges them.
type Buffer struct {
	mu   sync.Mutex
	recs []metrics.Sample
}

func (b *Buffer) Push(s metrics.Sample) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.recs = append(b.recs, s)
	if over := len(b.recs) - MaxBuffered; over > 0 {
		b.recs = append(b.recs[:0], b.recs[over:]...)
	}
}

func (b *Buffer) Pending() []metrics.Sample {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]metrics.Sample(nil), b.recs...)
}

func (b *Buffer) AckUpTo(ts int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	i := 0
	for i < len(b.recs) && b.recs[i].TS <= ts {
		i++
	}
	b.recs = append(b.recs[:0], b.recs[i:]...)
}

func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.recs)
}
