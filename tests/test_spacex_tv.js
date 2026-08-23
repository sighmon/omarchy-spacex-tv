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
  const cardStreams = broadcasts.map((card) => card.streamUrl).filter(Boolean)
  assert.ok(
    processedStreams.some((url) => cardStreams.includes(url)),
    "X broadcast cards must use processed_cards stream URLs from the cache"
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
})
