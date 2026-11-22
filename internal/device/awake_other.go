//go:build !darwin && !linux && !windows

package device

import (
	"context"
	"errors"
)

func PreventIdleSleep(_ context.Context) (func(), error) { return nil, errors.ErrUnsupported }
