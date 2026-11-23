//go:build browser_native

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"lever/internal/model"
)

type BrowserProbe struct{}

var workbenchBrowser = &Browser{tabs: make(map[string]*browserTab)}

func (*BrowserProbe) Echo() string { return "shell only" }

func TestMain(tests *testing.M) {
	mygo.App.SetName("Lever Browser Test")
	mygo.Bind(&BrowserProbe{}, &Appearance{}, &Dialogs{}, &Notifications{}, workbenchBrowser)
	mygo.App.OnWindowAllClosed(func() {})
	code := 1
	mygo.App.WhenReady(func() {
		go func() {
			code = tests.Run()
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(code)
}

func TestSystemBrowserOpensOriginalHTML(t *testing.T) {
	if os.Getenv("LEVER_TEST_SYSTEM_BROWSER") != "1" {
		t.Skip("set LEVER_TEST_SYSTEM_BROWSER=1 to open a fixture in the system browser")
	}
	loaded := make(chan string, 1)
	receipt := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/loaded" {
			http.NotFound(w, req)
			return
		}
		select {
		case loaded <- req.URL.Query().Get("href"):
		default:
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<title>Lever HTML check complete</title><script>window.close()</script>`)
	}))
	defer receipt.Close()
	path := filepath.Join(t.TempDir(), "报告 #100%.htm")
	html := fmt.Sprintf(`<script>location.replace(%q + encodeURIComponent(location.href))</script>`, receipt.URL+"/loaded?href=")
	if err := os.WriteFile(path, []byte(html), 0600); err != nil {
		t.Fatal(err)
	}
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	const fragment = "#part%202"
	expected, err := htmlFileURL(path, fragment)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&Dialogs{}).OpenPreviewInBrowser(path, fragment); err != nil {
		t.Fatal(err)
	}
	select {
	case href := <-loaded:
		if href != expected {
			t.Fatalf("browser loaded %q, want %q", href, expected)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("system browser did not load the original HTML")
	}
}

func TestNativeBrowserWorkbench(t *testing.T) {
	path := os.Getenv("LEVER_TEST_CONTEXT")
	if path == "" {
		t.Skip("start web/tests/server.mjs with LEVER_TEST_CONTEXT")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ URL, Scope string }
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	start, err := url.Parse(fixture.URL)
	if err != nil {
		t.Fatal(err)
	}
	origin := start.Scheme + "://" + start.Host
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Checkout fixture</title><style>body{margin:0}button{width:140px;height:70px}</style><button id="checkout">Checkout</button>`)
	}))
	defer site.Close()
	options := mygo.WindowOptions{Title: "Browser workbench fixture", Width: 1320, Height: 820, Content: ui.View(workbenchBrowser.paint)}
	if runtime.GOOS == "darwin" {
		options.TitleBarStyle, options.TitleBarHeight = mygo.TitleBarHidden, 48
		options.TrafficLightPosition = &mygo.Point{X: 12, Y: 17}
	}
	win := mygo.NewWindow(options)
	defer win.Destroy()
	mygo.RunOnMain(func() { err = workbenchBrowser.attach(win, origin, fixture.URL) })
	if err != nil {
		t.Fatal(err)
	}
	win.Show()
	win.Focus()
	shell := workbenchBrowser.shell.Page()
	wait := func(label string, check func() bool) {
		t.Helper()
		end := time.Now().Add(15 * time.Second)
		for time.Now().Before(end) {
			if check() {
				return
			}
			time.Sleep(40 * time.Millisecond)
		}
		body, _ := mygo.EvalAs[string](shell, "document.body.innerText.slice(-800)")
		layout, _ := shell.Eval(`({
			hidden:document.hidden,
			surface:document.querySelector('.tab-panel[data-visible=true] .browser-surface')?.getBoundingClientRect().toJSON(),
			overlays:[...document.querySelectorAll('[role=menu],[role=listbox],[role=dialog],[data-sonner-toast]')].map(el=>[el.getAttribute('role')||el.tagName,el.getAttribute('data-state')]),
			terminalRows:[...document.querySelectorAll('.tab-panel[data-visible=true] .xterm-rows > div')].slice(0,8).map(row=>row.textContent),
		})`)
		var pages []*mygo.Page
		mygo.RunOnMain(func() {
			for _, tab := range workbenchBrowser.tabs {
				t.Logf("native guest: %+v, %+v", tab.state, tab.viewport)
				pages = append(pages, tab.view.Page())
			}
		})
		for _, p := range pages {
			size, _ := p.Eval(`({inner:innerWidth,layout:document.documentElement.clientWidth,hidden:document.hidden})`)
			t.Logf("guest layout: %v, zoom %f", size, p.ZoomFactor())
		}
		t.Fatalf("%s: %s; layout %v", label, body, layout)
	}
	check := func(js string) bool { ok, _ := mygo.EvalAs[bool](shell, js); return ok }
	eval := func(js string) {
		t.Helper()
		if _, err := shell.Eval(js); err != nil {
			t.Fatal(err)
		}
	}
	wait("pairing", func() bool { return check(`fetch('/api/overview').then(r=>r.ok)`) })
	scope, _ := json.Marshal(fixture.Scope)
	agent, err := mygo.EvalAs[model.Agent](shell, `fetch('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Web review',profile:{provider:'codex',permission:'ask',roots:[{path:`+string(scope)+`}],skills:[],delegations:[]}})}).then(r=>r.json())`)
	if err != nil || agent.ID == "" {
		t.Fatalf("create agent %q: %v", agent.ID, err)
	}
	eval(fmt.Sprintf(`window.beforeFixtureReload=true;localStorage.setItem("lever:agent",%q);localStorage.setItem("lever:language","en-US");return true`, agent.ID))
	shell.Reload()
	wait("new workbench document", func() bool { return check("!window.beforeFixtureReload && document.readyState === 'complete'") })
	// WebKit suspends CSS animations when a native test window is occluded.
	eval(`const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(style);return true`)
	control := func(label string) string {
		return fmt.Sprintf(`[...document.querySelectorAll('button')].find(el=>el.offsetWidth && el.getAttribute('aria-label')===%q)`, label)
	}
	wait("Agents navigation", func() bool { return check("Boolean(" + control("Agents") + ")") })
	eval(control("Agents") + ".click()")
	wait("browser entry", func() bool { return check("Boolean(" + control("Browser") + ")") })
	if runtime.GOOS == "darwin" {
		wait("workbench received native window controls inset", func() bool {
			return check(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mygo-titlebar-inset-left')) > 0`)
		})
	}
	eval(control("Browser") + ".click()")
	wait("address bar", func() bool { return check(`Boolean(document.querySelector('.browser-address'))`) })
	eval(fmt.Sprintf(`const input=document.querySelector('.browser-address');input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,%q);input.dispatchEvent(new Event('input',{bubbles:true}));return true`, site.URL))
	eval(`document.querySelector('.browser-toolbar').requestSubmit()`)
	var guest *browserTab
	wait("visible native guest with page title", func() bool {
		mygo.RunOnMain(func() {
			for _, tab := range workbenchBrowser.tabs {
				if tab.state.Title == "Checkout fixture" && tab.viewport.Width > 0 {
					guest = tab
				}
			}
		})
		return guest != nil && check(`document.querySelector('.workspace-tab.selected [role=tab]')?.textContent.includes('Checkout fixture')`)
	})
	openMenu := func() {
		t.Helper()
		eval(control("Browser menu") + `.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`)
		wait("menu above native guest", func() bool {
			var width int
			mygo.RunOnMain(func() { width = guest.viewport.Width })
			return width == 0 && check(`Boolean(document.querySelector('[role=menu]'))`)
		})
	}
	openMenu()
	wait("webpage remains visible behind the menu", func() bool {
		return check(`document.querySelector('.browser-surface img')?.naturalWidth > 0`)
	})
	eval(`[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent==='Show device toolbar').click()`)
	wait("device preset applied to page layout", func() bool {
		var viewport BrowserViewport
		mygo.RunOnMain(func() { viewport = guest.viewport })
		if viewport.Scale <= 0 || !check(`Boolean(document.querySelector('.browser-device'))`) {
			return false
		}
		// MyGo presents the queued native frame when an occluded window becomes visible.
		// Its bounds and the page zoom are available while it is in the background.
		if check("document.hidden") {
			return math.Abs(float64(viewport.Width)/viewport.Scale-390) < 1 &&
				math.Abs(guest.view.Page().ZoomFactor()-viewport.Scale) < 0.001
		}
		width, _ := mygo.EvalAs[int](guest.view.Page(), "innerWidth")
		return width >= 389 && width <= 391
	})
	eval(control("Hide device toolbar") + ".click()")
	openMenu()
	eval(`document.querySelector('[role=menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`)
	wait("guest restored", func() bool { var width int; mygo.RunOnMain(func() { width = guest.viewport.Width }); return width > 0 })
	eval(control("Select an element") + ".click()")
	wait("picker armed", func() bool {
		ok, _ := mygo.EvalAs[bool](guest.view.Page(), `getComputedStyle(document.elementFromPoint(20,20)).cursor==='crosshair'`)
		return ok
	})
	if _, err := guest.view.Page().Eval(`document.elementFromPoint(20,20).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:20,clientY:20}))`); err != nil {
		t.Fatal(err)
	}
	wait("selection confirmation", func() bool { return check(`Boolean(document.querySelector('.browser-selection button'))`) })
	eval(`document.querySelector('.browser-selection button').click()`)
	wait("reference in draft", func() bool {
		return check(`[...document.querySelectorAll('[contenteditable] .inline-reference')].some(el=>el.offsetWidth && el.textContent.includes('Checkout'))`)
	})
	eval(`[...document.querySelectorAll('.workspace-tab [role=tab]')].find(el=>el.textContent==='Checkout fixture').click()`)
	wait("screenshot button and page visible", func() bool {
		var width int
		mygo.RunOnMain(func() { width = guest.viewport.Width })
		return width > 0 && check("Boolean("+control("Add screenshot to chat")+")")
	})
	eval(control("Add screenshot to chat") + ".click()")
	wait("screenshot attached in the same draft", func() bool {
		return check(`Boolean(document.querySelector('.chat-composer-wrap button[aria-label="Remove screenshot.png"]')?.offsetWidth)`)
	})
	overview, err := mygo.EvalAs[model.Overview](shell, `fetch('/api/overview').then(r=>r.json())`)
	if err != nil {
		t.Fatal(err)
	}
	for _, chat := range overview.Chats {
		if chat.AgentID == agent.ID {
			t.Fatal("adding to a draft sent a message")
		}
	}
	send := control("Send")
	wait("draft attachments are ready to send", func() bool { return check(send + `?.disabled===false`) })
	eval(send + ".click()")
	wait("sent reference accepted by backend", func() bool {
		body, _ := mygo.EvalAs[string](shell, `fetch('/api/overview').then(r=>r.json()).then(async o=>{const chat=o.chats.find(c=>c.agentId===localStorage.getItem('lever:agent'));return chat?await fetch('/api/chats/'+chat.id).then(r=>r.text()):''})`)
		return strings.Contains(body, `"selector":"#checkout"`) && strings.Contains(body, `"name":"screenshot.png"`)
	})

	// Terminal defers the initial connection by a frame. An occluded test
	// window may suspend animation frames while still rendering in WebKit.
	eval(`if (document.hidden) {
		window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
		window.cancelAnimationFrame = id => clearTimeout(id);
	} return true`)
	chatID, err := mygo.EvalAs[string](shell, fmt.Sprintf(`fetch('/api/overview').then(r=>r.json()).then(o=>o.chats.find(c=>c.agentId===%q).id)`, agent.ID))
	if err != nil || chatID == "" {
		t.Fatalf("find preview chat %q: %v", chatID, err)
	}
	newTopic := func(name string) model.Run {
		t.Helper()
		out, err := mygo.EvalAs[model.Run](shell, fmt.Sprintf(`fetch('/api/messages',{
			method:'POST',headers:{'Content-Type':'application/json'},
			body:JSON.stringify({chatId:%q,commandId:crypto.randomUUID(),operation:'topic',text:%q}),
		}).then(r=>r.json())`, chatID, name))
		if err != nil || out.SessionID == "" {
			t.Fatalf("create preview topic %q: %+v %v", name, out, err)
		}
		return out
	}
	topicA, topicB := newTopic("Terminal preview A"), newTopic("Terminal preview B")
	tab := func(id string) string {
		return fmt.Sprintf(`document.getElementById('tab-'+encodeURIComponent(%q))`, id)
	}
	panel := func(id string) string {
		return fmt.Sprintf(`document.getElementById('panel-'+encodeURIComponent(%q))`, id)
	}
	openTopic := func(run model.Run) {
		eval(tab(chatID) + ".click()")
		card := fmt.Sprintf(`[...document.querySelectorAll('.chat-panel .topic-thread[data-status="completed"]')].find(el=>el.offsetWidth && el.textContent.includes(%q))?.querySelector('.topic-open')`, run.Input)
		wait("topic card for "+run.Input, func() bool { return check("Boolean(" + card + ")") })
		eval(card + ".click()")
		wait("open "+run.Input, func() bool { return check(panel("topic:"+run.SessionID) + `?.dataset.visible==='true'`) })
	}
	openTerminal := func(run model.Run, address string) string {
		openTopic(run)
		menu := fmt.Sprintf(`document.querySelector('.tab-strip[data-pane="'+%s.dataset.pane+'"] button[aria-label="Open tab"]')`, panel("topic:"+run.SessionID))
		eval(menu + `.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`)
		entry := `[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent==='Terminal')`
		wait("terminal menu", func() bool { return check("Boolean(" + entry + ")") })
		eval(entry + ".click()")
		terminal := fmt.Sprintf(`JSON.parse(localStorage.getItem('lever:workspaces'))[%q].tabs.find(t=>t.kind==='terminal' && t.sessionId===%q)`, agent.ID, run.SessionID)
		wait("scoped terminal ready", func() bool {
			return check(terminal + `?.terminalLayout?.started===true && !!document.querySelector('.tab-panel[data-visible=true] .terminal-panel .xterm-helper-textarea:not([readonly])') && !document.querySelector('.tab-panel[data-visible=true] .terminal-status')`)
		})
		terminalID, err := mygo.EvalAs[string](shell, terminal+".id")
		if err != nil || terminalID == "" {
			t.Fatalf("terminal tab ID: %q %v", terminalID, err)
		}
		command := `printf '\033[2J\033[H%s\n' '` + address + `'`
		if runtime.GOOS == "windows" {
			command = "echo " + address
		}
		eval(fmt.Sprintf(`
			const input=%s.querySelector('.xterm-helper-textarea');
			input.focus();
			const clipboard=new DataTransfer();
			clipboard.setData('text/plain', %q);
			input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));
			const enter=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true});
			Object.defineProperty(enter,'keyCode',{value:13});
			input.dispatchEvent(enter);
			return true`, panel(terminalID), command))
		return terminalID
	}
	openPreview := func(run model.Run, terminalID, address string, verifyPlainClick bool) {
		eval(tab(terminalID) + ".click()")
		row := fmt.Sprintf(`[...%s.querySelectorAll('.xterm-rows > div')].find((row,index,rows) => {
			const text = rows.slice(index,index+3).map(line=>line.textContent.trim()).join('');
			return row.textContent.trimStart().startsWith('http') && text.startsWith(%q);
		})`, panel(terminalID), address)
		wait("printed address "+address, func() bool { return check("Boolean(" + row + ")") })
		mouse := func(types []string, modifier bool) string {
			events, _ := json.Marshal(types)
			return fmt.Sprintf(`const row=%s;
				const rect=row.getBoundingClientRect();
				for(const type of %s) row.dispatchEvent(new MouseEvent(type,{
					button:0,bubbles:true,cancelable:true,clientX:rect.left+20,clientY:rect.top+rect.height/2,
					metaKey:%t,ctrlKey:%t,
				}));
				return row.closest('.terminal-surface').title.includes('Lever Browser');`,
				row, events, modifier && runtime.GOOS == "darwin", modifier && runtime.GOOS != "darwin")
		}
		wait("preview link hover hint", func() bool { return check(mouse([]string{"mousemove"}, false)) })
		if verifyPlainClick {
			eval(mouse([]string{"mousedown", "mouseup"}, false))
			if check(fmt.Sprintf(`[...document.querySelectorAll('.browser-address')].some(input=>input.value===%q)`, address)) {
				t.Fatal("plain click opened the preview")
			}
		}
		eval(mouse([]string{"mousedown", "mouseup"}, true))
		browser := fmt.Sprintf(`[...document.querySelectorAll('.tab-panel[data-visible=true] .browser-address')].find(input=>input.value===%q)?.closest('.tab-panel')`, address)
		wait("preview opened beside the terminal", func() bool {
			return check(fmt.Sprintf(`const browser=%s; return !!browser && browser.dataset.pane!==%s.dataset.pane && %s.dataset.visible==='true'`, browser, panel(terminalID), panel(terminalID)))
		})
		capture := browser + `?.querySelector('button[aria-label="Add screenshot to chat"]')`
		wait("preview can capture the page", func() bool {
			ready := false
			mygo.RunOnMain(func() {
				for _, tab := range workbenchBrowser.tabs {
					if tab.state.URL == address && !tab.state.Loading && tab.viewport.Width > 0 {
						ready = true
					}
				}
			})
			return ready && check(capture+`?.disabled===false`)
		})
		eval(capture + ".click()")
		wait("preview screenshot in the draft of "+run.Input, func() bool {
			return check(panel("topic:"+run.SessionID) + `?.querySelector('button[aria-label="Remove screenshot.png"]')?.offsetWidth>0`)
		})
	}

	secondSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `<!doctype html><title>Second preview</title><p>Second preview</p>`)
	}))
	defer secondSite.Close()
	addressA, addressB := site.URL+"/first?mode=review#details", secondSite.URL+"/second"
	terminalA := openTerminal(topicA, addressA)
	openTopic(topicB) // A's preview should still target A even when B was visited last.
	openPreview(topicA, terminalA, addressA, true)
	terminalB := openTerminal(topicB, addressB)
	openPreview(topicB, terminalB, addressB, false)
}

func TestNativeBrowserTab(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Fixture</title><style>body{margin:0}button{width:150px;height:90px}</style><button id="submit" onclick="window.submitted=true">Submit</button><input id="draft">`)
	}))
	defer server.Close()
	browser := &Browser{tabs: make(map[string]*browserTab)}
	const id = "browser:test"
	agent := t.TempDir()
	box := BrowserViewport{X: 100, Y: 80, Width: 330, Height: 200, Scale: 1}
	var win *mygo.Window
	var err error
	// Place both views in the first native frame, including on an occluded test desktop.
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Lever Browser Test", Width: 600, Height: 400, Hidden: true, Content: ui.View(browser.paint)})
		browser.shell, err = win.NewWebView(mygo.WebViewOptions{Page: mygo.PageOptions{TrustedOrigins: []string{server.URL}}})
		if err != nil {
			return
		}
		if _, err = browser.Open(agent, id, server.URL+"/?private=secret"); err == nil {
			browser.Place(id, box)
		}
		win.Show()
	})
	defer win.Destroy()
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close(id)
	page := browser.shell.Page()
	if err := page.LoadURL(server.URL); err != nil {
		t.Fatal(err)
	}
	wait := func(label string, check func() bool) {
		t.Helper()
		end := time.Now().Add(12 * time.Second)
		for time.Now().Before(end) {
			if check() {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatal(label)
	}
	ready := func(page *mygo.Page) bool {
		title, _ := mygo.EvalAs[string](page, "document.title")
		return title == "Fixture"
	}
	wait("workbench did not load", func() bool { return ready(page) })
	echo, err := mygo.EvalAs[string](page, `mygo.call("BrowserProbe.Echo")`)
	if err != nil || echo != "shell only" {
		t.Fatalf("workbench binding: %q %v", echo, err)
	}
	if _, err := page.Eval(`document.cookie = 'workbench=1; path=/'`); err != nil {
		t.Fatal(err)
	}
	guest, _ := browser.tab(id)
	wait("guest did not load at its bounds", func() bool {
		width, _ := mygo.EvalAs[int](guest.view.Page(), "innerWidth")
		return width == box.Width && ready(guest.view.Page())
	})
	guestPage := guest.view.Page()
	denied, err := mygo.EvalAs[bool](guestPage, `mygo.call("BrowserProbe.Echo").then(()=>false,()=>true)`)
	if err != nil || !denied {
		t.Fatalf("untrusted guest binding: denied=%v %v", denied, err)
	}
	if browserAppearanceAvailable {
		for _, scheme := range []string{"dark", "light", "system"} {
			if err := browser.Command(id, "appearance", scheme); err != nil {
				t.Fatal(err)
			}
			if scheme != "system" {
				wait("page did not switch to "+scheme, func() bool {
					matches, _ := mygo.EvalAs[bool](guestPage, fmt.Sprintf("matchMedia('(prefers-color-scheme: %s)').matches", scheme))
					return matches
				})
			}
		}
	}
	cookies, err := mygo.EvalAs[string](guestPage, "document.cookie")
	if err != nil || cookies != "" {
		t.Fatalf("guest cookie jar: %q %v", cookies, err)
	}
	if _, err := guestPage.Eval(`document.querySelector('input').value='still here'; document.cookie='guest=1; path=/'; return true`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ id, agent, cookie string }{
		{"browser:sibling", agent, "guest=1"},
		{"browser:other", agent + "-other", ""},
	} {
		if _, err := browser.Open(tc.agent, tc.id, server.URL); err != nil {
			t.Fatal(err)
		}
		defer browser.Close(tc.id)
		sibling, _ := browser.tab(tc.id)
		wait("second browser document ready", func() bool { return ready(sibling.view.Page()) })
		cookie, err := mygo.EvalAs[string](sibling.view.Page(), "document.cookie")
		if err != nil || cookie != tc.cookie {
			t.Fatalf("%s cookie jar: got %q want %q: %v", tc.id, cookie, tc.cookie, err)
		}
	}
	browser.Place(id, BrowserViewport{})
	box.X = 14
	browser.Place(id, box)
	value, err := mygo.EvalAs[string](guestPage, "document.querySelector('input').value")
	if err != nil || value != "still here" {
		t.Fatalf("tab state after move: %q %v", value, err)
	}
	type selection struct {
		tag, selector, text, url string
		err                      error
	}
	result := make(chan selection, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	go func() {
		picked, err := browser.Pick(ctx, id)
		if picked == nil {
			result <- selection{err: err}
			return
		}
		result <- selection{picked.Tag, picked.Selector, picked.Text, picked.URL, err}
	}()
	wait("element picker did not appear", func() bool {
		ok, _ := mygo.EvalAs[bool](guestPage, `getComputedStyle(document.elementFromPoint(24,24)).cursor === "crosshair"`)
		return ok
	})
	if _, err := guestPage.Eval(`document.elementFromPoint(24,24).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:24,clientY:24}))`); err != nil {
		t.Fatal(err)
	}
	picked := <-result
	if picked.err != nil || picked.tag != "button" || picked.selector != "#submit" || picked.text != "Submit" || picked.url != server.URL+"/" {
		t.Fatalf("pick: %+v", picked)
	}
	submitted, _ := mygo.EvalAs[bool](guestPage, "Boolean(window.submitted)")
	if submitted {
		t.Fatal("selection activated page button")
	}
	screenshot, err := browser.Screenshot(id)
	if err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(screenshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := png.DecodeConfig(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if err := browser.Command(id, "clearCookies", ""); err != nil {
		t.Fatal(err)
	}
	wait("guest cookie jar cleared", func() bool {
		cookie, err := mygo.EvalAs[string](guestPage, "document.cookie")
		return err == nil && cookie == ""
	})
	workCookie, _ := mygo.EvalAs[string](page, "document.cookie")
	if workCookie != "workbench=1" {
		t.Fatalf("clearing profile affected workbench: %s", workCookie)
	}
}
