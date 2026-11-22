package app

import "testing"

func TestAttachmentAudioMediaTypes(t *testing.T) {
	for _, tc := range []struct{ name, data, want string }{
		{"voice.wav", "RIFF\x00\x00\x00\x00WAVEfmt ", "audio/wav"},
		{"voice.ogg", "OggS\x00\x02\x00OpusHead", "audio/ogg"},
		{"film.ogv", "OggS\x00\x02\x00theora", "application/ogg"},
		{"voice.flac", "fLaC\x00\x00\x00\x22", "audio/flac"},
		{"voice.m4a", "\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00isommp42", "audio/mp4"},
		{"film.mp4", "\x00\x00\x00\x18ftypisom\x00\x00\x00\x00isommp42", "video/mp4"},
		{"voice.aac", "\xff\xf1\x50\x80\x00\x1f\xfc", "audio/aac"},
		{"voice.mp3", "\xff\xfb\x90\x00", "audio/mpeg"},
		{"not-audio.mp3", "plain text", "text/plain; charset=utf-8"},
	} {
		if got := attachmentMediaType(tc.name, []byte(tc.data)); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}
