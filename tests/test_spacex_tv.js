const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const Discovery = require(path.join(root, "Discovery.js"))
const Launch = require(path.join(root, "Launch.js"))
const Play = require(path.join(root, "Play.js"))

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"))
}

function compactPlaylist(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: "Film " + i,
    autoStreamingLink: "https://example.com/" + i + ".m3u8"
  }))
}

function referencedMediaCache(count, keys, media) {
  return { timeline: {
    data: Array.from({ length: count }, (_, i) => ({
      id: String(i), referenced_tweets: [{ type: "quoted", id: "shared" }]
    })),
    includes: { media, tweets: [{ id: "shared", attachments: { media_keys: keys } }] }
  } }
}

test("shared referenced media has an aggregate expansion budget", () => {
  const photo = { media_key: "photo", type: "photo", url: "https://example.com/photo.jpg" }
  const keys = Array(Discovery.MAX_EXPANDED_MEDIA / 4).fill("photo")
  const cache = referencedMediaCache(4, keys, [photo])
  const cards = Discovery.cardsFromCache(cache)
  assert.equal(cards.reduce((sum, card) => sum + card.mediaItems.length, 0), Discovery.MAX_EXPANDED_MEDIA)
  cache.pinned = { data: [{ id: "extra", attachments: { media_keys: ["photo"] } }], includes: { media: [photo] } }
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) < 8 * 1024 * 1024)
  assert.throws(() => Discovery.cardsFromCache(cache), /Cache exceeds expanded media limit/)
})

test("repeated video expansion charges aggregate variant work", () => {
  const variants = Array.from({ length: 1024 }, () => ({ url: "https://example.com/video.mp4" }))
  const video = { media_key: "video", type: "video", variants }
  const cache = referencedMediaCache(1, Array(32).fill("video"), [video])
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) < 8 * 1024 * 1024)
  assert.throws(() => Discovery.cardsFromCache(cache), /Cache exceeds media work limit/)
})

test("shared long media strings cannot amplify beyond the model size budget", () => {
  const photo = { media_key: "photo", type: "photo", url: "https://pbs.twimg.com/" + "a".repeat(128 * 1024) }
  const cache = referencedMediaCache(100, ["photo"], [photo])
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) < 8 * 1024 * 1024)
  assert.throws(() => Discovery.cardsFromCache(cache), /Cache exceeds expanded media size limit/)
})

test("media lookup is indexed once per response with prototype-safe keys", () => {
  let reads = 0
  const photo = { type: "photo", url: "https://example.com/photo.jpg", get media_key() { reads++; return "__proto__" } }
  const cache = referencedMediaCache(100, ["__proto__"], [photo])
  assert.equal(Discovery.cardsFromCache(cache).length, 100)
  assert.ok(reads <= 106, "lookup indexes must not be rebuilt for each card")
})

test("media arrays reject oversized and malformed inputs before scanning", () => {
  const oversized = Array(Discovery.MAX_MEDIA_WORK + 1).fill(null)
  Object.defineProperty(oversized, 0, { get() { assert.fail("must reject before scanning") } })
  for (const field of ["media", "tweets"]) {
    assert.throws(() => Discovery.cardsFromCache({ timeline: { includes: { [field]: oversized } } }), /media work limit/)
    assert.throws(() => Discovery.cardsFromCache({ timeline: { includes: { [field]: { length: 1e9 } } } }), /Invalid cache media array/)
  }
  for (const malformed of [{ length: 1e9 }, "video"]) {
    assert.throws(() => Discovery.cardsFromCache(referencedMediaCache(1, malformed, [])), /Invalid cache media array/)
    assert.throws(() => Discovery.cardsFromCache(referencedMediaCache(1, ["v"], [{ media_key: "v", variants: malformed }])), /Invalid cache media array/)
  }
})

test("compact hostile feeds below the byte limit are rejected before card construction", () => {
  const cache = { starship_playlist: { media: compactPlaylist(30000) } }
  const raw = JSON.stringify(cache)
  assert.ok(Buffer.byteLength(raw) < 8 * 1024 * 1024)
  assert.throws(() => Discovery.cardsFromCache(JSON.parse(raw)), /Cache exceeds card limit/)

  Object.defineProperty(cache.starship_playlist.media[0], "title", {
    get() { assert.fail("oversized feeds must not construct cards") }
  })
  assert.throws(() => Discovery.cardsFromCache(cache), /Cache exceeds card limit/)
})

test("card budget accepts the boundary and rejects excess from every source", () => {
  const limit = Discovery.MAX_CACHE_CARDS
  const media = compactPlaylist(limit)
  const cards = Discovery.cardsFromCache({ starship_playlist: { media } })
  assert.equal(cards.length, limit)
  assert.equal(Discovery.sectionsFromCards(cards)[0].cards.length, limit)

  const sources = [
    entries => ({ pinned: { data: entries } }),
    entries => ({ timeline: { data: entries } }),
    entries => ({ starship_playlist: { media: entries } }),
    entries => ({ starship_flight_tests_playlist: { media: entries } }),
    entries => ({ starship_talks_playlist: { media: entries } }),
    entries => ({ starship_launch_tiles: entries.map(() => ({ vehicle: "Starship" })) })
  ]
  for (const source of sources) {
    // Invalid and duplicate entries still consume the input budget.
    assert.throws(() => Discovery.cardsFromCache(source(Array(limit + 1).fill({}))), /Cache exceeds card limit/)
  }
  assert.throws(() => Discovery.cardsFromCache({
    starship_playlist: { media: media.slice(0, limit / 2) },
    starship_talks_playlist: { media: media.slice(limit / 2) },
    timeline: { data: [{ id: "extra" }] }
  }), /Cache exceeds card limit/)
  assert.throws(() => Discovery.cardsFromCache({
    starship_playlist: { media: { length: 1, 0: media[0] } }
  }), /Invalid cache card source/)
})

test("section models enforce a total delegate budget across kinds", () => {
  const kinds = Discovery.contentFilters().map(filter => filter.kind)
  const cards = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i), title: "Card " + i, kind: kinds[i % kinds.length]
  }))
  const sections = Discovery.sectionsFromCards(cards)
  assert.equal(sections.reduce((total, section) => total + section.cards.length, 0), Discovery.MAX_CACHE_CARDS)
  assert.ok(sections.flatMap(section => section.cards).every(card => Number(card.id) < Discovery.MAX_CACHE_CARDS))
})

test("full launch history only charges Starship tiles to the card budget", () => {
  const cache = {
    starship_playlist: { media: compactPlaylist(4) },
    starship_launch_tiles: Array.from({ length: 743 }, () => ({ vehicle: "Falcon 9" }))
  }
  cache.starship_launch_tiles.push({ vehicle: "Starship", title: "Starship flight test 13", link: "flight-13" })
  assert.equal(Discovery.cardsFromCache(cache).length, 5)
  cache.starship_launch_tiles = Array(Discovery.MAX_LAUNCH_TILES).fill(null)
  assert.equal(Discovery.cardsFromCache(cache).length, 4)
  cache.starship_launch_tiles.push(null)
  assert.throws(() => Discovery.cardsFromCache(cache), /Cache exceeds launch tile limit/)
  cache.starship_launch_tiles = [{ vehicle: "Starship" }]
  cache.starship_playlist.media = compactPlaylist(Discovery.MAX_CACHE_CARDS)
  assert.throws(() => Discovery.cardsFromCache(cache), /Cache exceeds card limit/)
})

test("remote JSON collectors have byte ceilings and feed titles render as plain text", () => {
  const panel = fs.readFileSync(path.join(root, "Panel.qml"), "utf8")

  assert.match(panel, /function boundedJsonCommand\(url, maxSeconds, maxBytes\)/)
  assert.match(panel, /--max-filesize \\"\$2\\"/)
  assert.match(panel, /head -c \\"\$3\\"/)
  assert.equal(
    (panel.match(/command: root\.boundedJsonCommand\(/g) || []).length,
    2,
    "launch feeds must use the bounded command"
  )
  assert.match(panel, /root\.cachedJsonCommand\(root\.cacheUrl/)
  assert.match(panel, /root\.nextLaunch\.title : "SpaceX TV"\)[\s\S]*?textFormat: Text\.PlainText/)
  assert.match(panel, /text: cardItem\.card && cardItem\.card\.title[\s\S]*?textFormat: Text\.PlainText/)
})

test("cardsFromCache yields X broadcasts and Starship films with titles and stream URLs", () => {
  const cache = loadFixture("x-cache.json")
  assert.ok(cache.processed_cards)
  assert.ok(cache.pinned)
  assert.ok(cache.timeline)
  assert.ok(cache.starship_playlist)

  const cards = Discovery.cardsFromCache(cache)
  assert.ok(Array.isArray(cards), "cardsFromCache must return an array")
  assert.ok(cards.length > 0, "cache fixture must produce cards")

  const broadcasts = cards.filter((card) => card.kind === Discovery.CACHE_X_BROADCAST)
  const films = cards.filter((card) => card.kind === Discovery.CACHE_STARSHIP_FILM)
  assert.ok(broadcasts.length >= 1, "expected at least one X broadcast card")
  assert.ok(films.length >= 1, "expected at least one Starship film card")

  for (const card of broadcasts.concat(films)) {
    assert.ok(String(card.title || "").trim(), "card title must be non-empty")
    const playable = String(card.streamUrl || card.sourceUrl || "").trim()
    assert.ok(playable, "card must have a stream or source URL")
    assert.match(playable, /^https?:\/\//)
  }

  const processedStreams = Object.values(cache.processed_cards.entries)
    .map((entry) => entry.streamURL)
    .filter(Boolean)
  const cardStreams = broadcasts.flatMap((card) => [card.streamUrl, card.fallbackStreamUrl]).filter(Boolean)
  assert.ok(
    processedStreams.some((url) => cardStreams.includes(url)),
    "X broadcast cards must retain cached streams as a primary or alternate"
  )

  const filmTitles = cache.starship_playlist.media.map((item) => item.title)
  assert.ok(
    films.some((card) => filmTitles.includes(card.title)),
    "Starship film cards must use titles from starship_playlist"
  )
  assert.ok(
    films.every((card) => card.thumbnailUrl),
    "Starship films in this fixture supply posters"
  )

  const flightTests = cards.filter((card) => card.kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST)
  assert.ok(flightTests.length >= 1, "expected at least one Starship flight test card")
  assert.match(
    String(flightTests[0].streamUrl || ""),
    /\.m3u8(\?|$)/,
    "flight tests must play HLS, not the multi-GB progressive MP4"
  )

  const sections = Discovery.sectionsFromCards(cards)
  assert.deepEqual(
    sections.map((section) => section.title),
    ["Broadcasts", "Films", "Flight Tests"]
  )
  assert.equal(sections[0].cards[0].kind, Discovery.CACHE_X_BROADCAST)
  assert.equal(sections[1].cards[0].kind, Discovery.CACHE_STARSHIP_FILM)
  assert.equal(sections[2].cards[0].kind, Discovery.CACHE_STARSHIP_FLIGHT_TEST)

  const filters = Discovery.contentFilters()
  assert.deepEqual(
    filters.map((filter) => filter.title),
    ["Broadcasts", "Films", "Flight Tests", "Talks"]
  )
  assert.deepEqual(
    filters.map((filter) => filter.kind),
    [
      Discovery.CACHE_X_BROADCAST,
      Discovery.CACHE_STARSHIP_FILM,
      Discovery.CACHE_STARSHIP_FLIGHT_TEST,
      Discovery.CACHE_STARSHIP_TALK
    ]
  )
})

test("text-only X posts ignore processed streams scraped from reply media", () => {
  const cache = {
    processed_cards: {
      version: 4,
      entries: {
        "post:plain": {
          streamURL: "https://video.twimg.com/amplify_video/reply/pl/unrelated.m3u8",
          contentKind: "video",
          hasUsableContent: true
        }
      }
    },
    timeline: {
      data: [{
        id: "plain",
        text: "Deployment confirmed",
        created_at: "2026-08-22T08:29:39.000Z"
      }],
      includes: { media: [] }
    }
  }

  assert.deepEqual(Discovery.cardsFromCache(cache), [])
})

test("X photo and mixed-media posts become galleries and collections", () => {
  const photo = {
    media_key: "photo-1",
    type: "photo",
    url: "https://pbs.twimg.com/media/example.jpg",
    width: 1600,
    height: 900
  }
  const video = {
    media_key: "video-1",
    type: "video",
    preview_image_url: "https://pbs.twimg.com/video-thumb.jpg",
    variants: [
      { content_type: "application/x-mpegURL", url: "https://video.twimg.com/example.m3u8" },
      { content_type: "video/mp4", bit_rate: 1000, url: "https://video.twimg.com/example.mp4" }
    ]
  }
  const cache = {
    timeline: {
      data: [
        { id: "gallery", text: "Launch photos", attachments: { media_keys: ["photo-1"] } },
        { id: "mixed", text: "Launch recap", attachments: { media_keys: ["video-1", "photo-1"] } }
      ],
      includes: { media: [photo, video] }
    }
  }

  const cards = Discovery.cardsFromCache(cache)
  const gallery = cards.find((card) => card.id === "x:gallery")
  const collection = cards.find((card) => card.id === "x:mixed")
  assert.equal(gallery.contentKind, "gallery")
  assert.equal(gallery.galleryImages.length, 1)
  assert.match(gallery.galleryImages[0], /name=orig$/)
  assert.equal(collection.contentKind, "collection")
  assert.deepEqual(collection.mediaItems.map((item) => item.kind), ["video", "photo"])
  assert.match(collection.streamUrl, /\.m3u8$/)
  assert.match(collection.fallbackStreamUrl, /\.mp4$/)
})

test("cached X MP4s respect format preference and retain a distinct alternate", () => {
  const hls = "https://video.twimg.com/holy-grail/master.m3u8"
  const mp4 = "https://video.twimg.com/holy-grail/2160p.mp4"
  const cache = {
    processed_cards: { entries: {
      "post:holy-grail": { streamURL: mp4, contentKind: "video", hasUsableContent: true }
    } },
    timeline: {
      data: [{ id: "holy-grail", text: "The Holy Grail of Rocketry", attachments: { media_keys: ["video"] } }],
      includes: { media: [{ media_key: "video", type: "video", variants: [
        { content_type: "application/x-mpegURL", url: hls },
        { content_type: "video/mp4", bit_rate: 25128000, url: mp4 }
      ] }] }
    }
  }
  const source = "https://x.com/spacex/status/holy-grail"
  assert.deepEqual(Play.playbackCandidates(Discovery.cardsFromCache(cache)[0]), [hls, mp4, source])
  assert.deepEqual(Play.playbackCandidates(Discovery.cardsFromCache(cache, { prefersMP4Playback: true })[0]), [mp4, hls, source])

  const resolved = "https://video.pscp.tv/resolved.m3u8"
  cache.processed_cards.entries["post:holy-grail"].streamURL = resolved
  assert.deepEqual(Play.playbackCandidates(Discovery.cardsFromCache(cache)[0]), [resolved, hls, source])
})

test("Starship launch tiles add upcoming and YouTube flight-test cards", () => {
  const baseTile = {
    title: "Starship Flight 14",
    shortTitle: "Flight 14",
    vehicle: "Starship",
    launchSite: "Starbase",
    launchDate: "2026-09-01",
    imageDesktop: { url: "https://content.spacex.com/flight-14.jpg" }
  }
  const cache = {
    starship_launch_tiles: [
      { ...baseTile, link: "starship-flight-14" },
      { ...baseTile, title: "Starship Flight 15", shortTitle: "Flight 15", link: "starship-flight-15" }
    ],
    starship_missions: {
      "starship-flight-15": {
        webcasts: [{ streamingVideoType: "youtube", videoId: "abc123" }],
        paragraphs: [{ content: "<p>Live from Starbase.</p>" }]
      }
    }
  }

  const cards = Discovery.cardsFromCache(cache, {
    nowMs: Date.parse("2026-08-25T00:00:00Z")
  })
  const upcoming = cards.find((card) => card.id === "flight-test:flight-14")
  const youtube = cards.find((card) => card.id === "flight-test:flight-15")
  assert.equal(upcoming.isUpcoming, true)
  assert.match(upcoming.sourceUrl, /spacex\.com\/launches/)
  assert.equal(youtube.isUpcoming, false)
  assert.equal(youtube.sourceKind, "youtube")
  assert.equal(youtube.sourceUrl, "https://www.youtube.com/watch?v=abc123")
  assert.equal(youtube.description, "Live from Starbase.")
})

test("Flight Tests are ordered upcoming-first and then newest-to-oldest", () => {
  const cards = [
    { id: "old", kind: Discovery.CACHE_STARSHIP_FLIGHT_TEST, title: "Flight 9", publishedAt: "2025-01-01" },
    { id: "film", kind: Discovery.CACHE_STARSHIP_FILM, title: "A film", publishedAt: "2026-08-01" },
    { id: "new", kind: Discovery.CACHE_STARSHIP_FLIGHT_TEST, title: "Flight 12", publishedAt: "2026-05-22" },
    { id: "undated", kind: Discovery.CACHE_STARSHIP_FLIGHT_TEST, title: "Unknown date" },
    { id: "upcoming", kind: Discovery.CACHE_STARSHIP_FLIGHT_TEST, title: "Flight 13", publishedAt: "2026-09-01", isUpcoming: true }
  ]

  const section = Discovery.sectionsFromCards(cards)
    .find((candidate) => candidate.id === Discovery.CACHE_STARSHIP_FLIGHT_TEST)
  assert.deepEqual(section.cards.map((card) => card.id), [
    "upcoming",
    "new",
    "old",
    "undated"
  ])
})

test("pinned X cards survive broadcast/title duplicates and the final flight-test merge", () => {
  const post = (id, text, broadcast, date) => ({
    id, text, created_at: date,
    entities: { urls: [{ expanded_url: broadcast }] }
  })
  const cache = {
    pinned: { data: [post("pinned", "Watch Starship flight test 13", "https://x.com/i/broadcasts/shared", "2026-01-01")] },
    timeline: { data: [
      post("quote", "Live webcast starts now", "https://twitter.com/i/broadcasts/shared?ref=quote", "2026-01-03"),
      post("title-copy", " WATCH  Starship FLIGHT test 13 ", "https://x.com/i/broadcasts/other", "2026-01-02"),
      post("unrelated", "Another broadcast", "https://x.com/i/broadcasts/unrelated", "2026-01-04")
    ] },
    processed_cards: { entries: {
      "post:pinned": { streamURL: "https://example.com/pinned.m3u8" },
      "post:quote": { streamURL: "https://example.com/quote.m3u8", isLive: true }
    } },
    starship_flight_tests_playlist: { media: [{
      title: "Starship flight test 13", link: "flight-13",
      autoStreamingLink: "https://example.com/official.m3u8"
    }] },
    starship_launch_tiles: [{ title: "Starship flight test 13", link: "flight-13", vehicle: "Starship" }]
  }
  const cards = Discovery.cardsFromCache(cache)
  assert.deepEqual(cards.map(card => card.id), ["x:pinned", "x:unrelated"])
  assert.equal(cards[0].isPinned, true)
  assert.equal(Discovery.sectionsFromCards(cards)[0].cards[0].id, "x:pinned")
})

test("X title matching keeps newest unpinned copies without merging generic titles", () => {
  const post = (id, text, date) => ({
    id, text, created_at: date,
    entities: { urls: [{ expanded_url: "https://x.com/i/broadcasts/" + id }] }
  })
  const cards = Discovery.cardsFromCache({ timeline: { data: [
    post("old", "Company update", "2026-01-01"),
    post("new", " COMPANY   update ", "2026-01-02"),
    post("generic-one", "SpaceX Broadcast", "2026-01-03"),
    post("generic-two", "SpaceX Broadcast", "2026-01-04")
  ] } })
  assert.deepEqual(cards.map(card => card.id), ["x:generic-two", "x:generic-one", "x:new"])
})

test("Flight Tests deduplicate playlist, mission-tile, and ordinal X representations", () => {
  const cache = {
    timeline: {
      data: [{
        id: "x-flight-12",
        text: "Starship’s Twelfth Flight Test",
        created_at: "2026-05-22T10:00:00Z",
        attachments: { media_keys: ["x-video"] }
      }],
      includes: {
        media: [{
          media_key: "x-video",
          type: "video",
          variants: [{
            content_type: "application/x-mpegURL",
            url: "https://content.spacex.com/flight-12.m3u8"
          }]
        }]
      }
    },
    starship_flight_tests_playlist: {
      media: [
        {
          documentId: "older-copy",
          title: "Starship’s Twelfth Flight Test",
          link: "flight-12",
          date: "2026-05-21",
          autoStreamingLink: "https://content.spacex.com/flight-12-old.m3u8"
        },
        {
          documentId: "canonical-copy",
          title: "Starship’s Twelfth Flight Test",
          link: "starship-flight-12",
          date: "2026-05-22",
          autoStreamingLink: "https://content.spacex.com/flight-12.m3u8"
        }
      ]
    },
    starship_launch_tiles: [{
      title: "Starship Flight 12",
      shortTitle: "Flight 12",
      link: "starship-flight-12",
      vehicle: "Starship",
      launchDate: "2026-05-22"
    }],
    starship_missions: {
      "starship-flight-12": {
        webcasts: [{ streamingVideoType: "x.com", videoId: "flight12broadcast" }]
      }
    }
  }

  const matches = Discovery.cardsFromCache(cache)
    .filter((card) => card.flightTestKey === "flight-12")
  assert.equal(matches.length, 1)
  assert.equal(matches[0].id, "starshipFlightTest:canonical-copy")
  assert.equal(matches[0].flightTestSource, "playlist")
})

test("flight-test photo galleries survive video card deduplication", () => {
  const cache = {
    timeline: {
      data: [{
        id: "flight-12-photos",
        text: "Starship’s Twelfth Flight Test photos",
        attachments: { media_keys: ["flight-photo"] }
      }],
      includes: {
        media: [{
          media_key: "flight-photo",
          type: "photo",
          url: "https://pbs.twimg.com/media/flight-12.jpg"
        }]
      }
    },
    starship_flight_tests_playlist: {
      media: [{
        documentId: "flight-12-video",
        title: "Starship’s Twelfth Flight Test",
        link: "flight-12",
        date: "2026-05-22",
        autoStreamingLink: "https://content.spacex.com/flight-12.m3u8"
      }]
    }
  }

  const matches = Discovery.cardsFromCache(cache)
    .filter((card) => card.flightTestKey === "flight-12")
  assert.equal(matches.length, 2)
  assert.deepEqual(matches.map((card) => card.contentKind).sort(), ["gallery", "video"])
})

test("historical tiles without webcasts remain openable instead of upcoming", () => {
  const cache = {
    starship_launch_tiles: [
      {
        title: "Starship High Altitude Test - SN11",
        link: "starship-sn11",
        vehicle: "Starship",
        launchDate: "2021-03-30",
        launchTime: "08:00:00"
      },
      {
        title: "Starship Flight 14",
        link: "starship-flight-14",
        vehicle: "Starship",
        launchDate: "2026-09-01",
        launchTime: "08:00:00"
      }
    ],
    starship_missions: {}
  }

  const cards = Discovery.cardsFromCache(cache, {
    nowMs: Date.parse("2026-08-25T00:00:00Z")
  })
  const historical = cards.find((card) => card.flightTestKey === "sn11")
  const future = cards.find((card) => card.flightTestKey === "flight-14")
  assert.equal(historical.isUpcoming, false)
  assert.equal(historical.subtitle, "Starship flight test")
  assert.match(Discovery.playableUrl(historical), /spacex\.com\/launches\/starship-sn11/)
  assert.equal(future.isUpcoming, true)
})

test("SN prototype tests remain distinct from similarly numbered integrated flights", () => {
  const cache = {
    starship_flight_tests_playlist: {
      media: [{
        documentId: "flight-11-playlist",
        title: "Starship’s Eleventh Flight Test",
        link: "flight-11",
        date: "2025-10-13",
        autoStreamingLink: "https://content.spacex.com/flight-11.m3u8"
      }]
    },
    starship_launch_tiles: [
      {
        title: "Starship High Altitude Test - SN11",
        link: "starship-sn11",
        vehicle: "Starship",
        launchDate: "2021-03-30"
      },
      {
        title: "Starship High Altitude Test - SN9",
        link: "starship-sn9",
        vehicle: "Starship",
        launchDate: "2021-02-02"
      }
    ],
    starship_missions: {
      "starship-sn11": {
        webcasts: [{ streamingVideoType: "youtube", videoId: "sn11-video" }]
      },
      "starship-sn9": {
        webcasts: [{ streamingVideoType: "youtube", videoId: "sn9-video" }]
      }
    }
  }

  const cards = Discovery.cardsFromCache(cache)
  assert.deepEqual(
    cards.filter((card) => card.kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST)
      .map((card) => card.flightTestKey).sort(),
    ["flight-11", "sn11", "sn9"]
  )
})

test("nextLaunchFromFeeds joins a future correlationId and remaining time is > 0", () => {
  const tiles = loadFixture("launch-tiles-future.json")
  const timings = loadFixture("future-missions-future.json")
  const nowMs = 1900000000 * 1000

  const launch = Launch.nextLaunchFromFeeds(tiles, timings, nowMs)
  assert.ok(launch, "future correlationId match must yield a next launch")
  assert.equal(launch.correlationId, "FUTURE-STARLINK-1")
  assert.equal(launch.title, "Starlink Group 10-20")
  assert.equal(launch.vehicle, "Falcon 9")

  const remaining = Launch.remainingTime(launch, nowMs)
  assert.ok(remaining > 0, "remaining time for a future launch must be > 0")
  assert.equal(remaining, (1900086400 - 1900000000) * 1000)
})

test("past-only launch feeds do not invent a future launch", () => {
  const tiles = loadFixture("launch-tiles-past.json")
  const timings = loadFixture("future-missions-past.json")
  const nowMs = 1900000000 * 1000

  const launch = Launch.nextLaunchFromFeeds(tiles, timings, nowMs)
  assert.equal(launch, null)

  if (launch) {
    assert.ok(
      Launch.remainingTime(launch, nowMs) <= 0,
      "a past-only set must not produce remaining time > 0"
    )
  }
})

test("playLaunch includes the stream URL in the player invocation args", () => {
  const streamUrl = "https://content.spacex.com/cms-assets/film/stream.m3u8"
  const invocation = Play.playLaunch(streamUrl)

  assert.ok(invocation.command, "playLaunch must choose a player command")
  assert.ok(Array.isArray(invocation.args), "playLaunch must return args")
  assert.ok(
    invocation.args.includes(streamUrl),
    "player args must include the resolved stream URL"
  )
  assert.ok(
    Play.argv(invocation).includes(streamUrl),
    "argv helper must include the stream URL"
  )
  assert.ok(invocation.args.includes("--ytdl=yes"), "webpage fallbacks must resolve at play time")
})

test("cached live manifests resolve the canonical page before direct playback", () => {
  const sourceUrl = "https://x.com/i/broadcasts/example"
  const liveUrl = "https://video.pscp.tv/master_dynamic_delta.m3u8?type=live"
  const fallbackUrl = "https://video.pscp.tv/replay.mp4"
  assert.deepEqual(
    Play.playbackCandidates({
      sourceUrl,
      streamUrl: liveUrl,
      fallbackStreamUrl: fallbackUrl,
      isLive: true
    }),
    [
      sourceUrl,
      "https://video.pscp.tv/master_dynamic_delta.m3u8?type=replay",
      liveUrl,
      fallbackUrl
    ]
  )
  assert.equal(Play.isProvisionalLiveUrl(liveUrl), true)
  assert.equal(
    Play.replayUrlForLiveStream(liveUrl),
    "https://video.pscp.tv/master_dynamic_delta.m3u8?type=replay"
  )
})

test("archived media keeps direct streams ahead of webpage fallback", () => {
  const sourceUrl = "https://x.com/spacex/status/example"
  const hlsUrl = "https://video.twimg.com/archive.m3u8"
  const mp4Url = "https://video.twimg.com/archive.mp4"
  assert.deepEqual(
    Play.playbackCandidates({
      sourceUrl,
      streamUrl: hlsUrl,
      fallbackStreamUrl: mp4Url,
      isLive: false
    }),
    [hlsUrl, mp4Url, sourceUrl]
  )
})

test("gallery images open through a bounded fullscreen viewer command", () => {
  const imageUrl = "https://pbs.twimg.com/media/example.jpg?name=orig"
  const cachePath = "/tmp/space x/gallery-image"
  const invocation = Play.viewImage(imageUrl, cachePath, { maxBytes: 1024, helperPath: "/plugin/cache_io.py" })
  assert.equal(invocation.command, "python3")
  assert.ok(invocation.args.includes(imageUrl), "image URL must be a positional argument")
  assert.ok(invocation.args.includes(cachePath), "cache path must be a positional argument")
  assert.deepEqual(invocation.args, ["/plugin/cache_io.py", "image", cachePath, "30", "1024", imageUrl, "0"])
  assert.equal(Play.viewImage(imageUrl, cachePath).command, "")
})

test("panel supports local cache fallback, manual refresh, media browsing, and alternate retries", () => {
  const panel = fs.readFileSync(path.join(root, "Panel.qml"), "utf8")
  assert.match(panel, /function cachedJsonCommand\(/)
  assert.match(panel, /Retrying with alternate stream/)
  assert.match(panel, /Checking for a newly published livestream/)
  assert.match(panel, /contentKind === "gallery"/)
  assert.match(panel, /contentKind === "collection"/)
  assert.match(panel, /onClicked: root\.openGalleryImage\(galleryImage\.source\)/)
  assert.match(panel, /↻ Refresh/)
  assert.match(
    panel,
    /PreferenceControls \{\s*anchors\.horizontalCenter: parent\.horizontalCenter\s*\}[\s\S]*?text: "v1\.2\.0"/,
    "preferences must be centered immediately above the version footer"
  )
})

test("long-lived players discard both output streams", () => {
  const panel = fs.readFileSync(path.join(root, "Panel.qml"), "utf8")
  for (const id of ["playerProc", "imageViewerProc"]) {
    const block = panel.split("id: " + id + "\n")[1].split("\n  Process {")[0]
    assert.match(block, /stdout: null/)
    assert.match(block, /stderr: null/)
    assert.doesNotMatch(block, /StdioCollector|\.text\b/)
  }
  assert.doesNotMatch(panel, /\b(?:playerErr|imageViewerErr)\b/)
})
