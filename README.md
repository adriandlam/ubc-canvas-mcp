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
- Node.js 20 or newer
- Chrome, Edge, Brave or Chromium. If you have none of them, run `npx playwright install chromium`.

## Setup

### 1. Log in

```sh
npx -y github:adriandlam/ubc-canvas-mcp login
```

Sign in with your CWL in the window that opens. When Duo asks whether this is your device, say
yes, so it skips MFA here for 30 days. The window closes by itself and prints your name.

To have expired sessions renewed without a window, add `--remember`:

```sh
npx -y github:adriandlam/ubc-canvas-mcp login --remember
```

This saves the CWL login name and password you type in the window to your system keychain
(Keychain on macOS, Credential Manager on Windows, Secret Service on Linux). It's only saved once
the login has actually reached Canvas, and it's only ever filled in on `authentication.ubc.ca`.

### 2. Connect your client

Most clients take this config:

```json
{
  "mcpServers": {
    "ubc-canvas": {
      "command": "npx",
      "args": ["-y", "github:adriandlam/ubc-canvas-mcp"]
    }
  }
}
```

<details>
<summary>Claude Code</summary>

```sh
claude mcp add ubc-canvas -s user -- npx -y github:adriandlam/ubc-canvas-mcp
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
codex mcp add ubc-canvas -- npx -y github:adriandlam/ubc-canvas-mcp
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

One general tool covers the whole API, and its description lists the endpoints that matter most
to students, so models rarely need the docs.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `UBC_CANVAS_BROWSER` | first one found | Path to a Chromium-based browser |
| `UBC_CANVAS_MCP_DIR` | see below | Where the browser profile and session are kept |
| `CANVAS_URL` | `https://canvas.ubc.ca` | Another Canvas instance that signs in through a browser |

The profile and session live in `~/Library/Application Support/ubc-canvas-mcp` on macOS,
`%APPDATA%\ubc-canvas-mcp` on Windows and `~/.config/ubc-canvas-mcp` on Linux. Anyone who can read
that folder can use your Canvas session, the same as with your browser's own cookies.
`npx -y github:adriandlam/ubc-canvas-mcp logout` deletes it, along with any saved CWL login.

## Limitations

- Read-only by design. Write tools would let a model submit work as you.
- Files are listed with their download URLs, but their contents aren't fetched.
- It won't run on a headless server. When CWL wants you to sign in again, it needs a screen to
  show the window on.
