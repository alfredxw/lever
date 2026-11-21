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
	mux.HandleFunc("POST /api/runs/{id}/channel-reply/retry", func(w http.ResponseWriter, r *http.Request) {
		respond(w, map[string]bool{"queued": true}, a.RetryChannelReply(r.Context(), r.PathValue("id")))
	})
}
