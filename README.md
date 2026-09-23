# Omarchy SpaceX TV

An Omarchy bar widget for watching SpaceX broadcasts and Starship films.

<img src="preview.png" width="100%" />

It loads the hosted SpaceX TV cache (no X API Bearer Token required), shows poster cards for X broadcasts, photo galleries, mixed-media posts, Starship films, talks, and flight tests, and displays a next-launch countdown from the same SpaceX feeds used by spacex.com/launches. Selecting a video plays its HLS or MP4 stream in `mpv`; galleries and mixed posts open inside the panel. Click the large gallery image to open it fullscreen in `swayimg` or `imv`, with the system URL handler as a fallback.

Playback automatically retries the alternate HLS/MP4 format and finally the original X or YouTube page. `mpv` uses `yt-dlp` for that last play-time resolution step, so installing `yt-dlp` is recommended for live X and YouTube fallback playback.

The plugin runs inside the long-lived `omarchy-shell` process. It does not start a second Quickshell process.

## Install

```sh
omarchy plugin add https://github.com/sighmon/omarchy-spacex-tv.git --enable
```

Or copy this folder to `~/.config/omarchy/plugins/com.sighmon.spacex-tv/` and run `omarchy-shell shell rescanPlugins`.

## Usage

Click the bar countdown (or **SpaceX TV**) to open the poster panel. Click a card to play it in `mpv`. Press Escape to close the panel.

After copying files onto a running desktop, **restart the shell**. `omarchy-shell` keeps compiled QML in memory, so `rsync` and `omarchy-shell shell rescanPlugins` leave the previous panel running:

```sh
omarchy-restart-shell
```

## Configure

```sh
omarchy bar move com.sighmon.spacex-tv --section center
omarchy bar set com.sighmon.spacex-tv showCountdown false --json
omarchy bar set com.sighmon.spacex-tv showNextLaunchCountdown false --json
omarchy bar set com.sighmon.spacex-tv showCardFilters false --json
omarchy bar set com.sighmon.spacex-tv prefersMP4Playback true --json
omarchy bar set com.sighmon.spacex-tv useLocalCache false --json
```

`showCountdown` controls the bar label. The other preferences control the panel countdown, filter chips, HLS/MP4 priority, and fallback to the last successful hosted-cache response. They can also be toggled from the panel.

Cache downloads require `python3` and `curl`. Cache directories must be owned by the current user, with no symlink components or group/other-writable ancestors (root-owned sticky ancestors such as `/tmp` are allowed). JSON and image caches use exclusive random staging files and descriptor-relative publication; cached JSON reads and fullscreen image viewing also avoid following cache path symlinks.

Playback uses `mpv`. Install it if it is not already on the system (`xdg-open` is not used unless you change `Play.js`). Install `yt-dlp` as well to resolve X or YouTube webpage fallbacks at play time.

## Remove

```sh
omarchy plugin remove com.sighmon.spacex-tv
```

## Discovery

Default discovery is `https://www.sighmon.com/spacex-tv/x-cache.json` (`processed_cards`, pinned/timeline posts, and `starship_*` playlist snapshots). Next launch comes from:

- `https://content.spacex.com/api/spacex-website/launches-page-tiles/upcoming`
- `https://sxcontent9668.azureedge.us/cms-assets/future_missions.json`

When present, the cache's `starship_launch_tiles` and `starship_missions` snapshots add upcoming Starship holding cards and their X or YouTube webcasts. The last successful cache response is stored under the user's XDG cache directory for offline startup.

## Logs

Plugin `console.log` lines are prefixed `[SpaceX TV]` and go to the Omarchy shell log:

```sh
qs log -p "$OMARCHY_PATH/shell" --tail 100
```

If `qs` is not on your PATH:

```sh
journalctl --user -f | grep -i "SpaceX TV"
```

## Tests

```sh
node --test tests/test_spacex_tv.js
python3 -B -m unittest discover -s tests -p 'test_cache_io.py'
```

## Links

- [SpaceX TV for AppleTV/iPad on GitHub](https://github.com/sighmon/SpaceX-TV)
- [SpaceX TV on the AppleTV App Store](https://apps.apple.com/us/app/space-tv/id6772833511)
- [SpaceX TV website](https://sighmon.com/spacex-tv/)
