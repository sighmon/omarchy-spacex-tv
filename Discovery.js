// Cache → card assembly for SpaceX TV. Qt-free so Node tests can require
// this same file the QML panel imports.

var CACHE_X_BROADCAST = "xBroadcast"
var CACHE_STARSHIP_FILM = "starshipFilm"
var CACHE_STARSHIP_FLIGHT_TEST = "starshipFlightTest"
var CACHE_STARSHIP_TALK = "starshipTalk"

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
    addCard(xCardFromPost(pinnedPosts[i], pinnedIncludes, processed, true))
  }

  var pinnedPostIds = {}
  for (i = 0; i < pinnedPosts.length; i++) pinnedPostIds[String(pinnedPosts[i].id)] = true

  var timelineCards = []
  for (i = 0; i < timelinePosts.length; i++) {
    if (pinnedPostIds[String(timelinePosts[i].id)]) continue
    var card = xCardFromPost(timelinePosts[i], timelineIncludes, processed, false)
    if (isPlayableCard(card)) timelineCards.push(card)
  }
  timelineCards.sort(function (a, b) {
    return (b._sortMs || 0) - (a._sortMs || 0)
  })
  for (i = 0; i < timelineCards.length; i++) addCard(timelineCards[i])

  appendPlaylistCards(cards, seenIds, cache.starship_playlist, CACHE_STARSHIP_FILM, "Starship film", prefersMP4)
  appendPlaylistCards(cards, seenIds, cache.starship_flight_tests_playlist, CACHE_STARSHIP_FLIGHT_TEST, "Starship flight test", prefersMP4)
  appendPlaylistCards(cards, seenIds, cache.starship_talks_playlist, CACHE_STARSHIP_TALK, "Starship talk", prefersMP4)

  for (i = 0; i < cards.length; i++) delete cards[i]._sortMs
  return cards
}

function isPlayableCard(card) {
  if (!card || typeof card !== "object") return false
  var title = String(card.title || "").replace(/^\s+|\s+$/g, "")
  if (!title) return false
  return !!(card.streamUrl || card.sourceUrl)
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
    sections.push({
      id: order[i].kind,
      title: order[i].title,
      cards: list
    })
  }
  return sections
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

function xCardFromPost(post, includes, processed, isPinned) {
  if (!post || post.id == null) return null
  var entry = processedEntry(processed, post.id)
  if (entry && entry.hasUsableContent === false) return null
  if (entry && entry.contentKind === "gallery" && !entry.streamURL) return null

  var media = mediaForPost(post, includes)
  var broadcastUrl = broadcastUrlFromPost(post) || broadcastUrlFromReferenced(post, includes)
  // A processed stream is only trustworthy when the API post itself has media
  // or explicitly links a broadcast. Older cache generators could scrape a
  // reply video from the rendered page of an otherwise text-only post.
  var processedStreamUrl = (entry && entry.streamURL) || null
  if (processedStreamUrl && !media.length && !broadcastUrl) processedStreamUrl = null
  var streamUrl = processedStreamUrl || bestVariantUrl(media) || null
  if (!streamUrl && !broadcastUrl) return null

  var statusUrl = "https://x.com/spacex/status/" + post.id
  var sourceUrl = broadcastUrl || streamUrl || statusUrl
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

function bestVariantUrl(media) {
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
  if (mp4.length) return mp4[0].url
  for (i = 0; i < variants.length; i++) {
    var type = String(variants[i].content_type || "")
    var url = String(variants[i].url || "")
    if (type === "application/x-mpegURL" || /\.m3u8(\?|$)/i.test(url)) return variants[i].url
  }
  return null
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
    if (seenIds[dedupe]) continue
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
    thumbnailUrl: posterUrl(media.poster),
    isPinned: false,
    isLive: null,
    publishedAt: media.date || media.publishedAt || null,
    _sortMs: Date.parse(media.date || media.publishedAt || "") || 0
  }
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
