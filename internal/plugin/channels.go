package plugin

import (
	"context"
	"errors"
)

// ChannelDeliveryUnknown means a POST may have reached the platform. The
// host must keep its receipt for review instead of sending a second reply.
var ChannelDeliveryUnknown = errors.New("channel delivery was not confirmed")

type ChannelMention struct {
	Key    string
	Name   string
	OpenID string
}

type ChannelMessage struct {
	ID, ChatID, UserID, Tenant, Text string
	ChatType                         string // "p2p" | "group"
	SenderType                       string // "user" | "app"
	RootID                           string
	ParentID                         string
	ThreadID                         string
	Mentions                         []ChannelMention
}

type ChannelSendOptions struct {
	MessageID     string
	ChatID        string
	OpenID        string // When set, sends directly to this user (dm_first / admin test).
	DeliveryID    string
	Text          string
	ReplyInThread bool
	Card          bool
}

// ChannelAdapter transports channel messages. Lever owns their identity,
// admission to a Chat, and the lifetime of the connection.
type ChannelAdapter interface {
	Listen(context.Context, func(string), func(context.Context, ChannelMessage) error) error
	Reply(ctx context.Context, messageID, deliveryID, text string) error
	Send(ctx context.Context, chatID, deliveryID, text string) error
}
