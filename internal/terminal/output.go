package terminal

import (
	"bytes"
	"context"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
)

const (
	OutputFrameBytes = 16 << 10
	historyBytes     = 1 << 20
	historyFrames    = 2048
)

type Size struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

type Output struct {
	Data []byte
	Size Size // PTY geometry before Data, or a resize when Data is empty
}

type Viewer struct {
	next       int // guarded by Session.mu
	replay     int // end of history at attach
	Size       Size
	Trimmed    bool
	skipPrefix bool
}

type outputHistory struct {
	frames []Output
	first  int
	bytes  int
	size   Size
	parser *ansi.Parser // state at the beginning of the retained bytes
}

func (h *outputHistory) end() int { return h.first + len(h.frames) }

func (s *Session) attachLocked() *Viewer {
	h := &s.history
	h.align()
	v := &Viewer{
		next: h.first, replay: h.end(), Size: h.size, Trimmed: h.first != 0,
		skipPrefix: h.parser != nil && h.parser.State() != parser.GroundState,
	}
	s.viewer = v
	s.signalLocked()
	return v
}

func (s *Session) signalLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *Session) readOutput() {
	var buffer [OutputFrameBytes]byte
	for {
		n, err := s.Pty.Read(buffer[:])
		if n > 0 && !s.record(bytes.Clone(buffer[:n]), Size{}) {
			return
		}
		if err != nil {
			<-s.done
			s.closePTY()
			s.mu.Lock()
			s.exited = true
			s.signalLocked()
			s.mu.Unlock()
			return
		}
	}
}

// Retention and live delivery share one ordered stream. An attached viewer can
// apply backpressure. Without a viewer, old frames can always be discarded.
func (s *Session) record(data []byte, size Size) bool {
	for {
		s.mu.Lock()
		select {
		case <-s.Closing:
			s.mu.Unlock()
			return false
		default:
		}
		h := &s.history
		for (len(h.frames) >= historyFrames || h.bytes+len(data) > historyBytes) &&
			(s.viewer == nil || h.first < s.viewer.next) {
			h.drop()
		}
		if len(h.frames) < historyFrames && h.bytes+len(data) <= historyBytes {
			if size.Cols != 0 {
				if s.exited || size == s.size {
					s.mu.Unlock()
					return true
				}
				if err := s.Pty.Resize(size.Cols, size.Rows); err != nil {
					s.mu.Unlock()
					return false
				}
				s.size = size
			}
			h.frames = append(h.frames, Output{Data: data, Size: s.size})
			h.bytes += len(data)

			s.signalLocked()
			s.mu.Unlock()
			return true
		}
		changed := s.changed
		s.mu.Unlock()
		select {
		case <-changed:
		case <-s.Closing:
			return false
		}
	}
}

func (h *outputHistory) drop() {
	if h.parser == nil {
		h.parser = ansi.NewParser()
		h.parser.SetDataSize(1024)
	}
	h.parser.Parse(h.frames[0].Data)
	h.trimFirst(len(h.frames[0].Data))
}

func (h *outputHistory) trimFirst(n int) {
	h.bytes -= n
	frame := &h.frames[0]
	if n < len(frame.Data) {
		frame.Data = frame.Data[n:]
		return
	}
	h.size = frame.Size
	*frame = Output{}
	h.frames = h.frames[1:]
	h.first++
}

func (h *outputHistory) align() {
	for h.parser != nil && h.parser.State() != parser.GroundState && len(h.frames) > 0 {
		h.dropPrefix()
	}
}

func (h *outputHistory) dropPrefix() {
	data := h.frames[0].Data
	for i, b := range data {
		h.parser.Advance(b)
		if h.parser.State() == parser.GroundState {
			h.trimFirst(i + 1)
			return
		}
	}
	h.trimFirst(len(data))
}

// Next returns exactly one ordered frame. Ready separates replay from live
// output. A nil frame after Ready indicates the PTY has exited.
func (s *Session) Next(ctx context.Context, v *Viewer) (frame *Output, ready bool) {
	for ctx.Err() == nil {
		s.mu.Lock()
		h := &s.history
		if v.skipPrefix {
			h.align()
			v.next = h.first
			v.skipPrefix = h.parser.State() != parser.GroundState
		}
		if v.next >= v.replay && v.replay >= 0 {
			v.replay = -1
			s.mu.Unlock()
			return nil, true
		}
		if v.next < h.end() {
			frame := h.frames[v.next-h.first]
			v.next++
			s.signalLocked()
			s.mu.Unlock()
			return &frame, false
		}
		changed, exited := s.changed, s.exited
		s.mu.Unlock()
		if exited {
			break
		}
		select {
		case <-changed:
		case <-ctx.Done():
		case <-s.Closing:
			return nil, false
		}
	}
	return nil, false
}
