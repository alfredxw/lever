package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

type NotificationTarget struct {
	ChatID  string `json:"chatId"`
	TopicID string `json:"topicId,omitempty"`
	RunID   string `json:"runId"`
}

// Notifications delivers Agent notifications and holds a click until the page
// can navigate, including a click that launched the app on macOS.
type Notifications struct {
	mu      sync.Mutex
	clicked *NotificationTarget
}

var agentNotificationClicked = mygo.NewEvent[struct{}]("lever:agent-notification-clicked")

const agentNotificationPrefix = "lever-agent/"

func (*Notifications) Supported() bool { return mygo.NotificationsSupported() }

func (*Notifications) Show(ctx context.Context, id string, target NotificationTarget, title, agent string) error {
	window := mygo.CallerWindow(ctx)
	if window == nil || (window.IsFocused() && mygo.App.IsActive()) || !mygo.NotificationsSupported() {
		return nil
	}
	// Keep the destination in the ID so clicks can survive a desktop restart.
	notificationID := agentNotificationPrefix + strings.Join([]string{target.ChatID, target.TopicID, target.RunID, id}, "/")
	notification := mygo.NewNotification(mygo.NotificationOptions{
		ID:    notificationID,
		Title: title,
		Body:  agent,
	})
	err := notification.ShowContext(ctx)
	if errors.Is(err, mygo.ErrNotificationsDenied) {
		return nil
	}
	if err != nil && ctx.Err() == nil {
		slog.Warn("show Agent notification", "error", err)
	}
	return err
}

func (n *Notifications) TakeClick() *NotificationTarget {
	n.mu.Lock()
	defer n.mu.Unlock()
	target := n.clicked
	n.clicked = nil
	return target
}

func (n *Notifications) open(id string) {
	value, ok := strings.CutPrefix(id, agentNotificationPrefix)
	if !ok {
		return
	}
	parts := strings.Split(value, "/")
	if len(parts) != 4 || parts[0] == "" || parts[2] == "" || parts[3] == "" {
		return
	}
	n.mu.Lock()
	n.clicked = &NotificationTarget{ChatID: parts[0], TopicID: parts[1], RunID: parts[2]}
	n.mu.Unlock()

	mygo.NewNotification(mygo.NotificationOptions{ID: id}).Close()
	if windows := mygo.Windows(); len(windows) > 0 {
		window := windows[0]
		if window.IsMinimized() {
			window.Restore()
		}
		window.Focus()
		_ = agentNotificationClicked.Emit(window, struct{}{})
	}
}
