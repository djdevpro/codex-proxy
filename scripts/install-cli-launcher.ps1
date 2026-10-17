# Reuse the CLI bundled with the desktop app, without copying credentials or pinning a versioned directory.
[CmdletBinding()]
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskBin = Join-Path $env:USERPROFILE '.local\bin'
$taskLauncher = Join-Path $taskBin 'codex.cmd'
$taskMarker = 'Codex Desktop CLI launcher installed by codex-proxy'
if ($Uninstall) {
  if ((Test-Path -LiteralPath $taskLauncher) -and (Get-Content -Raw -LiteralPath $taskLauncher).Contains($taskMarker)) {
    Remove-Item -LiteralPath $taskLauncher
    Write-Output "Removed $taskLauncher"
  }
  exit
}
if (Test-Path -LiteralPath $taskLauncher) {
  if (!(Get-Content -Raw -LiteralPath $taskLauncher).Contains($taskMarker)) { throw "An existing codex.cmd is present; it will not be overwritten." }
}
$taskDesktop = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$taskExecutable = Get-ChildItem -LiteralPath $taskDesktop -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (!$taskExecutable) { throw 'No Codex Desktop CLI was found. Install the official Codex CLI first.' }
New-Item -ItemType Directory -Path $taskBin -Force | Out-Null
$taskContent = @'
@echo off
rem Codex Desktop CLI launcher installed by codex-proxy
setlocal
set "CODEX_DESKTOP_EXE="
for /f "delims=" %%F in ('powershell.exe -NoProfile -Command "Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName"') do set "CODEX_DESKTOP_EXE=%%F"
if not defined CODEX_DESKTOP_EXE (
  echo Codex Desktop CLI was not found. Reinstall the official Codex CLI. 1>&2
  exit /b 1
)
"%CODEX_DESKTOP_EXE%" %*
exit /b %errorlevel%
'@
[IO.File]::WriteAllText($taskLauncher, $taskContent.Replace("`n", "`r`n"), [Text.Encoding]::ASCII)
$taskUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$taskExpandedPath = [Environment]::ExpandEnvironmentVariables($taskUserPath)
if (!($taskExpandedPath -split ';' | Where-Object { $_.TrimEnd([char]92) -ieq $taskBin.TrimEnd([char]92) })) {
  [Environment]::SetEnvironmentVariable('Path', ($taskUserPath.TrimEnd(';') + ';' + $taskBin), 'User')
  Write-Output 'Added .localin to the user PATH. Open a new terminal to use it.'
}
Write-Output "Installed $taskLauncher"
Write-Output "CLI verified at $($taskExecutable.FullName)"
