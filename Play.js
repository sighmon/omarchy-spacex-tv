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

function argv(invocation) {
  if (!invocation || !invocation.command) return []
  return [invocation.command].concat(invocation.args || [])
}

if (typeof module !== "undefined") {
  module.exports = {
    playLaunch: playLaunch,
    argv: argv
  }
}
