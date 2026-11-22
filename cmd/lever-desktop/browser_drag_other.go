//go:build !darwin

package main

import "github.com/egoist/mygo"

func surfaceHasDraggedTypes(*mygo.Window) bool { return false }

func unregisterSurfaceDraggedTypes(*mygo.Window) {}
