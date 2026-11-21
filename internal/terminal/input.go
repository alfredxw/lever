package terminal

type terminalInput struct {
	viewer *Viewer
	size   Size
	data   []byte
}

func (s *Session) queue(v *Viewer, input terminalInput) bool {
	input.viewer = v
	select {
	case <-s.Closing:
		return false
	case s.input <- input:
		return true
	default:
		// Do not silently drop input or accumulate unbounded paste data.
		return false
	}
}

func (s *Session) Input(v *Viewer, data []byte) bool { return s.queue(v, terminalInput{data: data}) }

func (s *Session) ResizeFor(v *Viewer, cols, rows int) bool {
	return s.queue(v, terminalInput{size: Size{cols, rows}})
}

func (s *Session) writeInput() {
	for {
		select {
		case <-s.Closing:
			return
		case <-s.done:
			return
		case input := <-s.input:
			s.mu.Lock()
			current := s.viewer == input.viewer
			s.mu.Unlock()
			if !current {
				continue
			}
			if input.size.Cols != 0 {
				s.record(nil, input.size)
			} else {
				_, _ = s.Pty.Write(input.data)
			}
		}
	}
}
