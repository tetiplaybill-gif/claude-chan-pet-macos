// Local companion launcher. Reads application identity and window geometry only;
// no window titles, Apple Events, Accessibility, screen pixels, Claude files,
// credentials, or network access.
import AppKit
import CoreGraphics
import Foundation

struct Options {
    var hostBundle = "com.anthropic.claudefordesktop"
    var hostURL = URL(fileURLWithPath: "/Applications/Claude.app", isDirectory: true)
    var petBundle = "io.github.mushan08.claude-chan-pet.local"
    var petURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/ClaudeChanPet.app", isDirectory: true)
    var check = false
    var once = false
    var testMode = false
    var geometryTest = false

    init(arguments: [String]) throws {
        var values: [String: String] = [:]
        var index = 0
        let valued = Set(["--test-host-bundle", "--test-host-path", "--pet-bundle", "--pet-path"])
        while index < arguments.count {
            let option = arguments[index]
            if option == "--check" { check = true }
            else if option == "--once" { once = true }
            else if option == "--test-geometry" { geometryTest = true }
            else if valued.contains(option) {
                guard index + 1 < arguments.count, values[option] == nil else {
                    throw LauncherError.invalidArguments("Missing or duplicate value: \(option)")
                }
                index += 1
                values[option] = arguments[index]
            } else {
                throw LauncherError.invalidArguments("Unknown option: \(option)")
            }
            index += 1
        }
        if !values.isEmpty {
            guard values.count == 4,
                  let hostID = values["--test-host-bundle"],
                  let hostPath = values["--test-host-path"],
                  let petID = values["--pet-bundle"],
                  let petPath = values["--pet-path"],
                  hostID.hasPrefix("local.claudechan.fixture."),
                  petID.hasPrefix("local.claudechan.fixture."), hostID != petID else {
                throw LauncherError.invalidArguments("Test mode requires all four overrides and distinct local.claudechan.fixture.* bundle IDs")
            }
            // Test overrides must remain in this source checkout's build/qa
            // directory, including after resolving symlinks. They cannot point
            // at Claude, the installed pet, or any other user application.
            let qa = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("build/qa", isDirectory: true).resolvingSymlinksInPath().path + "/"
            func validatedURL(_ path: String) throws -> URL {
                let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
                guard path.hasPrefix("/"), url.path.hasPrefix(qa), url.pathExtension == "app" else {
                    throw LauncherError.invalidArguments("Fixture paths must be .app bundles beneath \(qa)")
                }
                return url
            }
            hostURL = try validatedURL(hostPath)
            petURL = try validatedURL(petPath)
            hostBundle = hostID
            petBundle = petID
            testMode = true
        }
        guard [check, once, geometryTest].filter({ $0 }).count <= 1 else {
            throw LauncherError.invalidArguments("Choose --check, --once, or --test-geometry")
        }
    }
}

enum LauncherError: Error, CustomStringConvertible {
    case invalidArguments(String)
    var description: String {
        switch self { case .invalidArguments(let message): return message }
    }
}

func canonical(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }

// Pure geometry: matching all four edges avoids treating an ordinary maximized
// window (which leaves menu-bar/Dock space) as fullscreen. CoreGraphics uses the
// same desktop coordinate system for window bounds and CGDisplayBounds.
struct WindowGeometry {
    let ownerPID: pid_t
    let layer: Int
    let isOnscreen: Bool
    let bounds: CGRect
}

func nearlyMatchesDisplay(_ window: CGRect, _ display: CGRect, tolerance: CGFloat = 2) -> Bool {
    let values = [window.minX, window.minY, window.width, window.height,
                  display.minX, display.minY, display.width, display.height, tolerance]
    guard values.allSatisfy({ $0.isFinite }), tolerance >= 0,
          window.width > 0, window.height > 0, display.width > 0, display.height > 0 else { return false }
    return abs(window.minX - display.minX) <= tolerance &&
        abs(window.minY - display.minY) <= tolerance &&
        abs(window.maxX - display.maxX) <= tolerance &&
        abs(window.maxY - display.maxY) <= tolerance
}

func hasFullscreenGeometry(windows: [WindowGeometry], foregroundPID: pid_t, displays: [CGRect]) -> Bool {
    windows.contains { window in
        window.ownerPID == foregroundPID && window.layer == 0 && window.isOnscreen &&
            displays.contains { nearlyMatchesDisplay(window.bounds, $0) }
    }
}

func needsCompanionStateWrite(previous: Bool?, writtenAt: Date?, value: Bool, now: Date) -> Bool {
    guard let previous = previous, let writtenAt = writtenAt else { return true }
    return previous != value || now.timeIntervalSince(writtenAt) >= 30
}

// Does not query the window server or write files; safe to run anywhere.
func runGeometryTests() throws {
    let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
    let second = CGRect(x: -1920, y: -180, width: 1920, height: 1080)
    let fixturePID: pid_t = 1234
    func window(_ bounds: CGRect, pid: pid_t = 1234, layer: Int = 0, visible: Bool = true) -> WindowGeometry {
        WindowGeometry(ownerPID: pid, layer: layer, isOnscreen: visible, bounds: bounds)
    }
    let tests: [(String, Bool)] = [
        ("exact-display", nearlyMatchesDisplay(display, display)),
        ("two-pixel-tolerance", nearlyMatchesDisplay(CGRect(x: 2, y: 2, width: 1436, height: 896), display)),
        ("three-pixel-inset-rejected", !nearlyMatchesDisplay(CGRect(x: 3, y: 0, width: 1437, height: 900), display)),
        ("maximized-menu-bar-rejected", !nearlyMatchesDisplay(CGRect(x: 0, y: 25, width: 1440, height: 875), display)),
        ("maximized-dock-rejected", !nearlyMatchesDisplay(CGRect(x: 0, y: 0, width: 1440, height: 840), display)),
        ("oversized-window-rejected", !nearlyMatchesDisplay(CGRect(x: -20, y: -20, width: 1480, height: 940), display)),
        ("second-display-negative-origin", hasFullscreenGeometry(windows: [window(second)], foregroundPID: fixturePID, displays: [display, second])),
        ("different-owner-rejected", !hasFullscreenGeometry(windows: [window(display, pid: 5678)], foregroundPID: fixturePID, displays: [display])),
        ("nonzero-layer-rejected", !hasFullscreenGeometry(windows: [window(display, layer: 1)], foregroundPID: fixturePID, displays: [display])),
        ("offscreen-rejected", !hasFullscreenGeometry(windows: [window(display, visible: false)], foregroundPID: fixturePID, displays: [display])),
        ("missing-geometry-false", !hasFullscreenGeometry(windows: [], foregroundPID: fixturePID, displays: [display])),
        ("missing-display-false", !hasFullscreenGeometry(windows: [window(display)], foregroundPID: fixturePID, displays: [])),
        ("invalid-geometry-false", !nearlyMatchesDisplay(CGRect(x: CGFloat.nan, y: 0, width: 1440, height: 900), display)),
        ("zero-size-false", !nearlyMatchesDisplay(.zero, .zero)),
        ("initial-state-write", needsCompanionStateWrite(previous: nil, writtenAt: nil, value: false, now: Date(timeIntervalSince1970: 0))),
        ("change-write", needsCompanionStateWrite(previous: false, writtenAt: Date(timeIntervalSince1970: 0), value: true, now: Date(timeIntervalSince1970: 1))),
        ("heartbeat-not-early", !needsCompanionStateWrite(previous: false, writtenAt: Date(timeIntervalSince1970: 0), value: false, now: Date(timeIntervalSince1970: 29))),
        ("heartbeat-at-30s", needsCompanionStateWrite(previous: false, writtenAt: Date(timeIntervalSince1970: 0), value: false, now: Date(timeIntervalSince1970: 30)))
    ]
    guard tests.allSatisfy({ $0.1 }) else {
        throw LauncherError.invalidArguments("Geometry selftest failed: \(tests.filter { !$0.1 }.map { $0.0 }.joined(separator: ", "))")
    }
    emit("geometry-tests", ["passed": true, "count": tests.count, "tests": tests.map { $0.0 }])
}

func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var output = fields
    output["event"] = event
    output["time"] = ISO8601DateFormatter().string(from: Date())
    if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

final class Launcher {
    let options: Options
    let workspace = NSWorkspace.shared
    var observers: [NSObjectProtocol] = []
    var launching = false
    var stopped = false
    var stateTimer: Timer?
    var previousHostPIDs: Set<pid_t> = []
    var hostWasFrontmost = false
    var lastFullscreenWritten: Bool?
    var lastCompanionWrite: Date?
    var lastCompanionWriteError: Date?

    init(_ options: Options) { self.options = options }

    func matches(_ app: NSRunningApplication, bundle: String, url: URL) -> Bool {
        guard app.bundleIdentifier == bundle, !app.isTerminated, let actual = app.bundleURL else { return false }
        return canonical(actual) == canonical(url)
    }

    func applications(bundle: String, url: URL) -> [NSRunningApplication] {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
            .filter { matches($0, bundle: bundle, url: url) }
    }

    func bundleValid(_ url: URL, identifier: String) -> Bool {
        Bundle(url: url)?.bundleIdentifier == identifier
    }

    func frontmostIsFullscreen() -> Bool {
        guard let foreground = workspace.frontmostApplication,
              !foreground.isTerminated,
              foreground.processIdentifier != getpid(),
              foreground.bundleIdentifier != options.petBundle else { return false }
        let foregroundPID = foreground.processIdentifier
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return false }
        let displays = ids.prefix(Int(count)).map { CGDisplayBounds($0) }
        guard let descriptions = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        // Access only owner PID, layer, on-screen flag and bounds. In particular,
        // do not access kCGWindowName, kCGWindowOwnerName, images, or AX APIs.
        let windows: [WindowGeometry] = descriptions.compactMap { description in
            guard let owner = description[kCGWindowOwnerPID as String] as? NSNumber,
                  owner.int32Value == foregroundPID,
                  let layer = description[kCGWindowLayer as String] as? NSNumber,
                  layer.intValue == 0,
                  let onscreen = description[kCGWindowIsOnscreen as String] as? Bool, onscreen,
                  let dictionary = description[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary) else { return nil }
            return WindowGeometry(ownerPID: owner.int32Value, layer: layer.intValue, isOnscreen: onscreen, bounds: bounds)
        }
        return hasFullscreenGeometry(windows: windows, foregroundPID: foregroundPID, displays: displays)
    }

    var companionStateURL: URL {
        if options.testMode {
            return options.petURL.deletingLastPathComponent().appendingPathComponent("companion-state.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ClaudeChanPet", isDirectory: true)
            .appendingPathComponent("companion-state.json")
    }

    func publishCompanionState() {
        let value = frontmostIsFullscreen()
        let now = Date()
        guard needsCompanionStateWrite(previous: lastFullscreenWritten, writtenAt: lastCompanionWrite, value: value, now: now) else { return }
        if let failure = lastCompanionWriteError, now.timeIntervalSince(failure) < 30 { return }
        do {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let data = try JSONSerialization.data(withJSONObject: ["fullscreen": value, "updatedAt": formatter.string(from: now)], options: [.sortedKeys])
            try FileManager.default.createDirectory(at: companionStateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: companionStateURL, options: [.atomic])
            lastFullscreenWritten = value
            lastCompanionWrite = now
            lastCompanionWriteError = nil
        } catch {
            lastCompanionWriteError = now
            // Never put foreground-application metadata into persistent logs.
            emit("companion-state-write-failed")
        }
    }

    func check() {
        let host = applications(bundle: options.hostBundle, url: options.hostURL)
        let pet = applications(bundle: options.petBundle, url: options.petURL)
        emit("check", [
            "testMode": options.testMode,
            "hostBundle": options.hostBundle, "hostPath": canonical(options.hostURL),
            "hostBundleValid": bundleValid(options.hostURL, identifier: options.hostBundle),
            "hostPIDs": host.map { $0.processIdentifier },
            "petBundle": options.petBundle, "petPath": canonical(options.petURL),
            "petBundleValid": bundleValid(options.petURL, identifier: options.petBundle),
            "petPIDs": pet.map { $0.processIdentifier },
            "fullscreen": frontmostIsFullscreen()
        ])
    }

    func ensurePet(reason: String, completion: (() -> Void)? = nil) {
        guard !applications(bundle: options.hostBundle, url: options.hostURL).isEmpty else {
            if options.once { emit("host-not-running") }
            completion?()
            return
        }
        guard bundleValid(options.hostURL, identifier: options.hostBundle),
              bundleValid(options.petURL, identifier: options.petBundle) else {
            emit("bundle-validation-failed", ["reason": reason])
            completion?()
            return
        }
        guard !launching else { completion?(); return }
        let running = applications(bundle: options.petBundle, url: options.petURL)
        guard running.isEmpty else {
            if options.once { emit("pet-already-running", ["pids": running.map { $0.processIdentifier }]) }
            completion?()
            return
        }
        launching = true
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        config.createsNewApplicationInstance = false
        emit("pet-open-request", ["reason": reason])
        workspace.openApplication(at: options.petURL, configuration: config) { [weak self] app, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.launching = false
                if let error = error {
                    emit("pet-open-failed", ["reason": reason, "error": error.localizedDescription])
                } else if let app = app, self.matches(app, bundle: self.options.petBundle, url: self.options.petURL) {
                    emit("pet-opened", ["reason": reason, "pid": app.processIdentifier])
                } else {
                    emit("pet-open-unverified", ["reason": reason])
                }
                completion?()
            }
        }
    }

    func start() {
        if options.check { check(); return }
        if options.once {
            ensurePet(reason: "initial-check") { self.stopped = true }
            // A bounded run loop is necessary for NSWorkspace's async callback.
            let deadline = Date().addingTimeInterval(15)
            while !stopped && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
            if !stopped { emit("open-timeout"); exit(1) }
            return
        }
        let notifications: [(Notification.Name, String)] = [
            (NSWorkspace.didLaunchApplicationNotification, "host-launched"),
            (NSWorkspace.didActivateApplicationNotification, "host-activated")
        ]
        for (name, reason) in notifications {
            let observer = workspace.notificationCenter.addObserver(forName: name, object: nil, queue: nil) { [weak self] note in
                guard let self = self else { return }
                guard
                      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                if self.options.testMode && app.bundleIdentifier == self.options.hostBundle {
                    emit("fixture-host-event", ["reason": reason, "pid": app.processIdentifier,
                         "path": app.bundleURL.map { canonical($0) } ?? "", "terminated": app.isTerminated])
                }
                guard self.matches(app, bundle: self.options.hostBundle, url: self.options.hostURL) else { return }
                DispatchQueue.main.async { self.ensurePet(reason: reason) }
            }
            observers.append(observer)
        }
        emit("watching", ["hostBundle": options.hostBundle, "hostPath": canonical(options.hostURL), "testMode": options.testMode])
        previousHostPIDs = Set(applications(bundle: options.hostBundle, url: options.hostURL).map { $0.processIdentifier })
        hostWasFrontmost = workspace.frontmostApplication.map {
            matches($0, bundle: options.hostBundle, url: options.hostURL)
        } ?? false
        ensurePet(reason: "initial-check")
        publishCompanionState()
        // LaunchServices notifications may be absent in a command-line agent's
        // login session. A lightweight identity-only check covers changes in
        // host process/activation state. No window content is inspected,
        // and does not reopen a manually quit pet while the host is unchanged.
        stateTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let pids = Set(self.applications(bundle: self.options.hostBundle, url: self.options.hostURL).map { $0.processIdentifier })
            let frontmost = self.workspace.frontmostApplication.map {
                self.matches($0, bundle: self.options.hostBundle, url: self.options.hostURL)
            } ?? false
            let newHost = !pids.subtracting(self.previousHostPIDs).isEmpty
            let activated = frontmost && !self.hostWasFrontmost
            self.previousHostPIDs = pids
            self.hostWasFrontmost = frontmost
            if newHost { self.ensurePet(reason: "host-started-poll") }
            else if activated { self.ensurePet(reason: "host-activated-poll") }
            self.publishCompanionState()
        }
        // NSWorkspace's LaunchServices notifications need a real AppKit event
        // pump. A Foundation-only RunLoop can query processes but misses these
        // notifications when launched as a command-line LaunchAgent.
        NSApplication.shared.run()
    }
}

do {
    let options = try Options(arguments: Array(CommandLine.arguments.dropFirst()))
    if options.geometryTest {
        try runGeometryTests()
        exit(0)
    }
    // Accessory UI is unnecessary: this process must never gain focus or appear
    // in the Dock. This initializes AppKit without an application window.
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    application.finishLaunching()
    let launcher = Launcher(options)
    launcher.start()
} catch {
    fputs("ClaudePetLauncher: \(error)\n", stderr)
    exit(2)
}
