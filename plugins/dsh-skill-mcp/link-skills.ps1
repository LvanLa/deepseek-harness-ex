param(
  [Parameter(Mandatory=$true)]
  [string]$SourceDirectory,
  [string]$TargetDirectory = ''
)
$ErrorActionPreference = 'Stop'
if (-not $TargetDirectory) {
  $TargetDirectory = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'skills' } else { Join-Path $env:USERPROFILE '.dsh\skills' }
}
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
Get-ChildItem -LiteralPath $source -Directory -Force | ForEach-Object {
  $link = Join-Path $TargetDirectory $_.Name
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Remove-Item -LiteralPath $link -Force -Recurse }
    else { throw "Target exists and is not a link: $link" }
  }
  New-Item -ItemType Junction -Path $link -Target $_.FullName | Out-Null
}
