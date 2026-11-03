# Win32 probes for the desktop E2E suite. Prints one JSON object.
#   affinity <hwnd>             → display affinity (17 = excluded from capture)
#   grabhash <x> <y> <w> <h>    → SHA-256 of what screen capture sees in that rectangle (no image is saved)
#   minimize <hwnd>             → ShowWindow(SW_MINIMIZE), like "minimise all"
#   sysminimize <hwnd>          → WM_SYSCOMMAND/SC_MINIMIZE, like a minimise request from another app
#   state <hwnd>                → { iconic, visible }
#   restore <hwnd>              → ShowWindow(SW_SHOWNOACTIVATE)
#   rect <hwnd>                 → window rectangle in physical pixels
param([string]$Command, [long]$A = 0, [int]$B = 0, [int]$C = 0, [int]$D = 0)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class P {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][P]::SetProcessDpiAwarenessContext([IntPtr](-4))
$h = [IntPtr]$A
switch ($Command) {
  'affinity' { $a = 0; [void][P]::GetWindowDisplayAffinity($h, [ref]$a); @{ affinity = $a } | ConvertTo-Json -Compress }
  'grabhash' {
    $bmp = New-Object System.Drawing.Bitmap $C, $D
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([int]$A, $B, 0, 0, $bmp.Size); $g.Dispose()
    $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
    $hash = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($ms.ToArray())).Replace('-', '')
    @{ hash = $hash } | ConvertTo-Json -Compress
  }
  'minimize' { [void][P]::ShowWindow($h, 6); @{ ok = $true } | ConvertTo-Json -Compress }
  'sysminimize' { [void][P]::SendMessage($h, 0x0112, [IntPtr]0xF020, [IntPtr]::Zero); @{ ok = $true } | ConvertTo-Json -Compress }
  'restore' { [void][P]::ShowWindow($h, 4); @{ ok = $true } | ConvertTo-Json -Compress }
  'rect' { $r = New-Object P+RECT; [void][P]::GetWindowRect($h, [ref]$r); @{ x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T } | ConvertTo-Json -Compress }
  'state' { @{ iconic = [P]::IsIconic($h); visible = [P]::IsWindowVisible($h) } | ConvertTo-Json -Compress }
}
