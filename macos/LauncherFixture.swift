// QA only: a harmless local AppKit process that exits on its own timer.
import AppKit
import Foundation

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var terminationTimer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let lifetime = Bundle.main.object(forInfoDictionaryKey: "FixtureLifetime") as? Double ?? 10
        terminationTimer = Timer.scheduledTimer(withTimeInterval: lifetime, repeats: false) { _ in
            NSApplication.shared.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = FixtureDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
