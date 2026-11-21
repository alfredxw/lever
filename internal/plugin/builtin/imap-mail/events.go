package imapmail

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-message/charset"

	"lever/internal/plugin"
)

const PluginID = "lever.imap-mail"
const ContributionID = "new-email"

type Source struct{}

type mailEvent struct {
	Type       string   `json:"type"`
	Mailbox    string   `json:"mailbox"`
	UID        imap.UID `json:"uid"`
	ReceivedAt string   `json:"receivedAt"`
	MessageID  string   `json:"messageId,omitempty"`
	Subject    string   `json:"subject,omitempty"`
	From       []string `json:"from,omitempty"`
	To         []string `json:"to,omitempty"`
}

func (Source) Poll(ctx context.Context, config map[string]string, cursor string, limit int) (plugin.EventBatch, error) {
	server := config["server"]
	if !strings.Contains(server, ":") || (strings.HasPrefix(server, "[") && strings.HasSuffix(server, "]")) {
		server = net.JoinHostPort(strings.Trim(server, "[]"), "993")
	}
	host, port, err := net.SplitHostPort(server)
	if err != nil || host == "" || port == "" {
		return plugin.EventBatch{}, errors.New("Enter an IMAP server hostname or hostname:port")
	}
	dialer := tls.Dialer{Config: &tls.Config{MinVersion: tls.VersionTLS12}}
	conn, err := dialer.DialContext(ctx, "tcp", server)
	if err != nil {
		return plugin.EventBatch{}, fmt.Errorf("Connect to the IMAP server: %w", err)
	}
	client := imapclient.New(conn, &imapclient.Options{
		WordDecoder: &mime.WordDecoder{CharsetReader: charset.Reader},
	})
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if err := client.Login(config["username"], config["password"]).Wait(); err != nil {
		return plugin.EventBatch{}, errors.New("IMAP login failed. Check the username and password")
	}
	mailbox := config["mailbox"]
	data, err := client.Select(mailbox, &imap.SelectOptions{ReadOnly: true}).Wait()
	if err != nil {
		return plugin.EventBatch{}, errors.New("Could not open the IMAP mailbox")
	}
	if data.UIDNext == 0 || data.UIDValidity == 0 {
		return plugin.EventBatch{}, errors.New("The IMAP server did not return mailbox UID information")
	}
	return readNewMail(client, mailbox, data, cursor, limit)
}

func readNewMail(client *imapclient.Client, mailbox string, data *imap.SelectData, cursor string, limit int) (plugin.EventBatch, error) {
	var validity uint32
	var after imap.UID
	upper := data.UIDNext - 1
	batch := plugin.EventBatch{Cursor: mailCursor(data.UIDValidity, upper)}
	if _, err := fmt.Sscanf(cursor, "%d:%d", &validity, &after); err != nil || validity != data.UIDValidity {
		// Baseline a new mailbox (or a reset UID namespace) at its current tip.
		return batch, nil
	}
	if after >= upper || limit <= 0 {
		batch.Cursor = cursor
		return batch, nil
	}
	var uidRange imap.UIDSet
	uidRange.AddRange(after+1, upper)
	result, err := client.UIDSearch(&imap.SearchCriteria{UID: []imap.UIDSet{uidRange}}, nil).Wait()
	if err != nil {
		return plugin.EventBatch{}, errors.New("Could not check for new IMAP messages")
	}
	uids := result.AllUIDs()
	slices.Sort(uids)
	uids = slices.DeleteFunc(uids, func(uid imap.UID) bool { return uid <= after || uid > upper })
	if len(uids) == 0 {
		return batch, nil
	}
	if len(uids) > limit {
		uids = uids[:limit]
		batch.Cursor = mailCursor(validity, uids[len(uids)-1])
		batch.More = true
	}
	messages, err := client.Fetch(imap.UIDSetNum(uids...), &imap.FetchOptions{
		UID: true, Envelope: true, InternalDate: true,
	}).Collect()
	if err != nil {
		return plugin.EventBatch{}, errors.New("Could not read new IMAP message headers")
	}
	slices.SortFunc(messages, func(a, b *imapclient.FetchMessageBuffer) int {
		if a.UID < b.UID {
			return -1
		}
		if a.UID > b.UID {
			return 1
		}
		return 0
	})
	for _, message := range messages {
		if _, found := slices.BinarySearch(uids, message.UID); !found {
			continue
		}
		event := mailEvent{
			Type: "email.received", Mailbox: mailbox, UID: message.UID,
			ReceivedAt: message.InternalDate.UTC().Format(time.RFC3339),
		}
		if header := message.Envelope; header != nil {
			event.MessageID, event.Subject = limitMailText(header.MessageID, 200), limitMailText(header.Subject, 400)
			event.From, event.To = mailAddresses(header.From), mailAddresses(header.To)
		}
		payload, err := json.Marshal(event)
		if err != nil {
			return plugin.EventBatch{}, err
		}
		batch.Events = append(batch.Events, plugin.SourceEvent{Key: mailCursor(validity, message.UID), Payload: payload})
	}
	return batch, nil
}

func mailCursor(validity uint32, uid imap.UID) string { return fmt.Sprintf("%d:%d", validity, uid) }

func limitMailText(value string, limit int) string {
	runes := []rune(value)
	return string(runes[:min(limit, len(runes))])
}

func mailAddresses(list []imap.Address) []string {
	var result []string
	for _, entry := range list {
		if address := entry.Addr(); address != "" {
			result = append(result, limitMailText(address, 180))
			if len(result) == 4 {
				break
			}
		}
	}
	return result
}
