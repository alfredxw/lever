package larkbot

import (
	"context"
	"errors"
	"net/url"
	"strings"

	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

var (
	ErrRegistrationExpired = errors.New("bot registration expired")
	ErrRegistrationDenied  = errors.New("bot registration declined")
)

type Registration struct {
	AppID, Secret, Brand, OpenID string
}

func Register(ctx context.Context, showURL func(string)) (Registration, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	brand := Feishu
	minimal := false
	result, err := registration.RegisterApp(ctx, &registration.Options{
		Source:    "lever",
		AppPreset: &registration.AppPreset{Name: "Lever"},
		Addons: &registration.AppAddons{
			Preset: &minimal,
			Scopes: registration.AppAddonsScopes{Tenant: []string{
				"im:message.p2p_msg:readonly",
				"im:message.group_at_msg:readonly",
				"im:message:send_as_bot",
				"im:chat:readonly",
				"im:chat.members:read",
				"im:message.reactions:write_only",
				"contact:user.base:readonly",
				"contact:contact.base:readonly",
				"contact:user.id:readonly",
			}},
			Events: registration.AppAddonsEvents{Items: registration.AppAddonsEventItems{
				Tenant: []string{"im.message.receive_v1"},
			}},
		},
		OnQRCode: func(info *registration.QRCodeInfo) {
			link, err := url.Parse(info.URL)
			if err != nil || link.Scheme != "https" || link.Hostname() == "" || link.User != nil {
				cancel()
				return
			}
			showURL(info.URL)
		},
		OnStatusChange: func(info *registration.StatusChangeInfo) {
			if info.Status == registration.StatusDomainSwitched {
				brand = Lark
			}
		},
	})
	if err != nil {
		if _, ok := errors.AsType[*registration.ExpiredError](err); ok {
			return Registration{}, ErrRegistrationExpired
		}
		if _, ok := errors.AsType[*registration.AccessDeniedError](err); ok {
			return Registration{}, ErrRegistrationDenied
		}
		return Registration{}, err
	}
	openID := ""
	if result.UserInfo != nil {
		if result.UserInfo.TenantBrand == Lark {
			brand = Lark
		}
		openID = strings.TrimSpace(result.UserInfo.OpenID)
	}
	return Registration{AppID: result.ClientID, Secret: result.ClientSecret, Brand: brand, OpenID: openID}, nil
}
