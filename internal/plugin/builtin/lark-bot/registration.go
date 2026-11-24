package larkbot

import (
	"context"
	"errors"
	"net/url"

	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

var (
	ErrRegistrationExpired = errors.New("bot registration expired")
	ErrRegistrationDenied  = errors.New("bot registration declined")
)

type Registration struct {
	AppID, Secret, Brand string
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
				"im:message.reactions:write_only",
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
	if result.UserInfo != nil && result.UserInfo.TenantBrand == Lark {
		brand = Lark
	}
	return Registration{AppID: result.ClientID, Secret: result.ClientSecret, Brand: brand}, nil
}
