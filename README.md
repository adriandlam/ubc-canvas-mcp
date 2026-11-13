# ubc-canvas-mcp

An [MCP](https://modelcontextprotocol.io) server for [UBC Canvas](https://canvas.ubc.ca). It lets
Claude, Cursor or any other MCP client read your courses, assignments, due dates, modules, pages,
announcements and grades.

Unofficial and not affiliated with UBC. UBC doesn't let students create Canvas API tokens, so this
signs in the way you do: through CWL in a real browser.

## How it works

`login` opens a browser window with its own profile, separate from your everyday one. You sign in
with CWL and MFA once. The server then makes plain HTTPS requests to the Canvas API with that
session's cookie, so normal calls don't start a browser at all.

When the Canvas session expires, the server opens the saved profile in a hidden browser to get a
new one. If you logged in with `--remember`, it fills in your CWL login itself, and Duo lets it
through without MFA for the 30 days the browser is trusted. Otherwise, or once Duo wants MFA again,
a browser window opens so you can sign in, and the request that triggered it carries on once
you're done.

The server can only read. It sends GET requests to `canvas.ubc.ca` and nowhere else, so it can't
submit assignments, post to discussions or send messages.

## Requirements

- macOS, Windows or Linux
- [Bun](https://bun.sh) 1.3 or newer
- Chrome, or Edge on Windows. For Brave, Helium or another Chromium browser, set `UBC_CANVAS_BROWSER` (see Configuration).

## Setup

### 1. Install and log in

```sh
git clone https://github.com/adriandlam/ubc-canvas-mcp
cd ubc-canvas-mcp
bun install
bun src/cli.ts login
```

Sign in with your CWL in the window that opens. When Duo asks whether this is your device, say
yes, so it skips MFA here for 30 days. The window closes by itself and prints your name.

To have expired sessions renewed without a window, add `--remember`:

```sh
bun src/cli.ts login --remember
```

This saves the CWL login name and password you type in the window to your system keychain
(Keychain on macOS, Credential Manager on Windows, Secret Service on Linux). It's only saved once
the login has actually reached Canvas, and it's only ever filled in on `authentication.ubc.ca`.

### 2. Connect your client

Most clients take this config. Use full paths: `which bun` prints the first one, and the second is
`src/cli.ts` in the folder you cloned.

```json
{
  "mcpServers": {
    "ubc-canvas": {
      "command": "/Users/you/.bun/bin/bun",
      "args": ["/Users/you/ubc-canvas-mcp/src/cli.ts"]
    }
  }
}
```

<details>
<summary>Claude Code</summary>

```sh
claude mcp add ubc-canvas -s user -- "$(which bun)" "$PWD/src/cli.ts"
```

</details>

<details>
<summary>Claude Desktop</summary>

Open Settings > Developer > Edit Config, add the config above to `claude_desktop_config.json` and
restart Claude Desktop.

</details>

<details>
<summary>Cursor</summary>

Add the config above to `~/.cursor/mcp.json`.

</details>

<details>
<summary>Codex</summary>

```sh
codex mcp add ubc-canvas -- "$(which bun)" "$PWD/src/cli.ts"
```

</details>

Then ask something like:

- What's due this week?
- Summarize the CPSC 213 announcements from the last two weeks.
- What's my current grade in MATH 300, and which assignments are still missing?

## Tools

| Tool | What it does |
|---|---|
| `canvas_get` | Any read-only [Canvas REST API](https://canvas.instructure.com/doc/api/) endpoint, with pagination handled |
| `canvas_read_file` | A file: PDFs and images as the file itself, text files as text |

`canvas_get` covers the whole API through one general tool, and its description lists the
endpoints that matter most to students, so models rarely need the docs. Two tools keep the tool
list small in every conversation. Responses leave out empty fields and opaque tokens, and HTML
(assignment descriptions, announcements, the syllabus) comes back as text with its links kept,
which cuts list responses by a quarter to a third.

`canvas_read_file` works for files linked from modules, pages and the syllabus, even when a course
hides its Files tab. PDFs reach the model as PDFs, so equations, tables and figures survive. The
server keeps files in memory and never writes them to disk, though your client may keep its own
copy of what a tool returns (Claude Code saves PDFs it receives to its session folder to read them).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `UBC_CANVAS_BROWSER` | Chrome (Edge on Windows) | Path to another Chromium-based browser, e.g. Brave |
| `UBC_CANVAS_MCP_DIR` | see below | Where the browser profile and session are kept |
| `CANVAS_URL` | `https://canvas.ubc.ca` | Another Canvas instance that signs in through a browser |

The profile and session live in `~/.ubc-canvas-mcp`. Anyone who can read that folder can use your Canvas session, the same as with your browser's own cookies.
`bun src/cli.ts logout` deletes the profile and session, along with any saved CWL login.

## Limitations

- Read-only by design. Write tools would let a model submit work as you.
- Word and PowerPoint files can't be read; the model gets their Canvas link instead.
- It won't run on a headless server. When CWL wants you to sign in again, it needs a screen to
  show the window on.
