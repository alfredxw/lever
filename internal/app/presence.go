package app

import "time"

const desktopPresenceTTL = 45 * time.Second

// SetDesktopPresence records whether a local Desktop UI window is currently open.
func (a *App) SetDesktopPresence(active bool) {
	a.presenceMu.Lock()
	a.desktopActive = active
	if active {
		a.desktopSeenAt = time.Now()
	} else {
		a.desktopSeenAt = time.Time{}
	}
	a.presenceMu.Unlock()
}

// DesktopActive reports whether the Desktop UI is open and the host screen is unlocked.
func (a *App) DesktopActive() bool {
	a.presenceMu.Lock()
	open := a.desktopActive && !a.desktopSeenAt.IsZero() && time.Since(a.desktopSeenAt) < desktopPresenceTTL
	checkedAt := a.screenLockCheckedAt
	locked := a.screenLocked
	a.presenceMu.Unlock()
	if !open {
		return false
	}
	if time.Since(checkedAt) >= 3*time.Second {
		locked = isHostScreenLocked()
		a.presenceMu.Lock()
		a.screenLocked = locked
		a.screenLockCheckedAt = time.Now()
		a.presenceMu.Unlock()
	}
	return !locked
}
