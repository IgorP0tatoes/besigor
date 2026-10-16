package docker

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxLine = 4096

// Logs streams a container's log lines to emit in small batches until ctx is
// done or, without follow, the log ends.
func (c *Client) Logs(ctx context.Context, container string, tail int, follow bool, emit func([]string)) error {
	var info inspectResp
	if err := c.get(ctx, "/containers/"+url.PathEscape(container)+"/json", &info); err != nil {
		return err
	}
	q := url.Values{"stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"}, "tail": {strconv.Itoa(tail)}}
	if follow {
		q.Set("follow", "1")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+url.PathEscape(container)+"/logs?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	// the log stream is long-lived: no client timeout here, ctx ends it
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker logs: %s", resp.Status)
	}

	lines := make(chan string, 256)
	go func() {
		defer close(lines)
		var r io.Reader = resp.Body
		if !info.Config.Tty {
			r = demux(resp.Body)
		}
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if len(line) > maxLine {
				line = line[:maxLine] + "…"
			}
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
	}()

	batch := make([]string, 0, 100)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	flush := func() {
		if len(batch) > 0 {
			emit(batch)
			batch = make([]string, 0, 100)
		}
	}
	for {
		select {
		case <-ctx.Done():
			flush()
			return nil
		case line, ok := <-lines:
			if !ok {
				flush()
				return nil
			}
			batch = append(batch, strings.TrimRight(line, "\r"))
			if len(batch) >= 100 {
				flush()
			}
		case <-tick.C:
			flush()
		}
	}
}

// demux strips Docker's 8-byte frame headers from a non-TTY log stream.
func demux(r io.Reader) io.Reader {
	pr, pw := io.Pipe()
	go func() {
		hdr := make([]byte, 8)
		for {
			if _, err := io.ReadFull(r, hdr); err != nil {
				pw.CloseWithError(err)
				return
			}
			size := int64(binary.BigEndian.Uint32(hdr[4:]))
			if _, err := io.CopyN(pw, r, size); err != nil {
				pw.CloseWithError(err)
				return
			}
		}
	}()
	return pr
}
