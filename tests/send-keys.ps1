# Sends ONE real OS-level key chord to the Chrome window that owns the given process id, e.g.  send-keys.ps1 -ChromePid 1234 -Chord "Ctrl+G"
# Safety: it first brings that window to the foreground and refuses to type (exit code 3) unless that window really is
# the foreground window. Used only by tests/e2e-keys.mjs against its own throw-away Chrome profile.
param([Parameter(Mandatory = $true)][int]$ChromePid, [Parameter(Mandatory = $true)][string]$Chord)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TabfoldWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
}
"@

$proc = Get-Process -Id $ChromePid -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 2 }

# bring the test window to the foreground (attach to the current foreground thread so Windows allows it)
[TabfoldWin]::ShowWindow($hwnd, 9) | Out-Null
$fg = [TabfoldWin]::GetForegroundWindow()
$fgPid = 0
$fgThread = [TabfoldWin]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$me = [TabfoldWin]::GetCurrentThreadId()
[TabfoldWin]::AttachThreadInput($me, $fgThread, $true) | Out-Null
[TabfoldWin]::AllowSetForegroundWindow(-1) | Out-Null
[TabfoldWin]::BringWindowToTop($hwnd) | Out-Null
[TabfoldWin]::SetForegroundWindow($hwnd) | Out-Null
[TabfoldWin]::AttachThreadInput($me, $fgThread, $false) | Out-Null
Start-Sleep -Milliseconds 300
if ([TabfoldWin]::GetForegroundWindow() -ne $hwnd) { [TabfoldWin]::SwitchToThisWindow($hwnd, $true); Start-Sleep -Milliseconds 400 }

$nowFg = [TabfoldWin]::GetForegroundWindow()
$nowPid = 0
[TabfoldWin]::GetWindowThreadProcessId($nowFg, [ref]$nowPid) | Out-Null
if ($nowPid -ne $ChromePid) { Write-Output "NOFOCUS (foreground pid $nowPid)"; exit 3 }

$vk = @{ 'Ctrl' = 0x11; 'Alt' = 0x12; 'Shift' = 0x10 }
$parts = $Chord.Split('+')
$mods = @($parts | Select-Object -SkipLast 1)
$last = $parts[-1]
if ($last.Length -ne 1) { Write-Output "BADCHORD"; exit 4 }
$keyCode = [byte][char]$last.ToUpper()

foreach ($m in $mods) { [TabfoldWin]::keybd_event([byte]$vk[$m], 0, 0, [UIntPtr]::Zero) }
[TabfoldWin]::keybd_event($keyCode, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[TabfoldWin]::keybd_event($keyCode, 0, 2, [UIntPtr]::Zero)
[array]::Reverse($mods)
foreach ($m in $mods) { [TabfoldWin]::keybd_event([byte]$vk[$m], 0, 2, [UIntPtr]::Zero) }
Write-Output "SENT $Chord"
exit 0
