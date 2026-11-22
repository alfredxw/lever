//go:build browser_native

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"lever/internal/model"
)

type nsPoint struct{ X, Y float64 }

var (
	testFinderDragOnce sync.Once
	testFinderDragInfo objc.ID
	testFinderDragPB   objc.ID
	testFinderDragWin  objc.ID
	testFinderDragLoc  nsPoint
)

func testFinderDraggingInfo(win objc.ID, loc nsPoint, path string) objc.ID {
	testFinderDragOnce.Do(func() {
		cls, err := objc.RegisterClass(
			"LeverTestFinderDraggingInfo",
			objc.GetClass("NSObject"),
			nil,
			nil,
			[]objc.MethodDef{
				{
					Cmd: objc.RegisterName("draggingDestinationWindow"),
					Fn:  func(objc.ID, objc.SEL) objc.ID { return testFinderDragWin },
				},
				{
					Cmd: objc.RegisterName("draggingLocation"),
					Fn:  func(objc.ID, objc.SEL) nsPoint { return testFinderDragLoc },
				},
				{
					Cmd: objc.RegisterName("draggingPasteboard"),
					Fn:  func(objc.ID, objc.SEL) objc.ID { return testFinderDragPB },
				},
				{
					Cmd: objc.RegisterName("draggingSourceOperationMask"),
					Fn:  func(objc.ID, objc.SEL) uint { return 1 }, // NSDragOperationCopy
				},
				{
					Cmd: objc.RegisterName("draggingSequenceNumber"),
					Fn:  func(objc.ID, objc.SEL) int { return 1 },
				},
				{
					Cmd: objc.RegisterName("draggedImage"),
					Fn:  func(objc.ID, objc.SEL) objc.ID { return 0 },
				},
				{
					Cmd: objc.RegisterName("draggedImageLocation"),
					Fn:  func(objc.ID, objc.SEL) nsPoint { return nsPoint{} },
				},
				{
					Cmd: objc.RegisterName("draggingSource"),
					Fn:  func(objc.ID, objc.SEL) objc.ID { return 0 },
				},
				{
					Cmd: objc.RegisterName("enumerateDraggingItemsWithOptions:forView:classes:searchOptions:usingBlock:"),
					Fn:  func(objc.ID, objc.SEL, uint, objc.ID, objc.ID, objc.ID, uintptr) {},
				},
				{
					Cmd: objc.RegisterName("numberOfValidItemsForDrop"),
					Fn:  func(objc.ID, objc.SEL) int { return 1 },
				},
				{
					Cmd: objc.RegisterName("setNumberOfValidItemsForDrop:"),
					Fn:  func(objc.ID, objc.SEL, int) {},
				},
				{
					Cmd: objc.RegisterName("draggingFormation"),
					Fn:  func(objc.ID, objc.SEL) int { return 0 },
				},
				{
					Cmd: objc.RegisterName("setDraggingFormation:"),
					Fn:  func(objc.ID, objc.SEL, int) {},
				},
				{
					Cmd: objc.RegisterName("animatesToDestination"),
					Fn:  func(objc.ID, objc.SEL) bool { return false },
				},
				{
					Cmd: objc.RegisterName("setAnimatesToDestination:"),
					Fn:  func(objc.ID, objc.SEL, bool) {},
				},
				{
					Cmd: objc.RegisterName("springLoadingHighlight"),
					Fn:  func(objc.ID, objc.SEL) int { return 0 },
				},
				{
					Cmd: objc.RegisterName("resetSpringLoading"),
					Fn:  func(objc.ID, objc.SEL) {},
				},
				{
					Cmd: objc.RegisterName("slideDraggedImageTo:"),
					Fn:  func(objc.ID, objc.SEL, nsPoint) {},
				},
			},
		)
		if err != nil {
			panic(err)
		}
		testFinderDragInfo = objc.ID(cls).Send(objc.RegisterName("alloc")).Send(objc.RegisterName("init"))
		testFinderDragPB = objc.ID(objc.GetClass("NSPasteboard")).Send(objc.RegisterName("pasteboardWithUniqueName")).Send(objc.RegisterName("retain"))
	})
	testFinderDragWin = win
	testFinderDragLoc = loc
	testFinderDragPB.Send(objc.RegisterName("clearContents"))
	nsPath := objc.ID(objc.GetClass("NSString")).Send(objc.RegisterName("stringWithUTF8String:"), path)
	fileURL := objc.ID(objc.GetClass("NSURL")).Send(objc.RegisterName("fileURLWithPath:"), nsPath)
	items := objc.ID(objc.GetClass("NSArray")).Send(objc.RegisterName("arrayWithObject:"), fileURL)
	testFinderDragPB.Send(objc.RegisterName("writeObjects:"), items)
	return testFinderDragInfo
}

func TestNativeFinderFileDrop(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Drop fixture</title><body style="margin:0;height:100vh">
			<div id="composer" style="width:100%;height:100%"></div>
			<script>
				window.events = [];
				window.dropped = null;
				const box = document.getElementById("composer");
				box.addEventListener("dragenter", (e) => {
					if (Array.from(e.dataTransfer.types).includes("Files")) {
						e.preventDefault();
						window.events.push("dragenter");
					}
				});
				box.addEventListener("dragover", (e) => {
					if (Array.from(e.dataTransfer.types).includes("Files")) {
						e.preventDefault();
						e.dataTransfer.dropEffect = "copy";
					}
				});
				box.addEventListener("drop", async (e) => {
					e.preventDefault();
					const file = e.dataTransfer.files[0];
					window.dropped = file ? { name: file.name, text: await file.text() } : null;
				});
			</script></body>`)
	}))
	defer server.Close()

	samplePath := filepath.Join(t.TempDir(), "finder-drop.txt")
	if err := os.WriteFile(samplePath, []byte("dragged from finder"), 0o600); err != nil {
		t.Fatal(err)
	}

	browser := &Browser{tabs: make(map[string]*browserTab)}
	const guestID = "browser:drop-check"
	guestBox := BrowserViewport{X: 300, Y: 60, Width: 260, Height: 240, Scale: 1}
	var win *mygo.Window
	var err error
	// Place both views in the first native frame, including on an occluded test desktop.
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{Title: "Lever Finder Drop Test", Width: 600, Height: 400, Hidden: true, Content: ui.View(browser.paint)})
		browser.shell, err = win.NewWebView(mygo.WebViewOptions{Page: mygo.PageOptions{TrustedOrigins: []string{server.URL}}})
		if err != nil {
			return
		}
		if _, err = browser.Open(t.TempDir(), guestID, server.URL); err == nil {
			browser.Place(guestID, guestBox)
		}
		win.Show()
	})
	defer win.Destroy()
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close(guestID)
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
	wait("drop fixture page loaded", func() bool {
		title, _ := mygo.EvalAs[string](page, "document.title")
		return title == "Drop fixture"
	})
	guest, err := browser.tab(guestID)
	if err != nil {
		t.Fatal(err)
	}
	wait("guest tab placed", func() bool {
		width, _ := mygo.EvalAs[int](guest.view.Page(), "innerWidth")
		return width == guestBox.Width
	})
	wait("surface unregistered dragged types", func() bool {
		var has bool
		mygo.RunOnMain(func() { has = surfaceHasDraggedTypes(win) })
		return !has
	})

	var targetClass string
	var shellWeb, rightTarget uintptr
	mygo.RunOnMain(func() {
		for _, handle := range nativeBrowserPages(win) {
			if handle != guest.nativePage {
				shellWeb = handle
			}
		}
		nsWin := objc.ID(win.NativeHandle())
		// Over the guest browser pane, AppKit routes drags to the guest WebView.
		rightInfo := testFinderDraggingInfo(nsWin, nsPoint{X: 400, Y: 200}, samplePath)
		rightTarget = uintptr(nsWin.Send(objc.RegisterName("_findDragTargetFrom:"), rightInfo))
		// Over the workbench pane, AppKit routes drags to the shell WebView.
		info := testFinderDraggingInfo(nsWin, nsPoint{X: 100, Y: 200}, samplePath)
		target := nsWin.Send(objc.RegisterName("_findDragTargetFrom:"), info)
		if target == 0 {
			return
		}
		targetClass = objc.Send[string](target.Send(objc.RegisterName("className")), objc.RegisterName("UTF8String"))
		if uintptr(target) != shellWeb {
			return
		}
		target.Send(objc.RegisterName("draggingEntered:"), info)
	})
	if rightTarget != guest.nativePage {
		t.Fatalf("guest tab drag target = %#x, want guest %#x", rightTarget, guest.nativePage)
	}
	if targetClass != "MyGoWebView" {
		t.Fatalf("AppKit drag target = %q, want MyGoWebView", targetClass)
	}

	wait("WKWebView received dragenter", func() bool {
		ok, _ := mygo.EvalAs[bool](page, `window.events.includes("dragenter")`)
		return ok
	})

	mygo.RunOnMain(func() {
		nsWin := objc.ID(win.NativeHandle())
		info := testFinderDraggingInfo(nsWin, nsPoint{X: 100, Y: 200}, samplePath)
		target := nsWin.Send(objc.RegisterName("_findDragTargetFrom:"), info)
		target.Send(objc.RegisterName("draggingUpdated:"), info)
		if objc.Send[bool](target, objc.RegisterName("prepareForDragOperation:"), info) {
			objc.Send[bool](target, objc.RegisterName("performDragOperation:"), info)
		}
	})

	wait("dropped file delivered with content", func() bool {
		ok, _ := mygo.EvalAs[bool](page, `window.dropped?.name === "finder-drop.txt" && window.dropped?.text === "dragged from finder"`)
		return ok
	})
}

func TestNativeWorkbenchFinderDrop(t *testing.T) {
	ctxPath := os.Getenv("LEVER_TEST_CONTEXT")
	if ctxPath == "" {
		t.Skip("start web/tests/server.mjs with LEVER_TEST_CONTEXT")
	}
	data, err := os.ReadFile(ctxPath)
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

	samplePath := filepath.Join(t.TempDir(), "finder-spec.txt")
	if err := os.WriteFile(samplePath, []byte("from finder into composer"), 0o600); err != nil {
		t.Fatal(err)
	}

	browser := &Browser{tabs: make(map[string]*browserTab)}
	var win *mygo.Window
	mygo.RunOnMain(func() {
		win = mygo.NewWindow(mygo.WindowOptions{
			Title:                "Lever Finder Composer Fixture",
			Width:                1320,
			Height:               820,
			Hidden:               true,
			TitleBarStyle:        mygo.TitleBarHidden,
			TitleBarHeight:       48,
			TrafficLightPosition: &mygo.Point{X: 12, Y: 17},
			Content:              ui.View(browser.paint),
		})
		err = browser.attach(win, origin, fixture.URL)
		if err == nil {
			win.Show()
		}
	})
	defer win.Destroy()
	if err != nil {
		t.Fatal(err)
	}
	win.Focus()
	shell := browser.shell.Page()
	wait := func(label string, check func() bool) {
		t.Helper()
		end := time.Now().Add(15 * time.Second)
		for time.Now().Before(end) {
			if check() {
				return
			}
			time.Sleep(40 * time.Millisecond)
		}
		t.Fatal(label)
	}
	check := func(js string) bool { ok, _ := mygo.EvalAs[bool](shell, js); return ok }

	wait("pairing", func() bool { return check(`fetch('/api/overview').then(r=>r.ok)`) })
	scope, _ := json.Marshal(fixture.Scope)
	agent, err := mygo.EvalAs[model.Agent](shell, `fetch('/api/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Finder drop',profile:{provider:'codex',permission:'ask',roots:[{path:`+string(scope)+`}],skills:[],delegations:[]}})}).then(r=>r.json())`)
	if err != nil || agent.ID == "" {
		t.Fatalf("create agent %q: %v", agent.ID, err)
	}
	if _, err := shell.Eval(fmt.Sprintf(`window.beforeFixtureReload=true;localStorage.setItem("lever:agent",%q);localStorage.setItem("lever:language","en-US");return true`, agent.ID)); err != nil {
		t.Fatal(err)
	}
	shell.Reload()
	wait("composer rendered", func() bool {
		return check(`!window.beforeFixtureReload && Boolean(document.querySelector('.prompt-editor')?.getBoundingClientRect().height > 0)`)
	})
	wait("surface unregistered dragged types", func() bool {
		var has bool
		mygo.RunOnMain(func() { has = surfaceHasDraggedTypes(win) })
		return !has
	})

	type dropPoint struct {
		X, Y, Height float64
	}
	pt, err := mygo.EvalAs[dropPoint](shell, `(() => {
		const r = document.querySelector('.prompt-editor').getBoundingClientRect();
		return { X: r.left + r.width / 2, Y: r.top + r.height / 2, Height: window.innerHeight };
	})()`)
	if err != nil {
		t.Fatal(err)
	}
	loc := nsPoint{X: pt.X, Y: pt.Height - pt.Y}

	var targetClass string
	mygo.RunOnMain(func() {
		nsWin := objc.ID(win.NativeHandle())
		info := testFinderDraggingInfo(nsWin, loc, samplePath)
		target := nsWin.Send(objc.RegisterName("_findDragTargetFrom:"), info)
		if target == 0 {
			return
		}
		targetClass = objc.Send[string](target.Send(objc.RegisterName("className")), objc.RegisterName("UTF8String"))
		target.Send(objc.RegisterName("draggingEntered:"), info)
	})
	if targetClass != "MyGoWebView" {
		t.Fatalf("AppKit drag target over composer = %q, want MyGoWebView", targetClass)
	}
	wait("drop overlay visible over composer", func() bool {
		return check(`Boolean(document.querySelector('.attachment-drop'))`)
	})

	mygo.RunOnMain(func() {
		nsWin := objc.ID(win.NativeHandle())
		info := testFinderDraggingInfo(nsWin, loc, samplePath)
		target := nsWin.Send(objc.RegisterName("_findDragTargetFrom:"), info)
		target.Send(objc.RegisterName("draggingUpdated:"), info)
		if objc.Send[bool](target, objc.RegisterName("prepareForDragOperation:"), info) {
			objc.Send[bool](target, objc.RegisterName("performDragOperation:"), info)
		}
	})
	wait("dropped Finder file attached to composer without inserting path text", func() bool {
		return check(`Boolean(document.querySelector('.attachment-chip')?.textContent.includes('finder-spec.txt')) && !document.querySelector('.attachment-drop') && document.querySelector('.prompt-editor')?.textContent.trim() === ''`)
	})
}
