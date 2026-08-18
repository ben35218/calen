import ExpoModulesCore
import WidgetKit

// Bridge between the app's widget-snapshot writer (lib/widgetSnapshot.ts) and
// the WidgetKit extension (targets/widget). The app decrypts + expands the
// calendar and hands a JSON snapshot here; this writes it into the shared App
// Group container — the ONLY channel the widget can read, since the extension
// holds no E2EE keys and never talks to the server — and pokes WidgetKit to
// rebuild its timelines.
//
// The snapshot is decrypted event data at rest outside the E2EE envelope, so
// it is written with `completeFileProtectionUntilFirstUserAuthentication`:
// encrypted while the device is at rest before its first unlock, readable by
// the widget afterwards (full `.complete` protection would blank the widget
// whenever the phone is locked, which is exactly when a home/lock-screen
// widget is looked at).

let appGroupId = "group.app.householdcalendar.mobile"
let snapshotFilename = "widget-snapshot.json"

internal final class AppGroupUnavailableException: Exception {
  override var reason: String {
    "App Group container \(appGroupId) is unavailable — entitlements missing?"
  }
}

public class CalenWidgetModule: Module {
  private func snapshotURL() throws -> URL {
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupId
    ) else {
      throw AppGroupUnavailableException()
    }
    return container.appendingPathComponent(snapshotFilename)
  }

  public func definition() -> ModuleDefinition {
    Name("CalenWidget")

    AsyncFunction("setSnapshot") { (json: String) in
      let url = try self.snapshotURL()
      let data = Data(json.utf8)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // Sign-out / household-change teardown: the snapshot belongs to the old
    // account's data and must not outlive it.
    AsyncFunction("clearSnapshot") {
      let url = try self.snapshotURL()
      try? FileManager.default.removeItem(at: url)
    }

    AsyncFunction("reloadWidgets") {
      WidgetCenter.shared.reloadAllTimelines()
    }

    // How many of our widgets are actually on the user's Home/Lock Screen —
    // the widget-adoption nudge suppresses itself for users who already added
    // one. Failure reads as 0 ("not installed"): the nudge is best-effort and
    // a wrong "not installed" only risks one redundant promo.
    AsyncFunction("installedWidgetCount") { (promise: Promise) in
      WidgetCenter.shared.getCurrentConfigurations { result in
        switch result {
        case .success(let infos): promise.resolve(infos.count)
        case .failure: promise.resolve(0)
        }
      }
    }

    // TEMP DEBUG (remove after device verification): where does this process's
    // App Group resolve, and is the snapshot actually there?
    AsyncFunction("snapshotDebug") { () -> [String: Any] in
      let url = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupId)
      var out: [String: Any] = ["containerPath": url?.path ?? "nil"]
      if let u = url {
        let f = u.appendingPathComponent(snapshotFilename)
        out["exists"] = FileManager.default.fileExists(atPath: f.path)
        out["size"] = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? Int ?? 0) ?? 0
      }
      return out
    }
  }
}
