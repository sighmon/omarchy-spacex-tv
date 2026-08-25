// Desktop player invocation for a resolved HLS or MP4 URL.
// Returns the argv the QML surface should exec — it never starts Quickshell.

function playLaunch(streamUrl, options) {
  var url = String(streamUrl || "")
  var opts = options || {}
  var player = String(opts.player || "mpv")

  if (!url) {
    return { command: player, args: [] }
  }

  if (player === "mpv") {
    return {
      command: "mpv",
      args: [
        "--force-window=immediate",
        "--no-terminal",
        "--cache=yes",
        "--ytdl=yes",
        "--ytdl-format=bestvideo+bestaudio/best",
        "--",
        url
      ]
    }
  }

  if (player === "xdg-open" || player === "open") {
    return { command: player, args: [url] }
  }

  return { command: player, args: ["--", url] }
}

function playbackCandidates(card) {
  if (!card) return []
  var stream = String(card.streamUrl || "")
  var fallback = String(card.fallbackStreamUrl || "")
  var source = String(card.sourceUrl || "")
  var provisionalLive = card.isLive === true || isProvisionalLiveUrl(stream)
  var replay = provisionalLive ? replayUrlForLiveStream(stream) : ""
  var ordered = provisionalLive
    // X's replay endpoint turns master_dynamic_delta renditions into finite,
    // seekable playlist_<id> manifests even while a stale cache says isLive.
    ? [source, replay, stream, fallback]
    : [stream, fallback, source]
  var result = []
  for (var i = 0; i < ordered.length; i++) {
    if (ordered[i] && result.indexOf(ordered[i]) < 0) result.push(ordered[i])
  }
  return result
}

function replayUrlForLiveStream(url) {
  var value = String(url || "")
  if (!isProvisionalLiveUrl(value)) return ""
  if (/[?&]type=live(?:&|$)/i.test(value)) {
    return value.replace(/([?&]type=)live(&|$)/i, "$1replay$2")
  }
  return value + (value.indexOf("?") >= 0 ? "&" : "?") + "type=replay"
}

function isProvisionalLiveUrl(url) {
  var value = String(url || "")
  return /\/dynamic_(?:delta|highlatency)\.m3u8/i.test(value)
    || /[?&]type=live(?:&|$)/i.test(value)
}

function viewImage(imageUrl, cachePath, options) {
  var url = String(imageUrl || "")
  var path = String(cachePath || "")
  var maxBytes = Number(options && options.maxBytes) || 64 * 1024 * 1024
  if (!url || !path) return { command: "", args: [] }
  return {
    command: "/bin/bash",
    args: [
      "-c",
      "set -o pipefail; url=\"$1\"; path=\"$2\"; max=\"$3\"; "
        + "mkdir -p \"${path%/*}\"; tmp=\"${path}.tmp.$$\"; trap 'rm -f \"$tmp\"' EXIT; "
        + "if curl -fsSL --compressed --max-time 30 --max-filesize \"$max\" -- \"$url\" "
        + "| head -c \"$((max + 1))\" > \"$tmp\" "
        + "&& [ \"$(wc -c < \"$tmp\")\" -le \"$max\" ]; then "
        + "mv -f \"$tmp\" \"$path\"; "
        + "if command -v swayimg >/dev/null 2>&1; then exec swayimg -f \"$path\"; fi; "
        + "if command -v imv >/dev/null 2>&1; then exec imv -f \"$path\"; fi; fi; "
        + "exec xdg-open \"$url\"",
      "spacex-tv-image",
      url,
      path,
      String(maxBytes)
    ]
  }
}

function argv(invocation) {
  if (!invocation || !invocation.command) return []
  return [invocation.command].concat(invocation.args || [])
}

if (typeof module !== "undefined") {
  module.exports = {
    playLaunch: playLaunch,
    playbackCandidates: playbackCandidates,
    isProvisionalLiveUrl: isProvisionalLiveUrl,
    replayUrlForLiveStream: replayUrlForLiveStream,
    viewImage: viewImage,
    argv: argv
  }
}
