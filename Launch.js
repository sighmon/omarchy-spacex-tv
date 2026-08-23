// Next-launch selection from SpaceX launch tiles + future_missions timings.
// Qt-free so Node tests can require this same file the QML panel imports.

function nextLaunchFromFeeds(tiles, timings, nowMs) {
  var now = nowMs == null ? Date.now() : Number(nowMs)
  var tileList = Array.isArray(tiles) ? tiles : []
  var timingMap = timings && typeof timings === "object" ? timings : {}
  var launches = []

  for (var i = 0; i < tileList.length; i++) {
    var tile = tileList[i]
    if (!tile || !tile.correlationId) continue
    var timing = timingMap[tile.correlationId]
    if (!timing) continue
    var launchDateMs = launchDateMsFromTiming(timing)
    if (launchDateMs == null || !isFinite(launchDateMs)) continue

    var title = String(tile.shortTitle || tile.title || "").replace(/^\s+|\s+$/g, "")
    if (!title) continue

    launches.push({
      title: title,
      vehicle: tile.vehicle || null,
      launchSite: tile.launchSite || null,
      launchDateMs: launchDateMs,
      windowCloseMs: windowCloseMsFromTiming(timing),
      isLaunchTimePrecise: timing.IsPrimaryLaunchTimeGiven === true,
      correlationId: tile.correlationId,
      sourceUrl: tile.link ? "https://www.spacex.com/launches/" + tile.link : "https://www.spacex.com/launches",
      imageUrl: launchImageUrl(tile)
    })
  }

  var upcoming = []
  for (var j = 0; j < launches.length; j++) {
    if (launches[j].launchDateMs >= now) upcoming.push(launches[j])
  }
  if (!upcoming.length) return null

  upcoming.sort(function (a, b) {
    return a.launchDateMs - b.launchDateMs
  })
  return upcoming[0]
}

function remainingTime(launch, nowMs) {
  if (!launch || launch.launchDateMs == null) return null
  var now = nowMs == null ? Date.now() : Number(nowMs)
  return launch.launchDateMs - now
}

function formatCountdown(remainingMs) {
  if (remainingMs == null || !isFinite(remainingMs)) return ""
  var sign = remainingMs < 0 ? "+" : "−"
  var totalSec = Math.floor(Math.abs(remainingMs) / 1000)
  var days = Math.floor(totalSec / 86400)
  var hours = Math.floor((totalSec % 86400) / 3600)
  var minutes = Math.floor((totalSec % 3600) / 60)
  var seconds = totalSec % 60
  if (days > 0) return "T" + sign + days + "d " + pad2(hours) + ":" + pad2(minutes)
  return "T" + sign + pad2(hours) + ":" + pad2(minutes) + ":" + pad2(seconds)
}

function launchDateMsFromTiming(timing) {
  if (!timing) return null
  if (timing.TZeroPaused !== true) {
    var tZero = timestampMs(timing.TZeroLaunchDate)
    if (tZero != null) return tZero
  }
  var window = timing.PrimaryLaunchWindow
  if (window && window.Open) {
    var open = timestampMs(window.Open)
    if (open != null) return open
  }
  return timestampMs(timing.PrimaryLaunchDate)
}

function windowCloseMsFromTiming(timing) {
  var window = timing && timing.PrimaryLaunchWindow
  return window && window.Close ? timestampMs(window.Close) : null
}

function timestampMs(stamp) {
  if (stamp == null) return null
  if (typeof stamp === "number") return stamp * 1000
  if (stamp.Seconds == null) return null
  return Number(stamp.Seconds) * 1000
}

function launchImageUrl(tile) {
  var image = tile && tile.imageDesktop
  if (!image) return null
  var formats = image.formats || {}
  if (formats.large && formats.large.url) return formats.large.url
  return image.url || null
}

function pad2(value) {
  var n = Number(value)
  return (n < 10 ? "0" : "") + n
}

if (typeof module !== "undefined") {
  module.exports = {
    nextLaunchFromFeeds: nextLaunchFromFeeds,
    remainingTime: remainingTime,
    formatCountdown: formatCountdown,
    launchDateMsFromTiming: launchDateMsFromTiming
  }
}
