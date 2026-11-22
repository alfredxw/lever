package main

import (
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

func nativeSurfaceView(win *mygo.Window) objc.ID {
	if win == nil {
		return 0
	}
	handle := win.NativeHandle()
	if handle == 0 {
		return 0
	}
	surfaceClass := objc.GetClass("MyGoSurfaceView")
	if surfaceClass == 0 {
		return 0
	}
	content := objc.ID(handle).Send(objc.RegisterName("contentView"))
	if content == 0 {
		return 0
	}
	var find func(objc.ID) objc.ID
	find = func(view objc.ID) objc.ID {
		if objc.Send[bool](view, objc.RegisterName("isKindOfClass:"), surfaceClass) {
			return view
		}
		children := view.Send(objc.RegisterName("subviews"))
		for index := range uintptr(children.Send(objc.RegisterName("count"))) {
			if match := find(children.Send(objc.RegisterName("objectAtIndex:"), index)); match != 0 {
				return match
			}
		}
		return 0
	}
	return find(content)
}

func surfaceHasDraggedTypes(win *mygo.Window) bool {
	surface := nativeSurfaceView(win)
	if surface == 0 {
		return false
	}
	types := surface.Send(objc.RegisterName("registeredDraggedTypes"))
	return types != 0 && uintptr(types.Send(objc.RegisterName("count"))) > 0
}

func unregisterSurfaceDraggedTypes(win *mygo.Window) {
	if surface := nativeSurfaceView(win); surface != 0 {
		surface.Send(objc.RegisterName("unregisterDraggedTypes"))
	}
}
