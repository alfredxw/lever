package imapmail

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-imap/v2/imapserver/imapmemserver"
)

func TestNewEmailUsesUIDCursorAndReadOnlyFetch(t *testing.T) {
	mem := imapmemserver.New()
	user := imapmemserver.NewUser("fixture", "fixture-password")
	mem.AddUser(user)
	if err := user.Create("INBOX", nil); err != nil {
		t.Fatal(err)
	}
	appendEmail := func(subject string) {
		t.Helper()
		text := "From: Alice <alice@example.invalid>\r\nTo: Bob <bob@example.invalid>\r\nSubject: " + subject + "\r\n\r\nFixture body"
		if _, err := user.Append("INBOX", strings.NewReader(text), &imap.AppendOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	appendEmail("Already in mailbox")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := imapserver.New(&imapserver.Options{
		InsecureAuth: true, NewSession: func(*imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
			return mem.NewSession(), nil, nil
		},
	})
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	read := func(cursor string, limit int) (string, []mailEvent, bool) {
		t.Helper()
		client, err := imapclient.DialInsecure(listener.Addr().String(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		if err := client.Login("fixture", "fixture-password").Wait(); err != nil {
			t.Fatal(err)
		}
		mailbox, err := client.Select("INBOX", &imap.SelectOptions{ReadOnly: true}).Wait()
		if err != nil {
			t.Fatal(err)
		}
		batch, err := readNewMail(client, "INBOX", mailbox, cursor, limit)
		if err != nil {
			t.Fatal(err)
		}
		data, err := client.Status("INBOX", &imap.StatusOptions{NumUnseen: true}).Wait()
		if err != nil || data.NumUnseen == nil || *data.NumUnseen != mailbox.NumMessages {
			t.Fatalf("reading event changed mail flags: %+v, %v", data, err)
		}
		var events []mailEvent
		for _, item := range batch.Events {
			var event mailEvent
			if err := json.Unmarshal(item.Payload, &event); err != nil {
				t.Fatal(err)
			}
			events = append(events, event)
		}
		return batch.Cursor, events, batch.More
	}
	cursor, events, _ := read("", 1)
	if cursor == "" || len(events) != 0 {
		t.Fatal("initial connection replayed the inbox")
	}
	appendEmail("One")
	appendEmail("Two")
	cursor, events, more := read(cursor, 1)
	if len(events) != 1 || events[0].Subject != "One" || !more || len(events[0].From) != 1 || events[0].From[0] != "alice@example.invalid" {
		t.Fatalf("wrong first batch: %+v", events)
	}
	cursor, events, more = read(cursor, 1)
	if len(events) != 1 || events[0].Subject != "Two" || more {
		t.Fatalf("wrong second batch: %+v", events)
	}
	if _, events, _ := read(cursor, 1); len(events) != 0 {
		t.Fatal("a repeated poll re-read a delivered email")
	}
}
