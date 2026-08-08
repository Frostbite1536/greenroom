$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
if (-not $env:SPRINT_COORDINATION_DIR) {
  $env:SPRINT_COORDINATION_DIR = Join-Path (Split-Path $Root -Parent) "SAAS-sprint-coordination"
}

& "C:\Program Files\Git\bin\bash.exe" "$Root/scripts/init-coordination.sh" | Out-Null
& "C:\Program Files\Git\bin\bash.exe" "$Root/scripts/setup-worktrees.sh"

$tabs = @(
  @{ Title = "Sprint Backend"; Dir = (Join-Path $Root ".worktrees/backend"); Prompt = "You are the backend worker. The Architect has locked the foundation. Read the coordination state, then use /backend." },
  @{ Title = "Sprint Frontend"; Dir = (Join-Path $Root ".worktrees/frontend"); Prompt = "You are the frontend worker. The Architect has locked the foundation. Read the coordination state, then use /frontend." },
  @{ Title = "Sprint Ops"; Dir = (Join-Path $Root ".worktrees/ops"); Prompt = "You are the ops worker. The Architect has locked the foundation. Read the coordination state, then use /ops." }
)

$launcherDir = Join-Path $env:TEMP "sprint-launchers"
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null

foreach ($tab in $tabs) {
  $slug = ($tab.Title -replace '[^A-Za-z0-9]', '-').ToLower()
  $launcher = Join-Path $launcherDir "$slug.ps1"
  @(
    "`$env:SPRINT_COORDINATION_DIR = '$($env:SPRINT_COORDINATION_DIR)'"
    "Set-Location '$($tab.Dir)'"
    "pi --provider anthropic --model claude-opus-5 --name '$($tab.Title)' '$($tab.Prompt)'"
  ) | Set-Content -Path $launcher -Encoding UTF8

  $wtArgs = "-w 0 new-tab --title `"$($tab.Title)`" -d `"$($tab.Dir)`" powershell.exe -NoExit -ExecutionPolicy Bypass -File `"$launcher`""
  Start-Process wt.exe -ArgumentList $wtArgs
}

Write-Host "Launched Pi tabs. Coordination: $env:SPRINT_COORDINATION_DIR"
