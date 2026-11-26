package httpapi

import (
	"net/http"

	"lever/internal/model"
)

func (s *Server) channelRoutes(mux *http.ServeMux) {
	a := s.App
	mux.HandleFunc("GET /api/plugins/{id}/channel", func(w http.ResponseWriter, r *http.Request) {
		view, err := a.PersonalChannel(r.Context(), r.PathValue("id"))
		respond(w, view, err)
	})
	mux.HandleFunc("PUT /api/plugins/{id}/channel", func(w http.ResponseWriter, r *http.Request) {
		var settings model.PersonalChannelSettings
		err := read(w, r, &settings)
		if err == nil {
			err = a.ConfigurePersonal(r.Context(), r.PathValue("id"), settings)
		}
		respond(w, map[string]bool{"saved": err == nil}, err)
	})
	mux.HandleFunc("POST /api/plugins/{id}/channel/{action}", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Region string `json:"region"`
		}
		err := read(w, r, &input)
		if err == nil {
			err = a.PersonalAction(r.Context(), r.PathValue("id"), r.PathValue("action"), input.Region)
		}
		respond(w, map[string]bool{"updated": err == nil}, err)
	})
	mux.HandleFunc("GET /api/channels/feishu", func(w http.ResponseWriter, r *http.Request) {
		respond(w, a.FeishuChannel(), nil)
	})
	mux.HandleFunc("POST /api/channels/feishu/registration", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.RegisterFeishu()
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/channels/feishu/registration", func(w http.ResponseWriter, r *http.Request) {
		respond(w, a.CancelFeishuRegistration(), nil)
	})
	mux.HandleFunc("PUT /api/channels/feishu/bot", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			AppID     string `json:"appId"`
			AppSecret string `json:"appSecret"`
			Brand     string `json:"brand"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.ConfigureFeishu(r.Context(), in.AppID, in.AppSecret, in.Brand)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/pair", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.PairFeishu()
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/reconnect", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ReconnectFeishu()
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/binding", func(w http.ResponseWriter, r *http.Request) {
		var in model.ChannelPairInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.ConfirmFeishuPair(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/channels/feishu/binding", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.UnbindFeishu(r.Context())
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/channels/feishu/agent", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			AgentID string `json:"agentId"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SetFeishuAgent(r.Context(), in.AgentID)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/channels/feishu/pause", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Paused bool `json:"paused"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.PauseFeishu(r.Context(), in.Paused)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/test", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"sent": true}, a.TestFeishu(r.Context()))
	})
	// Multi-bot Feishu routes
	mux.HandleFunc("POST /api/channels/feishu/bots", func(w http.ResponseWriter, r *http.Request) {
		var in model.FeishuBotCreateInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.CreateFeishuBot(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/bots/registration", func(w http.ResponseWriter, r *http.Request) {
		var in model.FeishuRegistrationInput
		if r.ContentLength != 0 {
			if err := read(w, r, &in); err != nil {
				respond(w, nil, err)
				return
			}
		}
		v, err := a.RegisterFeishuBot(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/channels/feishu/bots/registration", func(w http.ResponseWriter, r *http.Request) {
		var in model.FeishuRegistrationInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.UpdateFeishuRegistrationDraft(r.Context(), in)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/channels/feishu/bots/{id}/settings", func(w http.ResponseWriter, r *http.Request) {
		var in model.FeishuBotSettings
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.UpdateFeishuBotSettings(r.Context(), r.PathValue("id"), in)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/channels/feishu/bots/{id}/credentials", func(w http.ResponseWriter, r *http.Request) {
		var in model.FeishuBotCredentialsInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.UpdateFeishuBotCredentials(r.Context(), r.PathValue("id"), in)
		respond(w, v, err)
	})
	mux.HandleFunc("PUT /api/channels/feishu/bots/{id}/enabled", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Enabled bool `json:"enabled"`
		}
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.SetFeishuBotEnabled(r.Context(), r.PathValue("id"), in.Enabled)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/channels/feishu/bots/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.DeleteFeishuBot(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/bots/{id}/reconnect", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.ReconnectFeishuBot(r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/bots/{id}/test", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"sent": true}, a.TestFeishuBot(r.Context(), r.PathValue("id")))
	})
	mux.HandleFunc("POST /api/channels/feishu/bots/{id}/pair", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.PairFeishuBot(r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/bots/{id}/binding", func(w http.ResponseWriter, r *http.Request) {
		var in model.ChannelPairInput
		if err := read(w, r, &in); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := a.ConfirmFeishuBotPair(r.Context(), r.PathValue("id"), in)
		respond(w, v, err)
	})
	mux.HandleFunc("DELETE /api/channels/feishu/bots/{id}/binding", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.UnbindFeishuBotDM(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("GET /api/channels/feishu/bots/{id}/chats", func(w http.ResponseWriter, r *http.Request) {
		chats, err := a.ListFeishuBotChats(r.Context(), r.PathValue("id"))
		respond(w, chats, err)
	})
	mux.HandleFunc("POST /api/channels/feishu/bots/{id}/check-scopes", func(w http.ResponseWriter, r *http.Request) {
		v, err := a.CheckFeishuBotScopes(r.Context(), r.PathValue("id"))
		respond(w, v, err)
	})
	mux.HandleFunc("POST /api/runs/{id}/channel-reply/retry", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"queued": true}, a.RetryChannelReply(r.Context(), r.PathValue("id")))
	})
}
