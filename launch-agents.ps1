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

foreach ($tab in $tabs) {
  $command = "`$env:SPRINT_COORDINATION_DIR='$($env:SPRINT_COORDINATION_DIR)'; pi --name '$($tab.Title)' '$($tab.Prompt)'"
  Start-Process wt.exe -ArgumentList @("-w", "0", "new-tab", "--title", $tab.Title, "-d", $tab.Dir, "powershell.exe", "-NoExit", "-Command", $command)
}

Write-Host "Launched Pi tabs. Coordination: $env:SPRINT_COORDINATION_DIR"
