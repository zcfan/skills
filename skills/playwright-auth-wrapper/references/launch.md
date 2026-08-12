# Launch

Use Launch for normal browser opening, authenticated screenshots, state-reuse checks, and automation. It must never write `storage-state.json`.

Open a URL and capture the result:

```bash
node <skill-directory>/scripts/open_with_shared_state.cjs <url>
```

Options:

- `--auth-dir <dir>`: read the same non-default directory selected during Setup.
- `--screenshot <path>`: choose the screenshot path; the default is a private OS temporary directory.
- `--wait-ms <ms>`: wait after navigation before taking the screenshot.

The result contains the requested URL, final URL, title, screenshot path, browser language, and a login-redirect heuristic. If it reports `redirectedToLogin: true`, tell the user and ask whether to run Login. Do not save the launched context.

For multiple URLs, create one Browser Context per URL. Concurrent contexts may read the same shared state safely; never share a persistent browser profile and never write state from Launch.
