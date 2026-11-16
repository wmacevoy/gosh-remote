# Remote - Gosh

Work on a remote machine from VSCodium over [gosh](https://wmacevoy.github.io/gosh/), so that the
connection survives changing networks, closing the laptop, and outages.

An ordinary remote session rides on a TCP connection from your machine to the host, and dies with
it. Here the editor talks to a port on your own machine, and a gosh session (mosh's session, with
forwards beside it) carries that port to the host. The editor never sees the network change: at
worst it sees a pause.

**Not independently reviewed, and not yet run inside an editor.** No third party has reviewed gosh
or this extension. See [What has and has not been tested](#what-has-and-has-not-been-tested).

It installs [gosh](https://github.com/wmacevoy/gosh) at both ends for you, from gosh's releases.
Migrated from `remote-mosh`, which did the same with the fork `mosh-1.4.0-pf.*`. Its requirements,
design, queue and findings live in gosh (`docs/REQUIREMENTS_v16.md`, `REQ1/EXT-1` to `REQ1/EXT-4`).

## What it does when you connect

1. Installs the gosh client for your machine, if it isn't there, into the extension's own storage,
   after checking the download against the release's `SHA256SUMS`. Nothing is installed
   system-wide.
2. Logs in to the host with `ssh` and, if they aren't there already, installs gosh (into
   `~/.local/bin`, no root needed, by the release's own `install.sh`) and the editor's server;
   starts the server; and starts a gosh session that forwards a port to it.
3. Starts the gosh client on your machine with no terminal (`-N`) as the other end of that session.

After that ssh is finished with, and everything goes through gosh, unless UDP cannot reach the
host: see [When UDP is blocked](#when-udp-is-blocked).

## What you need

| | |
| --- | --- |
| Your machine | Linux (x86-64, ARM64) or macOS 11+. **Not Windows yet**: gosh's releases have no Windows build. |
| The host | Linux (x86-64, ARM64; glibc 2.34+) or macOS 11+. A Windows host is experimental (`REQ4/EXT-2`), and waits on that same build. |
| `ssh` | On your machine, able to log in to the host **without asking anything**: keys or an agent, and a host key already accepted. There is nowhere for it to ask for a password. `ssh -o BatchMode=yes HOST true` must work. |
| UDP | gosh uses a UDP port between 60000 and 61000 on the host. If your machine cannot reach it, the session is carried over ssh instead. |
| On the host | `curl` or `wget`, and `tar`. |
| The editor | VSCodium, with this extension allowed to use the API it needs (below). |

### Allowing the API

Remote extensions rely on an editor API that is not yet declared stable, so the editor has to be
told this one may use it. Run **Preferences: Configure Runtime Arguments** and add:

```json
"enable-proposed-api": ["wmacevoy.remote-gosh"]
```

then restart the editor.

## Installing

From a `.vsix`: **Extensions: Install from VSIX...** in the command palette. A release of this
extension carries one; `pixi run vsix` builds one from a checkout.

Or, to try it from a checkout with no packaging:

```
codium --extensionDevelopmentPath=/path/to/remote-gosh --enable-proposed-api wmacevoy.remote-gosh
```

## Using it

Run **Remote-Gosh: Connect to Host...** from the command palette, or from the remote indicator in
the bottom-left corner, and give the host as you would give it to ssh: `user@host`, or a name from
your `~/.ssh/config`. A new window opens on that host (its address is `gosh+HOST`). The first
connection to a host takes a while, because it downloads gosh and the editor's server there.

**Remote-Gosh: Show Log** shows what it did and what went wrong.

### Settings

- `remoteGosh.goshVersion`: the gosh release to use at both ends (default `0.2`).
- `remoteGosh.releasesUrl`: where to download gosh from, if not GitHub (each release is the
  directory `vVERSION` under it).
- `remoteGosh.sshPath`: the ssh program, if not the one on your `PATH`.
- `remoteGosh.serverDownloadUrlTemplate`: where hosts get the editor's server.
- `remoteGosh.persistentTerminals`: `off` (the default) or `shpool`; see below.
- `remoteGosh.relay`: `auto` (the default), `always` or `never`; see below.
- `remoteGosh.localCopies.folder`, `.delete`, `.interval`: see below.

### Local copies of folders (`REQ1/EXT-4`)

The extension can keep chosen folders on the host copied to your machine, and up to date, for as
long as a window is connected: **Remote-Gosh: Choose Folders to Keep a Local Copy Of...**, or
right-click a folder and **Keep a Local Copy of This Folder**. Each goes to
`remote-gosh-copies/HOST/path/on/the/host` in your home directory. The copying is a gosh session
of its own (`gocp --auto`), so it carries on through changes of network and sleep, and after an
interruption sends only what is missing.

It goes **one way**, from the host to your machine: an edit to the copy is replaced the next time
the file changes on the host. Files removed on the host stay in the copy unless
`remoteGosh.localCopies.delete` is on. Not available for Windows hosts.

### When UDP is blocked

When the host does not answer by UDP, the gosh client opens another ssh connection and carries the
session through it, by itself: three seconds into a connection getting no answer, or ten seconds
into a silence later on. It goes back to UDP when UDP works again. `remoteGosh.relay` set to
`always` uses ssh from the start, and `never` is UDP only.

### Terminals that outlive the editor (`REQ1/EXT-3`)

Set `remoteGosh.persistentTerminals` to `shpool` and the terminals on the host are
[shpool](https://github.com/shell-pool/shpool) sessions: quit the editor, come back tomorrow, open a
terminal, and you are back in the shell you left. From any login to the host, `shpool list` shows
them and `shpool attach NAME` joins one. A host with no shpool of its own is given the one the
extension carries (0.11.6, built unmodified from crates.io; Apache-2.0, its licence in
`third-party/`). Not available on Windows hosts.

## When it doesn't work

- **"gosh could not reach ... on UDP port ..., nor through ssh"**: setting up over ssh worked, and
  then the session got no answer by UDP or by a second ssh connection. Open UDP 60000-61000 on the
  host's firewall, and check `ssh -o BatchMode=yes HOST true`.
- **"Could not set up HOST: ... installing gosh failed"**: the host could not fetch gosh's release.
  While `wmacevoy/gosh` is private its releases cannot be downloaded without a login; set
  `remoteGosh.releasesUrl` to a copy of them that the host can reach.
- **It connects, but only after a few seconds' wait every time**: UDP is blocked; set
  `remoteGosh.relay` to `always`.

## What has and has not been tested

Tested, by `node test/connect.test.js` with `GOSH_BUILD` set to a built gosh checkout, on Linux
(x86-64), against gosh's own programs:

- installing gosh at both ends from a release made from that build, with its checksum checked, by
  gosh's own `install.sh`;
- a headless gosh session forwarding to the editor's server, which answers through the forward;
- connecting again, reusing what is installed and running; closing one connection without
  disturbing another;
- the session carried by the relay when told to, and found by itself when UDP gets no answer;
- keeping a local copy of a folder: it arrives, and changes, additions and removals follow;
- the persistent-terminals setting, with a stand-in shpool and with the real 0.11.6
  (`test/shpool.test.py`).

**Not tested:**

- **The editor itself.** Nothing here has run inside VSCodium. The tests drive `lib/` with no
  editor; `extension.js` is not run by any test.
- **The editor's real server**, in the run above: it used `EDITOR_SERVER=standin`, a stand-in that
  says what the real one says and answers `/version`, because the real one is downloaded from
  GitHub. Without that setting the test downloads and runs the real one, as `remote-mosh`'s did.
- **ssh.** The "host" is this machine, reached by a local shell instead of ssh, and the relay on it
  is started directly.
- **Windows**, at either end, and **macOS**: not run.
- **gosh's published releases**: none with programs exists yet (v0.1 has none), and while gosh is
  private the default download cannot work.

## Licence

GPL-3.0-or-later (`LICENSE`). The shpool it carries is Apache-2.0 (`third-party/shpool-LICENSE`).
