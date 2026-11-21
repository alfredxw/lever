package app

import (
	"context"

	"lever/internal/model"
	"lever/internal/store"
)

func (a *App) Retry(ctx context.Context, runID, commandID string) (model.Run, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	run, err := store.Get[model.Run](ctx, a.Store.DB, "SELECT data FROM runs WHERE id=?", runID)
	if err != nil {
		return model.Run{}, err
	}
	if run.Status != "failed" && run.Status != "interrupted" {
		return model.Run{}, conflict("Only failed or stopped executions can be retried")
	}
	// Use the stored input so the retry is independent of the current draft.
	input := model.SendInput{CommandID: commandID, ChatID: run.ChatID, Text: run.Input, Selection: &run.Selection, References: run.References, Quote: run.Quote}
	for _, file := range run.Attachments {
		input.AttachmentIDs = append(input.AttachmentIDs, file.ID)
	}
	return a.sendLocked(ctx, input, sendOrigin{retry: &run})
}
