$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
if (-not $env:SPRINT_COORDINATION_DIR) {
  $env:SPRINT_COORDINATION_DIR = Join-Path (Split-Path $Root -Parent) "SAAS-sprint-coordination"
}

& "C:\Program Files\Git\bin\bash.exe" "$Root/scripts/init-coordination.sh" | Out-Null
& "C:\Program Files\Git\bin\bash.exe" "$Root/scripts/setup-worktrees.sh"

$tabs = @(
  @{ Title = "Sprint Architect"; Dir = $Root; Prompt = "Run /architect after the target brief is available. First inspect sprint documentation and coordination state." },
  @{ Title = "Sprint Backend"; Dir = (Join-Path $Root ".worktrees/backend"); Prompt = "You are the backend worker. Wait for contract lock, then use /backend." },
  @{ Title = "Sprint Frontend"; Dir = (Join-Path $Root ".worktrees/frontend"); Prompt = "You are the frontend worker. Wait for contract lock, then use /frontend." },
  @{ Title = "Sprint Ops"; Dir = (Join-Path $Root ".worktrees/ops"); Prompt = "You are the ops worker. Wait for contract lock, then use /ops." }
)

foreach ($tab in $tabs) {
  $command = "`$env:SPRINT_COORDINATION_DIR='$($env:SPRINT_COORDINATION_DIR)'; pi --name '$($tab.Title)' '$($tab.Prompt)'"
  Start-Process wt.exe -ArgumentList @("-w", "0", "new-tab", "--title", $tab.Title, "-d", $tab.Dir, "powershell.exe", "-NoExit", "-Command", $command)
}

Write-Host "Launched Pi tabs. Coordination: $env:SPRINT_COORDINATION_DIR"
