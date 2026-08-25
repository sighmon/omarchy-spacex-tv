import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "com.sighmon.spacex-tv"

  readonly property bool opened: panelLoader.item
    ? panelLoader.item.opened === true
    : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true
    : false
  readonly property string displayText: panelLoader.item && panelLoader.item.label
    ? panelLoader.item.label
    : "SpaceX TV"
  readonly property bool showCountdown: parseBoolSetting(setting("showCountdown", true), true)
  readonly property real iconSize: Math.max(16, Math.round(button.fontSize * 1.55))

  function parseBoolSetting(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback
    if (value === true || value === 1 || value === "true" || value === "1") return true
    if (value === false || value === 0 || value === "false" || value === "0") return false
    return fallback
  }

  function persistSetting(keyName, value) {
    var entry = { id: root.moduleName }
    for (var key in root.settings) {
      if (key !== "id") entry[key] = root.settings[key]
    }
    entry[keyName] = value
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function persistShowCountdown(value) {
    root.persistSetting("showCountdown", value)
  }

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function toggle() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    if (!panelLoader.item) return
    panelLoader.item.bar = root.bar
    panelLoader.item.anchorItem = button
    panelLoader.item.hostWidget = root
    if ("settings" in panelLoader.item) panelLoader.item.settings = root.settings
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.showCountdown ? root.displayText : ""
    labelVisible: false
    hasVisualContent: true
    tooltipText: root.showCountdown
      ? "Open SpaceX TV"
      : (root.displayText + " — Open SpaceX TV")
    fixedWidth: button.vertical
      ? -1
      : Math.ceil(contentRow.implicitWidth + button.scaledHorizontalMargin * 2)
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.persistShowCountdown(!root.showCountdown)
      else if (buttonCode === Qt.LeftButton) root.toggle()
    }

    Row {
      id: contentRow
      anchors.centerIn: parent
      spacing: root.showCountdown ? Math.max(4, Math.round(button.fontSize * 0.35)) : 0

      SpaceXMark {
        size: root.iconSize
        foreground: button.foreground
        anchors.verticalCenter: parent.verticalCenter
      }

      Text {
        visible: root.showCountdown
        text: root.displayText
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
        renderType: Text.NativeRendering
        anchors.verticalCenter: parent.verticalCenter
      }
    }
  }
}
