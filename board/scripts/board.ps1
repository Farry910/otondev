<#
.SYNOPSIS
    Delivery board CLI. Claims are a compare-and-set against origin/main.

.EXAMPLE
    .\board\scripts\board.ps1 status
    .\board\scripts\board.ps1 claim S07 -Session "kai-1"
    .\board\scripts\board.ps1 fake S07
    .\board\scripts\board.ps1 finish S07
    .\board\scripts\board.ps1 release S07 -Note "context exhausted, executor half-built"
    .\board\scripts\board.ps1 request S07 -Note "action.v2 needs a retry_after hint"
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'list', 'claim', 'release', 'finish', 'block', 'unblock', 'fake', 'request')]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [string]$Id,

    [string]$Session,
    [string]$Note,
    [switch]$Force,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'

# Keep this file pure ASCII. PowerShell 5.1 decodes a BOM-less .ps1 as the system ANSI codepage, so a
# non-ASCII literal here is silently mangled on the way into generated output. Card *content* is UTF-8
# and is handled correctly by Read-Text / Write-Text below.

# --- locate the primary worktree; board state always lives there, on main -------------------------
function Get-PrimaryRoot {
    $lines = & git worktree list --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'not inside a git repository' }
    foreach ($line in $lines) {
        if ($line -like 'worktree *') { return (Resolve-Path ($line -replace '^worktree\s+', '')).Path }
    }
    throw 'could not resolve the primary worktree'
}

$Root     = Get-PrimaryRoot
$CardDir  = Join-Path $Root 'board\packages'
$ReqDir   = Join-Path $Root 'board\requests'
$StatusMd = Join-Path $Root 'board\STATUS.md'
$Stamp    = Get-Date -Format 'yyyy-MM-dd HH:mm'

# --- UTF-8 I/O ------------------------------------------------------------------------------------
# PS 5.1 defaults Get-Content/Set-Content to the ANSI codepage, which mangles the em-dashes in every
# card. Go through .NET so encoding is explicit and no BOM is introduced.
function Read-Text([string]$path) {
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Write-Text([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

# --- card helpers ---------------------------------------------------------------------------------
function Get-CardPath([string]$cardId) {
    if (-not $cardId) { throw 'card id required, e.g. S07' }
    $found = @(Get-ChildItem -Path $CardDir -Filter "$cardId-*.md" -File)
    if ($found.Count -eq 0) { throw "no card matching '$cardId'" }
    if ($found.Count -gt 1) { throw "ambiguous card id '$cardId'" }
    return $found[0].FullName
}

function Get-Field([string]$path, [string]$name) {
    $m = [regex]::Match((Read-Text $path), "(?m)^$name\s*:\s*(.*)$")
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value.Trim().Trim('"')
}

function Set-Field([string]$path, [string]$name, [string]$value) {
    $safe = $value -replace '\$', '$$$$'
    Write-Text $path ([regex]::Replace((Read-Text $path), "(?m)^$name\s*:\s*.*$", "${name}: $safe"))
}

function Get-CardTitle([string]$path) {
    $first = ((Read-Text $path) -split "`r?`n")[0]
    return ($first -replace '^#\s*', '')
}

function Add-Log([string]$path, [string]$line) {
    Write-Text $path ((Read-Text $path).TrimEnd() + "`r`n- $line`r`n")
}

# --- git ------------------------------------------------------------------------------------------
# git writes ordinary progress to stderr. Under $ErrorActionPreference = 'Stop' that becomes a
# terminating NativeCommandError before any $LASTEXITCODE check runs, so every git call goes through
# here and is judged by its exit code alone.
function Invoke-Git([string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git -C $Root @GitArgs } finally { $ErrorActionPreference = $prev }
    return $LASTEXITCODE
}

function Sync-Board([switch]$Required) {
    if ((Invoke-Git @('pull', '--rebase', '--quiet', 'origin', 'main')) -ne 0) {
        if ($Required) {
            throw 'git pull failed - the board must be current before claiming. Commit or stash your working changes, then retry.'
        }
        Write-Warning 'could not sync with origin; showing local board state'
    }
}

function Save-Board([string]$path, [string]$message) {
    $rel = $path.Substring($Root.Length).TrimStart('\', '/')
    [void](Invoke-Git @('add', '--', $rel))
    if ((Invoke-Git @('commit', '-q', '-m', $message, '--', $rel)) -ne 0) { throw 'commit failed' }
    if ($NoPush) { return }
    if ((Invoke-Git @('push', '-q', 'origin', 'main')) -ne 0) {
        Write-Warning 'PUSH REJECTED - another session almost certainly got there first.'
        Write-Warning "Run:  git -C `"$Root`" pull --rebase origin main   then re-read the card."
        Write-Warning 'Never force-push the board.'
        exit 2
    }
}

# --- status ---------------------------------------------------------------------------------------
function Get-Rows {
    $rows = @()
    foreach ($c in (Get-ChildItem -Path $CardDir -Filter '*.md' -File)) {
        $rows += [pscustomobject]@{
            Id     = Get-Field $c.FullName 'id'
            Title  = Get-CardTitle $c.FullName
            Status = Get-Field $c.FullName 'status'
            Owner  = Get-Field $c.FullName 'owner'
            Fake   = Get-Field $c.FullName 'fake'
            Gate   = Get-Field $c.FullName 'gate'
            Stage  = Get-Field $c.FullName 'stage'
            File   = $c.Name
        }
    }
    # W0 first, then S1..S20 numerically - not lexically, or S10 sorts before S2
    return ($rows | Sort-Object @{ Expression = {
        if ($_.Id -eq 'W0') { -1 } else { [int]($_.Id -replace '\D', '') }
    } })
}

function Update-Status {
    $rows = Get-Rows
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# Board status')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("_Generated $Stamp by ``board.ps1 status``. Do not edit; this file is git-ignored._")
    [void]$sb.AppendLine()
    foreach ($s in @('claimed', 'in-review', 'available', 'blocked', 'done')) {
        $n = @($rows | Where-Object { $_.Status -eq $s }).Count
        [void]$sb.AppendLine("- **$s**: $n")
    }
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| ID | Package | Status | Owner | Fake | Gate | Stage |')
    [void]$sb.AppendLine('|---|---|---|---|---|---|---|')
    foreach ($r in $rows) {
        $owner = $r.Owner; if (-not $owner) { $owner = '-' }
        [void]$sb.AppendLine("| [$($r.Id)](packages/$($r.File)) | $($r.Title) | ``$($r.Status)`` | $owner | $($r.Fake) | $($r.Gate) | $($r.Stage) |")
    }
    Write-Text $StatusMd $sb.ToString()
    return $rows
}

function Show-Rows($rows) {
    $rows | Format-Table -AutoSize @{L = 'ID'; E = { $_.Id } },
                                  @{L = 'STATUS'; E = { $_.Status } },
                                  @{L = 'OWNER'; E = { if ($_.Owner) { $_.Owner } else { '-' } } },
                                  @{L = 'FAKE'; E = { $_.Fake } },
                                  @{L = 'GATE'; E = { $_.Gate } },
                                  @{L = 'PACKAGE'; E = { $_.Title } }
}

# --- commands -------------------------------------------------------------------------------------
switch ($Command) {

    'status' {
        Sync-Board
        Show-Rows (Update-Status)
        Write-Host "`nwrote $StatusMd" -ForegroundColor DarkGray
    }

    'list' { Show-Rows (Get-Rows) }

    'claim' {
        if (-not $Session) { throw 'claim requires -Session, e.g. -Session "kai-1"' }
        Sync-Board -Required
        $card = Get-CardPath $Id
        $status = Get-Field $card 'status'
        if ($status -ne 'available') {
            $owner = Get-Field $card 'owner'
            throw "$Id is '$status' (owner: $(if ($owner) { $owner } else { 'none' })). Pick another card."
        }
        Set-Field $card 'status' 'claimed'
        Set-Field $card 'owner' $Session
        Set-Field $card 'claimed_at' $Stamp
        Add-Log $card "$Stamp | $Session | claimed"
        Save-Board $card "board: claim $Id ($Session)"
        $branch = Get-Field $card 'branch'
        Write-Host "claimed $Id" -ForegroundColor Green
        Write-Host "next:  git worktree add ../otondev-$Id -b $branch" -ForegroundColor Cyan
    }

    'release' {
        $card = Get-CardPath $Id
        $owner = Get-Field $card 'owner'
        Set-Field $card 'status' 'available'
        Set-Field $card 'owner' ''
        Set-Field $card 'claimed_at' ''
        $why = if ($Note) { $Note } else { 'no reason given' }
        Add-Log $card "$Stamp | $owner | released - $why"
        Save-Board $card "board: release $Id"
        Write-Host "released $Id" -ForegroundColor Yellow
    }

    'finish' {
        $card = Get-CardPath $Id
        $open = @([regex]::Matches((Read-Text $card), '(?m)^\s*-\s\[ \]')).Count
        if ($open -gt 0 -and -not $Force) {
            throw "$Id still has $open unchecked exit criteria. Tick them, or pass -Force and say why in -Note."
        }
        Set-Field $card 'status' 'in-review'
        $who = Get-Field $card 'owner'
        $why = if ($Note) { $Note } else { 'exit criteria met' }
        Add-Log $card "$Stamp | $who | finished - $why"
        Save-Board $card "board: finish $Id"
        Write-Host "$Id -> in-review" -ForegroundColor Green
        if ($Id -match '^(S04|S05|S10)$') {
            Write-Warning "$Id is security-critical: independent review required before 'done' (impl plan section 7)."
        }
    }

    'fake' {
        $card = Get-CardPath $Id
        Set-Field $card 'fake' 'yes'
        Add-Log $card "$Stamp | $(Get-Field $card 'owner') | fake published - downstream may depend on it"
        Save-Board $card "board: $Id fake published"
        Write-Host "$Id fake published" -ForegroundColor Green
    }

    'block' {
        $card = Get-CardPath $Id
        Set-Field $card 'status' 'blocked'
        Add-Log $card "$Stamp | - | blocked - $(if ($Note) { $Note } else { 'gate unmet' })"
        Save-Board $card "board: block $Id"
    }

    'unblock' {
        $card = Get-CardPath $Id
        Set-Field $card 'status' 'available'
        Add-Log $card "$Stamp | - | gate cleared - $(if ($Note) { $Note } else { 'now available' })"
        Save-Board $card "board: unblock $Id"
    }

    'request' {
        if (-not $Note) { throw 'request requires -Note describing what you need and why' }
        $slug = ($Note.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
        if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
        $file = Join-Path $ReqDir ((Get-Date -Format 'yyyy-MM-dd') + "-$Id-$slug.md")
        $body = @"
# Contract request - $Id

- **Raised:** $Stamp
- **Card:** $Id
- **Status:** open

## Need

$Note

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->
"@
        Write-Text $file $body
        Save-Board $file "board: contract request from $Id"
        Write-Host "raised $file" -ForegroundColor Green
        Write-Host 'do not block on this - record your assumption on the card and keep building' -ForegroundColor Cyan
    }
}

# Do not leak a native git exit code as the script's own result. Failures above either throw or exit 2.
exit 0
