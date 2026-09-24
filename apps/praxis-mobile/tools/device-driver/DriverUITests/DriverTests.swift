import XCTest

/// Drives an installed app (DRIVER_BUNDLE_ID, default Praxis) through one step.
/// Actions come from DRIVER_ACTIONS, separated by ";;" — see ../README.md.
/// After the actions it prints the accessibility tree between DRIVER_TREE_BEGIN
/// and DRIVER_TREE_END and attaches a screenshot named "screen".
final class DriverTests: XCTestCase {
  func testStep() throws {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication(bundleIdentifier: env["DRIVER_BUNDLE_ID"] ?? "com.acresweb.praxis.mobile")
    let actions = (env["DRIVER_ACTIONS"] ?? "").components(separatedBy: ";;").filter { !$0.isEmpty }
    if actions.first == "launch" { app.launch() } else { app.activate() }
    for action in actions where action != "launch" {
      let parts = action.split(separator: ":", maxSplits: 1).map(String.init)
      let verb = parts[0]; let arg = parts.count > 1 ? parts[1] : ""
      switch verb {
      case "tap", "tapprefix":
        let predicate = verb == "tap"
          ? NSPredicate(format: "label == %@ OR identifier == %@", arg, arg)
          : NSPredicate(format: "label BEGINSWITH %@", arg)
        let element = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex.first { $0.isHittable }
          ?? app.descendants(matching: .any).matching(predicate).firstMatch
        if element.waitForExistence(timeout: 8) { element.tap(); print("DRIVER tapped \(arg)") } else { print("DRIVER NOT FOUND \(arg)") }
      case "type":
        app.typeText(arg); print("DRIVER typed")
      case "clear":
        // Focus the field labelled <arg> and delete its current text.
        let field = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR identifier == %@", arg, arg)).firstMatch
        if field.waitForExistence(timeout: 8) {
          field.tap()
          let current = (field.value as? String) ?? ""
          field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 8))
          print("DRIVER cleared \(arg)")
        } else { print("DRIVER NOT FOUND \(arg)") }
      case "wait":
        Thread.sleep(forTimeInterval: Double(arg) ?? 1)
      case "home": XCUIDevice.shared.press(.home)
      case "activate": app.activate()
      case "swipeup": app.swipeUp()
      case "swipedown": app.swipeDown()
      case "tapxy":
        let xy = arg.split(separator: ",").compactMap { Double($0) }
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: xy[0], dy: xy[1])).tap()
      default: print("DRIVER unknown action \(action)")
      }
      Thread.sleep(forTimeInterval: 0.6)
    }
    Thread.sleep(forTimeInterval: Double(env["DRIVER_SETTLE"] ?? "1.5") ?? 1.5)
    print("DRIVER_TREE_BEGIN")
    print(app.debugDescription)
    print("DRIVER_TREE_END")
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "screen"; shot.lifetime = .keepAlways
    add(shot)
  }
}
