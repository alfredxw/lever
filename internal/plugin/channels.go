package plugin

import (
	"context"
	"errors"
)

// ChannelDeliveryUnknown means a POST may have reached the platform. The
// host must keep its receipt for review instead of sending a second reply.
var ChannelDeliveryUnknown = errors.New("channel delivery was not confirmed")

type ChannelMessage struct {
	ID, ChatID, UserID, Tenant, Text string
}

// ChannelAdapter transports direct messages. Lever owns their identity,
// admission to a Chat, and the lifetime of the connection.
type ChannelAdapter interface {
	Listen(context.Context, func(string), func(context.Context, ChannelMessage) error) error
	Reply(ctx context.Context, messageID, deliveryID, text string) error
	Send(ctx context.Context, chatID, deliveryID, text string) error
}
