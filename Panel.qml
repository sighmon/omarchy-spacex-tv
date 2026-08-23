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

  function open() {
    root.controller.show()
    root.refresh()
  }

  function close() {
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
    var url = Discovery.playableUrl(card)
    if (!url || !card) return
    if (playerProc.running && root.playingCardId === card.id) {
      console.log("[SpaceX TV] already starting", card.id)
      return
    }

    var gen = root.playGeneration + 1
    root.playGeneration = gen
    root.playingCardId = card.id
    root.statusText = "Starting " + card.title
    console.log("[SpaceX TV] play", card.kind, card.title, url)

    function start() {
      if (gen !== root.playGeneration) return
      var invocation = Play.playLaunch(url)
      playerProc.command = Play.argv(invocation)
      playerProc.running = true
      root.close()
    }

    if (playerProc.running) {
      playerProc.running = false
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
        if (exitCode && exitCode !== 0)
          root.statusText = "Playback failed"
        else if (root.statusText.indexOf("Starting ") === 0)
          root.statusText = ""
        root.playingCardId = ""
      })
    }
  }

  Process {
    id: cacheProc
    command: root.boundedJsonCommand(root.cacheUrl, 20, root.cacheResponseLimit)
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
          var parsed = Discovery.cardsFromCache(JSON.parse(raw))
          root.cards = parsed
          root.setSections(Discovery.sectionsFromCards(parsed))
          console.log("[SpaceX TV] loaded", parsed.length, "cards in", root.sections.length, "sections")
          root.statusText = parsed.length ? "" : "No playable broadcasts or films in the cache."
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
            text: root.nextLaunch ? root.nextLaunch.title : "SpaceX TV"
            textFormat: Text.PlainText
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: root.nextLaunch != null
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

          Flow {
            width: parent.width
            spacing: Style.space(6)

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
            visible: root.statusText !== "" && !root.loadingCache
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
            visible: root.loadingCache

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
              visible: sectionBlock.kind === Discovery.CACHE_X_BROADCAST ? root.filterBroadcasts
                : sectionBlock.kind === Discovery.CACHE_STARSHIP_FILM ? root.filterFilms
                : sectionBlock.kind === Discovery.CACHE_STARSHIP_FLIGHT_TEST ? root.filterFlightTests
                : sectionBlock.kind === Discovery.CACHE_STARSHIP_TALK ? root.filterTalks
                : true

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
                        height: cardTitle.implicitHeight + Style.space(10)
                        color: Qt.rgba(0, 0, 0, 0.55)
                        z: 3

                        Text {
                          id: cardTitle
                          anchors.left: parent.left
                          anchors.right: parent.right
                          anchors.bottom: parent.bottom
                          anchors.margins: Style.space(6)
                          text: cardItem.card && cardItem.card.title ? cardItem.card.title : ""
                          textFormat: Text.PlainText
                          color: root.barForeground
                          font.family: root.bar ? root.bar.fontFamily : Style.font.family
                          font.pixelSize: Style.font.caption
                          wrapMode: Text.WordWrap
                          maximumLineCount: 2
                          elide: Text.ElideRight
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

          Text {
            width: parent.width
            text: "v1.0.5"
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
