<#
.SYNOPSIS
    Delivery board CLI. Safe for many concurrent autonomous sessions, and built so a session that
    collides with another session keeps working instead of stopping.

.DESCRIPTION
    Board state lives on origin/main and is NEVER read from or written to a checked-out branch.

      reads  - git show origin/main:<card>      (no working tree touched at all)
      writes - a commit built with plumbing against a temp index, pushed straight to main

    Writes never check anything out. A checkout would take ~500ms and every millisecond of that is a
    window for another session to land first, which is how a busy board starves a session.

    Availability is DERIVED, never stored: a card is available when its status is 'todo', its external
    gate is cleared, and every card in depends_on is 'done'. So finishing W0 makes Wave 1 claimable with
    no human step.

    'next' NEVER gives up on the first collision. It reads live agent status, scores every available
    card, and walks the whole ranked list; if all of them are taken it looks for review work, reaps
    claims whose owner has gone silent, and can park and poll rather than exiting. A session stops only
    when the board can prove there is nothing left that does not need a human.

.EXAMPLE
    .\board\scripts\board.ps1 agents                # who is working on what, right now
    .\board\scripts\board.ps1 next                  # pick + claim the best non-conflicting card
    .\board\scripts\board.ps1 next -DryRun          # show the ranking and the pick, claim nothing
    .\board\scripts\board.ps1 next -Wait            # never stop: park and poll until work appears
    .\board\scripts\board.ps1 beat S7               # I am still alive on S7
    .\board\scripts\board.ps1 finish S7
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('next', 'status', 'list', 'agents', 'claim', 'release', 'finish', 'approve',
                 'review', 'fake', 'check', 'uncheck', 'beat', 'reap', 'block', 'unblock',
                 'clear-gate', 'request', 'requests', 'resolve')]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [string]$Id,

    [string]$Session,
    [string]$Note,

    [int]$StaleMinutes   = 120,   # no sign of life for this long => the claim may be reaped
    [int]$QuietMinutes   = 20,    # no sign of life for this long => shown as 'quiet', still protected
    [int]$WaitSeconds    = 60,    # -Wait poll interval
    [int]$MaxWaitMinutes = 30,    # -Wait ceiling, so a parked session cannot hang forever

    [switch]$Wait,
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Keep this file pure ASCII. PowerShell 5.1 decodes a BOM-less .ps1 as the system ANSI codepage, so a
# non-ASCII literal here is silently mangled on the way into generated output.
# Native git output is decoded using this, so without it every em-dash in a card comes back corrupted.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Stamp       = Get-Date -Format 'yyyy-MM-dd HH:mm'
$Now         = Get-Date
$CardGlob    = 'board/packages/'
$MaxTries    = 8
$NeedsReview = '^(S4|S5|S10)$'   # security-critical: finish stops at in-review, never self-approves
$WipCeiling  = 10                # implementation plan section 6: beyond this, contract queueing dominates

# --- git plumbing -----------------------------------------------------------------------------------
# git writes ordinary progress to stderr. Under $ErrorActionPreference = 'Stop' that becomes a
# terminating NativeCommandError before any exit-code check runs, so every call goes through here.
# A rejected push is the compare-and-set working, and git reports it on stderr. Both streams are
# swallowed and only $LASTEXITCODE is trusted: without this, every lost race prints a wall of red
# NativeCommandError text and a working board looks like a broken one.
function Invoke-Git([string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @GitArgs 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
    return $LASTEXITCODE
}

function Get-GitOut([string[]]$GitArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & git @GitArgs 2>$null } finally { $ErrorActionPreference = $prev }
    return $out
}

function Write-Text([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, ($content -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# --- session identity -------------------------------------------------------------------------------
# A session is one worktree. Deriving the id from the worktree path makes it STABLE across invocations,
# which is what lets 'you already hold a card' work and lets a stale claim be attributed to a real
# session instead of guessed at. The old behaviour - a fresh random id per run - made both impossible.
function Get-SessionId {
    if ($Session) { return $Session }
    if ($env:BOARD_SESSION) { return $env:BOARD_SESSION }

    $top = (Get-GitOut @('rev-parse', '--show-toplevel') | Select-Object -First 1)
    if (-not $top) { $top = (Get-Location).Path }
    $key = ([string]$top).ToLower() -replace '\\', '/'

    $md5  = [System.Security.Cryptography.MD5]::Create()
    $hash = ([BitConverter]::ToString($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))) -replace '-', '').Substring(0, 8).ToLower()

    $dir = Join-Path ([System.IO.Path]::GetTempPath()) 'otondev-board'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $file = Join-Path $dir "$hash.session"
    if (Test-Path $file) {
        $existing = (Get-Content $file -Raw).Trim()
        if ($existing) { return $existing }
    }
    $name = 'agent-' + $hash
    Write-Text $file $name
    return $name
}

$Me = Get-SessionId

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
    if ([regex]::IsMatch($content, "(?m)^$name[ \t]*:[ \t]*.*$")) {
        return [regex]::Replace($content, "(?m)^$name[ \t]*:[ \t]*.*$", "${name}: $safe")
    }
    # Field absent - cards written before this field existed. Insert it at the end of the yaml block
    # rather than failing, so old and new cards stay interchangeable.
    $lines = $content -split "`n"
    $open = -1; $close = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*```yaml\s*$') { $open = $i; continue }
        if ($open -ge 0 -and $lines[$i] -match '^\s*```\s*$') { $close = $i; break }
    }
    if ($close -lt 0) { return $content }
    $head = $lines[0..($close - 1)]
    $tail = $lines[$close..($lines.Count - 1)]
    return ((@($head) + @("${name}: $value") + @($tail)) -join "`n")
}

function Add-Log([string]$content, [string]$line) { return ($content.TrimEnd() + "`n- $line`n") }
function Get-Title([string]$content) { return ((($content -split "`n")[0]) -replace '^#\s*', '') }

function Get-Stamp([string]$text) {
    if (-not $text) { return $null }
    $parsed = [datetime]::MinValue
    $ok = [datetime]::TryParseExact($text.Trim(), 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture,
                                    [Globalization.DateTimeStyles]::None, [ref]$parsed)
    if ($ok) { return $parsed }
    return $null
}

function Format-Age([Nullable[datetime]]$when) {
    if ($null -eq $when) { return '-' }
    $mins = [int]($Now - $when).TotalMinutes
    if ($mins -lt 0)   { return 'just now' }
    if ($mins -lt 60)  { return "${mins}m" }
    return ('{0}h{1:00}m' -f [int]($mins / 60), ($mins % 60))
}

# Path roots are a SOFT signal used only to spread agents apart. Cards state Owns in prose, so take the
# backticked tokens that look like paths and keep their first two segments.
function Get-PathRoots([string]$content) {
    $m = [regex]::Match($content, '(?m)^\*\*Owns\*\*(.*)$')
    $line = ''
    if ($m.Success) { $line = $m.Groups[1].Value }
    $explicit = Get-Field $content 'owns'
    if ($explicit) { $line = $line + ', ' + $explicit }

    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($tok in [regex]::Matches($line, '`([^`]+)`')) {
        $v = $tok.Groups[1].Value.Trim()
        if ($v -notlike '*/*') { continue }                     # e.g. a Postgres schema name, not a path
        $parts = @($v -split '/' | Where-Object { $_ -and $_ -ne '**' })
        if ($parts.Count -ge 2) { $roots.Add(($parts[0] + '/' + $parts[1])) }
        elseif ($parts.Count -eq 1) { $roots.Add($parts[0]) }
    }
    foreach ($tok in ($explicit -split ',')) {
        $v = $tok.Trim()
        if (-not $v -or $v -notlike '*/*') { continue }
        $parts = @($v -split '/' | Where-Object { $_ -and $_ -ne '**' })
        if ($parts.Count -ge 2) { $roots.Add(($parts[0] + '/' + $parts[1])) }
    }
    return @($roots | Select-Object -Unique)
}

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

# A refused precondition throws a BoardRefusal; anything else is a real fault and must not be mistaken
# for contention. Try-Claim relies on this distinction.
function New-Refusal([string]$message) {
    return (New-Object System.Management.Automation.RuntimeException ("BOARD-REFUSED: " + $message))
}
function Test-Refusal($err) { return ([string]$err) -like '*BOARD-REFUSED:*' }
function Get-RefusalText($err) { return (([string]$err) -replace '.*BOARD-REFUSED:\s*', '') }

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
        $hb = Get-Field $c 'heartbeat'
        $ca = Get-Field $c 'claimed_at'
        $seen = Get-Stamp $hb
        if ($null -eq $seen) { $seen = Get-Stamp $ca }   # cards written before heartbeat existed
        $rows += [pscustomobject]@{
            Id         = Get-Field $c 'id'
            Title      = Get-Title $c
            Status     = Get-Field $c 'status'
            Owner      = Get-Field $c 'owner'
            Reviewer   = Get-Field $c 'reviewer'
            Fake       = Get-Field $c 'fake'
            Gate       = Get-Field $c 'gate'
            GateOk     = ((Get-Field $c 'gate_cleared') -eq 'yes')
            ClearsGate = Get-Field $c 'clears_gate'
            BlockedOn  = Get-Field $c 'blocked_on'
            Deps       = @((Get-Field $c 'depends_on') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            Stage      = [int](Get-Field $c 'stage')
            Roots      = Get-PathRoots $c
            ClaimedAt  = Get-Stamp $ca
            Seen       = $seen
            File       = [System.IO.Path]::GetFileName($p)
            State      = ''
            Reason     = ''
            Weight     = 0
            Reach      = 0
            Contention = 0
            Liveness   = ''
        }
    }

    $byId = @{}
    foreach ($r in $rows) { $byId[$r.Id] = $r }

    foreach ($r in $rows) {
        if ($r.Status -eq 'blocked') { $r.State = 'blocked'; $r.Reason = $r.BlockedOn; continue }
        if ($r.Status -ne 'todo') { $r.State = $r.Status; continue }
        if (-not $r.GateOk) { $r.State = 'gated'; $r.Reason = $r.Gate; continue }
        $pending = @($r.Deps | Where-Object { -not $byId.ContainsKey($_) -or $byId[$_].Status -ne 'done' })
        if ($pending.Count -gt 0) { $r.State = 'waiting'; $r.Reason = ($pending -join ',') ; continue }
        $r.State = 'available'
    }

    # Direct unblock count, kept for the status view.
    foreach ($r in $rows) { foreach ($d in $r.Deps) { if ($byId.ContainsKey($d)) { $byId[$d].Weight++ } } }

    # Reach = how many cards this one frees TRANSITIVELY, counting both dependency edges and gate edges
    # (a spike that clears 'windows-spike' frees S16 and S17). This is the critical-path signal: it is
    # what makes an agent take the card that unlocks the most other agents, not merely the earliest one.
    $edges = @{}
    foreach ($r in $rows) { $edges[$r.Id] = (New-Object System.Collections.Generic.List[string]) }
    foreach ($r in $rows) {
        foreach ($d in $r.Deps) { if ($edges.ContainsKey($d)) { $edges[$d].Add($r.Id) } }
    }
    foreach ($r in $rows) {
        if (-not $r.ClearsGate -or $r.ClearsGate -eq 'none') { continue }
        foreach ($t in $rows) {
            if ($t.Gate -eq $r.ClearsGate -and -not $t.GateOk) { $edges[$r.Id].Add($t.Id) }
        }
    }
    foreach ($r in $rows) {
        $seenIds = New-Object 'System.Collections.Generic.HashSet[string]'
        $stack = New-Object System.Collections.Generic.Stack[string]
        foreach ($n in $edges[$r.Id]) { [void]$stack.Push($n) }
        while ($stack.Count -gt 0) {
            $n = $stack.Pop()
            if (-not $seenIds.Add($n)) { continue }
            if ($edges.ContainsKey($n)) { foreach ($m in $edges[$n]) { [void]$stack.Push($m) } }
        }
        $r.Reach = $seenIds.Count
    }

    # Liveness, and contention against work that is actually in flight.
    $inFlight = @($rows | Where-Object { $_.State -eq 'claimed' })
    foreach ($r in $rows) {
        if ($r.State -eq 'claimed') {
            $age = $null
            if ($null -ne $r.Seen) { $age = [int]($Now - $r.Seen).TotalMinutes }
            if     ($null -eq $age)          { $r.Liveness = 'unknown' }
            elseif ($age -ge $StaleMinutes)  { $r.Liveness = 'stale' }
            elseif ($age -ge $QuietMinutes)  { $r.Liveness = 'quiet' }
            else                             { $r.Liveness = 'live' }
        }
        foreach ($f in $inFlight) {
            if ($f.Id -eq $r.Id -or $f.Owner -eq $Me) { continue }
            foreach ($root in $r.Roots) { if ($f.Roots -contains $root) { $r.Contention++; break } }
        }
    }

    # W0 first, then the SP spikes, then S1..S20 numerically - not lexically, or S10 sorts before S2.
    # The prefix must be part of the key: bare digit extraction maps SP1 and S1 to the same slot.
    return ($rows | Sort-Object @{ Expression = {
        $n = [int]($_.Id -replace '\D', '')
        if     ($_.Id -eq 'W0')      { -1000 }
        elseif ($_.Id -like 'SP*')   { -100 + $n }
        else                         { $n }
    } })
}

function Show-Rows($rows) {
    $rows | Format-Table -AutoSize @{L = 'ID'; E = { $_.Id } },
                                  @{L = 'STATE'; E = { $_.State } },
                                  @{L = 'WHY'; E = { $_.Reason } },
                                  @{L = 'OWNER'; E = { if ($_.Owner) { $_.Owner } else { '-' } } },
                                  @{L = 'SEEN'; E = { if ($_.State -eq 'claimed') { Format-Age $_.Seen } else { '' } } },
                                  @{L = 'FAKE'; E = { $_.Fake } },
                                  @{L = 'FREES'; E = { if ($_.Reach) { $_.Reach } else { '' } } },
                                  @{L = 'PACKAGE'; E = { $_.Title } }
}

# The "look at the board first" view: who is working, on what, and how much room is left.
function Show-Agents($rows) {
    $busy = @($rows | Where-Object { $_.State -eq 'claimed' -or ($_.State -eq 'in-review' -and $_.Reviewer) })
    Write-Host ''
    if ($busy.Count -eq 0) {
        Write-Host 'agents: none active' -ForegroundColor DarkGray
    } else {
        $busy | Sort-Object Owner | Format-Table -AutoSize `
            @{L = 'AGENT'; E = { $o = $_.Owner; if ($_.State -eq 'in-review') { $o = $_.Reviewer }; if ($o -eq $Me) { "$o (me)" } else { $o } } },
            @{L = 'CARD'; E = { $_.Id } },
            @{L = 'ROLE'; E = { if ($_.State -eq 'in-review') { 'review' } else { 'build' } } },
            @{L = 'HELD'; E = { Format-Age $_.ClaimedAt } },
            @{L = 'LAST SEEN'; E = { Format-Age $_.Seen } },
            @{L = ' '; E = { $_.Liveness } },
            @{L = 'WORKING ON'; E = { $_.Title } },
            @{L = 'PATHS'; E = { ($_.Roots -join ' ') } }
    }

    $avail = @($rows | Where-Object { $_.State -eq 'available' }).Count
    $stale = @($rows | Where-Object { $_.Liveness -eq 'stale' }).Count
    $room  = $WipCeiling - $busy.Count
    Write-Host ("board: {0} active / {1} available / {2} room before the WIP ceiling of {3}" -f $busy.Count, $avail, [Math]::Max(0, $room), $WipCeiling) -ForegroundColor DarkGray
    if ($stale -gt 0) {
        Write-Host ("  {0} claim(s) with no sign of life for {1}+ min - 'reap' will return them" -f $stale, $StaleMinutes) -ForegroundColor Yellow
    }
    Write-Host ''
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
    foreach ($s in @('claimed', 'in-review', 'available', 'waiting', 'blocked', 'gated', 'done')) {
        [void]$sb.AppendLine("- **$s**: " + @($rows | Where-Object { $_.State -eq $s }).Count)
    }
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| ID | Package | State | Why | Owner | Last seen | Fake | Frees | Stage |')
    [void]$sb.AppendLine('|---|---|---|---|---|---|---|---|---|')
    foreach ($r in $rows) {
        $owner = $r.Owner; if (-not $owner) { $owner = '-' }
        $seen = ''; if ($r.State -eq 'claimed') { $seen = (Format-Age $r.Seen) + ' (' + $r.Liveness + ')' }
        [void]$sb.AppendLine("| [$($r.Id)](packages/$($r.File)) | $($r.Title) | ``$($r.State)`` | $($r.Reason) | $owner | $seen | $($r.Fake) | $($r.Reach) | $($r.Stage) |")
    }
    Write-Text $out $sb.ToString()
}

function Set-CardStatus([string]$cardId, [string]$to, [string]$who, [string]$note, [string]$from) {
    Invoke-BoardWrite -CardId $cardId -Message "board: $cardId -> $to" -Mutate {
        param($c)
        if ($from -and (Get-Field $c 'status') -ne $from) {
            throw (New-Refusal "$cardId is '$(Get-Field $c 'status')', not '$from'.")
        }
        $c = Set-Field $c 'status' $to
        return (Add-Log $c "$Stamp | $who | $note")
    }
}

# Returns 'claimed' | 'taken'. A real fault (network, malformed card) is rethrown, because reporting it
# as contention is how a broken board looks like a busy one.
function Try-Claim([string]$cardId, [string]$who) {
    try {
        Invoke-BoardWrite -CardId $cardId -Message "board: claim $cardId ($who)" -Mutate {
            param($c)
            if ((Get-Field $c 'status') -ne 'todo') { throw (New-Refusal 'taken') }
            $c = Set-Field $c 'status' 'claimed'
            $c = Set-Field $c 'owner' $who
            $c = Set-Field $c 'claimed_at' $Stamp
            $c = Set-Field $c 'heartbeat' $Stamp
            return (Add-Log $c "$Stamp | $who | claimed")
        }
        return 'claimed'
    } catch {
        if (Test-Refusal $_) { return 'taken' }
        throw
    }
}

function Try-Review([string]$cardId, [string]$who) {
    try {
        Invoke-BoardWrite -CardId $cardId -Message "board: review $cardId ($who)" -Mutate {
            param($c)
            if ((Get-Field $c 'status') -ne 'in-review') { throw (New-Refusal 'not in review') }
            if ((Get-Field $c 'owner') -eq $who) { throw (New-Refusal 'you built it; someone else reviews it') }
            $existing = Get-Field $c 'reviewer'
            if ($existing -and $existing -ne $who) { throw (New-Refusal "already being reviewed by $existing") }
            $c = Set-Field $c 'reviewer' $who
            $c = Set-Field $c 'heartbeat' $Stamp
            return (Add-Log $c "$Stamp | $who | took the independent review")
        }
        return 'claimed'
    } catch {
        if (Test-Refusal $_) { return 'taken' }
        throw
    }
}

function Show-Claimed([string]$cardId, [string]$who, $row) {
    $path = Resolve-CardPath $cardId
    $card = Read-Card $path
    Write-Host ""
    Write-Host "CLAIMED $cardId - $(Get-Title $card)" -ForegroundColor Green
    Write-Host "session: $who" -ForegroundColor DarkGray
    if ($row) {
        Write-Host ("why this one: stage $($row.Stage), frees $($row.Reach) card(s), $(if ($row.Contention) { "$($row.Contention) path overlap(s) with work in flight" } else { 'no path overlap with work in flight' })") -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "  git worktree add .worktrees/$cardId -b $(Get-Field $card 'branch')" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "then read board/packages/$([System.IO.Path]::GetFileName($path)) and only the docs it links." -ForegroundColor DarkGray
}

# Rank available work. Lower sorts first.
#   1. stage            - retire the earliest stage first
#   2. -Reach           - prefer the card that frees the most other agents (critical path)
#   3. Contention       - prefer paths nobody in flight is near, so two agents rarely meet
#   4. -fake urgency    - an unpublished fake that peers depend on is worth starting sooner
#   5. random           - so simultaneous sessions spread out instead of colliding on one card
function Sort-Candidates($cands) {
    return @($cands | Sort-Object `
        @{E = { $_.Stage } }, `
        @{E = { - $_.Reach } }, `
        @{E = { $_.Contention } }, `
        @{E = { if ($_.Fake -eq 'no') { - $_.Weight } else { 0 } } }, `
        @{E = { Get-Random } })
}

function Show-Ranking($cands) {
    Write-Host 'ranked candidates:' -ForegroundColor DarkGray
    $i = 1
    foreach ($c in $cands) {
        Write-Host ("  {0}. {1,-4} stage {2}  frees {3,-2}  overlap {4}  {5}" -f $i, $c.Id, $c.Stage, $c.Reach, $c.Contention, $c.Title) -ForegroundColor DarkGray
        $i++
    }
}

# Return one stale claim to the pool. Shared by 'next' and 'reap' so both apply the identical rule:
# only a claim silent past the TTL, never the caller's own, never on judgment.
function Invoke-Reap($row) {
    Write-Host ("{0} has had no sign of life for {1} (owner {2}); returning it to the pool" -f $row.Id, (Format-Age $row.Seen), $row.Owner) -ForegroundColor Yellow
    try {
        Invoke-BoardWrite -CardId $row.Id -Message "board: reap $($row.Id)" -Mutate {
            param($c)
            if ((Get-Field $c 'status') -ne 'claimed') { throw (New-Refusal 'no longer claimed') }
            $hb = Get-Field $c 'heartbeat'; if (-not $hb) { $hb = Get-Field $c 'claimed_at' }
            $o = Get-Field $c 'owner'
            $c = Set-Field $c 'status' 'todo'
            $c = Set-Field $c 'owner' ''
            $c = Set-Field $c 'claimed_at' ''
            return (Add-Log $c "$Stamp | $Me | reaped - owner $o last seen $hb, past the $StaleMinutes min TTL")
        }
    } catch {
        if (-not (Test-Refusal $_)) { throw }   # someone else reaped or reclaimed it first; fine
    }
}

# --- contract requests ------------------------------------------------------------------------------
function Get-RequestRows {
    $rows = @()
    foreach ($p in @(Get-GitOut @('ls-tree', '--name-only', 'origin/main', 'board/requests/'))) {
        if ($p -notlike '*.md' -or $p -like '*README.md') { continue }
        $c = ((Get-GitOut @('show', "origin/main:$p")) -join "`n")
        $status = 'open'
        $m = [regex]::Match($c, '(?m)^\s*-\s\*\*Status:\*\*\s*(.+)$')
        if ($m.Success) { $status = $m.Groups[1].Value.Trim() }
        $need = ''
        $n = [regex]::Match($c, '(?ms)^##\s*Need\s*$(.+?)^##')
        if ($n.Success) { $need = ($n.Groups[1].Value.Trim() -split "`n")[0].Trim() }
        $file = [System.IO.Path]::GetFileNameWithoutExtension($p)
        $card = ''
        $cm = [regex]::Match($file, '^\d{4}-\d{2}-\d{2}-([A-Za-z0-9]+)-')
        if ($cm.Success) { $card = $cm.Groups[1].Value }
        $rows += [pscustomobject]@{
            File = $file; Path = $p; Card = $card; Status = $status; Need = $need
            Date = ($file -replace '^(\d{4}-\d{2}-\d{2}).*', '$1')
        }
    }
    return $rows
}

function Show-Blockers($rows) {
    $w = @($rows | Where-Object { $_.State -eq 'waiting' })
    $g = @($rows | Where-Object { $_.State -eq 'gated' })
    $c = @($rows | Where-Object { $_.State -eq 'claimed' })
    $r = @($rows | Where-Object { $_.State -eq 'in-review' })
    if ($c.Count) { Write-Host "  in flight: $(($c | ForEach-Object { "$($_.Id)($($_.Owner),$($_.Liveness))" }) -join ', ')" }
    if ($r.Count) { Write-Host "  in review: $(($r | ForEach-Object { "$($_.Id)($(if ($_.Reviewer) { $_.Reviewer } else { 'unassigned' }))" }) -join ', ')" }
    if ($w.Count) { Write-Host "  waiting on dependencies: $(($w | ForEach-Object { "$($_.Id)<-$($_.Reason)" }) -join ', ')" }

    # Blocked cards are the ones a human must act on. Printed with the reason the discovering session
    # recorded, so the human does not have to read a card log to find out what is actually needed.
    $b = @($rows | Where-Object { $_.State -eq 'blocked' })
    if ($b.Count) {
        Write-Host "  blocked (needs a human to supply something):" -ForegroundColor Yellow
        foreach ($card in $b) {
            Write-Host ("    {0} - {1}" -f $card.Id, $(if ($card.Reason) { $card.Reason } else { 'no reason recorded' })) -ForegroundColor DarkGray
        }
        Write-Host "    unblock with: board.ps1 unblock <ID> -Note 'what changed'" -ForegroundColor DarkGray
    }

    if ($g.Count) {
        Write-Host "  gated (needs a human decision): $(($g | ForEach-Object { "$($_.Id)<-$($_.Reason)" }) -join ', ')" -ForegroundColor Yellow
        $gates = @($g | ForEach-Object { $_.Reason } | Select-Object -Unique)
        foreach ($gate in $gates) {
            $producer = @($rows | Where-Object { $_.ClearsGate -eq $gate })
            if ($producer.Count -and @($producer | Where-Object { $_.Status -ne 'done' }).Count) {
                Write-Host "    '$gate' is produced by $(($producer | ForEach-Object { $_.Id }) -join ',') - that card is the way to clear it" -ForegroundColor DarkGray
            } else {
                Write-Host "    '$gate' has no card that produces it; a human must run: board.ps1 clear-gate <ID> -Note '...'" -ForegroundColor DarkGray
            }
        }
    }

    # If an agent has run out of work, the open request queue is the other thing a human can act on.
    # Only computed here, on the rare exhausted path - it costs one git call per request file.
    $openReqs = @(Get-RequestRows | Where-Object { $_.Status -eq 'open' })
    if ($openReqs.Count) {
        Write-Host ("  {0} contract request(s) open and unresolved - see: board.ps1 requests" -f $openReqs.Count) -ForegroundColor Yellow
    }
}

# A refused precondition is an ordinary, expected answer - "someone else has it", "that criterion is not
# met yet" - and an agent must be able to tell it apart from a broken board without parsing a stack
# trace. Refusal exits 5 with one line; a real fault exits 1.
trap {
    if (Test-Refusal $_) {
        Write-Host ("refused: " + (Get-RefusalText $_)) -ForegroundColor Yellow
        exit 5
    }
    Write-Host ("board error: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

# --- commands ---------------------------------------------------------------------------------------
switch ($Command) {

    { $_ -in 'status', 'list' } {
        Sync-Remote
        $rows = @(Get-Rows)
        Show-Agents $rows
        Show-Rows $rows
        if ($Command -eq 'status') { Update-Status $rows }
    }

    'agents' {
        Sync-Remote
        Show-Agents @(Get-Rows)
    }

    'next' {
        $deadline = $Now.AddMinutes($MaxWaitMinutes)
        $round = 0

        while ($true) {
            $round++
            Sync-Remote
            $rows = @(Get-Rows)

            # 1. Always look at the board before choosing.
            if ($round -eq 1) { Show-Agents $rows }

            # 2. One card per session. Holding one is not a stall - it is the work.
            $mine = @($rows | Where-Object { $_.State -eq 'claimed' -and $_.Owner -eq $Me })
            if ($mine.Count -gt 0) {
                Write-Host "you already hold $($mine[0].Id) - finish or release it before taking another." -ForegroundColor Yellow
                Write-Host "  board.ps1 beat $($mine[0].Id)     # if you are still working it" -ForegroundColor DarkGray
                exit 4
            }
            $myReview = @($rows | Where-Object { $_.State -eq 'in-review' -and $_.Reviewer -eq $Me })
            if ($myReview.Count -gt 0) {
                Write-Host "you already hold the review on $($myReview[0].Id) - finish it with 'approve'." -ForegroundColor Yellow
                exit 4
            }

            # 3. Return anything whose owner has gone silent past the TTL, BEFORE picking. Reaping used
            #    to sit at the bottom of the ladder, which meant a stale claim was only collected when
            #    the board was otherwise empty - so a card abandoned mid-flight sat claimed for days
            #    while agents worked around it. Staleness is measured, so acting on it is not a guess.
            if (-not $DryRun) {
                $stale = @($rows | Where-Object { $_.State -eq 'claimed' -and $_.Liveness -eq 'stale' -and $_.Owner -ne $Me })
                if ($stale.Count -gt 0) {
                    foreach ($s in $stale) { Invoke-Reap $s }
                    continue
                }
            }

            # 4. Build work, best first, walking the WHOLE list. A card taken out from under us is not a
            #    reason to stop; it is a reason to take the next one.
            # @() is load-bearing: a function returning a one-element array has it unwrapped to a bare
            # object by PowerShell, and $obj.Count is then $null, so '-gt 0' is false. Without this the
            # board reports "nothing available" precisely when ONE card is left - the exact moment an
            # agent must not stop.
            $cands = @(Sort-Candidates @($rows | Where-Object { $_.State -eq 'available' }))
            if ($cands.Count -gt 0) {
                if ($DryRun) {
                    Show-Ranking $cands
                    Write-Host "would claim $($cands[0].Id) - $($cands[0].Title)" -ForegroundColor Green
                    exit 0
                }
                if ($cands.Count -gt 1) { Show-Ranking $cands }
                foreach ($cand in $cands) {
                    if ((Try-Claim $cand.Id $Me) -eq 'claimed') {
                        Show-Claimed $cand.Id $Me $cand
                        exit 0
                    }
                    Write-Host "$($cand.Id) was taken by another agent; moving to the next candidate" -ForegroundColor DarkGray
                }
                Write-Host 'every available card went to another agent while picking; re-reading the board' -ForegroundColor DarkGray
                continue
            }

            # 4. No build work. Independent review IS work, and S4/S5/S10 cannot finish without it.
            $reviews = @($rows | Where-Object { $_.State -eq 'in-review' -and -not $_.Reviewer -and $_.Owner -ne $Me })
            if ($reviews.Count -gt 0) {
                if ($DryRun) {
                    Write-Host "would take the independent review on $($reviews[0].Id)" -ForegroundColor Green
                    exit 0
                }
                foreach ($rv in $reviews) {
                    if ((Try-Review $rv.Id $Me) -eq 'claimed') {
                        Write-Host ""
                        Write-Host "REVIEW $($rv.Id) - $($rv.Title)" -ForegroundColor Green
                        Write-Host "session: $Me" -ForegroundColor DarkGray
                        Write-Host ""
                        Write-Host "This card is security-critical and its owner may not approve it. Verify every exit" -ForegroundColor DarkGray
                        Write-Host "criterion against the branch, then: board.ps1 approve $($rv.Id)" -ForegroundColor DarkGray
                        exit 0
                    }
                }
            }

            # 5. Genuinely nothing this agent can do without a human.
            Write-Host 'nothing this agent can start right now.' -ForegroundColor Yellow
            Show-Blockers $rows

            if ($Wait -and -not $DryRun) {
                if ((Get-Date) -ge $deadline) {
                    Write-Host "waited $MaxWaitMinutes min with no work appearing; stopping." -ForegroundColor Yellow
                    exit 3
                }
                Write-Host "parking for $WaitSeconds s and re-reading the board (until $($deadline.ToString('HH:mm')))" -ForegroundColor DarkGray
                Start-Sleep -Seconds $WaitSeconds
                continue
            }
            exit 3
        }
    }

    'claim' {
        Sync-Remote      # without this the state check runs against whatever was last fetched
        $row = @(Get-Rows | Where-Object { $_.Id -eq $Id })
        if ($row.Count -eq 1 -and $row[0].State -ne 'available' -and -not $Force) {
            throw "$Id is '$($row[0].State)'$(if ($row[0].Reason) { " ($($row[0].Reason))" }). Use 'next' to take claimable work."
        }
        if ((Try-Claim $Id $Me) -ne 'claimed') { throw "$Id was claimed by another session first." }
        Show-Claimed $Id $Me $(if ($row.Count -eq 1) { $row[0] } else { $null })
    }

    'review' {
        Sync-Remote
        if ((Try-Review $Id $Me) -ne 'claimed') { throw "could not take the review on $Id (see 'agents')." }
        Write-Host "$Id - you are the independent reviewer" -ForegroundColor Green
    }

    'beat' {
        Invoke-BoardWrite -CardId $Id -Message "board: $Id heartbeat" -Mutate {
            param($c)
            $o = Get-Field $c 'owner'
            $rv = Get-Field $c 'reviewer'
            if ($o -ne $Me -and $rv -ne $Me -and -not $Force) {
                throw (New-Refusal "$Id is held by '$o', not you ($Me).")
            }
            return (Set-Field $c 'heartbeat' $Stamp)
        }
        Write-Host "$Id heartbeat $Stamp" -ForegroundColor DarkGray
    }

    'reap' {
        Sync-Remote
        $rows = @(Get-Rows)
        # Never reap your own card: you are demonstrably alive, you are running this.
        $stale = @($rows | Where-Object { $_.State -eq 'claimed' -and $_.Liveness -eq 'stale' -and $_.Owner -ne $Me })
        if ($stale.Count -eq 0) {
            Write-Host "no claim has been silent for $StaleMinutes+ min; nothing to reap." -ForegroundColor DarkGray
            Show-Agents $rows
            exit 0
        }
        foreach ($s in $stale) { Invoke-Reap $s }
    }

    'release' {
        $why = if ($Note) { $Note } else { 'no reason given' }
        Invoke-BoardWrite -CardId $Id -Message "board: release $Id" -Mutate {
            param($c)
            $o = Get-Field $c 'owner'
            # Releasing someone else's live card is the single most damaging thing on this board, and it
            # has already happened here twice on a wrong liveness guess. Name yourself, or use 'reap'.
            if ($o -and $o -ne $Me -and -not $Force) {
                throw (New-Refusal ("$Id belongs to '$o', not you ($Me). If you are that session, pass -Session $o. " +
                                    "If it looks abandoned, use 'reap' - it releases only claims silent for ${StaleMinutes}+ min."))
            }
            $c = Set-Field $c 'status' 'todo'
            $c = Set-Field $c 'owner' ''
            $c = Set-Field $c 'claimed_at' ''
            $c = Set-Field $c 'heartbeat' ''   # a released card has no owner, so it has no sign of life
            return (Add-Log $c "$Stamp | $o | released - $why")
        }
        Write-Host "released $Id" -ForegroundColor Yellow
        Write-Host "if it is blocked on something only a human can supply, use 'block' instead - a plain" -ForegroundColor DarkGray
        Write-Host "release puts it straight back at the front of the queue for the next agent." -ForegroundColor DarkGray
    }

    # 'block' is the state the board was missing. A card released for an ordinary reason should go back
    # in the queue; a card that CANNOT progress until a human supplies something must not - or every
    # agent in turn claims it, rediscovers the same blocker, and releases. That happened here: SP3 was
    # claimed and released five times in 56 minutes, each session correctly concluding it needed a Ditto
    # licence token no agent can obtain.
    'block' {
        if (-not $Note) { throw 'block requires -Note stating exactly what a human must supply' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id blocked" -Mutate {
            param($c)
            $st = Get-Field $c 'status'
            if ($st -notin @('todo', 'claimed')) {
                throw (New-Refusal "$Id is '$st'; only a 'todo' or 'claimed' card can be blocked.")
            }
            $o = Get-Field $c 'owner'
            if ($o -and $o -ne $Me -and -not $Force) {
                throw (New-Refusal "$Id belongs to '$o', not you ($Me).")
            }
            $c = Set-Field $c 'status' 'blocked'
            $c = Set-Field $c 'blocked_on' $Note
            $c = Set-Field $c 'owner' ''
            $c = Set-Field $c 'claimed_at' ''
            $c = Set-Field $c 'heartbeat' ''
            return (Add-Log $c "$Stamp | $Me | blocked - $Note")
        }
        Write-Host "$Id -> blocked" -ForegroundColor Yellow
        Write-Host "'next' will not offer it again until a human runs: board.ps1 unblock $Id -Note '...'" -ForegroundColor DarkGray
    }

    'unblock' {
        $why = if ($Note) { $Note } else { 'unblocked' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id unblocked" -Mutate {
            param($c)
            if ((Get-Field $c 'status') -ne 'blocked') {
                throw (New-Refusal "$Id is '$(Get-Field $c 'status')', not 'blocked'.")
            }
            $was = Get-Field $c 'blocked_on'
            $c = Set-Field $c 'status' 'todo'
            $c = Set-Field $c 'blocked_on' ''
            return (Add-Log $c "$Stamp | $Me | unblocked - was '$was' - $why")
        }
        Write-Host "$Id -> todo (claimable again)" -ForegroundColor Green
    }

    'check' {
        if (-not $Note) { throw 'check requires -Note with text from the exit criterion to tick' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id criterion met" -Mutate {
            param($c)
            $lines = $c -split "`n"
            $hit = -1
            for ($i = 0; $i -lt $lines.Count; $i++) {
                # Literal, case-insensitive containment. -like would treat [ ] * ? in criterion text as
                # wildcards, and several criteria contain them.
                if ($lines[$i] -match '^\s*-\s\[ \]' -and
                    $lines[$i].IndexOf($Note, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $i; break }
            }
            if ($hit -lt 0) { throw (New-Refusal "no unchecked criterion on $Id matching '$Note'") }
            $lines[$hit] = $lines[$hit] -replace '\[ \]', '[x]'
            $c = ($lines -join "`n")
            return (Set-Field $c 'heartbeat' $Stamp)
        }
        Write-Host "ticked on $Id" -ForegroundColor Green
    }

    # The checkboxes are what every other session trusts, so a tick made in error has to be correctable.
    # Without this the only remedy was a note in the card log contradicting the checkbox - which happened
    # on SP3, leaving the card claiming a criterion its own FINDINGS.md said was never tested.
    'uncheck' {
        if (-not $Note) { throw 'uncheck requires -Note with text from the criterion to untick' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id criterion un-ticked" -Mutate {
            param($c)
            $lines = $c -split "`n"
            $hit = -1
            for ($i = 0; $i -lt $lines.Count; $i++) {
                if ($lines[$i] -match '^\s*-\s\[x\]' -and
                    $lines[$i].IndexOf($Note, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $hit = $i; break }
            }
            if ($hit -lt 0) { throw (New-Refusal "no ticked criterion on $Id matching '$Note'") }
            $lines[$hit] = $lines[$hit] -replace '\[x\]', '[ ]'
            $c = ($lines -join "`n")
            return (Add-Log $c "$Stamp | $Me | un-ticked a criterion matching '$Note' - it was not actually met")
        }
        Write-Host "un-ticked on $Id" -ForegroundColor Yellow
    }

    'finish' {
        $review = $Id -match $NeedsReview
        $to = if ($review) { 'in-review' } else { 'done' }
        Invoke-BoardWrite -CardId $Id -Message "board: $Id -> $to" -Mutate {
            param($c)
            # -Force is deliberately NOT a master key. It overrides the criteria count and nothing else,
            # so it can never be used to finish a card this session does not hold.
            $st = Get-Field $c 'status'
            if ($st -ne 'claimed') {
                throw (New-Refusal "$Id is '$st', not 'claimed'; only a claimed card can be finished. If it was abandoned, 'reap' it and claim it first.")
            }
            $who = Get-Field $c 'owner'
            if ($who -and $who -ne $Me) {
                throw (New-Refusal "$Id belongs to '$who', not you ($Me). If you are that session, pass -Session $who.")
            }
            $open = @([regex]::Matches($c, '(?m)^\s*-\s\[ \]')).Count
            if ($open -gt 0 -and -not $Force) {
                throw (New-Refusal "$Id still has $open unchecked exit criteria. Tick them with 'check', or pass -Force with -Note.")
            }
            $why = if ($Note) { $Note } else { 'exit criteria met' }
            $c = Set-Field $c 'status' $to
            return (Add-Log $c "$Stamp | $who | $to - $why")
        }
        Write-Host "$Id -> $to" -ForegroundColor Green
        if ($review) {
            Write-Warning "$Id is security-critical and does NOT self-approve. Another session must run: board.ps1 review $Id, then approve $Id"
        } else {
            $freed = @(Get-Rows | Where-Object { $_.State -eq 'available' })
            Write-Host "cards now available: $($freed.Count)" -ForegroundColor Cyan
        }
    }

    'approve' {
        Invoke-BoardWrite -CardId $Id -Message "board: $Id -> done" -Mutate {
            param($c)
            if ((Get-Field $c 'status') -ne 'in-review') {
                throw (New-Refusal "$Id is '$(Get-Field $c 'status')', not 'in-review'.")
            }
            $owner = Get-Field $c 'owner'
            $rv    = Get-Field $c 'reviewer'
            # Structural, not advisory: the session that built it cannot be the session that clears it.
            # An empty owner means independence cannot be established at all, so that is refused too.
            if (-not $owner -and -not $Force) {
                throw (New-Refusal "$Id has no recorded owner, so an independent review cannot be established. A human must resolve this card.")
            }
            if ($owner -eq $Me -and -not $Force) {
                throw (New-Refusal "$Id was built by you ($Me). It requires an INDEPENDENT reviewer; a human or another session must approve it.")
            }
            if ($rv -and $rv -ne $Me -and -not $Force) {
                throw (New-Refusal "$Id is being reviewed by '$rv'.")
            }
            $why = if ($Note) { $Note } else { 'independent review passed' }
            $c = Set-Field $c 'status' 'done'
            $c = Set-Field $c 'reviewer' $Me
            return (Add-Log $c "$Stamp | $Me | approved - $why")
        }
        Write-Host "$Id -> done" -ForegroundColor Green
    }

    'clear-gate' {
        $why = if ($Note) { $Note } else { 'gate cleared' }
        Invoke-BoardWrite -CardId $Id -Message "board: clear gate on $Id" -Mutate {
            param($c)
            $g = Get-Field $c 'gate'
            $c = Set-Field $c 'gate_cleared' 'yes'
            return (Add-Log $c "$Stamp | - | gate '$g' cleared - $why")
        }
        Write-Host "$Id gate cleared" -ForegroundColor Green
        $freed = @(Get-Rows | Where-Object { $_.State -eq 'available' })
        Write-Host "cards now available: $($freed.Count)" -ForegroundColor Cyan
    }

    'fake' {
        Invoke-BoardWrite -CardId $Id -Message "board: $Id fake published" -Mutate {
            param($c)
            $c = Set-Field $c 'fake' 'yes'
            $c = Set-Field $c 'heartbeat' $Stamp
            return (Add-Log $c "$Stamp | $(Get-Field $c 'owner') | fake published - downstream may depend on it")
        }
        Write-Host "$Id fake published" -ForegroundColor Green
    }

    'request' {
        if (-not $Note) { throw 'request requires -Note describing what you need and why' }
        $slug = ($Note.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
        if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40).Trim('-') }
        $base = 'board/requests/' + (Get-Date -Format 'yyyy-MM-dd') + "-$Id-$slug"

        # Two requests with the same slug on the same day must not silently overwrite each other.
        Sync-Remote
        $existing = @(Get-GitOut @('ls-tree', '--name-only', 'origin/main', 'board/requests/'))
        $path = "$base.md"; $n = 2
        while ($existing -contains $path) { $path = "$base-$n.md"; $n++ }

        # Four sessions independently filed the same root-tsconfig request because nothing showed them
        # it already existed. Surface likely duplicates - as a warning, never a refusal, since the
        # filing session is mid-build and must not be stopped to adjudicate this.
        $words = @($Note.ToLower() -split '[^a-z0-9]+' | Where-Object { $_.Length -gt 4 } | Select-Object -Unique)
        if ($words.Count -gt 0) {
            $near = @(Get-RequestRows | Where-Object { $_.Status -eq 'open' } | ForEach-Object {
                $hay = ($_.File + ' ' + $_.Need).ToLower()
                $hits = @($words | Where-Object { $hay -like "*$_*" }).Count
                [pscustomobject]@{ Row = $_; Score = $hits / [double]$words.Count }
            } | Where-Object { $_.Score -ge 0.5 } | Sort-Object -Property Score -Descending)
            if ($near.Count -gt 0) {
                Write-Host "similar request(s) already open - check before duplicating:" -ForegroundColor Yellow
                foreach ($d in ($near | Select-Object -First 3)) {
                    Write-Host ("  [{0:P0}] {1}" -f $d.Score, $d.Row.File) -ForegroundColor DarkGray
                }
            }
        }

        Invoke-BoardWrite -Path $path -IsNewFile -Message "board: contract request from $Id" -Mutate {
            param($c)
            return @"
# Contract request - $Id

- **Raised:** $Stamp
- **Card:** $Id
- **By:** $Me
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

    # A request nobody can see is a request nobody resolves. 21 accumulated here unread, four of them
    # the same root cause, because filing was the only verb the board had.
    'requests' {
        Sync-Remote
        $reqs = @(Get-RequestRows)
        $open = @($reqs | Where-Object { $_.Status -eq 'open' })
        $done = @($reqs | Where-Object { $_.Status -ne 'open' })
        Write-Host ""
        Write-Host ("contract requests: {0} open, {1} resolved" -f $open.Count, $done.Count) -ForegroundColor Cyan
        if ($open.Count -gt 0) {
            $open | Sort-Object Date, Card | Format-Table -AutoSize `
                @{L = 'RAISED'; E = { $_.Date } },
                @{L = 'CARD'; E = { $_.Card } },
                @{L = 'NEED'; E = { if ($_.Need.Length -gt 96) { $_.Need.Substring(0, 93) + '...' } else { $_.Need } } }
            Write-Host "resolve one with: board.ps1 resolve <slug-fragment> -Note 'what changed'" -ForegroundColor DarkGray
            Write-Host ""
        }
    }

    'resolve' {
        if (-not $Id)   { throw 'resolve requires a fragment of the request filename, e.g. root-tsconfig' }
        if (-not $Note) { throw 'resolve requires -Note describing what changed' }
        Sync-Remote
        $hit = @(Get-RequestRows | Where-Object { $_.File -like "*$Id*" -and $_.Status -eq 'open' })
        if ($hit.Count -eq 0) { throw (New-Refusal "no open request matching '$Id'") }
        if ($hit.Count -gt 1) {
            throw (New-Refusal ("'{0}' matches {1} open requests: {2}" -f $Id, $hit.Count, (($hit | ForEach-Object { $_.File }) -join ', ')))
        }
        $target = $hit[0]
        Invoke-BoardWrite -Path $target.Path -Message "board: resolve request $($target.File)" -Mutate {
            param($c)
            $c = [regex]::Replace($c, '(?m)^(\s*-\s\*\*Status:\*\*\s*).*$', "`${1}resolved")
            return ($c.TrimEnd() + "`n`n**Resolved $Stamp by $Me** - $Note`n")
        }
        Write-Host "resolved $($target.File)" -ForegroundColor Green
    }
}

exit 0
