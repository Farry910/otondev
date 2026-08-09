<#
.SYNOPSIS
    Delivery board CLI. Safe for many concurrent sessions.

.DESCRIPTION
    Board state lives on origin/main and is NEVER read from or written to a checked-out branch.

      reads  - git show origin/main:<card>      (no working tree touched at all)
      writes - a commit built with plumbing against a temp index, pushed straight to main

    Writes never check anything out. A checkout would take ~500ms and every millisecond of that is a
    window for another session to land first, which is how a busy board starves a session.

    Consequences that matter when several sessions run at once:
      * you can run this from any directory, any branch, any worktree
      * your working tree may be dirty; the board does not care and will not touch it
      * no shared index, so no index.lock contention between sessions
      * origin/main is the single serialization point; a rejected push is a lost race and is retried

.EXAMPLE
    .\board\scripts\board.ps1 status
    .\board\scripts\board.ps1 claim S7 -Session "kai-1"
    .\board\scripts\board.ps1 check S7 -Note "ambiguous timeout"
    .\board\scripts\board.ps1 finish S7
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'list', 'claim', 'release', 'finish', 'fake', 'check', 'block', 'unblock', 'request')]
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

$Stamp    = Get-Date -Format 'yyyy-MM-dd HH:mm'
$CardGlob = 'board/packages/'
$MaxTries = 8

# --- git plumbing -----------------------------------------------------------------------------------
# git writes ordinary progress to stderr. Under $ErrorActionPreference = 'Stop' that becomes a
# terminating NativeCommandError before any exit-code check runs, so every call goes through here.
function Invoke-Git([string[]]$GitArgs, [string]$Dir) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Dir) { & git -C $Dir @GitArgs | Out-Null } else { & git @GitArgs | Out-Null }
    } finally { $ErrorActionPreference = $prev }
    return $LASTEXITCODE
}

function Get-GitOut([string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & git @GitArgs } finally { $ErrorActionPreference = $prev }
    return $out
}

function Write-Text([string]$path, [string]$content) {
    # LF + UTF-8 without BOM, matching .gitattributes.
    [System.IO.File]::WriteAllText($path, ($content -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# --- reading the board (never touches a working tree) -----------------------------------------------
function Sync-Remote {
    if ((Invoke-Git @('fetch', '--quiet', 'origin', 'main')) -ne 0) {
        Write-Warning 'could not reach origin; showing the last fetched board state'
        return $false
    }
    return $true
}

function Get-CardPaths {
    return @(Get-GitOut @('ls-tree', '--name-only', 'origin/main', $CardGlob) | Where-Object { $_ -like '*.md' })
}

function Read-Card([string]$path) {
    return ((Get-GitOut @('show', "origin/main:$path")) -join "`n")
}

function Resolve-CardPath([string]$cardId) {
    if (-not $cardId) { throw 'card id required, e.g. S7' }
    $hit = @(Get-CardPaths | Where-Object { [System.IO.Path]::GetFileName($_) -match "^$cardId-" })
    if ($hit.Count -eq 0) { throw "no card matching '$cardId'" }
    if ($hit.Count -gt 1) { throw "ambiguous card id '$cardId'" }
    return $hit[0]
}

function Get-Field([string]$content, [string]$name) {
    $m = [regex]::Match($content, "(?m)^$name\s*:\s*(.*)$")
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value.Trim().Trim('"')
}

function Set-Field([string]$content, [string]$name, [string]$value) {
    $safe = $value -replace '\$', '$$$$'
    return [regex]::Replace($content, "(?m)^$name\s*:\s*.*$", "${name}: $safe")
}

function Add-Log([string]$content, [string]$line) {
    return ($content.TrimEnd() + "`n- $line`n")
}

function Get-Title([string]$content) {
    return ((($content -split "`n")[0]) -replace '^#\s*', '')
}

# --- writing the board ------------------------------------------------------------------------------
# Compare-and-set against origin/main. The mutation is re-applied to freshly fetched state on every
# attempt, so a racing session cannot be silently overwritten - it either wins or gets a clean refusal.
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
    param(
        [string]$Path,           # repo-relative; resolved per attempt when -CardId is given
        [string]$CardId,
        [scriptblock]$Mutate,    # takes current content, returns new content, or throws to refuse
        [string]$Message,
        [switch]$IsNewFile
    )

    for ($attempt = 1; $attempt -le $MaxTries; $attempt++) {
        Sync-Remote | Out-Null

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

# --- status -----------------------------------------------------------------------------------------
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
            Stage  = Get-Field $c 'stage'
            File   = [System.IO.Path]::GetFileName($p)
        }
    }
    # W0 first, then S1..S20 numerically - not lexically, or S10 sorts before S2
    return ($rows | Sort-Object @{ Expression = {
        if ($_.Id -eq 'W0') { -1 } else { [int]($_.Id -replace '\D', '') }
    } })
}

function Show-Rows($rows) {
    $rows | Format-Table -AutoSize @{L = 'ID'; E = { $_.Id } },
                                  @{L = 'STATUS'; E = { $_.Status } },
                                  @{L = 'OWNER'; E = { if ($_.Owner) { $_.Owner } else { '-' } } },
                                  @{L = 'FAKE'; E = { $_.Fake } },
                                  @{L = 'GATE'; E = { $_.Gate } },
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
    foreach ($s in @('claimed', 'in-review', 'available', 'blocked', 'done')) {
        [void]$sb.AppendLine("- **$s**: " + @($rows | Where-Object { $_.Status -eq $s }).Count)
    }
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| ID | Package | Status | Owner | Fake | Gate | Stage |')
    [void]$sb.AppendLine('|---|---|---|---|---|---|---|')
    foreach ($r in $rows) {
        $owner = $r.Owner; if (-not $owner) { $owner = '-' }
        [void]$sb.AppendLine("| [$($r.Id)](packages/$($r.File)) | $($r.Title) | ``$($r.Status)`` | $owner | $($r.Fake) | $($r.Gate) | $($r.Stage) |")
    }
    Write-Text $out $sb.ToString()
}

# --- commands ---------------------------------------------------------------------------------------
switch ($Command) {

    { $_ -in 'status', 'list' } {
        Sync-Remote | Out-Null
        $rows = Get-Rows
        Show-Rows $rows
        if ($Command -eq 'status') { Update-Status $rows }
    }

    'claim' {
        if (-not $Session) { throw 'claim requires -Session, e.g. -Session "kai-1"' }
        $branch = ''
        Invoke-BoardWrite -CardId $Id -Message "board: claim $Id ($Session)" -Mutate {
            param($c)
            $st = Get-Field $c 'status'
            if ($st -ne 'available') {
                $o = Get-Field $c 'owner'
                if (-not $o) { $o = 'none' }
                throw "$Id is '$st' (owner: $o). Pick another card."
            }
            $script:branch = Get-Field $c 'branch'
            $c = Set-Field $c 'status' 'claimed'
            $c = Set-Field $c 'owner' $Session
            $c = Set-Field $c 'claimed_at' $Stamp
            return (Add-Log $c "$Stamp | $Session | claimed")
        }
        Write-Host "claimed $Id" -ForegroundColor Green
        Write-Host "next:  git worktree add ../otondev-$Id -b $script:branch" -ForegroundColor Cyan
    }

    'release' {
        $why = if ($Note) { $Note } else { 'no reason given' }
        Invoke-BoardWrite -CardId $Id -Message "board: release $Id" -Mutate {
            param($c)
            $o = Get-Field $c 'owner'
            $c = Set-Field $c 'status' 'available'
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
            Write-Host ("ticked:" + ($lines[$hit] -replace '^\s*-\s\[x\]\s*', ' ')) -ForegroundColor Green
            return ($lines -join "`n")
        }
    }

    'finish' {
        Invoke-BoardWrite -CardId $Id -Message "board: finish $Id" -Mutate {
            param($c)
            $open = @([regex]::Matches($c, '(?m)^\s*-\s\[ \]')).Count
            if ($open -gt 0 -and -not $Force) {
                throw "$Id still has $open unchecked exit criteria. Tick them with 'check', or pass -Force with -Note."
            }
            $who = Get-Field $c 'owner'
            $why = if ($Note) { $Note } else { 'exit criteria met' }
            $c = Set-Field $c 'status' 'in-review'
            return (Add-Log $c "$Stamp | $who | finished - $why")
        }
        Write-Host "$Id -> in-review" -ForegroundColor Green
        if ($Id -match '^(S4|S5|S10)$') {
            Write-Warning "$Id is security-critical: independent review required before 'done' (impl plan section 7)."
        }
    }

    'fake' {
        Invoke-BoardWrite -CardId $Id -Message "board: $Id fake published" -Mutate {
            param($c)
            $c = Set-Field $c 'fake' 'yes'
            return (Add-Log $c "$Stamp | $(Get-Field $c 'owner') | fake published - downstream may depend on it")
        }
        Write-Host "$Id fake published" -ForegroundColor Green
    }

    'block' {
        $why = if ($Note) { $Note } else { 'gate unmet' }
        Invoke-BoardWrite -CardId $Id -Message "board: block $Id" -Mutate {
            param($c)
            $c = Set-Field $c 'status' 'blocked'
            return (Add-Log $c "$Stamp | - | blocked - $why")
        }
        Write-Host "$Id blocked" -ForegroundColor Yellow
    }

    'unblock' {
        $why = if ($Note) { $Note } else { 'gate cleared' }
        Invoke-BoardWrite -CardId $Id -Message "board: unblock $Id" -Mutate {
            param($c)
            $c = Set-Field $c 'status' 'available'
            return (Add-Log $c "$Stamp | - | gate cleared - $why")
        }
        Write-Host "$Id available" -ForegroundColor Green
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

# Do not leak a native git exit code as the script's own result.
exit 0
