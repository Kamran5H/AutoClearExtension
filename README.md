# Auto Clear & Optimize (Pro) — Chrome Extension (v2.3)

> **Owner:** Kamran Ashraf. A small Manifest V3 Chrome extension that keeps Chrome fast and light.

## What it does

Auto-wipes history, cache, cookies and site data on a timer, and frees RAM by discarding idle tabs.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (permissions, background worker, popup) |
| `background.js` | The timer + clearing/tab-discard logic |
| `popup.html` / `popup.js` | Toolbar popup UI and settings |

## How to load it

1. Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder.
