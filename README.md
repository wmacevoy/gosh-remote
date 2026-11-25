# Gosh - Remote

Work on a remote machine from VSCodium over [gosh](https://wmacevoy.github.io/gosh/), so that the
connection survives changing networks, closing the laptop, and outages.

An ordinary remote session rides on a TCP connection from your machine to the host, and dies with
it. Here the editor talks to a port on your own machine, and a gosh session (mosh's session, with
forwards beside it) carries that port to the host. The editor never sees the network change: at
worst it sees a pause.

**In use; not independently reviewed.** The extension has been in use since 2026-11-19, from
VSCodium on macOS to a Debian 12 host, with persistent terminals. No third party has reviewed gosh
or this extension. See [What has and has not been tested](#what-has-and-has-not-been-tested).

It installs [gosh](https://github.com/wmacevoy/gosh) at both ends for you, from gosh's releases.
Migrated from `remote-mosh`, which did the same with the fork `mosh-1.4.0-pf.*`. Its requirements,
design, queue and findings live in gosh (`docs/REQUIREMENTS_v16.md`, `REQ1/EXT-1` to `REQ1/EXT-4`).

## Getting started

Five steps take you from nothing to a window on the host. Each says what you should see. `HOST` is
the host as you would give it to ssh: `user@host`, or a name from your `~/.ssh/config`.

1. **ssh first.** On your machine:

   ```
   ssh -o BatchMode=yes HOST true && echo ok
   ```

   It should print `ok` and nothing else. If it fails, fix that before going on: the extension
   logs in with ssh and has nowhere to ask for a password, a passphrase or a new host key. Usually
   it needs a key on the host (`ssh-copy-id HOST`), the key's passphrase in an agent
   (`ssh-add`), or one ordinary `ssh HOST` to accept the host's key.

2. **Install the extension.** Run **Extensions: Install from VSIX...** in the Command Palette and
   pick the `.vsix`. A release of this extension carries one; `pixi run vsix` builds one from a
   checkout. *Gosh - Remote* then appears among the installed extensions.

3. **Allow the API it needs.** Remote extensions rely on an editor API that is not yet declared
   stable, so the editor has to be told this one may use it. Run **Preferences: Configure Runtime
   Arguments**, and add to the `argv.json` it opens:

   ```json
   "enable-proposed-api": ["wmacevoy.gosh-remote"]
   ```

   (If there is an `enable-proposed-api` line already, add `"wmacevoy.gosh-remote"` to its list.)
   Then **quit the editor fully** and start it again: Cmd-Q on macOS, or **File > Exit**. Closing
   its windows is not enough, because the file is read only when the editor starts.

4. **Connect.** Run **Gosh-Remote: Connect to Host...** from the Command Palette, or from the
   remote indicator in the bottom-left corner, and give `HOST`. A new window opens on that host
   (its address is `gosh+HOST`). The first connection to a host takes a minute or two, because it
   downloads gosh and the editor's server there; later ones take seconds.

5. **Trust the folder.** When the window asks whether you trust the authors of the files in the
   folder, say yes. Until a window's folder is trusted the extension stays disabled in it (the
   editor's Restricted Mode), and that looks as if it were broken.

It worked if **Gosh-Remote: Show Log** says `gosh: connected; forwarding.`

To try it from a checkout with no packaging, instead of steps 2 and 3:

```
codium --extensionDevelopmentPath=/path/to/gosh-remote --enable-proposed-api wmacevoy.gosh-remote
```

### Then: terminals that outlive the editor

Add to your settings (**Preferences: Open User Settings (JSON)**):

```json
"goshRemote.persistentTerminals": "shpool"
```

Open a terminal in the remote window. In a plain ssh login to the host, `shpool list` should show
it as a session `editor-FOLDER-1`, attached, where `FOLDER` is the folder the window has open.
Start something in it, quit the editor, start it again and connect: a new terminal is that same
shell, with what you started still running. From a plain login, `shpool attach editor-FOLDER-1`
joins it (`shpool attach -f` takes it from the editor). See [Terminals that outlive the
editor](#terminals-that-outlive-the-editor-req1ext-3) for the details, and for choosing, renaming
and detaching sessions.

### Then: a local copy of a folder

Right-click a folder in the Explorer and choose **Keep a Local Copy of This Folder**. A copy appears
on your machine at `~/gosh-remote-copies/HOST/path/on/the/host`. Change a file in the folder on the
host (`date > FOLDER/hello.txt` in a terminal there): within a few seconds the copy has it too.

It goes **one way**, from the host to your machine: an edit to the copy is replaced the next time
the file changes on the host. Files removed on the host stay in the copy unless
`goshRemote.localCopies.delete` is on. The folder is looked at for changes every 2 seconds, or every
`goshRemote.localCopies.interval` seconds. See [Local copies of
folders](#local-copies-of-folders-req1ext-4).

## When it doesn't work

Start with **Gosh-Remote: Show Log**: it says what was done and what went wrong. The usual causes:

- **Nothing happens, or the extension shows as disabled**: the window's folder is not trusted.
  Run **Workspaces: Manage Workspace Trust** and trust it.
- **The remote commands fail at once, or no remote window opens**: the API is not allowed.
  Check the `enable-proposed-api` line in `argv.json` (step 3), and quit the editor fully, not just
  its windows.
- **"Could not set up HOST"** with ssh's own complaint: ssh asked for something. Run
  `ssh -o BatchMode=yes HOST true` and fix what it says (step 1).
- **"gosh could not reach ... on UDP port ..., nor through ssh"**: setting up over ssh worked, and
  then the session got no answer by UDP or by a second ssh connection. Open UDP 60000-61000 on the
  host's firewall, and check `ssh -o BatchMode=yes HOST true`.
- **It connects, but only after a few seconds' wait every time**: UDP is blocked, and the session
  goes over ssh by itself after the wait. Set `goshRemote.relay` to `always` to skip the wait.
- **"Could not set up HOST: ... installing gosh failed"**: the host could not fetch gosh's release.
  While `wmacevoy/gosh` is private its releases cannot be downloaded without a login. Set
  `goshRemote.releasesUrl` to a directory on your machine holding a copy of the release
  (`vVERSION/` with its `SHA256SUMS`, `install.sh` and the client's archive); this note can go once
  gosh is public.

## What it does when you connect

1. Installs the gosh client for your machine, if it isn't there, into the extension's own storage.
   The download comes by https only, and is unpacked only if it matches the SHA-256 the release's
   `SHA256SUMS` lists for it; the client must then say it is that release. Nothing is installed
   system-wide.
2. Logs in to the host with `ssh` and, if they aren't there already, installs gosh (into
   `~/.local/bin`, no root needed, by the release's own `install.sh`, run only if it matches the
   release's `SHA256SUMS`) and the editor's server (unpacked only if it matches the `.sha256`
   VSCodium publishes beside it); starts the server; and starts a gosh session that forwards a port
   to it.
3. Starts the gosh client on your machine with no terminal (`-N`) as the other end of that session,
   forwarding a port on your machine's loopback address (`127.0.0.1`) that the extension chooses.

**What the checksums prove, and what not.** A `SHA256SUMS` or `.sha256` comes from the same place as
the file it lists, so the check catches a download that was damaged or swapped on the way, or a
mirror serving something else; it does not prove who published the release. That rests on https
and on GitHub's account of who can publish there. A host name that ssh could take for one of its
options (one beginning with `-`) is refused, as is one with spaces, control characters or `/`.

After that ssh is finished with, and everything goes through gosh, unless UDP cannot reach the
host: see [When UDP is blocked](#when-udp-is-blocked).

**When the editor loses its connection** (the lid closed, a change of network) it asks again. If
the editor's server answers through the gosh session the window had, within 10 seconds, that
session is kept and nothing is set up. If not, the steps above are run again, and the old session
is ended only once a new one is up. If that fails too, the extension tells the editor to try again
later. The editor keeps trying for up to 3 hours, retrying the old session each time. After
connecting, what the gosh client says goes to the "Gosh - Remote" output with the time, so a drop
leaves a record of why.

## What you need

| | |
| --- | --- |
| Your machine | Linux (x86-64, ARM64) or macOS 11+. **Not Windows yet**: gosh's releases have no Windows build. |
| The host | Linux (x86-64, ARM64; glibc 2.34+) or macOS 11+. A Windows host is experimental (`REQ4/EXT-2`), and waits on that same build; a connection to one says so. |
| `ssh` | On your machine, able to log in to the host **without asking anything**: keys or an agent, and a host key already accepted. There is nowhere for it to ask for a password. `ssh -o BatchMode=yes HOST true` must work. |
| UDP | gosh uses a UDP port between 60000 and 61000 on the host. If your machine cannot reach it, the session is carried over ssh instead. |
| On the host | `curl` or `wget`, `tar`, and `sha256sum`, `shasum` or `openssl` (to check what it downloads). |
| The editor | VSCodium, with this extension allowed to use the API it needs ([Getting started](#getting-started), step 3). |

## Settings

- `goshRemote.goshVersion`: the gosh release to use at both ends (default `0.3.1`, the one this
  extension is in use with).
- `goshRemote.releasesUrl`: where to download gosh from, if not GitHub (each release is the
  directory `vVERSION` under it). By https only, or a directory on your machine.
- `goshRemote.sshPath`: the ssh program, if not the one on your `PATH`.
- `goshRemote.serverDownloadUrlTemplate`: where hosts get the editor's server.
- `goshRemote.persistentTerminals`: `off` (the default) or `shpool`; see below.
- `goshRemote.relay`: `auto` (the default), `always` or `never`; see below.
- `goshRemote.localCopies.folder`, `.delete`, `.interval`: see below.

### Local copies of folders (`REQ1/EXT-4`)

The extension can keep chosen folders on the host copied to your machine, and up to date, for as
long as a window is connected: **Gosh-Remote: Choose Folders to Keep a Local Copy Of...**, or
right-click a folder and **Keep a Local Copy of This Folder**. Each goes to
`gosh-remote-copies/HOST/path/on/the/host` in your home directory. The copying is a gosh session
of its own (`gocp --auto`), so it carries on through changes of network and sleep, and after an
interruption sends only what is missing.

It goes **one way**, from the host to your machine: an edit to the copy is replaced the next time
the file changes on the host. Files removed on the host stay in the copy unless
`goshRemote.localCopies.delete` is on. Not available for Windows hosts.

### When UDP is blocked

When the host does not answer by UDP, the gosh client opens another ssh connection and carries the
session through it, by itself: three seconds into a connection getting no answer, or ten seconds
into a silence later on. It goes back to UDP when UDP works again. `goshRemote.relay` set to
`always` uses ssh from the start, and `never` is UDP only.

### Terminals that outlive the editor (`REQ1/EXT-3`)

Set `goshRemote.persistentTerminals` to `shpool` and the terminals on the host are
[shpool](https://github.com/shell-pool/shpool) sessions: quit the editor, come back tomorrow, open a
terminal, and you are back in the shell you left. From any login to the host, `shpool list` shows
them and `shpool attach NAME` joins one. A host with no shpool of its own is given the one the
extension carries: [gosh-shpool](https://github.com/wmacevoy/gosh-shpool) 0.11.7-gosh.2, which is
shpool 0.11.7 with `shpool rename` and fixes to its session restore that could lose what was on
the screen, each offered to shpool upstream
([shpool#459](https://github.com/shell-pool/shpool/pull/459),
[shpool_vt100#2](https://github.com/shell-pool/shpool_vt100/pull/2),
[shpool_vt100#3](https://github.com/shell-pool/shpool_vt100/pull/3)). It is fetched from that
release and checked against the SHA-256 of each file (`tools/build-shpool.js`). The Linux builds are
static, so Alpine hosts get one too. Apache-2.0, its licence beside it. Not available on Windows hosts.

#### Pool terminals: attach, rename, detach (gosh-remote #3)

A new terminal takes the first `editor-WORKSPACE-N` session that no terminal has. To choose, three
commands, in the Command Palette and on a terminal's right-click and tab menus:

- **Gosh-Remote: Attach Terminal to Session...** lists every shpool session on the host (other
  workspaces', ones started from a login, ones held by a window that has gone), each marked *not
  attached*, *attached elsewhere* or *this terminal*, and opens a terminal on the one you pick, or
  on a new one you name. One attached elsewhere is taken over after you confirm (`shpool attach
  -f`); one already in a terminal of this window is just shown. Also the button on the terminal
  panel's title bar, and **Gosh: Attach to Session...** in the new-terminal dropdown (the `⌄`
  beside `+`). From the dropdown, a pick that opens no terminal (you chose nothing, or the session
  was already in a terminal here) ends in an error message saying so: the editor allows a dropdown
  entry no other way. The entry is in every window's dropdown, and in one not connected by
  Gosh-Remote it only says so.
- **Gosh-Remote: Rename Terminal's Session...** renames the session the active terminal is in (or
  one you pick), with `shpool rename`, and the terminal's tab takes the name. A renamed session is
  not taken by a new terminal by itself: it is yours to attach by name, so a long job (`claude`,
  say) can be given a name and found by it. Needs gosh-shpool on the host; plain shpool has no
  rename.
- **Gosh-Remote: Detach Terminal's Session** detaches the active terminal's session (or an attached
  one you pick, such as one a lost window still holds): its terminal closes and the shell keeps
  running, to be attached again.

Names are up to 64 letters, digits and `. _ : @ + = -`, with no spaces. Each command asks the host
over ssh (`lib/sessions.sh`), so ssh must log in without asking, as for connecting. Which session a
terminal is in is found from shpool's list, whose attached sessions name the pid of their `shpool
attach`; its parent is the terminal launcher, the process the editor knows the terminal by. Terminals
the editor opened by itself keep the tab title "shpool (persistent)" until renamed.

## What has and has not been tested

**In use** since 2026-11-19: VSCodium 1.143 on macOS, to a Debian 12 host on x86-64, gosh 0.3.1 at
both ends (fetched from a local copy of its releases by `goshRemote.releasesUrl`, while gosh is
private). It connects and works, and with `persistentTerminals` set to `shpool` its terminals
outlive the editor. Not yet tried in use: local copies, the pool-terminal commands (attach, rename,
detach), a reconnect after the editor loses its connection, a Linux client, and a macOS host.

Tested, by `node test/connect.test.js` with `GOSH_BUILD` set to a built gosh checkout, on Linux
(x86-64), against gosh's own programs:

- installing gosh at both ends from a release made from that build, with its checksum checked, by
  gosh's own `install.sh`;
- a headless gosh session forwarding to the editor's server, which answers through the forward;
- connecting again, reusing what is installed and running; closing one connection without
  disturbing another;
- on a reconnect, a session whose forward still answers is kept, and one that does not is ended
  only once a new one is up, with stand-ins for the sessions (`reconnect` in `lib/connect.js`;
  that the editor is told to try again is in `extension.js`, which no test runs);
- the session carried by the relay when told to, and found by itself when UDP gets no answer;
- keeping a local copy of a folder: it arrives, and changes, additions and removals follow;
- the persistent-terminals setting, with a stand-in shpool and with the real one it carries
  (gosh-shpool 0.11.7-gosh.2; `test/shpool.test.py`);
- pool terminals, against that real shpool on Linux and macOS (`test/shpool.test.py`): the host's
  script lists each session with the terminal holding it, renames one (and refuses a name in use),
  and detaches one, whose terminal ends and whose shell stays; a new terminal leaves a renamed
  session alone; the launcher's `--attach NAME` returns to that shell, background job and all,
  refuses a session in use with the reason left on screen, takes it with `--force`, and refuses a
  name that is not one. The commands' names, script and list-reading are unit-tested;
- what the review of 2026-11-16 found, each case seen to fail before it was mended: a host that ssh
  would take for an option, refused, and ssh always told where its options end; downloads by https
  only, and each checked before it is unpacked or run (a changed `install.sh`, a changed editor
  server, a client that is not the release asked for); only `gosh: connected; forwarding.` taken for
  connected; the forward always the extension's own, on loopback; only the keys asked for taken from
  the host; the editor's server's token readable by its user alone; a saved process id that is now
  another program's not taken for the server; a local copy kept inside its folder whatever the host
  is called; the terminal launcher's claims kept to the user's own directory, and to 64 sessions.

**Not tested:**

- **`extension.js`, by any test.** The tests drive `lib/` with no editor; the code that talks to
  the editor has run only in the use above. So what that use has not reached is not tested: the
  pool-terminal commands' pickers and the dropdown entry, the terminals they open and the tab
  renaming, and the editor being told to try again after a failed reconnect.
- **The editor's real server**, in the run above: it used `EDITOR_SERVER=standin`, a stand-in that
  says what the real one says and answers `/version`, because the real one is downloaded from
  GitHub. Without that setting the test downloads and runs the real one, as `remote-mosh`'s did.
- **ssh.** The "host" is this machine, reached by a local shell instead of ssh, and the relay on it
  is started directly.
- **Windows**, at either end: not run. **macOS**: the client in use only; the tests run on Linux,
  and `test/shpool.test.py` on macOS too.
- **gosh's published releases**: none with programs exists yet (v0.1 has none), and while gosh is
  private the default download cannot work.

## Licence

GPL-3.0-or-later (`LICENSE`). The shpool it carries is Apache-2.0 (`shpool/LICENSE` in the package,
`third-party/shpool-LICENSE` here).
