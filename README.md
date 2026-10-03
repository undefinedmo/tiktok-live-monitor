# TikTok Live Monitor

Desktop app (Windows) that monitors a TikTok Shop live's sales in real time — live
sales feed, top/unique buyers, failed payments, product table, current auction, and
headline stats — derived from the streamer dashboard's own traffic.

## Install

Download the latest **`TikTok Live Monitor Setup x.y.z.exe`** from
[Releases](https://github.com/undefinedmo/tiktok-live-monitor/releases/latest) and run it.

Windows SmartScreen will warn because the installer is not code-signed — click
**More info → Run anyway**.

The app auto-updates: on launch it checks this repo's releases and installs new
versions in the background.

## Releasing

Releases are built with `electron-builder` and published here.

```powershell
# in the app source tree
# 1. bump "version" in package.json
# 2. build + publish (needs GH_TOKEN with write access to this repo)
$env:GH_TOKEN = "$(gh auth token)"
npm run publish
# 3. electron-builder creates a DRAFT release — un-draft it so auto-update clients see it:
gh release edit vX.Y.Z --repo undefinedmo/tiktok-live-monitor --draft=false
```

Assets per release: the NSIS installer `.exe`, its `.blockmap`, and `latest.yml`
(the electron-updater manifest).
