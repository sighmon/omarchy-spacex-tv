import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Discovery.js" as Discovery
import "Launch.js" as Launch
import "Play.js" as Play

Panel {
  id: root
  moduleName: "com.sighmon.spacex-tv"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var cards: []
  property var sections: []
  property var nextLaunch: null
  property string statusText: "Loading SpaceX TV…"
  property string label: "SpaceX TV"
  property string playingCardId: ""
  property int playGeneration: 0
  property int playerGeneration: 0
  property var playAttempts: []
  property int playAttemptIndex: 0
  property var selectedMediaCard: null
  property int selectedImageIndex: 0
  property string pendingCardId: ""
  property bool filterBroadcasts: true
  property bool filterFilms: true
  property bool filterFlightTests: true
  property bool filterTalks: true

  readonly property string cacheUrl: "https://www.sighmon.com/spacex-tv/x-cache.json"
  readonly property string tilesUrl: "https://content.spacex.com/api/spacex-website/launches-page-tiles/upcoming"
  readonly property string timingsUrl: "https://sxcontent9668.azureedge.us/cms-assets/future_missions.json"
  readonly property int cacheResponseLimit: 8 * 1024 * 1024
  readonly property int launchResponseLimit: 1024 * 1024
  readonly property var barIdentity: hostWidget || root
  readonly property bool prefersMP4Playback: settingBool("prefersMP4Playback", false)
  readonly property bool showCardFilters: settingBool("showCardFilters", true)
  readonly property bool showNextLaunchCountdown: settingBool("showNextLaunchCountdown", true)
  readonly property bool useLocalCache: settingBool("useLocalCache", true)
  readonly property string localCachePath: Quickshell.cachePath("omarchy-spacex-tv/x-cache.json")
  readonly property string galleryImagePath: Quickshell.cachePath("omarchy-spacex-tv/gallery-image")

  function settingBool(key, fallback) {
    if (!root.hostWidget || typeof root.hostWidget.setting !== "function") return fallback
    var value = root.hostWidget.setting(key, fallback)
    if (value === true || value === 1 || value === "true" || value === "1") return true
    if (value === false || value === 0 || value === "false" || value === "0") return false
    return fallback
  }

  function persistSetting(key, value) {
    if (root.hostWidget && typeof root.hostWidget.persistSetting === "function")
      root.hostWidget.persistSetting(key, value)
  }

  function boundedJsonCommand(url, maxSeconds, maxBytes) {
    // head is the hard backstop for curl versions older than 8.4, where
    // --max-filesize does not cap responses without a Content-Length header.
    // Passing URL and limits as positional arguments keeps them out of shell syntax.
    return [
      "/bin/sh", "-c",
      "curl -fsSL --compressed --max-time \"$1\" --max-filesize \"$2\" "
        + "-A 'Mozilla/5.0 Omarchy SpaceXTV/1.0' -H 'Accept: application/json' "
        + "-- \"$4\" | head -c \"$3\"",
      "spacex-tv-fetch",
      String(maxSeconds),
      String(maxBytes),
      String(maxBytes + 1),
      url
    ]
  }

  function cachedJsonCommand(url, maxSeconds, maxBytes, path, allowFallback) {
    return [
      "/bin/bash", "-c",
      "set -o pipefail; p=\"$1\"; mkdir -p \"${p%/*}\"; t=\"${p}.tmp.$$\"; "
        + "trap 'rm -f \"$t\"' EXIT; "
        + "if curl -fsSL --compressed --max-time \"$2\" --max-filesize \"$3\" "
        + "-A 'Mozilla/5.0 Omarchy SpaceXTV/1.0' -H 'Accept: application/json' -- \"$4\" "
        + "| head -c \"$(($3 + 1))\" > \"$t\" "
        + "&& [ \"$(wc -c < \"$t\")\" -le \"$3\" ]; then "
        + "head -c \"$3\" \"$t\"; mv -f \"$t\" \"$p\"; "
        + "elif [ \"$5\" = 1 ] && [ -s \"$p\" ]; then head -c \"$3\" \"$p\"; else exit 1; fi",
      "spacex-tv-cache",
      path,
      String(maxSeconds),
      String(maxBytes),
      url,
      allowFallback ? "1" : "0"
    ]
  }

  function open() {
    root.controller.show()
    root.refresh()
  }

  function close() {
    if (root.selectedMediaCard) {
      root.selectedMediaCard = null
      return
    }
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  ListModel {
    id: sectionModel
  }

  ListModel {
    id: filterModel
  }

  function isKindEnabled(kind) {
    if (kind === Discovery.CACHE_X_BROADCAST) return root.filterBroadcasts
    if (kind === Discovery.CACHE_STARSHIP_FILM) return root.filterFilms
    if (kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST) return root.filterFlightTests
    if (kind === Discovery.CACHE_STARSHIP_TALK) return root.filterTalks
    return true
  }

  function toggleKind(kind) {
    if (kind === Discovery.CACHE_X_BROADCAST) root.filterBroadcasts = !root.filterBroadcasts
    else if (kind === Discovery.CACHE_STARSHIP_FILM) root.filterFilms = !root.filterFilms
    else if (kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST) root.filterFlightTests = !root.filterFlightTests
    else if (kind === Discovery.CACHE_STARSHIP_TALK) root.filterTalks = !root.filterTalks
  }

  function loadFilters() {
    if (filterModel.count) return
    var filters = Discovery.contentFilters()
    for (var i = 0; i < filters.length; i++) {
      filterModel.append({
        title: String(filters[i].title || ""),
        kind: String(filters[i].kind || "")
      })
    }
  }

  Component.onCompleted: root.loadFilters()

  readonly property bool loadingCache: cacheProc.running && sectionModel.count === 0

  function setSections(list) {
    var sections = list || []
    root.sections = sections
    sectionModel.clear()
    for (var i = 0; i < sections.length; i++) {
      sectionModel.append({
        title: String(sections[i].title || ""),
        kind: String(sections[i].id || "")
      })
    }
  }

  function refresh() {
    if (!root.sections.length)
      root.statusText = "Loading SpaceX TV…"
    cacheProc.running = false
    tilesProc.running = false
    timingsProc.running = false
    cacheProc.running = true
    tilesProc.running = true
    timingsProc.running = true
  }

  function playCard(card) {
    if (!card) return
    if (card.contentKind === "gallery" || card.contentKind === "collection") {
      root.selectedMediaCard = card
      root.selectedImageIndex = 0
      return
    }
    if (card.isUpcoming && !card.streamUrl) {
      root.pendingCardId = card.id
      root.statusText = "Checking for a newly published livestream…"
      cacheProc.running = false
      cacheProc.running = true
      return
    }
    var url = Discovery.playableUrl(card)
    if (!url) return
    if (playerProc.running && root.playingCardId === card.id) {
      console.log("[SpaceX TV] already starting", card.id)
      return
    }

    var gen = root.playGeneration + 1
    root.playGeneration = gen
    root.playingCardId = card.id
    root.statusText = "Starting " + card.title
    console.log("[SpaceX TV] play", card.kind, card.title, url)

    root.playAttempts = Play.playbackCandidates(card)
    root.playAttemptIndex = 0

    function start() {
      if (gen !== root.playGeneration) return
      root.startPlaybackAttempt(gen)
    }

    if (playerProc.running) {
      playerProc.running = false
      Qt.callLater(start)
    } else {
      start()
    }
  }

  function startPlaybackAttempt(gen) {
    if (gen !== root.playGeneration || root.playAttemptIndex >= root.playAttempts.length) return
    var url = root.playAttempts[root.playAttemptIndex]
    var invocation = Play.playLaunch(url)
    console.log("[SpaceX TV] playback attempt", root.playAttemptIndex + 1, url)
    playerProc.command = Play.argv(invocation)
    root.playerGeneration = gen
    playerProc.running = true
    root.controller.hide()
  }

  function playMediaItem(item, parentCard) {
    if (!item || !parentCard) return
    if (item.kind === "photo") {
      var photos = []
      var items = parentCard.mediaItems || []
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === "photo" && items[i].photoUrl) photos.push(items[i].photoUrl)
      }
      root.selectedMediaCard = {
        title: parentCard.title,
        contentKind: "gallery",
        galleryImages: photos,
        publishedAt: parentCard.publishedAt
      }
      root.selectedImageIndex = Math.max(0, photos.indexOf(item.photoUrl))
      return
    }
    root.selectedMediaCard = null
    root.playCard({
      id: parentCard.id + ":" + item.id,
      title: parentCard.title,
      streamUrl: item.streamUrl,
      fallbackStreamUrl: item.fallbackStreamUrl,
      sourceUrl: parentCard.sourceUrl,
      sourceKind: parentCard.sourceKind,
      contentKind: "video"
    })
  }

  function cardMetadata(card) {
    if (!card) return ""
    var parts = []
    if (card.contentKind === "gallery") parts.push((card.galleryImages || []).length + " photos")
    else if (card.contentKind === "collection") parts.push((card.mediaItems || []).length + " media")
    else if (card.isUpcoming) parts.push("Upcoming")
    else if (card.subtitle) parts.push(card.subtitle)
    if (card.publishedAt) {
      var date = new Date(card.publishedAt)
      if (!isNaN(date.getTime())) parts.push(Qt.formatDate(date, "MMM d, yyyy"))
    }
    return parts.join(" · ")
  }

  function openGalleryImage(url) {
    var invocation = Play.viewImage(url, root.galleryImagePath)
    if (!invocation.command) return
    function start() {
      imageViewerProc.command = Play.argv(invocation)
      imageViewerProc.running = true
      root.controller.hide()
    }
    if (imageViewerProc.running) {
      imageViewerProc.running = false
      Qt.callLater(start)
    } else {
      start()
    }
  }

  function updateLaunchLabel() {
    if (!root.nextLaunch) {
      root.label = "SpaceX TV"
      return
    }
    var remaining = Launch.remainingTime(root.nextLaunch, Date.now())
    var countdown = Launch.formatCountdown(remaining)
    root.label = countdown || "SpaceX TV"
  }

  function applyLaunchFeeds() {
    if (tilesProc.running || timingsProc.running) return
    var tilesText = String(tilesStdout.text || "").replace(/^\s+|\s+$/g, "")
    var timingsText = String(timingsStdout.text || "").replace(/^\s+|\s+$/g, "")
    if (!tilesText || !timingsText) return
    try {
      root.nextLaunch = Launch.nextLaunchFromFeeds(JSON.parse(tilesText), JSON.parse(timingsText), Date.now())
      root.updateLaunchLabel()
    } catch (e) {
      root.nextLaunch = null
      root.updateLaunchLabel()
    }
  }

  Process {
    id: playerProc
    stdout: StdioCollector {
      waitForEnd: false
    }
    stderr: StdioCollector {
      id: playerErr
      waitForEnd: false
    }
    onExited: function(exitCode) {
      console.log("[SpaceX TV] mpv exited", exitCode)
      Qt.callLater(function() {
        if (playerProc.running) return
        if (root.playerGeneration !== root.playGeneration) return
        if (exitCode && exitCode !== 0 && root.playAttemptIndex + 1 < root.playAttempts.length) {
          root.playAttemptIndex += 1
          root.statusText = "Retrying with alternate stream…"
          root.startPlaybackAttempt(root.playGeneration)
          return
        }
        if (exitCode && exitCode !== 0)
          root.statusText = "Playback failed"
        else if (root.statusText.indexOf("Starting ") === 0)
          root.statusText = ""
        root.playingCardId = ""
      })
    }
  }

  Process {
    id: imageViewerProc
    stdout: StdioCollector { waitForEnd: false }
    stderr: StdioCollector {
      id: imageViewerErr
      waitForEnd: false
    }
    onExited: function(exitCode) {
      if (exitCode && exitCode !== 0)
        console.log("[SpaceX TV] image viewer failed", exitCode, imageViewerErr.text)
    }
  }

  Process {
    id: cacheProc
    command: root.useLocalCache
      ? root.cachedJsonCommand(root.cacheUrl, 20, root.cacheResponseLimit, root.localCachePath, true)
      : root.boundedJsonCommand(root.cacheUrl, 20, root.cacheResponseLimit)
    stdout: StdioCollector {
      id: cacheStdout
      waitForEnd: true
      onStreamFinished: {
        var raw = String(text || "").replace(/^\s+|\s+$/g, "")
        if (raw.length > root.cacheResponseLimit) {
          console.log("[SpaceX TV] cache response exceeded size limit")
          if (!root.cards.length) root.statusText = "Could not load SpaceX TV cache."
          return
        }
        if (!raw) {
          if (!root.cards.length) root.statusText = "Could not load SpaceX TV cache."
          return
        }
        try {
          var parsed = Discovery.cardsFromCache(JSON.parse(raw), {
            prefersMP4Playback: root.prefersMP4Playback
          })
          root.cards = parsed
          root.setSections(Discovery.sectionsFromCards(parsed))
          console.log("[SpaceX TV] loaded", parsed.length, "cards in", root.sections.length, "sections")
          root.statusText = parsed.length ? "" : "No playable broadcasts or films in the cache."
          if (root.pendingCardId) {
            var pendingId = root.pendingCardId
            root.pendingCardId = ""
            var fresh = null
            for (var i = 0; i < parsed.length; i++) {
              if (parsed[i].id === pendingId) { fresh = parsed[i]; break }
            }
            if (fresh && !fresh.isUpcoming) root.playCard(fresh)
            else root.statusText = "Livestream not started yet. Check back closer to launch."
          }
        } catch (e) {
          console.log("[SpaceX TV] cache parse failed", e)
          if (!root.cards.length) root.statusText = "Could not read SpaceX TV cache."
        }
      }
    }
  }

  Process {
    id: tilesProc
    command: root.boundedJsonCommand(root.tilesUrl, 15, root.launchResponseLimit)
    stdout: StdioCollector {
      id: tilesStdout
      waitForEnd: true
      onStreamFinished: root.applyLaunchFeeds()
    }
    onExited: root.applyLaunchFeeds()
  }

  Process {
    id: timingsProc
    command: root.boundedJsonCommand(root.timingsUrl, 15, root.launchResponseLimit)
    stdout: StdioCollector {
      id: timingsStdout
      waitForEnd: true
      onStreamFinished: root.applyLaunchFeeds()
    }
    onExited: root.applyLaunchFeeds()
  }

  Timer {
    interval: 1000
    running: true
    repeat: true
    onTriggered: root.updateLaunchLabel()
  }

  Timer {
    interval: 5 * 60 * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(560))
    contentHeight: panel.fittedContentHeight(Math.min(content.implicitHeight, Style.space(520)))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: scroller
        anchors.fill: parent
        clip: true
        contentWidth: width
        contentHeight: content.implicitHeight
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: content
          width: scroller.width
          spacing: Style.space(10)

          Text {
            width: parent.width
            text: root.selectedMediaCard
              ? root.selectedMediaCard.title
              : (root.nextLaunch && root.showNextLaunchCountdown ? root.nextLaunch.title : "SpaceX TV")
            textFormat: Text.PlainText
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: !root.selectedMediaCard && root.showNextLaunchCountdown && root.nextLaunch != null
            text: root.nextLaunch
              ? (Launch.formatCountdown(Launch.remainingTime(root.nextLaunch, Date.now()))
                 + (root.nextLaunch.vehicle ? " · " + root.nextLaunch.vehicle : ""))
              : ""
            textFormat: Text.PlainText
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          component PreferenceControls: Row {
            spacing: Style.space(6)
            visible: !root.selectedMediaCard

            Rectangle {
              implicitWidth: refreshLabel.implicitWidth + Style.space(18)
              implicitHeight: refreshLabel.implicitHeight + Style.space(10)
              radius: height / 2
              color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, refreshArea.containsMouse ? 0.25 : 0.10)
              Text {
                id: refreshLabel
                anchors.centerIn: parent
                text: cacheProc.running ? "Refreshing…" : "↻ Refresh"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
              }
              MouseArea {
                id: refreshArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                enabled: !cacheProc.running
                onClicked: root.refresh()
              }
            }

            Rectangle {
              implicitWidth: formatLabel.implicitWidth + Style.space(18)
              implicitHeight: formatLabel.implicitHeight + Style.space(10)
              radius: height / 2
              color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, formatArea.containsMouse ? 0.25 : 0.10)
              Text {
                id: formatLabel
                anchors.centerIn: parent
                text: root.prefersMP4Playback ? "MP4 preferred" : "HLS preferred"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: formatArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  root.persistSetting("prefersMP4Playback", !root.prefersMP4Playback)
                  Qt.callLater(root.refresh)
                }
              }
            }

            Rectangle {
              implicitWidth: countdownSettingLabel.implicitWidth + Style.space(18)
              implicitHeight: countdownSettingLabel.implicitHeight + Style.space(10)
              radius: height / 2
              color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, countdownSettingArea.containsMouse ? 0.25 : 0.10)
              opacity: root.showNextLaunchCountdown ? 1 : 0.62
              Text {
                id: countdownSettingLabel
                anchors.centerIn: parent
                text: root.showNextLaunchCountdown ? "Countdown on" : "Countdown off"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: countdownSettingArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.persistSetting("showNextLaunchCountdown", !root.showNextLaunchCountdown)
              }
            }

            Rectangle {
              implicitWidth: filtersSettingLabel.implicitWidth + Style.space(18)
              implicitHeight: filtersSettingLabel.implicitHeight + Style.space(10)
              radius: height / 2
              color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, filtersSettingArea.containsMouse ? 0.25 : 0.10)
              opacity: root.showCardFilters ? 1 : 0.62
              Text {
                id: filtersSettingLabel
                anchors.centerIn: parent
                text: root.showCardFilters ? "Filters on" : "Filters off"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: filtersSettingArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.persistSetting("showCardFilters", !root.showCardFilters)
              }
            }

            Rectangle {
              implicitWidth: cacheSettingLabel.implicitWidth + Style.space(18)
              implicitHeight: cacheSettingLabel.implicitHeight + Style.space(10)
              radius: height / 2
              color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, cacheSettingArea.containsMouse ? 0.25 : 0.10)
              opacity: root.useLocalCache ? 1 : 0.62
              Text {
                id: cacheSettingLabel
                anchors.centerIn: parent
                text: root.useLocalCache ? "Offline cache on" : "Offline cache off"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: cacheSettingArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.persistSetting("useLocalCache", !root.useLocalCache)
              }
            }
          }

          Flow {
            width: parent.width
            spacing: Style.space(6)
            visible: !root.selectedMediaCard && root.showCardFilters

            Repeater {
              model: filterModel

              Rectangle {
                required property string title
                required property string kind
                readonly property bool selected: kind === Discovery.CACHE_X_BROADCAST ? root.filterBroadcasts
                  : kind === Discovery.CACHE_STARSHIP_FILM ? root.filterFilms
                  : kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST ? root.filterFlightTests
                  : kind === Discovery.CACHE_STARSHIP_TALK ? root.filterTalks
                  : true

                implicitWidth: chipLabel.implicitWidth + Style.space(20)
                implicitHeight: chipLabel.implicitHeight + Style.space(10)
                radius: height / 2
                color: Qt.rgba(
                  root.barForeground.r,
                  root.barForeground.g,
                  root.barForeground.b,
                  selected ? 0.28 : 0.10
                )
                border.width: chipArea.containsMouse ? 1 : 0
                border.color: root.barForeground
                opacity: selected ? 1 : 0.75

                Text {
                  id: chipLabel
                  anchors.centerIn: parent
                  text: title
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }

                MouseArea {
                  id: chipArea
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleKind(kind)
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: !root.selectedMediaCard && root.statusText !== "" && !root.loadingCache
            text: root.statusText
            textFormat: Text.PlainText
            color: root.barForeground
            opacity: 0.8
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Item {
            width: parent.width
            height: Style.space(72)
            visible: !root.selectedMediaCard && root.loadingCache

            Column {
              anchors.centerIn: parent
              spacing: Style.space(8)

              Text {
                id: cacheSpinner
                anchors.horizontalCenter: parent.horizontalCenter
                text: "󰦖"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.title

                RotationAnimator on rotation {
                  running: root.loadingCache
                  from: 0
                  to: 360
                  duration: 800
                  loops: Animation.Infinite
                }
              }

              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "Loading SpaceX TV…"
                color: root.barForeground
                opacity: 0.8
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.selectedMediaCard != null

            Rectangle {
              implicitWidth: backLabel.implicitWidth + Style.space(18)
              implicitHeight: backLabel.implicitHeight + Style.space(10)
              radius: height / 2
              color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, backArea.containsMouse ? 0.25 : 0.10)
              Text {
                id: backLabel
                anchors.centerIn: parent
                text: "← Back"
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
              }
              MouseArea {
                id: backArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.selectedMediaCard = null
              }
            }

            Column {
              width: parent.width
              spacing: Style.space(8)
              visible: root.selectedMediaCard && root.selectedMediaCard.contentKind === "gallery"

              Image {
                id: galleryImage
                width: parent.width
                height: Style.space(320)
                source: root.selectedMediaCard && root.selectedMediaCard.galleryImages
                  && root.selectedMediaCard.galleryImages.length
                  ? root.selectedMediaCard.galleryImages[root.selectedImageIndex] : ""
                fillMode: Image.PreserveAspectFit
                asynchronous: true

                Rectangle {
                  anchors.right: parent.right
                  anchors.bottom: parent.bottom
                  anchors.margins: Style.space(8)
                  implicitWidth: fullscreenLabel.implicitWidth + Style.space(16)
                  implicitHeight: fullscreenLabel.implicitHeight + Style.space(8)
                  radius: height / 2
                  color: Qt.rgba(0, 0, 0, 0.62)
                  z: 1

                  Text {
                    id: fullscreenLabel
                    anchors.centerIn: parent
                    text: "⛶ Fullscreen"
                    color: "white"
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.caption
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  enabled: galleryImage.source !== ""
                  onClicked: root.openGalleryImage(galleryImage.source)
                  z: 2
                }
              }

              Row {
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: Style.space(14)

                Text {
                  text: "‹"
                  color: root.barForeground
                  opacity: root.selectedImageIndex > 0 ? 1 : 0.3
                  font.pixelSize: Style.font.title
                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    enabled: root.selectedImageIndex > 0
                    onClicked: root.selectedImageIndex -= 1
                  }
                }
                Text {
                  text: root.selectedMediaCard && root.selectedMediaCard.galleryImages
                    ? (root.selectedImageIndex + 1) + " of " + root.selectedMediaCard.galleryImages.length : ""
                  color: root.barForeground
                  font.family: root.bar ? root.bar.fontFamily : Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  text: "›"
                  color: root.barForeground
                  opacity: root.selectedMediaCard && root.selectedMediaCard.galleryImages
                    && root.selectedImageIndex + 1 < root.selectedMediaCard.galleryImages.length ? 1 : 0.3
                  font.pixelSize: Style.font.title
                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    enabled: root.selectedMediaCard && root.selectedMediaCard.galleryImages
                      && root.selectedImageIndex + 1 < root.selectedMediaCard.galleryImages.length
                    onClicked: root.selectedImageIndex += 1
                  }
                }
              }
            }

            Grid {
              width: parent.width
              columns: 2
              spacing: Style.space(8)
              visible: root.selectedMediaCard && root.selectedMediaCard.contentKind === "collection"

              Repeater {
                model: root.selectedMediaCard && root.selectedMediaCard.mediaItems
                  ? root.selectedMediaCard.mediaItems.length : 0

                Rectangle {
                  required property int index
                  readonly property var mediaItem: root.selectedMediaCard.mediaItems[index]
                  width: (parent.width - parent.spacing) / 2
                  height: Style.space(110)
                  radius: Style.cornerRadius
                  clip: true
                  color: Qt.rgba(0, 0, 0, 0.25)

                  Image {
                    anchors.fill: parent
                    source: mediaItem.thumbnailUrl || mediaItem.photoUrl || ""
                    fillMode: Image.PreserveAspectCrop
                    asynchronous: true
                  }
                  Rectangle {
                    anchors.fill: parent
                    color: Qt.rgba(0, 0, 0, collectionArea.containsMouse ? 0.18 : 0.36)
                  }
                  Text {
                    anchors.centerIn: parent
                    text: mediaItem.kind === "photo" ? "Photo" : "▶ Video"
                    color: "white"
                    font.family: root.bar ? root.bar.fontFamily : Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  MouseArea {
                    id: collectionArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.playMediaItem(mediaItem, root.selectedMediaCard)
                  }
                }
              }
            }
          }

          Repeater {
            model: sectionModel

            Column {
              id: sectionBlock
              required property string title
              required property string kind
              required property int index
              readonly property var sectionCards: (root.sections[index] && root.sections[index].cards) || []
              width: content.width
              spacing: Style.space(8)
              visible: !root.selectedMediaCard && (sectionBlock.kind === Discovery.CACHE_X_BROADCAST ? root.filterBroadcasts
                : sectionBlock.kind === Discovery.CACHE_STARSHIP_FILM ? root.filterFilms
                : sectionBlock.kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST ? root.filterFlightTests
                : sectionBlock.kind === Discovery.CACHE_STARSHIP_TALK ? root.filterTalks
                : true)

              Text {
                width: parent.width
                text: sectionBlock.title.toUpperCase()
                color: root.barForeground
                font.family: root.bar ? root.bar.fontFamily : Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
                font.letterSpacing: 1.2
              }

              Grid {
                id: sectionGrid
                width: parent.width
                columns: 2
                spacing: Style.space(8)

                Repeater {
                  model: sectionBlock.sectionCards.length

                  Item {
                    id: cardItem
                    required property int index
                    readonly property var card: sectionBlock.sectionCards[index]
                    readonly property bool hovered: cardArea.containsMouse
                    readonly property bool starting: !!(cardItem.card && root.playingCardId === cardItem.card.id)
                    readonly property bool imageLoading: poster.status === Image.Loading

                    width: (sectionGrid.width - sectionGrid.spacing) / 2
                    height: Style.space(110)

                    Rectangle {
                      id: posterClip
                      anchors.fill: parent
                      radius: Style.cornerRadius
                      color: Qt.rgba(0, 0, 0, 0.22)
                      clip: true

                      Image {
                        id: poster
                        anchors.fill: parent
                        source: cardItem.card && cardItem.card.thumbnailUrl ? cardItem.card.thumbnailUrl : ""
                        fillMode: Image.PreserveAspectCrop
                        asynchronous: true
                        visible: status === Image.Ready
                      }

                      Column {
                        anchors.centerIn: parent
                        spacing: Style.space(6)
                        visible: cardItem.imageLoading || cardItem.starting
                        z: 2

                        Text {
                          id: cardSpinner
                          anchors.horizontalCenter: parent.horizontalCenter
                          text: "󰦖"
                          color: root.barForeground
                          font.family: root.bar ? root.bar.fontFamily : Style.font.family
                          font.pixelSize: Style.font.title

                          RotationAnimator on rotation {
                            running: cardItem.imageLoading || cardItem.starting
                            from: 0
                            to: 360
                            duration: 800
                            loops: Animation.Infinite
                          }
                        }

                        Text {
                          anchors.horizontalCenter: parent.horizontalCenter
                          visible: cardItem.starting
                          text: "Starting"
                          color: root.barForeground
                          font.family: root.bar ? root.bar.fontFamily : Style.font.family
                          font.pixelSize: Style.font.caption
                        }
                      }

                      Rectangle {
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        height: cardText.implicitHeight + Style.space(10)
                        color: Qt.rgba(0, 0, 0, 0.55)
                        z: 3

                        Column {
                          id: cardText
                          anchors.left: parent.left
                          anchors.right: parent.right
                          anchors.bottom: parent.bottom
                          anchors.margins: Style.space(6)
                          spacing: 1

                          Text {
                            width: parent.width
                            text: cardItem.card && cardItem.card.title ? cardItem.card.title : ""
                            textFormat: Text.PlainText
                            color: root.barForeground
                            font.family: root.bar ? root.bar.fontFamily : Style.font.family
                            font.pixelSize: Style.font.caption
                            font.bold: true
                            maximumLineCount: 1
                            elide: Text.ElideRight
                          }

                          Text {
                            width: parent.width
                            text: root.cardMetadata(cardItem.card)
                            textFormat: Text.PlainText
                            color: root.barForeground
                            opacity: 0.72
                            font.family: root.bar ? root.bar.fontFamily : Style.font.family
                            font.pixelSize: Math.max(9, Style.font.caption - 2)
                            maximumLineCount: 1
                            elide: Text.ElideRight
                          }
                        }
                      }

                      MouseArea {
                        id: cardArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.playCard(cardItem.card)
                        z: 4
                      }
                    }

                    Rectangle {
                      anchors.fill: parent
                      radius: Style.cornerRadius
                      color: "transparent"
                      border.width: cardItem.hovered || cardItem.starting ? 2 : 0
                      border.color: root.barForeground
                      z: 5
                    }
                  }
                }
              }
            }
          }

          PreferenceControls {
            anchors.horizontalCenter: parent.horizontalCenter
          }

          Text {
            width: parent.width
            text: "v1.1.0"
            color: root.barForeground
            opacity: 0.45
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }

          Item {
            width: parent.width
            height: Style.space(16)
          }
        }
      }
    }
  }
}
