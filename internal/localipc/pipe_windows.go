package localipc

import (
	"context"
	"errors"
	"net"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func pipe(dataDir string) (string, *windows.SID, error) {
	id, err := instanceID(dataDir)
	if err != nil {
		return "", nil, err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", nil, err
	}
	return `\\.\pipe\lever-cli-` + id, user.User.Sid, nil
}

func Listen(dataDir string) (net.Listener, error) {
	path, user, err := pipe(dataDir)
	if err != nil {
		return nil, err
	}
	sid := user.String()
	return winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: "O:" + sid + "D:P(A;;GA;;;" + sid + ")",
	})
}

func Dial(ctx context.Context, dataDir string) (net.Conn, error) {
	path, user, err := pipe(dataDir)
	if err != nil {
		return nil, err
	}
	conn, err := winio.DialPipeContext(ctx, path)
	if err != nil {
		return nil, err
	}
	fd, ok := conn.(interface{ Fd() uintptr })
	err = errors.New("The Lever CLI pipe does not belong to the current user")
	if ok {
		var sd *windows.SECURITY_DESCRIPTOR
		sd, err = windows.GetSecurityInfo(windows.Handle(fd.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err == nil {
			owner, _, ownerErr := sd.Owner()
			if ownerErr == nil && owner != nil && owner.Equals(user) {
				return conn, nil
			}
			err = errors.New("The Lever CLI pipe does not belong to the current user")
		}
	}
	_ = conn.Close()
	return nil, err
}
