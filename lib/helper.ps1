# dsh-self-restart - Windows helper
#
# Three actions, one protocol (a JSON payload in, one compressed JSON line out):
#
#   resolve : read-only. Walk up from the caller process to the top of this
#             application (the process a user would relaunch) and report the
#             plan: what would be stopped, with what command it comes back.
#   arm     : hand the real work to a process that is NOT inside this
#             application's process tree. On Windows the shell is started by
#             Chromium inside a job object, so a plain child dies together with
#             it; Explorer is outside that tree, so the helper is launched
#             through a generated .lnk shortcut. Falls back to a plain child
#             when Explorer cannot do it.
#   run     : the actual restart. Waits, stops the application, relaunches it,
#             verifies the listener came back, writes a report.
#
# ASCII only on purpose: Windows PowerShell 5.1 decodes BOM-less UTF-8 script
# files as ANSI, so non-ASCII text here would be mangled into syntax errors.

param(
    [Parameter(Mandatory = $true)][ValidateSet('resolve', 'arm', 'run', 'status')][string]$Action,
    [string]$Payload64 = '',
    [string]$PayloadFile = ''
)

$ErrorActionPreference = 'Stop'

function Read-Payload {
    param([string]$B64, [string]$File)
    $json = $null
    if (-not [string]::IsNullOrEmpty($File) -and (Test-Path -LiteralPath $File)) {
        $json = [IO.File]::ReadAllText($File, (New-Object System.Text.UTF8Encoding($false)))
    }
    elseif (-not [string]::IsNullOrEmpty($B64)) {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
    }
    if ([string]::IsNullOrWhiteSpace($json)) { return [pscustomobject]@{} }
    return ($json | ConvertFrom-Json)
}

function Emit {
    param($Object)
    Write-Output ($Object | ConvertTo-Json -Depth 8 -Compress)
}

function Get-ProcInfo {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $null }
    return (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue)
}

function Split-CommandLine {
    # "C:\path with space\app.exe" --flag value  ->  --flag value
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return '' }
    $s = $CommandLine.Trim()
    if ($s.StartsWith('"')) {
        $end = $s.IndexOf('"', 1)
        if ($end -lt 0) { return '' }
        return $s.Substring($end + 1).Trim()
    }
    $sp = $s.IndexOf(' ')
    if ($sp -lt 0) { return '' }
    return $s.Substring($sp + 1).Trim()
}

function Get-ProcessTable {
    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
}

function Get-Tree {
    # Every descendant of $RootPid (root excluded), each row carrying its depth.
    param($Table, [int]$RootPid)
    $byParent = @{}
    foreach ($row in $Table) {
        $parent = [int]$row.ParentProcessId
        if (-not $byParent.ContainsKey($parent)) { $byParent[$parent] = New-Object System.Collections.ArrayList }
        [void]$byParent[$parent].Add($row)
    }
    $out = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@{ Pid = $RootPid; Depth = -1 })
    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        $depth = $node.Depth + 1
        $childRows = $byParent[[int]$node.Pid]
        if ($null -eq $childRows) { continue }
        foreach ($child in $childRows) {
            [void]$out.Add([pscustomobject]@{ ProcessId = [int]$child.ProcessId; Name = [string]$child.Name; Depth = $depth })
            $queue.Enqueue(@{ Pid = [int]$child.ProcessId; Depth = $depth })
        }
    }
    return , $out
}

function Test-DshProcess {
    # Does this process look like the DSH runtime itself (rather than a shell that
    # happens to sit above it)? Used to find the host when the caller is not the
    # host, e.g. when the CLI is run from a terminal inside a DSH session.
    param($Proc)
    if ($null -eq $Proc) { return $false }
    $cmd = [string]$Proc.CommandLine
    if ($cmd -like '*dsh-desktop-host*') { return $true }
    $imageName = ''
    try { $imageName = [System.IO.Path]::GetFileNameWithoutExtension([string]$Proc.ExecutablePath) } catch { }
    if ($imageName -ieq 'dsh') { return $true }
    return $false
}

function Resolve-Plan {
    param($Payload)

    $plan = [ordered]@{
        platform         = 'win32'
        callerPid        = 0
        targetPid        = 0
        targetName       = ''
        targetExe        = ''
        targetArgs       = ''
        relaunchCommand  = ''
        workingDirectory = ''
        resolution       = ''
        treeSize         = 0
        killList         = @()
        warnings         = @()
    }

    $overridePid = 0
    if ($null -ne $Payload.targetPid) { $overridePid = [int]$Payload.targetPid }

    if ($overridePid -gt 0) {
        $target = Get-ProcInfo -ProcessId $overridePid
        if ($null -eq $target) { throw "target process $overridePid is not running" }
        $plan.resolution = 'explicit-target'
    }
    else {
        $callerPid = 0
        if ($null -ne $Payload.callerPid) { $callerPid = [int]$Payload.callerPid }
        if ($callerPid -le 0) { $callerPid = $PID }

        # Prefer an ancestor that IS the DSH runtime: the caller may be a shell or a
        # wrapper script (the CLI is), and walking up from there would otherwise
        # pick the wrong process.
        $startPid = $callerPid
        $markerFound = $false
        for ($i = 0; $i -lt 12; $i++) {
            $candidate = Get-ProcInfo -ProcessId $startPid
            if ($null -eq $candidate) { break }
            if (Test-DshProcess -Proc $candidate) { $markerFound = $true; break }
            $parentPid = [int]$candidate.ParentProcessId
            if ($parentPid -le 0) { break }
            $startPid = $parentPid
        }
        $plan.callerPid = $startPid

        $current = Get-ProcInfo -ProcessId $startPid
        if ($null -eq $current) { throw "caller process $startPid is not running" }

        $exe = [string]$current.ExecutablePath
        if ([string]::IsNullOrEmpty($exe)) { $exe = [string]$Payload.selfExe }
        if ([string]::IsNullOrEmpty($exe)) { throw 'cannot determine the host executable path' }

        # Climb while the parent is the SAME executable: that is what makes the
        # desktop shell and its node-mode host count as one application. Never
        # cross into a Chromium child process.
        $top = $current
        for ($i = 0; $i -lt 16; $i++) {
            $parent = Get-ProcInfo -ProcessId ([int]$top.ParentProcessId)
            if ($null -eq $parent) { break }
            $parentExe = [string]$parent.ExecutablePath
            if ([string]::IsNullOrEmpty($parentExe)) { break }
            if ($parentExe -ne $exe) { break }
            if ([string]$parent.CommandLine -like '*--type=*') { break }
            $top = $parent
        }
        $target = $top
        if ($markerFound) { $plan.resolution = 'ancestor-walk' } else { $plan.resolution = 'ancestor-walk-no-dsh-marker' }
    }

    $plan.targetPid = [int]$target.ProcessId
    $plan.targetName = [string]$target.Name
    $plan.targetExe = [string]$target.ExecutablePath
    $plan.targetArgs = Split-CommandLine -CommandLine ([string]$target.CommandLine)

    if ($null -ne $Payload.relaunchCommand -and -not [string]::IsNullOrEmpty([string]$Payload.relaunchCommand)) {
        $plan.relaunchCommand = [string]$Payload.relaunchCommand
        $plan.resolution = "$($plan.resolution)+relaunch-override"
    }
    else {
        $quoted = '"' + $plan.targetExe + '"'
        if ([string]::IsNullOrEmpty($plan.targetArgs)) { $plan.relaunchCommand = $quoted }
        else { $plan.relaunchCommand = "$quoted $($plan.targetArgs)" }
    }

    $cwd = ''
    if ($plan.targetPid -eq $plan.callerPid) {
        # the caller IS the application (a node-mode CLI): its own cwd is right
        $cwd = [string]$Payload.cwdHint
    }
    if ([string]::IsNullOrEmpty($cwd) -and -not [string]::IsNullOrEmpty($plan.targetExe)) {
        $cwd = [System.IO.Path]::GetDirectoryName($plan.targetExe)
    }
    $plan.workingDirectory = $cwd

    $table = Get-ProcessTable
    $tree = Get-Tree -Table $table -RootPid $plan.targetPid
    $selfTree = Get-Tree -Table $table -RootPid $PID
    $excluded = @{}
    $excluded[$PID] = $true
    foreach ($row in $selfTree) { $excluded[[int]$row.ProcessId] = $true }

    $killable = New-Object System.Collections.ArrayList
    foreach ($row in $tree) {
        if ($excluded.ContainsKey([int]$row.ProcessId)) { continue }
        [void]$killable.Add([pscustomobject]@{ pid = [int]$row.ProcessId; name = [string]$row.Name; depth = [int]$row.Depth })
    }
    $plan.treeSize = $tree.Count
    $plan.killList = @($killable | Sort-Object -Property depth -Descending)
    if ($excluded.Count -gt 1) {
        $plan.warnings = @("helper subtree excluded from the kill list ($($excluded.Count) process(es), helper pid $PID)")
    }
    return $plan
}

function Test-PortOpen {
    param([string]$TargetHost, [int]$Port, [int]$TimeoutMs)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            $client.EndConnect($iar)
            return $true
        }
        return $false
    }
    catch { return $false }
    finally { try { $client.Close() } catch { } }
}

function Get-NewestSessionWrite {
    # The session store writes on every event; a quiet store means the turn that
    # asked for the restart has been flushed and it is safe to stop the app.
    param([string]$SessionRoot)
    try {
        if ([string]::IsNullOrEmpty($SessionRoot) -or -not (Test-Path -LiteralPath $SessionRoot)) { return $null }
        $files = @(Get-ChildItem -Path (Join-Path $SessionRoot '*\*\session*.zstd') -File -ErrorAction SilentlyContinue)
        if ($files.Count -eq 0) {
            $dirs = @(Get-ChildItem -Path (Join-Path $SessionRoot '*\*') -Directory -ErrorAction SilentlyContinue | Sort-Object -Property LastWriteTime -Descending)
            if ($dirs.Count -gt 0) { return $dirs[0].LastWriteTime }
            return $null
        }
        return ($files | Sort-Object -Property LastWriteTime -Descending)[0].LastWriteTime
    }
    catch { return $null }
}

function New-Utf8NoBom {
    return (New-Object System.Text.UTF8Encoding($false))
}

function Write-JsonFile {
    param([string]$Path, $Object)
    [IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 8), (New-Utf8NoBom))
}

function Get-HelperPath {
    return $PSCommandPath
}

function Start-HelperDirectly {
    # Plain child. Fine when the application is a plain CLI; dangerous when the
    # shell holds a kill-on-close job object, hence only the fallback path.
    param([string]$PayloadPath, [string]$HelperPath, [string]$LogPath)
    $args = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$HelperPath`" -Action run -PayloadFile `"$PayloadPath`""
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -PassThru
    if ($null -ne $LogPath -and $LogPath -ne '') {
        [IO.File]::AppendAllText($LogPath, ("{0} [arm] direct fallback started pid {1}`r`n" -f (Get-Date).ToString('o'), $proc.Id), (New-Utf8NoBom))
    }
    return $proc.Id
}

function Invoke-Arm {
    param($Payload)

    $stateDir = [string]$Payload.stateDir
    if ([string]::IsNullOrEmpty($stateDir)) { throw 'stateDir is required' }
    if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    $id = [string]$Payload.id
    if ([string]::IsNullOrEmpty($id)) { throw 'id is required' }
    $logPath = Join-Path $stateDir 'helper.log'
    $payloadPath = Join-Path $stateDir "payload-$id.json"
    $bootPath = Join-Path $stateDir "boot-$id.json"
    $lnkPath = Join-Path $stateDir "launch-$id.lnk"

    Remove-Item -LiteralPath $bootPath -Force -ErrorAction SilentlyContinue
    Write-JsonFile -Path $payloadPath -Object $Payload

    $helperPath = Get-HelperPath
    $waitSeconds = 20
    if ($null -ne $Payload.armWaitSeconds) {
        $parsed = [int]$Payload.armWaitSeconds
        if ($parsed -gt 0) { $waitSeconds = $parsed }
    }

    $result = [ordered]@{
        ok = $true
        action = 'arm'
        id = $id
        payloadPath = $payloadPath
        helperPath = $helperPath
        stateDir = $stateDir
    }

    # --- route 1: let Explorer start it (outside the application's job object)
    $launched = $false
    $launchError = ''
    if (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'explorer.exe')) {
        try {
            $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$helperPath`" -Action run -PayloadFile `"$payloadPath`""
            $shell = New-Object -ComObject WScript.Shell
            $link = $shell.CreateShortcut($lnkPath)
            $link.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
            $link.Arguments = $arguments
            $link.WorkingDirectory = $stateDir
            $link.WindowStyle = 1
            $link.Save()
            Start-Process -FilePath 'explorer.exe' -ArgumentList $lnkPath | Out-Null
            $deadline = (Get-Date).AddSeconds($waitSeconds)
            while ((Get-Date) -lt $deadline) {
                if (Test-Path -LiteralPath $bootPath) { $launched = $true; break }
                Start-Sleep -Milliseconds 400
            }
            if (-not $launched) { $launchError = "explorer route did not check in within $waitSeconds s" }
        }
        catch {
            $launchError = $_.Exception.Message
        }
    }
    else {
        $launchError = 'explorer.exe not found'
    }

    if ($launched) {
        $result['mode'] = 'explorer'
        $result['launchedAt'] = (Get-Date).ToString('o')
        $boot = $null
        try { $boot = ([IO.File]::ReadAllText($bootPath, (New-Utf8NoBom)) | ConvertFrom-Json) } catch { }
        if ($null -ne $boot -and $null -ne $boot.pid) { $result['helperPid'] = [int]$boot.pid }
        [IO.File]::AppendAllText($logPath, ("{0} [arm] explorer route ok, helper pid {1}`r`n" -f (Get-Date).ToString('o'), $result['helperPid']), (New-Utf8NoBom))
        Remove-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
        return $result
    }

    # --- route 2: plain child (survives a normal parent exit, not a job kill)
    $result['mode'] = 'direct'
    $result['warning'] = "explorer route unavailable ($launchError); started as a plain child instead"
    try {
        $pidDirect = Start-HelperDirectly -PayloadPath $payloadPath -HelperPath $helperPath -LogPath $logPath
        $result['helperPid'] = $pidDirect
        $deadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $bootPath) { break }
            Start-Sleep -Milliseconds 300
        }
        if (-not (Test-Path -LiteralPath $bootPath)) {
            $result['ok'] = $false
            $result['error'] = "helper did not start (explorer: $launchError)"
        }
        return $result
    }
    catch {
        $result['ok'] = $false
        $result['error'] = "cannot start the helper: $($_.Exception.Message)"
        return $result
    }
}

function Invoke-Restart {
    param($Payload)

    $stateDir = [string]$Payload.stateDir
    if ([string]::IsNullOrEmpty($stateDir)) { throw 'stateDir is required' }
    if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
    $reportsDir = Join-Path $stateDir 'reports'
    if (-not (Test-Path -LiteralPath $reportsDir)) { New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null }
    $id = [string]$Payload.id
    if ([string]::IsNullOrEmpty($id)) { $id = (Get-Date -Format 'yyyyMMdd-HHmmss') }
    $logPath = Join-Path $stateDir 'helper.log'
    $bootPath = Join-Path $stateDir "boot-$id.json"

    $script:report = [ordered]@{
        id          = $id
        state       = 'starting'
        reason      = [string]$Payload.reason
        requestedAt = [string]$Payload.requestedAt
        startedAt   = (Get-Date).ToString('o')
        helperPid   = $PID
        parentPid   = (Get-ProcInfo -ProcessId $PID).ParentProcessId
        delaySeconds = [int]$Payload.delaySeconds
        quietSeconds = [int]$Payload.quietSeconds
        maxWaitSeconds = [int]$Payload.maxWaitSeconds
        dryRun      = [bool]$Payload.dryRun
    }

    function Write-Report {
        param([string]$State, [hashtable]$Extra)
        $script:report.state = $State
        $script:report.updatedAt = (Get-Date).ToString('o')
        if ($null -ne $Extra) {
            foreach ($key in $Extra.Keys) { $script:report[$key] = $Extra[$key] }
        }
        $json = $script:report | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText((Join-Path $reportsDir "$id.json"), $json, (New-Utf8NoBom))
        [IO.File]::WriteAllText((Join-Path $stateDir 'last.json'), $json, (New-Utf8NoBom))
    }

    function Write-Log {
        param([string]$Message)
        try {
            [IO.File]::AppendAllText($logPath, ("{0} [{1}] {2}`r`n" -f (Get-Date).ToString('o'), $id, $Message), (New-Utf8NoBom))
        }
        catch { }
    }

    # check in first: the arming side waits for this to prove the hand-off worked
    try { Write-JsonFile -Path $bootPath -Object ([ordered]@{ pid = $PID; at = (Get-Date).ToString('o'); parent = (Get-ProcInfo -ProcessId $PID).ParentProcessId }) } catch { }
    Write-Log 'run: handed over and started'

    $cancelFile = Join-Path $stateDir "cancel-$id"
    function Is-Canceled { return (Test-Path -LiteralPath $cancelFile) }

    Write-Report -State 'waiting' -Extra @{ cancelFile = $cancelFile }

    $plan = Resolve-Plan -Payload $Payload
    Write-Report -State 'waiting' -Extra @{
        targetPid        = $plan.targetPid
        targetName       = $plan.targetName
        targetExe        = $plan.targetExe
        relaunchCommand  = $plan.relaunchCommand
        workingDirectory = $plan.workingDirectory
        resolution       = $plan.resolution
        killList         = $plan.killList
    }
    Write-Log ("plan: target={0} ({1}) relaunch={2}" -f $plan.targetPid, $plan.targetName, $plan.relaunchCommand)

    # 1) grace period so the asking turn gets delivered before anything dies
    $delay = [int]$Payload.delaySeconds
    if ($delay -lt 0) { $delay = 0 }
    $delayDeadline = (Get-Date).AddSeconds($delay)
    while ((Get-Date) -lt $delayDeadline) {
        if (Is-Canceled) { Write-Report -State 'canceled' -Extra @{}; Write-Log 'canceled during delay'; return  }
        Start-Sleep -Milliseconds 400
    }

    # 2) wait until the session store stops being written (or the cap is hit)
    $quiet = [int]$Payload.quietSeconds
    if ($quiet -lt 0) { $quiet = 0 }
    $maxWait = [int]$Payload.maxWaitSeconds
    if ($maxWait -le 0) { $maxWait = 180 }
    $hardCap = (Get-Date).AddSeconds($maxWait)
    $sessionRoot = [string]$Payload.sessionRoot
    $idleMs = $null
    while ((Get-Date) -lt $hardCap) {
        if (Is-Canceled) { Write-Report -State 'canceled' -Extra @{}; Write-Log 'canceled while waiting for quiet'; return $script:report }
        $target = Get-ProcInfo -ProcessId $plan.targetPid
        if ($null -eq $target) {
            Write-Report -State 'exited-early' -Extra @{ note = 'the application exited on its own before the restart; relaunch skipped' }
            Write-Log 'target exited before we stopped it; not relaunching'
            return $script:report
        }
        $newest = Get-NewestSessionWrite -SessionRoot $sessionRoot
        if ($null -eq $newest) { break }
        $idle = ((Get-Date) - $newest).TotalMilliseconds
        if ($idle -ge ($quiet * 1000)) { $idleMs = [int]$idle; break }
        Start-Sleep -Milliseconds 500
    }
    Write-Report -State 'quiet-reached' -Extra @{ idleMs = $idleMs }

    if ([bool]$Payload.dryRun) {
        Write-Report -State 'dry-run' -Extra @{ note = 'dry run: nothing was stopped' }
        Write-Log 'dry run: exiting without touching anything'
        return $script:report
    }

    if (Is-Canceled) { Write-Report -State 'canceled' -Extra @{}; return $script:report }

    # 2b) re-read the process table right before the kill: anything spawned by the
    #     asking turn after the first look belongs to this application too.
    try {
        $fresh = Resolve-Plan -Payload $Payload
        if ($null -ne $fresh.killList -and @($fresh.killList).Count -gt 0) {
            if (@($fresh.killList).Count -ne @($plan.killList).Count) {
                Write-Log ("kill list refreshed: {0} -> {1} process(es)" -f @($plan.killList).Count, @($fresh.killList).Count)
            }
            $plan.killList = $fresh.killList
        }
    }
    catch { Write-Log ("kill list refresh failed, using the original plan: {0}" -f $_.Exception.Message) }

    # 3) stop the application. The shell goes first on purpose: its death breaks
    #    the IPC channel and the host reacts with its own graceful shutdown,
    #    which flushes session state. Survivors are force-killed right after.
    $killFailed = @()
    $stopped = 0
    if ($null -ne (Get-ProcInfo -ProcessId $plan.targetPid)) {
        Write-Log ("stopping target {0}" -f $plan.targetPid)
        try { Stop-Process -Id $plan.targetPid -Force -ErrorAction Stop; $stopped++ }
        catch { $killFailed += "target $($plan.targetPid): $($_.Exception.Message)" }
    }

    $grace = [int]$Payload.graceSeconds
    if ($grace -le 0) { $grace = 8 }
    $graceDeadline = (Get-Date).AddSeconds($grace)
    while ((Get-Date) -lt $graceDeadline) {
        $alive = @($plan.killList | Where-Object { $null -ne (Get-ProcInfo -ProcessId ([int]$_.pid)) })
        if ($alive.Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    }

    foreach ($row in $plan.killList) {
        if ($null -eq (Get-ProcInfo -ProcessId ([int]$row.pid))) { continue }
        try { Stop-Process -Id ([int]$row.pid) -Force -ErrorAction Stop; $stopped++ }
        catch { $killFailed += "pid $($row.pid): $($_.Exception.Message)" }
    }
    $killedAt = Get-Date
    Write-Report -State 'stopped' -Extra @{ killedAt = $killedAt.ToString('o'); killFailures = $killFailed; killCount = $stopped }
    Write-Log ("stopped; count={0} failures={1}" -f $stopped, $killFailed.Count)

    # 4) make sure the listener is gone before the replacement starts
    $port = 0
    $healthHost = '127.0.0.1'
    $healthUrl = [string]$Payload.healthUrl
    if (-not [string]::IsNullOrEmpty($healthUrl)) {
        try {
            $uri = [Uri]$healthUrl
            $healthHost = $uri.Host
            $port = $uri.Port
        }
        catch { $port = 0 }
    }
    if ($port -gt 0) {
        $freeDeadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $freeDeadline) {
            if (-not (Test-PortOpen -TargetHost $healthHost -Port $port -TimeoutMs 500)) { break }
            Start-Sleep -Milliseconds 300
        }
    }

    # 5) relaunch. The helper was started by Explorer, so the new application is
    #    outside the old job object and shows up on the interactive desktop.
    $exe = $plan.targetExe
    $argString = Split-CommandLine -CommandLine $plan.relaunchCommand
    if ([string]::IsNullOrEmpty($exe)) { throw 'no executable to relaunch' }
    Write-Log ("relaunching {0} {1}" -f $exe, $argString)
    $started = $null
    try {
        $startArgs = @{
            FilePath = $exe
            WorkingDirectory = $plan.workingDirectory
            PassThru = $true
        }
        if (-not [string]::IsNullOrEmpty($argString)) { $startArgs['ArgumentList'] = $argString }
        $started = Start-Process @startArgs
    }
    catch {
        Write-Report -State 'relaunch-failed' -Extra @{ error = $_.Exception.Message; relaunchCommand = $plan.relaunchCommand }
        Write-Log ("relaunch failed: {0}" -f $_.Exception.Message)
        return $script:report
    }
    $newPid = 0
    if ($null -ne $started) { $newPid = [int]$started.Id }
    Write-Report -State 'relaunched' -Extra @{ relaunchedAt = (Get-Date).ToString('o'); newPid = $newPid }

    # 6) health check: the listener has to come back
    $healthy = $false
    if ($port -gt 0) {
        $healthSeconds = [int]$Payload.healthSeconds
        if ($healthSeconds -le 0) { $healthSeconds = 120 }
        $healthDeadline = (Get-Date).AddSeconds($healthSeconds)
        while ((Get-Date) -lt $healthDeadline) {
            if (Test-PortOpen -TargetHost $healthHost -Port $port -TimeoutMs 800) { $healthy = $true; break }
            Start-Sleep -Milliseconds 500
        }
    }
    $readyAt = Get-Date
    $downtimeMs = [int]($readyAt - $killedAt).TotalMilliseconds
    $finalState = 'ok'
    if ($port -gt 0 -and -not $healthy) { $finalState = 'started-but-unhealthy' }
    Write-Report -State $finalState -Extra @{
        readyAt = $readyAt.ToString('o')
        healthy = $healthy
        downtimeMs = $downtimeMs
    }
    Write-Log ("done: state={0} newPid={1} healthy={2} downtimeMs={3}" -f $finalState, $newPid, $healthy, $downtimeMs)
    Remove-Item -LiteralPath $bootPath -Force -ErrorAction SilentlyContinue
    return $script:report
}

try {
    $payload = Read-Payload -B64 $Payload64 -File $PayloadFile

    # the payload file has served its purpose: nothing below re-reads it, and
    # leaving it around would only clutter the state directory
    if (-not [string]::IsNullOrEmpty($PayloadFile)) {
        Remove-Item -LiteralPath $PayloadFile -Force -ErrorAction SilentlyContinue
    }

    if ($Action -eq 'resolve') {
        Emit ([ordered]@{ ok = $true; action = 'resolve'; plan = (Resolve-Plan -Payload $payload) })
        exit 0
    }

    if ($Action -eq 'arm') {
        Emit (Invoke-Arm -Payload $payload)
        exit 0
    }

    if ($Action -eq 'status') {
        $stateDir = [string]$payload.stateDir
        $result = [ordered]@{ ok = $true; action = 'status'; stateDir = $stateDir }
        $lastPath = Join-Path $stateDir 'last.json'
        if (Test-Path -LiteralPath $lastPath) {
            $result['last'] = ([IO.File]::ReadAllText($lastPath, (New-Utf8NoBom)) | ConvertFrom-Json)
        }
        Emit $result
        exit 0
    }

    $finalReport = Invoke-Restart -Payload $payload
    $okStates = @('ok', 'started-but-unhealthy', 'dry-run', 'canceled', 'exited-early')
    Emit ([ordered]@{ ok = ($okStates -contains [string]$finalReport.state); action = 'run'; report = $finalReport })
    if ($okStates -notcontains [string]$finalReport.state) { exit 1 }
    exit 0
}
catch {
    $message = $_.Exception.Message
    $stack = $_.ScriptStackTrace
    try {
        $stateDir = [string]$payload.stateDir
        if (-not [string]::IsNullOrEmpty($stateDir) -and (Test-Path -LiteralPath $stateDir)) {
            $id = [string]$payload.id
            if ([string]::IsNullOrEmpty($id)) { $id = 'unknown' }
            $errorReport = [ordered]@{
                id = $id
                state = 'error'
                error = $message
                stack = $stack
                helperPid = $PID
                updatedAt = (Get-Date).ToString('o')
            }
            $reportsDir = Join-Path $stateDir 'reports'
            if (-not (Test-Path -LiteralPath $reportsDir)) { New-Item -ItemType Directory -Path $reportsDir -Force | Out-Null }
            Write-JsonFile -Path (Join-Path $reportsDir "$id.json") -Object $errorReport
            Write-JsonFile -Path (Join-Path $stateDir 'last.json') -Object $errorReport
        }
    }
    catch { }
    Emit ([ordered]@{ ok = $false; error = $message; stack = $stack })
    exit 1
}
