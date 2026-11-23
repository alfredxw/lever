package main

import (
	"encoding/binary"
	"errors"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

func openInSystemBrowser(fileURL string) error {
	browser, err := mygo.Shell.DefaultApp("https://example.invalid")
	if err != nil {
		return err
	}
	var result chan error
	mygo.RunOnMain(func() {
		result = make(chan error, 1)
		selector := objc.RegisterName
		nativeString := func(value string) objc.ID {
			return objc.ID(objc.GetClass("NSString")).Send(selector("stringWithUTF8String:"), value)
		}
		application := objc.ID(objc.GetClass("NSURL")).Send(selector("fileURLWithPath:"), nativeString(browser.Path))
		descriptor := objc.ID(objc.GetClass("NSAppleEventDescriptor"))
		getURL := binary.BigEndian.Uint32([]byte("GURL"))
		event := descriptor.Send(selector("appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID:"), getURL, getURL, objc.ID(0), int16(-1), int32(0))
		event.Send(selector("setParamDescriptor:forKeyword:"), descriptor.Send(selector("descriptorWithString:"), nativeString(fileURL)), binary.BigEndian.Uint32([]byte("----")))
		configuration := objc.ID(objc.GetClass("NSWorkspaceOpenConfiguration")).Send(selector("configuration"))
		configuration.Send(selector("setAppleEvent:"), event)
		done := objc.NewBlock(func(_ objc.Block, _, failure objc.ID) {
			if failure != 0 {
				result <- errors.New(objc.Send[string](failure.Send(selector("localizedDescription")), selector("UTF8String")))
			} else {
				result <- nil
			}
		})
		defer done.Release()
		workspace := objc.ID(objc.GetClass("NSWorkspace")).Send(selector("sharedWorkspace"))
		workspace.Send(selector("openApplicationAtURL:configuration:completionHandler:"), application, configuration, done)
	})
	if result == nil {
		return errors.New("desktop is shutting down")
	}
	return <-result
}
