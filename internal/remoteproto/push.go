package remoteproto

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
)

type PushRegistration struct {
	Token string `json:"token"`
	Key   []byte `json:"key"`
}

// The phone shares its notification key only with its own paired Hub.
// The optional delivery relay and platform receive a generic alert plus
// an opaque route which the app can open on LAN even when the Hub is down.
type PushEnvelope struct {
	Kind    string `json:"kind"`
	Tag     string `json:"tag"`
	Payload string `json:"payload"`
}

func pushCipher(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, errors.New("invalid notification key")
	}
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithRandomNonce(b)
}
func SealPush(n PushNotice, key []byte) (PushEnvelope, error) {
	box, err := pushCipher(key)
	if err != nil {
		return PushEnvelope{}, err
	}
	data, err := json.Marshal(n)
	if err != nil {
		return PushEnvelope{}, err
	}
	sealed := box.Seal(nil, nil, data, []byte("lever-push-v1"))
	return PushEnvelope{Kind: n.Kind, Tag: Digest([]byte(n.HubID + "/" + n.SpaceID + "/" + n.DeviceID + "/" + n.RunID + "/" + n.RequestID)), Payload: base64.RawURLEncoding.EncodeToString(sealed)}, nil
}
func OpenPush(payload string, key []byte) (PushNotice, error) {
	var n PushNotice
	box, err := pushCipher(key)
	if err != nil {
		return n, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return n, err
	}
	data, err := box.Open(nil, nil, raw, []byte("lever-push-v1"))
	if err != nil {
		return n, err
	}
	err = Decode(data, &n)
	return n, err
}
