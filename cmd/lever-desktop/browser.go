package main

import (
	"context"
	_ "embed"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"lever/internal/model"
)

//go:embed browser_picker.js
var browserPicker string

type Browser struct {
	shell *mygo.WebView
	tabs  map[string]*browserTab
	frame *DesktopFrame
}

type DesktopFrame struct {
	Height float32 `json:"height"`
	Left   float32 `json:"left"`
	Right  float32 `json:"right"`
}

type BrowserViewport struct {
	X      int     `json:"x"`
	Y      int     `json:"y"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scale  float64 `json:"scale,omitempty"`
}

type BrowserState struct {
	ID         string  `json:"id"`
	URL        string  `json:"url"`
	Title      string  `json:"title"`
	Error      string  `json:"error"`
	Back       bool    `json:"back"`
	Forward    bool    `json:"forward"`
	Loading    bool    `json:"loading"`
	Zoom       float64 `json:"zoom"`
	Appearance string  `json:"appearance,omitempty"`
}

type browserTab struct {
	agent      string
	view       *mygo.WebView
	profile    *mygo.Session
	detached   *mygo.Window
	viewport   BrowserViewport
	state      BrowserState
	nativePage uintptr
}

var browserChanged = mygo.NewEvent[BrowserState]("lever:browser-changed")
var browserPressed = mygo.NewEvent[string]("lever:browser-pressed")
var frameChanged = mygo.NewEvent[DesktopFrame]("lever:desktop-frame")

func (b *Browser) paint(ctx *ui.Context) {
	if b.shell == nil {
		return
	}
	titleBar := ctx.TitleBar()
	frame := DesktopFrame{Height: titleBar.Height, Left: titleBar.Left, Right: titleBar.Right}
	if b.frame == nil || *b.frame != frame {
		b.frame = &frame
		_ = frameChanged.EmitPage(b.shell.Page(), frame)
	}
	ui.Box(ctx).Fill().Children(func() {
		guestPressed := ui.WebView(ctx, b.shell).Fill().PressedOutside()
		// A stable paint order keeps sibling WebViews attached while both panes are visible.
		for _, id := range slices.Sorted(maps.Keys(b.tabs)) {
			tab := b.tabs[id]
			box := tab.viewport
			if box.Width <= 0 || box.Height <= 0 {
				continue
			}
			element := ui.WebView(ctx.Key(id), tab.view).Absolute().Left(float32(box.X)).Top(float32(box.Y)).Size(float32(box.Width), float32(box.Height))
			if _, _, over := element.PointerPosition(); guestPressed && over {
				_ = browserPressed.EmitPage(b.shell.Page(), id)
			}
		}
	})
}

func (b *Browser) reset() {
	b.frame = nil
	for _, tab := range b.tabs {
		tab.close()
	}
	clear(b.tabs)
	if b.shell != nil && !b.shell.IsDestroyed() {
		b.shell.Window().Invalidate()
	}
}

func (tab *browserTab) close() {
	if tab.detached != nil {
		tab.detached.Destroy()
	}
	tab.view.Destroy()
}

func browserURL(raw string) (*url.URL, error) {
	value, err := url.Parse(raw)
	if err != nil || len(raw) > 8192 || value.Hostname() == "" || value.User != nil || (value.Scheme != "http" && value.Scheme != "https") {
		return nil, errors.New("expected an HTTP or HTTPS address without credentials")
	}
	return value, nil
}

func allowBrowserNavigation(page *mygo.Page) {
	page.OnWillNavigate(func(event *mygo.NavigateEvent) {
		if _, err := browserURL(event.URL); err != nil {
			event.PreventDefault()
		}
	})
	page.SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions {
		if _, err := browserURL(request.URL); err == nil && request.UserInitiated {
			_ = page.LoadURL(request.URL)
		}
		return nil
	})
}

func (b *Browser) publish(tab *browserTab) {
	if b.tabs[tab.state.ID] != tab {
		return
	}
	page := tab.view.Page()
	tab.state.Back, tab.state.Forward = page.CanGoBack(), page.CanGoForward()
	_ = browserChanged.EmitPage(b.shell.Page(), tab.state)
}

func (b *Browser) Open(agent, id, raw string) (state BrowserState, err error) {
	if agent == "" || len(agent) > 160 || !strings.HasPrefix(id, "browser:") || len(id) > 200 {
		return state, errors.New("invalid browser tab")
	}
	if raw != "" {
		if _, err := browserURL(raw); err != nil {
			return state, err
		}
	}
	mygo.RunOnMain(func() {
		if b.shell == nil || b.shell.IsDestroyed() {
			err = errors.New("browser workbench closed")
			return
		}
		if tab := b.tabs[id]; tab != nil {
			if tab.agent != agent {
				err = errors.New("browser tab belongs to a different Agent")
			}
			state = tab.state
			return
		}
		profile := mygo.NewSession("lever-browser:" + agent)
		opts := mygo.PageOptions{Untrusted: true, DevTools: mygo.DevToolsEnabled, Session: profile, SwipeNavigation: true}
		window := b.shell.Window()
		before := nativeBrowserPages(window)
		var view *mygo.WebView
		view, err = window.NewWebView(mygo.WebViewOptions{Page: opts})
		if err != nil {
			return
		}
		tab := &browserTab{agent: agent, view: view, profile: profile, state: BrowserState{ID: id, URL: raw, Zoom: 1}}
		if browserAppearanceAvailable {
			fresh := slices.DeleteFunc(nativeBrowserPages(window), func(handle uintptr) bool { return slices.Contains(before, handle) })
			if len(fresh) == 1 {
				tab.nativePage, tab.state.Appearance = fresh[0], "system"
			}
		}
		b.tabs[id] = tab
		page := view.Page()
		allowBrowserNavigation(page)
		page.OnDidNavigate(func(address string) {
			tab.state.URL, tab.state.Title, tab.state.Error, tab.state.Loading = address, "", "", true
			b.publish(tab)
		})
		page.OnPageTitleUpdated(func(event *mygo.TitleEvent) {
			event.PreventDefault()
			tab.state.Title = clippedText(event.Title, 180)
			b.publish(tab)
		})
		page.OnDidFinishLoad(func() {
			tab.state.Loading = false
			b.publish(tab)
		})
		page.OnDidFailLoad(func(failure *mygo.LoadError) {
			tab.state.Loading = false
			if failure.Code != -999 && failure.Description != "" {
				if _, err := browserURL(failure.URL); err == nil {
					tab.state.URL, tab.state.Title = failure.URL, ""
				}
				tab.state.Error = clippedText(failure.Description, 300)
			}
			b.publish(tab)
		})
		page.OnRenderProcessGone(func(reason string) {
			tab.state.Error, tab.state.Loading = reason, false
			b.publish(tab)
		})
		if raw != "" {
			tab.state.Loading = true
			err = page.LoadURL(raw)
			if err != nil {
				delete(b.tabs, id)
				tab.close()
				return
			}
		}
		state = tab.state
	})
	return
}

func clippedText(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func (b *Browser) Close(id string) {
	mygo.RunOnMain(func() {
		if tab := b.tabs[id]; tab != nil {
			delete(b.tabs, id)
			tab.close()
			b.shell.Window().Invalidate()
		}
	})
}

func (b *Browser) Place(id string, box BrowserViewport) {
	mygo.RunOnMain(func() {
		if tab := b.tabs[id]; tab != nil && tab.viewport != box {
			tab.viewport = box
			if box.Width > 0 && box.Height > 0 {
				tab.applyZoom()
			}
			b.shell.Window().Invalidate()
		}
	})
}

func (tab *browserTab) applyZoom() {
	scale := tab.viewport.Scale
	if scale <= 0 || scale > 1 || math.IsNaN(scale) {
		scale = 1
	}
	page := tab.view.Page()
	if zoom := scale * tab.state.Zoom; math.Abs(page.ZoomFactor()-zoom) > 0.001 {
		page.SetZoomFactor(zoom)
	}
}

func (b *Browser) tab(id string) (tab *browserTab, err error) {
	mygo.RunOnMain(func() { tab = b.tabs[id] })
	if tab == nil {
		err = errors.New("browser tab closed")
	}
	return
}

func (b *Browser) Command(id, action, value string) (err error) {
	tab, err := b.tab(id)
	if err != nil {
		return err
	}
	page := tab.view.Page()
	switch action {
	case "clearCookies":
		return tab.profile.ClearData(mygo.SiteDataCookies)
	case "clearCache":
		return tab.profile.ClearData(mygo.SiteDataCaches)
	}
	mygo.RunOnMain(func() {
		if b.tabs[id] != tab {
			err = errors.New("browser tab closed")
			return
		}
		switch action {
		case "navigate":
			if _, err = browserURL(value); err == nil {
				tab.state.URL, tab.state.Title, tab.state.Error = value, "", ""
				tab.state.Loading = true
				err = page.LoadURL(value)
			}
		case "back":
			page.GoBack()
		case "forward":
			page.GoForward()
		case "reload", "hardReload":
			if tab.state.Error != "" {
				err = page.LoadURL(tab.state.URL)
			} else if action == "hardReload" {
				page.ReloadIgnoringCache()
			} else {
				page.Reload()
			}
			tab.state.Loading, tab.state.Error = true, ""
		case "stop":
			page.Stop()
			tab.state.Loading = false
		case "inspect":
			page.OpenDevTools()
		case "appearance":
			if value != "system" && value != "dark" && value != "light" {
				err = errors.New("invalid appearance")
			} else if err = setBrowserAppearance(tab.nativePage, value); err == nil {
				tab.state.Appearance = value
			}
		case "zoom":
			var zoom float64
			zoom, err = strconv.ParseFloat(value, 64)
			if err == nil && !math.IsNaN(zoom) && zoom >= 0.5 && zoom <= 3 {
				tab.state.Zoom = zoom
				tab.applyZoom()
			} else {
				err = errors.New("invalid zoom")
			}
		case "window":
			if tab.detached != nil {
				tab.detached.Focus()
				return
			}
			if _, err = browserURL(tab.state.URL); err != nil {
				return
			}
			win := mygo.NewWindow(mygo.WindowOptions{
				Title: tab.state.Title, Width: 960, Height: 700,
				Page: mygo.PageOptions{Untrusted: true, Session: tab.profile, DevTools: mygo.DevToolsEnabled, ZoomFactor: tab.state.Zoom},
			})
			tab.detached = win
			win.OnClosed(func() { tab.detached = nil })
			allowBrowserNavigation(win.Page())
			err = win.Page().LoadURL(tab.state.URL)
			if err != nil {
				win.Destroy()
			}
		default:
			err = fmt.Errorf("unknown browser action %q", action)
		}
		b.publish(tab)
	})
	return err
}

func (b *Browser) Screenshot(id string) (string, error) {
	tab, err := b.tab(id)
	if err != nil {
		return "", err
	}
	data, err := tab.view.CapturePage()
	if err != nil {
		return "", err
	}
	if len(data) == 0 || len(data) > 20<<20 {
		return "", errors.New("screenshot unavailable or larger than 20 MiB")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func (b *Browser) Pick(ctx context.Context, id string) (*model.BrowserElement, error) {
	tab, err := b.tab(id)
	if err != nil {
		return nil, err
	}
	page := tab.view.Page()
	tab.view.Focus()
	result, err := page.EvalContext(ctx, browserPicker)
	if err != nil || result == nil {
		return nil, err
	}
	fields, ok := result.(map[string]any)
	if !ok {
		return nil, errors.New("invalid element")
	}
	address, err := browserURL(page.URL())
	if err != nil {
		return nil, err
	}
	address.RawQuery, address.Fragment, address.ForceQuery = "", "", false
	var selected model.BrowserElement
	for key, target := range map[string]*string{"tag": &selected.Tag, "text": &selected.Text, "selector": &selected.Selector} {
		value, ok := fields[key].(string)
		if !ok || len(value) > 4096 {
			return nil, errors.New("invalid element description")
		}
		*target = value
	}
	if selected.Tag == "" || selected.Selector == "" {
		return nil, errors.New("missing element description")
	}
	if slices.Contains([]string{"input", "textarea", "select"}, selected.Tag) {
		selected.Text = ""
	}
	selected.URL = address.String()
	return &selected, nil
}

func (b *Browser) CancelPick(id string) {
	if tab, err := b.tab(id); err == nil {
		_, _ = tab.view.Page().Eval(`window.dispatchEvent(new Event("lever:cancel-element-pick"))`)
	}
}
