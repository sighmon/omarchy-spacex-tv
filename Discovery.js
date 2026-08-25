// Cache → card assembly for SpaceX TV. Qt-free so Node tests can require
// this same file the QML panel imports.

var CACHE_X_BROADCAST = "xBroadcast"
var CACHE_STARSHIP_FILM = "starshipFilm"
var CACHE_STARSHIP_FLIGHT_TEST = "starshipFlightTest"
var CACHE_STARSHIP_TALK = "starshipTalk"
var CONTENT_VIDEO = "video"
var CONTENT_GALLERY = "gallery"
var CONTENT_COLLECTION = "collection"

function cardsFromCache(cache, options) {
  if (!cache || typeof cache !== "object") return []

  // HLS first: SpaceX flight-test MP4s are multi-GB progressive files that
  // stall mpv. Match the iOS default (prefersMP4Playback = false).
  var prefersMP4 = !!(options && options.prefersMP4Playback === true)
  var processed = (cache.processed_cards && cache.processed_cards.entries) || {}
  var seenIds = {}
  var cards = []

  function addCard(card) {
    if (!isPlayableCard(card)) return
    var dedupe = String(card.streamUrl || card.sourceUrl || card.id)
    if (seenIds[dedupe]) return
    seenIds[dedupe] = true
    cards.push(card)
  }

  var pinnedPosts = postsFromResponse(cache.pinned)
  var timelinePosts = postsFromResponse(cache.timeline)
  var pinnedIncludes = includesFromResponse(cache.pinned)
  var timelineIncludes = includesFromResponse(cache.timeline)
  var i

  for (i = 0; i < pinnedPosts.length; i++) {
    addCard(xCardFromPost(pinnedPosts[i], pinnedIncludes, processed, true, prefersMP4))
  }

  var pinnedPostIds = {}
  for (i = 0; i < pinnedPosts.length; i++) pinnedPostIds[String(pinnedPosts[i].id)] = true

  var timelineCards = []
  for (i = 0; i < timelinePosts.length; i++) {
    if (pinnedPostIds[String(timelinePosts[i].id)]) continue
    var card = xCardFromPost(timelinePosts[i], timelineIncludes, processed, false, prefersMP4)
    if (isPlayableCard(card)) timelineCards.push(card)
  }
  timelineCards.sort(function (a, b) {
    return (b._sortMs || 0) - (a._sortMs || 0)
  })
  for (i = 0; i < timelineCards.length; i++) addCard(timelineCards[i])

  appendPlaylistCards(cards, seenIds, cache.starship_playlist, CACHE_STARSHIP_FILM, "Starship film", prefersMP4)
  appendPlaylistCards(cards, seenIds, cache.starship_flight_tests_playlist, CACHE_STARSHIP_FLIGHT_TEST, "Starship flight test", prefersMP4)
  appendPlaylistCards(cards, seenIds, cache.starship_talks_playlist, CACHE_STARSHIP_TALK, "Starship talk", prefersMP4)
  appendFlightTestTiles(cards, seenIds, cache.starship_launch_tiles, cache.starship_missions)
  cards = deduplicatedFlightTests(cards)

  for (i = 0; i < cards.length; i++) delete cards[i]._sortMs
  return cards
}

function isPlayableCard(card) {
  if (!card || typeof card !== "object") return false
  var title = String(card.title || "").replace(/^\s+|\s+$/g, "")
  if (!title) return false
  return card.contentKind === CONTENT_GALLERY
    || card.contentKind === CONTENT_COLLECTION
    || card.isUpcoming === true
    || !!(card.streamUrl || card.sourceUrl)
}

function playableUrl(card) {
  if (!card) return ""
  var stream = String(card.streamUrl || "")
  if (stream) return stream
  return String(card.sourceUrl || "")
}

function contentFilters() {
  return [
    { kind: CACHE_X_BROADCAST, title: "Broadcasts" },
    { kind: CACHE_STARSHIP_FILM, title: "Films" },
    { kind: CACHE_STARSHIP_FLIGHT_TEST, title: "Flight Tests" },
    { kind: CACHE_STARSHIP_TALK, title: "Talks" }
  ]
}

function sectionsFromCards(cards) {
  var order = contentFilters()
  var byKind = {}
  var i
  for (i = 0; i < (cards || []).length; i++) {
    var card = cards[i]
    if (!card || !card.kind) continue
    if (!byKind[card.kind]) byKind[card.kind] = []
    byKind[card.kind].push(card)
  }
  var sections = []
  for (i = 0; i < order.length; i++) {
    var list = byKind[order[i].kind] || []
    if (!list.length) continue
    if (order[i].kind === CACHE_STARSHIP_FLIGHT_TEST) {
      list.sort(compareFlightTests)
    }
    sections.push({
      id: order[i].kind,
      title: order[i].title,
      cards: list
    })
  }
  return sections
}

function compareFlightTests(a, b) {
  // Match the Apple app: unpublished/upcoming holding cards lead the shelf,
  // followed by the newest dated flight test first.
  if (!!a.isUpcoming !== !!b.isUpcoming) return a.isUpcoming ? -1 : 1
  var aMs = Date.parse(a.publishedAt || "")
  var bMs = Date.parse(b.publishedAt || "")
  var aHasDate = isFinite(aMs)
  var bHasDate = isFinite(bMs)
  if (aHasDate && bHasDate && aMs !== bMs) return bMs - aMs
  if (aHasDate !== bHasDate) return aHasDate ? -1 : 1
  return String(a.title || "").localeCompare(String(b.title || ""))
}

function postsFromResponse(response) {
  if (!response || !response.data) return []
  return Array.isArray(response.data) ? response.data : []
}

function includesFromResponse(response) {
  return (response && response.includes) || {}
}

function processedEntry(processed, postId) {
  if (!processed || postId == null) return null
  return processed["post:" + postId] || processed[String(postId)] || null
}

function xCardFromPost(post, includes, processed, isPinned, prefersMP4) {
  if (!post || post.id == null) return null
  var entry = processedEntry(processed, post.id)

  var media = mediaForPost(post, includes)
  var broadcastUrl = broadcastUrlFromPost(post) || broadcastUrlFromReferenced(post, includes)
  // A processed stream is only trustworthy when the API post itself has media
  // or explicitly links a broadcast. Older cache generators could scrape a
  // reply video from the rendered page of an otherwise text-only post.
  var processedStreamUrl = (entry && entry.streamURL) || null
  if (processedStreamUrl && !media.length && !broadcastUrl) processedStreamUrl = null
  var mediaItems = postMediaItems(media, prefersMP4)
  var videos = mediaItems.filter(function (item) { return item.kind === CONTENT_VIDEO && item.streamUrl })
  var photos = mediaItems.filter(function (item) { return item.kind === "photo" })
  if (entry && entry.hasUsableContent === false && !videos.length && !photos.length && !broadcastUrl) return null
  var streamUrl = processedStreamUrl || (videos[0] && videos[0].streamUrl) || null
  var contentKind = photos.length && !videos.length && !broadcastUrl ? CONTENT_GALLERY
    : ((videos.length > 1 || (videos.length && photos.length)) ? CONTENT_COLLECTION : CONTENT_VIDEO)
  if (entry && entry.contentKind === CONTENT_GALLERY && photos.length) contentKind = CONTENT_GALLERY
  if (!streamUrl && !broadcastUrl && !photos.length) return null

  var statusUrl = "https://x.com/spacex/status/" + post.id
  // Keep the canonical X page separate from the cached media URL so mpv/yt-dlp
  // can re-resolve it if both cached HLS and MP4 variants have expired.
  var sourceUrl = broadcastUrl || statusUrl
  var thumbnailUrl = (entry && entry.thumbnailURL) || thumbnailFromMedia(media) || thumbnailFromEntities(post) || null
  var title = titleFromPost(post)

  return {
    id: "x:" + post.id,
    kind: CACHE_X_BROADCAST,
    title: title,
    subtitle: isPinned ? "Pinned X broadcast" : (broadcastUrl ? "X broadcast" : "X video"),
    streamUrl: streamUrl,
    sourceUrl: sourceUrl,
    thumbnailUrl: thumbnailUrl,
    fallbackStreamUrl: videos[0] ? videos[0].fallbackStreamUrl : null,
    contentKind: contentKind,
    mediaItems: mediaItems,
    galleryImages: photos.map(function (item) { return item.photoUrl }),
    sourceKind: "x",
    flightTestKey: flightTestKey(null, title),
    flightTestSource: "x",
    isPinned: !!isPinned,
    isLive: entry && entry.isLive != null ? entry.isLive : null,
    publishedAt: post.created_at || null,
    _sortMs: Date.parse(post.created_at || "") || 0
  }
}

function titleFromPost(post) {
  var text = String((post && post.text) || "")
  var firstLine = text.split(/\r?\n/)[0].replace(/^\s+|\s+$/g, "")
  return firstLine || "SpaceX Broadcast"
}

function mediaByKey(includes) {
  var map = {}
  var media = (includes && includes.media) || []
  for (var i = 0; i < media.length; i++) {
    var item = media[i]
    if (item && item.media_key) map[item.media_key] = item
  }
  return map
}

function includedPostsById(includes) {
  var map = {}
  var tweets = (includes && includes.tweets) || []
  for (var i = 0; i < tweets.length; i++) {
    var post = tweets[i]
    if (post && post.id != null) map[String(post.id)] = post
  }
  return map
}

function mediaForPost(post, includes) {
  var byKey = mediaByKey(includes)
  var keys = ((post.attachments || {}).media_keys) || []
  var own = []
  var i
  for (i = 0; i < keys.length; i++) {
    if (byKey[keys[i]]) own.push(byKey[keys[i]])
  }
  if (own.length) return own

  var referenced = referencedContentPost(post, includes)
  if (!referenced) return []
  var refKeys = ((referenced.attachments || {}).media_keys) || []
  var nested = []
  for (i = 0; i < refKeys.length; i++) {
    if (byKey[refKeys[i]]) nested.push(byKey[refKeys[i]])
  }
  return nested
}

function referencedContentPost(post, includes) {
  var refs = (post && post.referenced_tweets) || []
  var byId = includedPostsById(includes)
  for (var i = 0; i < refs.length; i++) {
    var type = refs[i] && refs[i].type
    if (type === "quoted" || type === "retweeted") {
      return byId[String(refs[i].id)] || null
    }
  }
  return null
}

function variantUrls(media) {
  var variants = []
  var i, j
  for (i = 0; i < (media || []).length; i++) {
    var list = media[i].variants || []
    for (j = 0; j < list.length; j++) {
      var url = String((list[j] && list[j].url) || "")
      if (/^https?:/i.test(url)) variants.push(list[j])
    }
  }
  var mp4 = variants.filter(function (variant) {
    var type = String(variant.content_type || "")
    var url = String(variant.url || "")
    return type === "video/mp4" || /\.mp4(\?|$)/i.test(url)
  })
  mp4.sort(function (a, b) {
    return (Number(b.bit_rate) || 0) - (Number(a.bit_rate) || 0)
  })
  var hls = null
  for (i = 0; i < variants.length; i++) {
    var type = String(variants[i].content_type || "")
    var url = String(variants[i].url || "")
    if (type === "application/x-mpegURL" || /\.m3u8(\?|$)/i.test(url)) {
      hls = variants[i].url
      break
    }
  }
  return { mp4: mp4.length ? mp4[0].url : null, hls: hls }
}

function postMediaItems(media, prefersMP4) {
  var result = []
  for (var i = 0; i < (media || []).length; i++) {
    var item = media[i] || {}
    if (item.type === "photo") {
      var photo = item.url || item.preview_image_url
      if (photo) result.push({
        id: item.media_key || "photo:" + i,
        kind: "photo",
        photoUrl: fullSizePhotoUrl(photo),
        thumbnailUrl: photo,
        width: item.width || null,
        height: item.height || null,
        altText: item.alt_text || null
      })
    } else if (item.type === "video" || item.type === "animated_gif" || (item.variants || []).length) {
      var urls = variantUrls([item])
      var primary = prefersMP4 ? (urls.mp4 || urls.hls) : (urls.hls || urls.mp4)
      var fallback = prefersMP4 ? urls.hls : urls.mp4
      if (primary) result.push({
        id: item.media_key || "video:" + i,
        kind: CONTENT_VIDEO,
        streamUrl: primary,
        fallbackStreamUrl: fallback && fallback !== primary ? fallback : null,
        thumbnailUrl: item.preview_image_url || null,
        width: item.width || null,
        height: item.height || null
      })
    }
  }
  return result
}

function fullSizePhotoUrl(url) {
  var value = String(url || "")
  if (!/pbs\.twimg\.com/i.test(value)) return value
  if (/[?&]name=/.test(value)) return value.replace(/([?&]name=)[^&]*/i, "$1orig")
  return value + (value.indexOf("?") >= 0 ? "&" : "?") + "name=orig"
}

function thumbnailFromMedia(media) {
  for (var i = 0; i < (media || []).length; i++) {
    var url = media[i].preview_image_url || media[i].url
    if (url) return url
  }
  return null
}

function thumbnailFromEntities(post) {
  var urls = ((post && post.entities) || {}).urls || []
  var images = []
  for (var i = 0; i < urls.length; i++) {
    var list = urls[i].images || []
    for (var j = 0; j < list.length; j++) {
      if (list[j] && list[j].url) images.push(list[j])
    }
  }
  images.sort(function (a, b) {
    return (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0)
  })
  return images.length ? images[0].url : null
}

function broadcastUrlFromPost(post) {
  return broadcastUrlFromEntities(post && post.entities)
}

function broadcastUrlFromReferenced(post, includes) {
  var referenced = referencedContentPost(post, includes)
  return referenced ? broadcastUrlFromEntities(referenced.entities) : null
}

function broadcastUrlFromEntities(entities) {
  var urls = (entities && entities.urls) || []
  for (var i = 0; i < urls.length; i++) {
    var candidate = urls[i].unwound_url || urls[i].expanded_url || urls[i].url
    if (isBroadcastUrl(candidate)) return candidate
  }
  return null
}

function isBroadcastUrl(value) {
  var url = String(value || "")
  var match = url.match(/^https?:\/\/([^/]+)(\/.*)?$/i)
  if (!match) return false
  var host = match[1].toLowerCase()
  var path = match[2] || ""
  var isX = host === "x.com" || host === "twitter.com" || host.slice(-6) === ".x.com" || host.slice(-12) === ".twitter.com"
  return isX && path.indexOf("/i/broadcasts/") === 0
}

function appendPlaylistCards(cards, seenIds, playlist, kind, subtitle, prefersMP4) {
  var media = (playlist && playlist.media) || []
  var list = []
  var i
  for (i = 0; i < media.length; i++) {
    var card = cardFromStarshipMedia(media[i], kind, subtitle, prefersMP4)
    if (isPlayableCard(card)) list.push(card)
  }
  list.sort(function (a, b) {
    return (b._sortMs || 0) - (a._sortMs || 0)
  })
  for (i = 0; i < list.length; i++) {
    var dedupe = String(list[i].streamUrl || list[i].sourceUrl || list[i].id)
    // Flight tests get a canonical merge after every source is assembled. Keep
    // the playlist candidate even when an X card exposes the exact same stream,
    // so the richer official playlist card can win that merge.
    if (seenIds[dedupe] && kind !== CACHE_STARSHIP_FLIGHT_TEST) continue
    seenIds[dedupe] = true
    cards.push(list[i])
  }
}

function cardFromStarshipMedia(media, kind, subtitle, prefersMP4) {
  if (!media) return null
  var playback = playbackUrls(media, prefersMP4)
  if (!playback) return null
  var title = String(media.title || "").replace(/^\s+|\s+$/g, "")
  if (!title) return null
  var id = media.documentId || media.documentID || media.link || playback.primary
  return {
    id: kind + ":" + id,
    kind: kind,
    title: title,
    subtitle: starshipSubtitle(media, subtitle),
    streamUrl: playback.primary,
    sourceUrl: playback.primary,
    fallbackStreamUrl: playback.fallback || null,
    contentKind: CONTENT_VIDEO,
    mediaItems: [],
    galleryImages: [],
    sourceKind: "direct",
    flightTestKey: kind === CACHE_STARSHIP_FLIGHT_TEST ? flightTestKey(media.link, media.title) : null,
    flightTestSource: kind === CACHE_STARSHIP_FLIGHT_TEST ? "playlist" : null,
    thumbnailUrl: posterUrl(media.poster),
    isPinned: false,
    isLive: null,
    publishedAt: media.date || media.publishedAt || null,
    _sortMs: Date.parse(media.date || media.publishedAt || "") || 0
  }
}

function appendFlightTestTiles(cards, seenIds, tiles, missions) {
  var list = Array.isArray(tiles) ? tiles.slice() : []
  list.sort(function (a, b) {
    return (Date.parse(b.launchDate || "") || 0) - (Date.parse(a.launchDate || "") || 0)
  })
  for (var i = 0; i < list.length; i++) {
    var tile = list[i] || {}
    if (String(tile.vehicle || "").toLowerCase() !== "starship") continue
    var key = flightTestKey(tile.link, tile.title)
    if (!key) continue
    var mission = (missions && missions[tile.link]) || {}
    var webcast = preferredWebcast(mission.webcasts)
    var sourceUrl = webcastUrl(webcast) || (tile.link ? "https://www.spacex.com/launches/" + tile.link : "https://www.spacex.com/launches")
    var image = launchPoster(mission.imageDesktop) || launchPoster(tile.imageDesktop)
    var dedupe = "flight-test:" + key
    if (seenIds[dedupe]) continue
    seenIds[dedupe] = true
    cards.push({
      id: dedupe,
      kind: CACHE_STARSHIP_FLIGHT_TEST,
      title: String(tile.shortTitle || tile.title || "Starship flight test"),
      subtitle: webcast ? "Starship flight test" : "Upcoming Starship flight test",
      streamUrl: null,
      fallbackStreamUrl: null,
      sourceUrl: sourceUrl,
      sourceKind: webcast && String(webcast.streamingVideoType || "").toLowerCase() === "youtube" ? "youtube" : "x",
      flightTestKey: key,
      flightTestSource: "tile",
      thumbnailUrl: image,
      contentKind: CONTENT_VIDEO,
      mediaItems: [],
      galleryImages: [],
      isUpcoming: !webcast,
      publishedAt: tile.launchDate || null,
      description: missionSummary(mission) || [tile.vehicle, tile.launchSite].filter(Boolean).join(" · ")
    })
  }
}

function flightTestKey(link, title) {
  var rawLink = String(link || "").toLowerCase().replace(/^starship[-_ ]*/, "")
  var text = (rawLink + " " + String(title || "")).toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[_-]+/g, " ")

  // Prototype serial numbers are their own test lineage. SN11 (March 2021)
  // must never collapse into Flight 11 (October 2025).
  var serialMatch = rawLink.match(/^sn[-_ ]*(\d+)$/)
    || text.match(/\bsn\s*(\d+)\b/)
  if (serialMatch) return "sn" + String(Number(serialMatch[1]))
  if (rawLink === "starhopper" || /\bstarhopper\b/.test(text)) return "starhopper"
  if (rawLink === "flight-test") return "flight-1"

  var hasFlightContext = /\bflight\b/.test(text)
    && (/\btest\b/.test(text) || /\bstarship\b/.test(text) || !!link)
  if (!hasFlightContext) return null

  var match = text.match(/\bflight\s*(?:test\s*)?(\d+)(?:st|nd|rd|th)?\b/)
    || text.match(/\b(\d+)(?:st|nd|rd|th)?\s+flight\b/)
  if (match) return "flight-" + String(Number(match[1]))

  var ordinals = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
    fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
    nineteenth: 19, twentieth: 20
  }
  for (var word in ordinals) {
    if (new RegExp("\\b" + word + "\\b").test(text)) return "flight-" + ordinals[word]
  }
  return null
}

function deduplicatedFlightTests(cards) {
  var winners = {}
  var i
  for (i = 0; i < (cards || []).length; i++) {
    var card = cards[i]
    var key = card && card.flightTestKey
    if (!key) continue
    card.flightTestKey = key
    var current = winners[key]
    if (!current || prefersFlightTestCard(card, current.card)) {
      winners[key] = { card: card, index: i }
    }
  }

  var result = []
  for (i = 0; i < (cards || []).length; i++) {
    var candidate = cards[i]
    var candidateKey = candidate && candidate.flightTestKey
    if (!candidateKey || winners[candidateKey].card === candidate) result.push(candidate)
  }
  return result
}

function prefersFlightTestCard(candidate, current) {
  var candidateScore = flightTestCardScore(candidate)
  var currentScore = flightTestCardScore(current)
  if (candidateScore !== currentScore) return candidateScore > currentScore
  var candidateDate = Date.parse(candidate.publishedAt || "")
  var currentDate = Date.parse(current.publishedAt || "")
  if (isFinite(candidateDate) && isFinite(currentDate) && candidateDate !== currentDate) {
    return candidateDate > currentDate
  }
  if (isFinite(candidateDate) !== isFinite(currentDate)) return isFinite(candidateDate)
  return false
}

function flightTestCardScore(card) {
  if (!card) return 0
  var score = card.streamUrl ? 20 : 10
  if (card.isLive === true) score = 100
  else if (card.flightTestSource === "playlist" && card.streamUrl) score = 80
  else if (card.flightTestSource === "tile" && !card.isUpcoming) score = 60
  else if (card.flightTestSource === "x" && card.streamUrl) score = 50
  else if (card.flightTestSource === "tile" && card.isUpcoming) score = 30
  return score + (card.isPinned ? 5 : 0)
}

function preferredWebcast(webcasts) {
  var list = Array.isArray(webcasts) ? webcasts : []
  for (var i = 0; i < list.length; i++) {
    var type = String(list[i].streamingVideoType || "").toLowerCase()
    if ((type === "x.com" || type === "x-live-studio") && list[i].videoId) return list[i]
  }
  for (var j = 0; j < list.length; j++) {
    if (String(list[j].streamingVideoType || "").toLowerCase() === "youtube" && list[j].videoId) return list[j]
  }
  return null
}

function webcastUrl(webcast) {
  if (!webcast || !webcast.videoId) return null
  return String(webcast.streamingVideoType || "").toLowerCase() === "youtube"
    ? "https://www.youtube.com/watch?v=" + webcast.videoId
    : "https://x.com/i/broadcasts/" + webcast.videoId
}

function launchPoster(image) {
  if (!image) return null
  var formats = image.formats || {}
  return (formats.large && formats.large.url) || image.url || null
}

function missionSummary(mission) {
  var paragraphs = (mission && mission.paragraphs) || []
  for (var i = 0; i < paragraphs.length; i++) {
    var value = String((paragraphs[i] && paragraphs[i].content) || "")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "")
    if (value) return value
  }
  return null
}

function starshipSubtitle(media, fallback) {
  if (media.uhdStreamingLink || media.uhdLink) return fallback + " · 4K"
  return fallback
}

function playbackUrls(media, prefersMP4) {
  var mp4 = media.fhdLink || media.hdLink || media.uhdLink || null
  var hls = media.autoStreamingLink || media.fhdStreamingLink || media.hdStreamingLink || media.uhdStreamingLink || null
  var primary = prefersMP4 ? (mp4 || hls) : (hls || mp4)
  if (!primary) return null
  var alternate = prefersMP4 ? hls : mp4
  return {
    primary: primary,
    fallback: alternate && alternate !== primary ? alternate : null
  }
}

function posterUrl(poster) {
  if (!poster) return null
  var formats = poster.formats || {}
  if (formats.large && formats.large.url) return formats.large.url
  if (formats.medium && formats.medium.url) return formats.medium.url
  return poster.url || null
}

if (typeof module !== "undefined") {
  module.exports = {
    cardsFromCache: cardsFromCache,
    isPlayableCard: isPlayableCard,
    playableUrl: playableUrl,
    sectionsFromCards: sectionsFromCards,
    contentFilters: contentFilters,
    CACHE_X_BROADCAST: CACHE_X_BROADCAST,
    CACHE_STARSHIP_FILM: CACHE_STARSHIP_FILM,
    CACHE_STARSHIP_FLIGHT_TEST: CACHE_STARSHIP_FLIGHT_TEST,
    CACHE_STARSHIP_TALK: CACHE_STARSHIP_TALK
  }
}
