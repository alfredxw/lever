#Requires -Version 7.0

[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 4779,
    [ValidateNotNullOrEmpty()][string]$DataDir = $(if ($env:LEVER_DATA_DIR) { $env:LEVER_DATA_DIR } else { '.lever' })
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This script requires Windows.' }

$root = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root 'bin/desktop'
$dataDir = [IO.Path]::GetFullPath($DataDir, $root)
$address = "127.0.0.1:$Port"
$node = (Get-Command node.exe -CommandType Application -TotalCount 1).Source
$pnpm = Get-Command pnpm.cmd, pnpm.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $pnpm) { throw 'pnpm is required.' }

# Find the processes using the target database lock and desktop log.
if (-not ('LeverRestartFiles' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class LeverRestartFiles {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessInfo {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
        public uint ApplicationType, Status, SessionId;
        public int Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    static extern int RmRegisterResources(uint session, uint count, string[] files, int apps, IntPtr processes, int services, IntPtr names);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, out uint reasons);
    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint session);

    static void Check(int result) {
        if (result != 0) throw new Win32Exception(result);
    }

    public static int[] ProcessIds(string file) {
        Check(RmStartSession(out uint session, 0, new StringBuilder(33)));
        try {
            Check(RmRegisterResources(session, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero));
            uint count = 0;
            ProcessInfo[] processes = null;
            int result;
            const int MoreData = 234;
            while ((result = RmGetList(session, out uint needed, ref count, processes, out _)) == MoreData) {
                processes = new ProcessInfo[needed];
                count = needed;
            }
            Check(result);
            return count == 0 ? Array.Empty<int>() : processes.Take((int)count).Select(p => p.ProcessId).ToArray();
        } finally {
            RmEndSession(session);
        }
    }
}
'@
}

function Get-FileProcesses([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $owners = [LeverRestartFiles]::ProcessIds($Path)
        if ($owners.Count) { Get-Process -Id $owners -ErrorAction SilentlyContinue }
    }
}

function Test-CheckoutDesktop([string]$Executable) {
    if (-not $Executable) { return $false }
    if ($Executable -eq (Join-Path $root 'bin/lever-desktop.exe')) { return $true }
    $dir = [IO.Path]::GetDirectoryName($Executable)
    $name = [IO.Path]::GetFileName($Executable)
    return (
        ($dir -eq $binDir -and $name -match '^Lever(?:-dev-[0-9a-f]{32})?\.exe$') -or
        ($name -eq 'Lever.exe' -and [IO.Path]::GetFileName($dir) -match '^windows-(amd64|arm64)$' -and
            [IO.Path]::GetDirectoryName($dir) -eq (Join-Path $root 'desktop/dist'))
    )
}

$null = [IO.Directory]::CreateDirectory($binDir)
$restartLock = [IO.File]::Open((Join-Path $binDir 'restart-windows.lock'), 'OpenOrCreate', 'Write', 'None')
$previousDataDir = $env:LEVER_DATA_DIR
$previousWebViewDir = $env:WEBVIEW2_USER_DATA_FOLDER
Push-Location -LiteralPath $root
try {
    Write-Host '==> Installing frontend dependencies and building the Go desktop and backend'
    & $pnpm.Source --dir web install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install exited with code $LASTEXITCODE." }

    # The previous backend and its run workers can still be using their executable.
    $buildName = 'Lever-dev-' + [Guid]::NewGuid().ToString('N')
    $executable = Join-Path $binDir "$buildName.exe"
    & go.exe build -tags dev -o $executable ./cmd/lever-desktop
    if ($LASTEXITCODE -ne 0) { throw "go build exited with code $LASTEXITCODE." }

    $announced = $false
    $backendLock = Join-Path $dataDir 'lever.lock'
    while ($holders = Get-FileProcesses $backendLock) {
        foreach ($holder in $holders) {
            if (-not $holder.HasExited -and -not (Test-CheckoutDesktop $holder.Path)) {
                throw "$dataDir is in use by another Lever server (PID $($holder.Id))."
            }
        }
        $busy = & $executable --data-dir $dataDir --print-restart-busy
        if ($LASTEXITCODE -ne 0) { throw "Could not check active runs in $dataDir." }
        if ($busy -eq 'false') { break }
        if (-not $announced) {
            Write-Host '==> Waiting for runs without an independent provider worker. The current window stays open for approvals (Ctrl+C cancels the restart).'
            $announced = $true
        }
        Start-Sleep -Seconds 1
    }

    Write-Host "==> Closing desktop windows for $dataDir"
    $checkoutWindows = Get-FileProcesses (Join-Path $dataDir 'desktop.log') |
        Where-Object { Test-CheckoutDesktop $_.Path }
    foreach ($window in $checkoutWindows) {
        if (-not $window.HasExited -and -not $window.CloseMainWindow() -and -not $window.HasExited) {
            throw "Could not close the development window (PID $($window.Id))."
        }
    }
    $closing = [Diagnostics.Stopwatch]::StartNew()
    foreach ($window in $checkoutWindows) {
        if (-not $window.WaitForExit([Math]::Max(0, 120000 - $closing.ElapsedMilliseconds))) {
            throw "Timed out closing the development window (PID $($window.Id))."
        }
    }

    $null = [IO.Directory]::CreateDirectory($dataDir)
    $env:LEVER_DATA_DIR = $dataDir
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $dataDir 'WebView2'
    $stdout = Join-Path $dataDir 'dev-desktop.out.log'
    $stderr = Join-Path $dataDir 'dev-desktop.err.log'
    $launchOptions = @{
        FilePath = $node
        WorkingDirectory = $root
        ArgumentList = @('web/scripts/dev-desktop.mjs', "--prebuilt=bin/desktop/$buildName.exe",
            '--fresh-backend', '--listen', $address)
        RedirectStandardOutput = $stdout
        RedirectStandardError = $stderr
        WindowStyle = 'Hidden'
        PassThru = $true
    }
    Write-Host '==> Starting the newly built Go backend and desktop with Vite hot updates'
    $launcher = Start-Process @launchOptions
    $startup = [Diagnostics.Stopwatch]::StartNew()
    while (-not $launcher.HasExited -and $startup.Elapsed.TotalSeconds -lt 60) {
        $window = Get-Process -Name $buildName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero }
        if ($window) {
            $runningExecutables = Get-Process -Name 'Lever-dev-*' | ForEach-Object Path
            foreach ($oldBuild in Get-ChildItem -LiteralPath $binDir -File -Filter 'Lever-dev-*.exe') {
                if ($oldBuild.BaseName -match '^Lever-dev-[0-9a-f]{32}$' -and
                    $oldBuild.FullName -ne $executable -and $oldBuild.FullName -notin $runningExecutables) {
                    Remove-Item -LiteralPath $oldBuild.FullName -ErrorAction SilentlyContinue
                }
            }
            Write-Host "Lever Desktop is running at http://$address"
            return
        }
        Start-Sleep -Milliseconds 200
    }
    if ($launcher.HasExited) {
        throw "Lever Desktop exited during startup with code $($launcher.ExitCode). See $stderr."
    }
    throw "Timed out waiting for the Lever Desktop window. See $stderr."
}
finally {
    $env:LEVER_DATA_DIR = $previousDataDir
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousWebViewDir
    Pop-Location
    $restartLock.Dispose()
}
