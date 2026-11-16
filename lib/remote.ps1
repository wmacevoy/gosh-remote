# Run on a Windows host by lib/connect.js, which puts settings above this
# line.  It does what lib/remote.sh does on other systems: makes sure
# mosh and the editor's server are there and running, starts a mosh
# session forwarding to the server, and reports on lines of the form
#     MOSHREMOTE key==value==

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # progress bars slow downloads to a crawl

function Report($key, $value) { [Console]::Out.WriteLine("MOSHREMOTE $key==$value==") }
function Fail($message) { Report 'error' $message; exit 1 }

# OpenSSH on Windows ends every process a login started when the login
# ends.  Processes started this way are not the login's, and stay.
function Start-Detached($commandLine, $directory) {
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $directory }
    if ($result.ReturnValue -ne 0) { throw "could not start a process (Win32_Process.Create returned $($result.ReturnValue))" }
    return $result.ProcessId
}

function Fetch($url, $file) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($url -match '^file://(.*)$') { Copy-Item -LiteralPath $Matches[1] -Destination $file -Force }
    else { Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing }
}

try {
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Fail "Windows hosts with a $($env:PROCESSOR_ARCHITECTURE) processor are not supported" }
    Report 'platform' 'win32-x64'

    $root = Join-Path $env:LOCALAPPDATA 'remote-mosh'
    $work = Join-Path $root ("work-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # ---- 1. mosh

    $moshName = "mosh-$MOSH_VERSION-msys2"
    $moshDir = Join-Path $root $moshName
    $moshServer = Join-Path $moshDir 'mosh-server.exe'
    if (-not (Test-Path $moshServer)) {
        Report 'status' "installing mosh $MOSH_VERSION"
        $zip = Join-Path $work "$moshName.zip"
        $sums = Join-Path $work 'SHA256SUMS'
        Fetch "$MOSH_RELEASES/mosh-$MOSH_VERSION/SHA256SUMS" $sums
        Fetch "$MOSH_RELEASES/mosh-$MOSH_VERSION/$moshName.zip" $zip
        $listed = (Get-Content $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape("$moshName.zip"))$" } |
            ForEach-Object { $Matches[1] } | Select-Object -First 1)
        if (-not $listed) { Fail "$moshName.zip is not listed in the release's SHA256SUMS" }
        # (by hand: the commands for this and for unpacking are add-ons that are not always there)
        $sha = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead($zip)
        try { $actual = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Close() }
        if ($actual -ne $listed) { Fail "$moshName.zip does not match its published checksum" }
        if (Test-Path $moshDir) { Remove-Item -Recurse -Force $moshDir }
        & tar.exe -xf $zip -C $root
        if ($LASTEXITCODE -ne 0) { Fail "could not unpack $moshName.zip" }
        if (-not (Test-Path $moshServer)) { Fail "mosh $MOSH_VERSION has no server for Windows (1.4.0-pf.2 is the first that does)" }
    }
    Report 'mosh' $MOSH_VERSION

    # ---- 2. the editor's server

    $data = Join-Path $HOME $SERVER_DATA_FOLDER
    $dir = Join-Path $data "bin\$SERVER_COMMIT"
    $program = Join-Path $dir "bin\$SERVER_APP_NAME.cmd"
    $log = Join-Path $data ".$SERVER_COMMIT.log"
    $pidFile = Join-Path $data ".$SERVER_COMMIT.pid"
    $tokenFile = Join-Path $data ".$SERVER_COMMIT.token"

    if (-not (Test-Path $program)) {
        Report 'status' "installing the editor's server"
        $url = $SERVER_URL_TEMPLATE.Replace('${quality}', $SERVER_QUALITY).Replace('${version}', $SERVER_VERSION).Replace('${commit}', $SERVER_COMMIT).Replace('${os}', 'win32').Replace('${arch}', 'x64').Replace('${release}', $SERVER_RELEASE)
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $archive = Join-Path $work 'server.tar.gz'
        Fetch $url $archive
        & tar.exe -xf $archive -C $dir --strip-components 1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $program)) { Fail "could not unpack the editor's server from $url" }
    }

    function Listening {
        if (-not (Test-Path $log)) { return $null }
        $line = Select-String -LiteralPath $log -Pattern 'Extension host agent listening on (\d+)' | Select-Object -First 1
        if ($line) { return $line.Matches[0].Groups[1].Value }
        return $null
    }

    $port = $null
    if (Test-Path $pidFile) {
        $running = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
        if ($running) { $port = Listening }   # one is already running: use it
    }
    if (-not $port) {
        Report 'status' "starting the editor's server"
        $bytes = New-Object byte[] 16
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        [IO.File]::WriteAllText($tokenFile, $token)
        if (Test-Path $log) { Remove-Item -Force $log }
        $arguments = "--start-server --host=127.0.0.1 --port=0 --connection-token-file `"$tokenFile`" --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms"
        $started = Start-Detached "cmd.exe /c `"`"$program`" $arguments > `"$log`" 2>&1`"" $dir
        [IO.File]::WriteAllText($pidFile, "$started")
        for ($i = 0; $i -lt 120 -and -not $port; $i++) {
            Start-Sleep -Milliseconds 250
            $port = Listening
        }
        if (-not $port) {
            $tail = if (Test-Path $log) { (Get-Content $log -Tail 3) -join ' ' } else { '' }
            Fail "the editor's server did not start: $tail"
        }
    }
    Report 'serverPort' $port
    Report 'token' ([IO.File]::ReadAllText($tokenFile).Trim())

    if ($PERSISTENT_TERMINALS -eq 'shpool') {
        Report 'note' 'Terminals are not persistent: shpool does not run on Windows hosts.'
    }

    # ---- 3. a mosh session that forwards to it

    # It has no terminal to serve, so its command just waits (for a key that will
    # never be pressed).  Should the user's machine vanish for good, it gives up after a week.
    $spec = "${LOCAL_PORT}:127.0.0.1:$port"

    # The address this machine was reached at is the one to send mosh's datagrams
    # to, and the one for mosh-server to listen on.  (Before 1.4.0-pf.3 the
    # Windows build could not listen on an IPv6 address.)
    $address = ''
    if ($env:SSH_CONNECTION) { $address = ($env:SSH_CONNECTION -split ' ')[2] }
    $old = $MOSH_VERSION -match '^1\.4\.0-pf\.[12]$'
    $listen = if ($address -and -not ($old -and $address -match ':')) { $address } else { '0.0.0.0' }
    $out = Join-Path $work 'mosh-server.out'
    $command = "cmd.exe /c `"set LC_ALL=C.UTF-8&& set MOSH_SERVER_NETWORK_TMOUT=604800&& `"$moshServer`" new -i $listen -L $spec -- cmd.exe /c pause > `"$out`" 2>&1`""
    Start-Detached $command $moshDir | Out-Null
    $connect = $null
    for ($i = 0; $i -lt 80 -and -not $connect; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Path $out) {
            $connect = Select-String -LiteralPath $out -Pattern 'MOSH CONNECT (\d+) (\S+)' | Select-Object -First 1
        }
    }
    if (-not $connect) {
        $tail = if (Test-Path $out) { (Get-Content $out -Tail 3) -join ' ' } else { '' }
        Fail "mosh-server would not start on the remote machine: $tail"
    }
    Report 'moshPort' $connect.Matches[0].Groups[1].Value
    Report 'moshKey' $connect.Matches[0].Groups[2].Value
    Report 'spec' $spec

    Report 'moshAddress' $address
    Report 'moshServer' $moshServer

    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    Report 'done' 'yes'
} catch {
    Fail "$($_.Exception.Message)"
}
