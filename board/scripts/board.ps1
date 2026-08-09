<#
.SYNOPSIS
    Delivery board CLI. Safe for many concurrent autonomous sessions.

.DESCRIPTION
    Board state lives on origin/main and is NEVER read from or written to a checked-out branch.

      reads  - git show origin/main:<card>      (no working tree touched at all)
      writes - a commit built with plumbing against a temp index, pushed straight to main

    Writes never check anything out. A checkout would take ~500ms and every millisecond of that is a
    window for another session to land first, which is how a busy board starves a session.

    Availability is DERIVED, never stored: a card is available when its status is 'todo', its external
    gate is cleared, and every card in depends_on is 'done'. So finishing W0 makes Wave 1 claimable with
    no human step.

.EXAMPLE
    .\board\scripts\board.ps1 next                 # pick + claim the best available card, atomically
    .\board\scripts\board.ps1 check S7 -Note "ambiguous timeout"
    .\board\scripts\board.ps1 finish S7
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('next', 'status', 'list', 'claim', 'release', 'finish', 'approve', 'fake', 'check', 'clear-gate', 'request')]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [string]$Id,

    [string]$Session,
    [string]$Note,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Keep this file pure ASCII. PowerShell 5.1 decodes a BOM-less .ps1 as the system ANSI codepage, so a
# non-ASCII literal here is silently mangled on the way into generated output.
# Native git output is decoded using this, so without it every em-dash in a card comes back corrupted.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Stamp     = Get-Date -Format 'yyyy-MM-dd HH:mm'
$CardGlob  = 'board/packages/'
$MaxTries  = 8
$NeedsReview = '^(S4|S5|S10)$'   # security-critical: finish stops at in-review, never self-approves

# --- git plumbing -----------------------------------------------------------------------------------
# git writes ordinary progress to stderr. Under $ErrorActionPreference = 'Stop' that becomes a
# terminating NativeCommandError before any exit-code check runs, so every call goes through here.
function Invoke-Git([string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @GitArgs | Out-Null } finally { $ErrorActionPreference = $prev }
    return $LASTEXITCODE
}

function Get-GitOut([string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & git @GitArgs } finally { $ErrorActionPreference = $prev }
    return $out
}

function Write-Text([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, ($content -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# --- reading (never touches a working tree) ---------------------------------------------------------
function Sync-Remote {
    if ((Invoke-Git @('fetch', '--quiet', 'origin', 'main')) -ne 0) {
        Write-Warning 'could not reach origin; showing the last fetched board state'
    }
}

function Get-CardPaths {
    return @(Get-GitOut @('ls-tree', '--name-only', 'origin/main', $CardGlob) | Where-Object { $_ -like '*.md' })
}

function Read-Card([string]$path) { return ((Get-GitOut @('show', "origin/main:$path")) -join "`n") }

function Resolve-CardPath([string]$cardId) {
    if (-not $cardId) { throw 'card id required, e.g. S7' }
    $hit = @(Get-CardPaths | Where-Object { [System.IO.Path]::GetFileName($_) -match "^$cardId-" })
    if ($hit.Count -eq 0) { throw "no card matching '$cardId'" }
    if ($hit.Count -gt 1) { throw "ambiguous card id '$cardId'" }
    return $hit[0]
}

# [ \t] not \s: in .NET regex \s matches newlines, so ':\s*' swallows the line break when a field's
# value is empty and captures the NEXT line - and Set-Field would overwrite it.
function Get-Field([string]$content, [string]$name) {
    $m = [regex]::Match($content, "(?m)^$name[ \t]*:[ \t]*(.*)$")
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value.Trim().Trim('"')
}

function Set-Field([string]$content, [string]$name, [string]$value) {
    $safe = $value -replace '\$', '$$$$'
    return [regex]::Replace($content, "(?m)^$name[ \t]*:[ \t]*.*$", "${name}: $safe")
}

function Add-Log([string]$content, [string]$line) { return ($content.TrimEnd() + "`n- $line`n") }
function Get-Title([string]$content) { return ((($content -split "`n")[0]) -replace '^#\s*', '') }

# --- writing ----------------------------------------------------------------------------------------
# Builds a one-file commit on top of origin/main using a temp index - no checkout, no working tree.
# Returns $true if it landed, $false if another session pushed first.
function New-BoardCommit([string]$Path, [string]$Content, [string]$Message) {
    $tmp = [System.IO.Path]::GetTempPath()
    $blobFile = Join-Path $tmp ('board-blob-' + [guid]::NewGuid().ToString('N').Substring(0, 10))
    $idxFile  = Join-Path $tmp ('board-idx-'  + [guid]::NewGuid().ToString('N').Substring(0, 10))
    $prevIdx  = $env:GIT_INDEX_FILE

    Write-Text $blobFile $Content
    $env:GIT_INDEX_FILE = $idxFile
    try {
        if ((Invoke-Git @('read-tree', 'origin/main')) -ne 0) { throw 'read-tree against origin/main failed' }

        $blob = (Get-GitOut @('hash-object', '-w', '--path', $Path, '--', $blobFile) | Select-Object -First 1)
        if (-not $blob) { throw 'could not write the card blob' }

        if ((Invoke-Git @('update-index', '--add', '--cacheinfo', "100644,$($blob.Trim()),$Path")) -ne 0) {
            throw 'update-index failed'
        }

        $tree   = (Get-GitOut @('write-tree') | Select-Object -First 1)
        $parent = (Get-GitOut @('rev-parse', 'origin/main') | Select-Object -First 1)
        $commit = (Get-GitOut @('commit-tree', $tree.Trim(), '-p', $parent.Trim(), '-m', $Message) | Select-Object -First 1)
        if (-not $commit) { throw 'commit-tree failed' }

        # "${x}:main" - "$commit:main" would parse as a scope qualifier and silently push the wrong ref
        return ((Invoke-Git @('push', '--quiet', 'origin', ('{0}:main' -f $commit.Trim()))) -eq 0)
    } finally {
        $env:GIT_INDEX_FILE = $prevIdx
        Remove-Item $blobFile, $idxFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-BoardWrite {
    param([string]$Path, [string]$CardId, [scriptblock]$Mutate, [string]$Message, [switch]$IsNewFile)

    for ($attempt = 1; $attempt -le $MaxTries; $attempt++) {
        Sync-Remote

        if ($CardId) { $Path = Resolve-CardPath $CardId }
        $current = ''
        if (-not $IsNewFile) { $current = Read-Card $Path }

        $updated = & $Mutate $current      # throws on a refused precondition

        if (New-BoardCommit $Path $updated $Message) { return }

        # Exponential backoff with jitter. Without the jitter, two sessions that collide once tend to
        # keep colliding in lockstep.
        $wait = [Math]::Min(2000, 50 * [Math]::Pow(2, $attempt)) + (Get-Random -Minimum 0 -Maximum 250)
        Write-Warning ("another session pushed first (attempt {0} of {1}); retrying in {2} ms" -f $attempt, $MaxTries, [int]$wait)
        Start-Sleep -Milliseconds ([int]$wait)
    }
    throw "could not land the board change after $MaxTries attempts. The board is unusually busy; retry in a moment."
}

# --- derived state ----------------------------------------------------------------------------------
function Get-Rows {
    $rows = @()
    foreach ($p in Get-CardPaths) {
        $c = Read-Card $p
        $rows += [pscustomobject]@{
            Id     = Get-Field $c 'id'
            Title  = Get-Title $c
            Status = Get-Field $c 'status'
            Owner  = Get-Field $c 'owner'
            Fake   = Get-Field $c 'fake'
            Gate   = Get-Field $c 'gate'
            GateOk = ((Get-Field $c 'gate_cleared') -eq 'yes')
            Deps   = @((Get-Field $c 'depends_on') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            Stage  = [int](Get-Field $c 'stage')
            File   = [System.IO.Path]::GetFileName($p)
            State  = ''
            Reason = ''
            Weight = 0
        }
    }

    $byId = @{}
    foreach ($r in $rows) { $byId[$r.Id] = $r }

    foreach ($r in $rows) {
        if ($r.Status -ne 'todo') { $r.State = $r.Status; continue }
        if (-not $r.GateOk) { $r.State = 'gated'; $r.Reason = $r.Gate; continue }
        $pending = @($r.Deps | Where-Object { -not $byId.ContainsKey($_) -or $byId[$_].Status -ne 'done' })
        if ($pending.Count -gt 0) { $r.State = 'waiting'; $r.Reason = ($pending -join ',') ; continue }
        $r.State = 'available'
    }

    # Weight = how many cards this one unblocks; used to prefer the work that frees the most sessions.
    foreach ($r in $rows) { foreach ($d in $r.Deps) { if ($byId.ContainsKey($d)) { $byId[$d].Weight++ } } }

    # W0 first, then S1..S20 numerically - not lexically, or S10 sorts before S2
    return ($rows | Sort-Object @{ Expression = {
        if ($_.Id -eq 'W0') { -1 } else { [int]($_.Id -replace '\D', '') }
    } })
}

function Show-Rows($rows) {
    $rows | Format-Table -AutoSize @{L = 'ID'; E = { $_.Id } },
                                  @{L = 'STATE'; E = { $_.State } },
                                  @{L = 'WHY'; E = { $_.Reason } },
                                  @{L = 'OWNER'; E = { if ($_.Owner) { $_.Owner } else { '-' } } },
                                  @{L = 'FAKE'; E = { $_.Fake } },
                                  @{L = 'PACKAGE'; E = { $_.Title } }
}

function Update-Status($rows) {
    $top = Get-GitOut @('rev-parse', '--show-toplevel')
    if (-not $top) { return }
    $out = Join-Path ($top -replace '/', '\') 'board\STATUS.md'
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# Board status')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("_Generated $Stamp from origin/main by ``board.ps1 status``. Do not edit; git-ignored._")
    [void]$sb.AppendLine()
    foreach ($s in @('claimed', 'in-review', 'available', 'waiting', 'gated', 'done')) {
        [void]$sb.AppendLine("- **$s**: " + @($rows | Where-Object { $_.State -eq $s }).Count)
    }
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| ID | Package | State | Why | Owner | Fake | Stage |')
    [void]$sb.AppendLine('|---|---|---|---|---|---|---|')
    foreach ($r in $rows) {
        $owner = $r.Owner; if (-not $owner) { $owner = '-' }
        [void]$sb.AppendLine("| [$($r.Id)](packages/$($r.File)) | $($r.Title) | ``$($r.State)`` | $($r.Reason) | $owner | $($r.Fake) | $($r.Stage) |")
    }
    Write-Text $out $sb.ToString()
}

function Set-CardStatus([string]$cardId, [string]$to, [string]$who, [string]$note, [string]$from) {
    Invoke-BoardWrite -CardId $cardId -Message "board: $cardId -> $to" -Mutate {
        param($c)
        if ($from -and (Get-Field $c 'status') -ne $from) {
            throw "$cardId is '$(Get-Field $c 'status')', not '$from'."
        }
        $c = Set-Field $c 'status' $to
        return (Add-Log $c "$Stamp | $who | $note")
    }
}

function Try-Claim([string]$cardId, [string]$who) {
    try {
        Invoke-BoardWrite -CardId $cardId -Message "board: claim $cardId ($who)" -Mutate {
            param($c)
            if ((Get-Field $c 'status') -ne 'todo') { throw 'taken' }
            $c = Set-Field $c 'status' 'claimed'
            $c = Set-Field $c 'owner' $who
            $c = Set-Field $c 'claimed_at' $Stamp
            return (Add-Log $c "$Stamp | $who | claimed")
        }
        return $true
    } catch { return $false }
}

function Show-Claimed([string]$cardId, [string]$who) {
    $card = Read-Card (Resolve-CardPath $cardId)
    Write-Host ""
    Write-Host "CLAIMED $cardId - $(Get-Title $card)" -ForegroundColor Green
    Write-Host "session: $who" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  git worktree add ../otondev-$cardId -b $(Get-Field $card 'branch')" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "then read board/packages/$([System.IO.Path]::GetFileName((Resolve-CardPath $cardId))) and only the docs it links." -ForegroundColor DarkGray
}

# --- commands ---------------------------------------------------------------------------------------
switch ($Command) {

    { $_ -in 'status', 'list' } {
        Sync-Remote
        $rows = Get-Rows
        Show-Rows $rows
        if ($Command -eq 'status') { Update-Status $rows }
    }

    'next' {
        if (-not $Session) { $Session = 'auto-' + [guid]::NewGuid().ToString('N').Substring(0, 6) }
        Sync-Remote
        $rows = Get-Rows

        $mine = @($rows | Where-Object { $_.State -eq 'claimed' -and $_.Owner -eq $Session })
        if ($mine.Count -gt 0) {
            Write-Host "you already hold $($mine[0].Id). Finish or release it before taking another." -ForegroundColor Yellow
            exit 4
        }

        # Prefer the earliest stage, then whatever unblocks the most other cards. Random tiebreak so
        # simultaneous sessions spread across candidates instead of all colliding on the same one.
        $cands = @($rows | Where-Object { $_.State -eq 'available' } |
                   Sort-Object @{E = { $_.Stage } }, @{E = { -$_.Weight } }, @{E = { Get-Random } })

        if ($cands.Count -eq 0) {
            Write-Host 'nothing available right now.' -ForegroundColor Yellow
            $w = @($rows | Where-Object { $_.State -eq 'waiting' })
            $g = @($rows | Where-Object { $_.State -eq 'gated' })
            $c = @($rows | Where-Object { $_.State -eq 'claimed' })
            if ($c.Count) { Write-Host "  in flight: $(($c | ForEach-Object { "$($_.Id)($($_.Owner))" }) -join ', ')" }
            if ($w.Count) { Write-Host "  waiting on dependencies: $(($w | ForEach-Object { "$($_.Id)<-$($_.Reason)" }) -join ', ')" }
            if ($g.Count) { Write-Host "  gated (needs a human decision): $(($g | ForEach-Object { "$($_.Id)<-$($_.Reason)" }) -join ', ')" }
            exit 3
        }

        foreach ($cand in $cands) {
            if (Try-Claim $cand.Id $Session) { Show-Claimed $cand.Id $Session; exit 0 }
            Write-Host "$($cand.Id) was taken; trying the next candidate" -ForegroundColor DarkGray
        }
        Write-Host 'every available card was taken while picking. Run next again.' -ForegroundColor Yellow
        exit 3
    }

    'claim' {
        if (-not $Session) { $Session = 'auto-' + [guid]::NewGuid().ToString('N').Substring(0, 6) }
        $row = @(Get-Rows | Where-Object { $_.Id -eq $Id })
        if ($row.Count -eq 1 -and $row[0].State -ne 'available' -and -not $Force) {
            throw "$Id is '$($row[0].State)'$(if ($row[0].Reason) { " ($($row[0].Reason))" }). Use 'next' to take claimable work."
        }
        if (-not (Try-Claim $Id $Session)) { throw "$Id was claimed by another session first." }
        Show-Claimed $Id $Session
    }

    'release' {
        $why = if ($Note) { $Note } else { 'no reason given' }
        Invoke-BoardWrite -CardId $Id -Message "board: release $Id" -Mutate {
            param($c)
            $o = Get-Field $c 'owner'
            $c = Set-Field $c 'status' 'todo'
            $c = Set-Field $c 'owner' ''
            $c = Set-Field $c 'claimed_at' ''
            return (Add-Log $c "$Stamp | $o | released - $why")
        }
        Write-Host "released $Id" -ForegroundColor Yellow
    }

    'check' {
        if (-not $Note) { throw 'check requires -Note with text from the exit criterion to tick' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id criterion met" -Mutate {
            param($c)
            $lines = $c -split "`n"
            $hit = -1
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -match '^\s*-\s\[ \]' -and $lines[$i] -like "*$Note*") { $hit = $i; break }
            }
            if ($hit -lt 0) { throw "no unchecked criterion on $Id matching '$Note'" }
            $lines[$hit] = $lines[$hit] -replace '\[ \]', '[x]'
            return ($lines -join "`n")
        }
        Write-Host "ticked on $Id" -ForegroundColor Green
    }

    'finish' {
        $review = $Id -match $NeedsReview
        $to = if ($review) { 'in-review' } else { 'done' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id -> $to" -Mutate {
            param($c)
            $open = @([regex]::Matches($c, '(?m)^\s*-\s\[ \]')).Count
            if ($open -gt 0 -and -not $Force) {
                throw "$Id still has $open unchecked exit criteria. Tick them with 'check', or pass -Force with -Note."
            }
            $who = Get-Field $c 'owner'
            $why = if ($Note) { $Note } else { 'exit criteria met' }
            $c = Set-Field $c 'status' $to
            return (Add-Log $c "$Stamp | $who | $to - $why")
        }
        Write-Host "$Id -> $to" -ForegroundColor Green
        if ($review) {
            Write-Warning "$Id is security-critical and does NOT self-approve. A separate session or a human must run: board.ps1 approve $Id"
        } else {
            $freed = @(Get-Rows | Where-Object { $_.State -eq 'available' })
            Write-Host "cards now available: $($freed.Count)" -ForegroundColor Cyan
        }
    }

    'approve' {
        $who = if ($Session) { $Session } else { 'reviewer' }
        Set-CardStatus $Id 'done' $who ("approved - " + $(if ($Note) { $Note } else { 'independent review passed' })) 'in-review'
        Write-Host "$Id -> done" -ForegroundColor Green
    }

    'clear-gate' {
        $why = if ($Note) { $Note } else { 'gate cleared' }
        Invoke-BoardWrite -CardId $Id -Message "board: clear gate on $Id" -Mutate {
            param($c)
            $c = Set-Field $c 'gate_cleared' 'yes'
            return (Add-Log $c "$Stamp | - | gate '$(Get-Field $c 'gate')' cleared - $why")
        }
        Write-Host "$Id gate cleared" -ForegroundColor Green
    }

    'fake' {
        Invoke-BoardWrite -CardId $Id -Message "board: $Id fake published" -Mutate {
            param($c)
            $c = Set-Field $c 'fake' 'yes'
            return (Add-Log $c "$Stamp | $(Get-Field $c 'owner') | fake published - downstream may depend on it")
        }
        Write-Host "$Id fake published" -ForegroundColor Green
    }

    'request' {
        if (-not $Note) { throw 'request requires -Note describing what you need and why' }
        $slug = ($Note.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
        if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
        $path = 'board/requests/' + (Get-Date -Format 'yyyy-MM-dd') + "-$Id-$slug.md"
        Invoke-BoardWrite -Path $path -IsNewFile -Message "board: contract request from $Id" -Mutate {
            param($c)
            return @"
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
        }
        Write-Host "raised $path" -ForegroundColor Green
        Write-Host 'do not block on this - record your assumption on the card and keep building' -ForegroundColor Cyan
    }
}

exit 0
