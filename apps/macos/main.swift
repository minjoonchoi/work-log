import Cocoa
import WebKit

struct ServiceControlPaths {
    let node: URL
    let script: URL
    let app: URL
}

// Only the app is registered with launchd. Its Node services are ordinary children.
final class AppServices {
    var children: [String: Process] = [:]
    var stopping = false
    var generation = 0
    func start(app: URL, dataRoot: URL) throws {
        stopping = false; generation += 1
        for role in ["runtime", "manager"] { try launch(role, app: app, dataRoot: dataRoot) }
    }
    func launch(_ role: String, app: URL, dataRoot: URL) throws {
        if children[role]?.isRunning == true { return }
        let child = Process()
        child.executableURL = app.appendingPathComponent("Contents/MacOS/node")
        child.arguments = [app.appendingPathComponent("Contents/Resources/harness/src/\(role).mjs").path]
        var env = ProcessInfo.processInfo.environment
        // Finder launches do not inherit the shell PATH. Reuse the installer’s
        // recorded CLI search path, also used by the single login registration.
        let launchAgent = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/local.worklog.gui.plist")
        if let bytes = try? Data(contentsOf: launchAgent),
           let plist = (try? PropertyListSerialization.propertyList(from: bytes, format: nil)) as? [String: Any],
           let variables = plist["EnvironmentVariables"] as? [String: String],
           let searchPath = variables["PATH"], !searchPath.isEmpty {
            env["PATH"] = searchPath
        }
        env["HARNESS_DATA_DIR"] = dataRoot.path
        env["HARNESS_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        child.environment = env
        child.standardInput = FileHandle.nullDevice
        let log = dataRoot.appendingPathComponent("\(role).log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let output = try FileHandle(forWritingTo: log); output.seekToEndOfFile()
        child.standardOutput = output; child.standardError = output
        let launchedGeneration = generation
        child.terminationHandler = { [weak self] _ in
            try? output.close()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                guard let self = self, !self.stopping, self.generation == launchedGeneration else { return }
                try? self.launch(role, app: app, dataRoot: dataRoot)
            }
        }
        children[role] = child
        try child.run()
    }
    func stop(dataRoot: URL, completion: @escaping (String?) -> Void) {
        // Let accepted work drain before the app exits; launchd must not kill it mid-run.
        guard children["runtime"]?.isRunning == true else { finish(completion); return }
        guard let bytes = try? Data(contentsOf: dataRoot.appendingPathComponent("runtime.endpoint.json")),
              let endpoint = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let port = endpoint["port"] as? Int,
              let token = try? String(contentsOf: dataRoot.appendingPathComponent("token"), encoding: .utf8) else {
            completion("실행 서비스가 시작 중입니다. 잠시 후 다시 종료하세요."); return
        }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/lifecycle/quit")!)
        request.httpMethod = "POST"; request.httpBody = Data("{}".utf8); request.timeoutInterval = 5
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else {
                    completion("실행 서비스 종료 요청을 확인하지 못했습니다. 다시 시도하세요."); return
                }
                self.stopping = true
                if self.children["manager"]?.isRunning == true { self.children["manager"]?.terminate() }
                self.waitForExit(completion)
            }
        }.resume()
    }
    func finish(_ completion: @escaping (String?) -> Void) {
        stopping = true
        for child in children.values where child.isRunning { child.terminate() }
        waitForExit(completion)
    }
    func waitForExit(_ completion: @escaping (String?) -> Void) {
        if children.values.allSatisfy({ !$0.isRunning }) { children.removeAll(); completion(nil); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForExit(completion) }
    }
}

final class ServiceControlClient {
    let appServices = AppServices()
    let resolve: (URL) -> ServiceControlPaths?
    init(resolve: @escaping (URL) -> ServiceControlPaths? = ServiceControlClient.installedPaths) { self.resolve = resolve }
    static func installedPaths(_ dataRoot: URL) -> ServiceControlPaths? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let app = Bundle.main.bundleURL.standardizedFileURL
        let allowed = [home.appendingPathComponent("Applications/WorkLog.app").path, "/Applications/WorkLog.app"]
        let data = home.appendingPathComponent("Library/Application Support/WorkLog")
        guard allowed.contains(app.path),
              let bytes = try? Data(contentsOf: data.appendingPathComponent("installation.json")),
              let receipt = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              ["installed", "needs_attention", "uninstalling", "install_failed"].contains(receipt["state"] as? String ?? ""),
              let trees = receipt["trees"] as? [[String: Any]], trees.first?["path"] as? String == app.path,
              dataRoot.standardizedFileURL.path == data.standardizedFileURL.path,
              FileManager.default.fileExists(atPath: data.appendingPathComponent("installation.json").path) else { return nil }
        return ServiceControlPaths(node: app.appendingPathComponent("Contents/MacOS/node"),
            script: app.appendingPathComponent("Contents/Resources/harness/scripts/service-control.mjs"), app: app)
    }
    func execute(_ action: String, dataRoot: URL, completion: @escaping (String?) -> Void) {
        guard let paths = resolve(dataRoot) else { completion(nil); return }
        if let bytes = try? Data(contentsOf: dataRoot.appendingPathComponent("installation.json")),
           let receipt = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
           let files = receipt["files"] as? [[String: Any]], files.count == 1,
           files.first?["label"] as? String == "local.worklog.gui" {
            if action == "start", receipt["state"] as? String != "installed" {
                completion("이전 설치 또는 제거가 완료되지 않았습니다. 메뉴 막대에서 WorkLog 설치 제거를 다시 실행하세요."); return
            }
            if action == "stop" { appServices.stop(dataRoot: dataRoot, completion: completion) }
            else {
                do { try appServices.start(app: paths.app, dataRoot: dataRoot); completion(nil) }
                catch { appServices.finish { _ in completion("로컬 서비스를 시작하지 못했습니다: \(error.localizedDescription)") } }
            }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(), output = Pipe(), errors = Pipe()
            process.executableURL = paths.node
            process.arguments = [paths.script.path, action, "--app-path", paths.app.path, "--data-root", dataRoot.path]
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output; process.standardError = errors
            var stdout = Data(), stderr = Data()
            let drains = DispatchGroup()
            let deadline = DispatchWorkItem {
                if process.isRunning { process.terminate() }
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                }
            }
            do {
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: deadline)
                drains.enter()
                DispatchQueue.global().async {
                    while let chunk = try? errors.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
                        if stderr.count + chunk.count <= 65536 { stderr.append(chunk) }
                    }
                    drains.leave()
                }
                while let chunk = try? output.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
                    if stdout.count + chunk.count <= 65536 { stdout.append(chunk) }
                }
                process.waitUntilExit(); drains.wait(); deadline.cancel()
                let result = (try? JSONSerialization.jsonObject(with: stdout)) as? [String: Any]
                let expected = action == "start" ? ["started"] : ["stopped", "user_work_continues"]
                if process.terminationStatus == 0, let status = result?["status"] as? String, expected.contains(status) {
                    DispatchQueue.main.async { completion(nil) }
                } else {
                    let errorResult = (try? JSONSerialization.jsonObject(with: stderr)) as? [String: Any]
                    let reasons = (result?["preserved"] as? [[String: Any]])?.compactMap { $0["reason"] as? String }.joined(separator: "\n")
                    let message = errorResult?["error"] as? String ?? result?["error"] as? String
                        ?? ((reasons?.isEmpty == false) ? reasons! : "로컬 서비스의 상태를 확인하지 못했습니다. 다시 시도하세요.")
                    DispatchQueue.main.async { completion(String(message.prefix(2000))) }
                }
            } catch {
                deadline.cancel()
                DispatchQueue.main.async { completion("서비스 제어 도우미를 실행할 수 없습니다. 설치 상태를 확인하세요.") }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSPopoverDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var statusItem: NSStatusItem!
    var utilityMenu: NSMenu!
    var window: NSWindow!
    var webView: WKWebView?
    var quickWebView: WKWebView?
    var popover: NSPopover!
    var quickController: NSViewController!
    var connectionItem: NSMenuItem!
    var timer: Timer?
    var connectionTask: URLSessionDataTask?
    var connectionGeneration = 0
    var currentPort: Int?
    var currentToken: String?
    var mainReady = false
    var mainNeedsReload = false
    var quickNeedsReload = false
    var pendingRoute: [String: Any]?
    var serviceControl = ServiceControlClient()
    var servicesStarting = false
    var terminationPending = false
    var serviceControlError: String?
    var pendingServiceAlert = false
    var serviceErrorItem: NSMenuItem!
    let routes = ["items", "current", "notifications", "calendar", "settings"]
    func normalizedRoute(_ view: String) -> String {
        ["attention", "waiting-user"].contains(view) ? "notifications" : view
    }
    let dataRoot: URL = {
        let override = Bundle.main.object(forInfoDictionaryKey: "HarnessDataRoot") as? String
        let base = override ?? ProcessInfo.processInfo.environment["HARNESS_DATA_DIR"]
        return base.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/WorkLog")
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if prepareDraggedInstallation() { return }
        NSApp.setActivationPolicy(.accessory)
        let appMenu = NSMenu()
        let appRoot = NSMenuItem(); appMenu.addItem(appRoot)
        let submenu = NSMenu(); appRoot.submenu = submenu
        let quick = NSMenuItem(title: "빠른 패널 열기", action: #selector(showQuickMenu), keyEquivalent: "")
        quick.target = self; submenu.addItem(quick); submenu.addItem(.separator())
        submenu.addItem(withTitle: "WorkLog 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editRoot = NSMenuItem(); appMenu.addItem(editRoot)
        let editMenu = NSMenu(title: "편집"); editRoot.submenu = editMenu
        editMenu.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = appMenu

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let icon = NSImage(named: NSImage.Name("WorkLogStatusTemplate"))
            ?? Bundle.main.url(forResource: "WorkLogStatusTemplate", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
            ?? NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
                // A vector fallback keeps the status button visible without SF Symbols or fonts.
                NSColor.black.setStroke()
                let mark = NSBezierPath()
                mark.lineWidth = 2; mark.lineCapStyle = .round; mark.lineJoinStyle = .round
                mark.move(to: NSPoint(x: 2, y: 14)); mark.line(to: NSPoint(x: 5, y: 4))
                mark.line(to: NSPoint(x: 9, y: 11)); mark.line(to: NSPoint(x: 13, y: 4))
                mark.line(to: NSPoint(x: 16, y: 14)); mark.stroke()
                return true
            }
        icon.size = NSSize(width: 18, height: 18)
        icon.isTemplate = true
        statusItem.button?.image = icon
        statusItem.button?.setAccessibilityLabel("WorkLog 빠른 패널")
        statusItem.button?.toolTip = "WorkLog · 로컬 에이전트 업무"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked(_:))
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        utilityMenu = NSMenu()
        connectionItem = NSMenuItem(title: "서비스 연결 중…", action: nil, keyEquivalent: "")
        utilityMenu.addItem(connectionItem)
        serviceErrorItem = NSMenuItem(title: "서비스 오류 확인", action: #selector(openServiceError), keyEquivalent: "")
        serviceErrorItem.target = self; serviceErrorItem.isHidden = true
        utilityMenu.addItem(serviceErrorItem); utilityMenu.addItem(.separator())
        for (title, route, key) in [("업무 목록 열기", "items", "1"), ("현재 작업", "current", "2"), ("오늘 캘린더", "calendar", "3"), ("알림", "notifications", "4"), ("연결 설정", "settings", ",")] {
            let item = NSMenuItem(title: title, action: #selector(navigate(_:)), keyEquivalent: key)
            item.representedObject = route; item.target = self; utilityMenu.addItem(item)
        }
        utilityMenu.addItem(.separator())
        let uninstall = NSMenuItem(title: "WorkLog 설치 제거…", action: #selector(uninstallWorkLog), keyEquivalent: "")
        uninstall.target = self
        uninstall.isEnabled = serviceControl.resolve(dataRoot) != nil
        utilityMenu.addItem(uninstall)
        utilityMenu.addItem(withTitle: "WorkLog 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let viewRoot = NSMenuItem(); appMenu.addItem(viewRoot)
        let viewMenu = NSMenu(title: "보기"); viewRoot.submenu = viewMenu
        for item in utilityMenu.items where item.action == #selector(navigate(_:)) {
            let copy = item.copy() as! NSMenuItem; viewMenu.addItem(copy)
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "WorkLog"
        window.appearance = NSAppearance(named: .aqua)
        window.minSize = NSSize(width: 920, height: 660)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        quickController = NSViewController()
        quickController.view = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 600))
        popover = NSPopover()
        popover.contentViewController = quickController
        popover.contentSize = NSSize(width: 380, height: 600)
        popover.behavior = .transient
        popover.delegate = self
        popover.appearance = NSAppearance(named: .aqua)
        refreshConnection()
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in self?.refreshConnection() }
        let firstOpen = dataRoot.appendingPathComponent(".open-after-install")
        let openAfterInstall = FileManager.default.fileExists(atPath: firstOpen.path)
        if openAfterInstall { try? FileManager.default.removeItem(at: firstOpen) }
        if openAfterInstall || !ProcessInfo.processInfo.arguments.contains("--background") {
            DispatchQueue.main.async { [weak self] in self?.openMain(["view": "items"]) }
        }
        servicesStarting = true
        serviceControl.execute("start", dataRoot: dataRoot) { [weak self] error in
            guard let self = self else { return }
            self.servicesStarting = false
            if self.terminationPending { self.stopServicesAndTerminate() }
            else if let error = error { self.showServiceControlError(error, stopping: false) }
            else { self.refreshConnection() }
        }
    }
    // A Finder copy has no receipt yet. Provision the per-user runtime before
    // the registered app starts; the provisioning process never copies the app.
    func prepareDraggedInstallation() -> Bool {
        let app = Bundle.main.bundleURL.standardizedFileURL
        let home = FileManager.default.homeDirectoryForCurrentUser
        guard ProcessInfo.processInfo.environment["HARNESS_DATA_DIR"] == nil,
              Bundle.main.object(forInfoDictionaryKey: "HarnessDataRoot") == nil else { return false }
        if app.path.hasPrefix("/Volumes/") {
            let alert = NSAlert(); alert.messageText = "WorkLog를 Applications 폴더로 옮겨주세요"
            alert.informativeText = "디스크 이미지에서 WorkLog를 Applications로 드래그한 뒤, 옮긴 앱을 실행하세요."
            alert.runModal(); NSApp.terminate(nil); return true
        }
        guard ["/Applications/WorkLog.app", home.appendingPathComponent("Applications/WorkLog.app").path].contains(app.path) else { return false }
        if serviceControl.resolve(dataRoot) != nil {
            // Retry an interrupted first registration. Ordinary launches and
            // partial uninstall recovery keep their existing app UI.
            guard let bytes = try? Data(contentsOf: dataRoot.appendingPathComponent("installation.json")),
                  let receipt = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  receipt["app_location"] != nil, receipt["state"] as? String == "installed",
                  let files = receipt["files"] as? [[String: Any]],
                  ["not_started", "starting"].contains(files.first?["activation"] as? String ?? "") else { return false }
        }
        NSApp.setActivationPolicy(.regular)
        let setupWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 140), styleMask: [.titled], backing: .buffered, defer: false)
        setupWindow.title = "WorkLog"
        let label = NSTextField(labelWithString: "처음 실행에 필요한 서비스를 준비하고 있습니다…")
        label.frame = NSRect(x: 25, y: 60, width: 380, height: 25)
        setupWindow.contentView?.addSubview(label); setupWindow.center(); setupWindow.makeKeyAndOrderFront(nil)
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: String?
            do {
                let process = Process(), pipe = Pipe()
                process.executableURL = app.appendingPathComponent("Contents/MacOS/node")
                process.arguments = [app.appendingPathComponent("Contents/Resources/harness/scripts/first-launch.mjs").path, app.path]
                process.standardOutput = pipe; process.standardError = pipe
                try process.run()
                let output = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
                if process.terminationStatus != 0 { failure = String(data: output, encoding: .utf8) ?? "서비스 준비에 실패했습니다." }
            } catch { failure = error.localizedDescription }
            DispatchQueue.main.async {
                setupWindow.orderOut(nil)
                if let failure = failure {
                    let alert = NSAlert(); alert.messageText = "WorkLog 설치를 완료하지 못했습니다"
                    alert.informativeText = String(failure.suffix(4000)); alert.runModal()
                }
                NSApp.terminate(nil)
            }
        }
        return true
    }
    func showServiceControlError(_ message: String, stopping: Bool) {
        serviceControlError = message
        serviceErrorItem.isHidden = false
        pendingServiceAlert = true
        // Startup completion can arrive after the user closed/minimized the window.
        // Background work must never activate or reopen it. Quit failures follow
        // an explicit user action and still need a visible failure explanation.
        if stopping { openMain(["view": "items"]) }
        else if window.isVisible && !window.isMiniaturized { presentServiceError() }
    }
    @objc func openServiceError() {
        pendingServiceAlert = serviceControlError != nil
        openMain(["view": "items"])
    }
    func presentServiceError() {
        guard pendingServiceAlert, window.attachedSheet == nil, let message = serviceControlError else { return }
        pendingServiceAlert = false
        let alert = NSAlert()
        alert.messageText = "WorkLog 서비스 오류"
        alert.informativeText = message
        alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window)
    }
    func stopServicesAndTerminate() {
        serviceControl.execute("stop", dataRoot: dataRoot) { [weak self] error in
            guard let self = self else { return }
            self.terminationPending = false
            if let error = error {
                NSApp.reply(toApplicationShouldTerminate: false)
                self.showServiceControlError(error, stopping: true)
            } else {
                self.timer?.invalidate(); self.connectionTask?.cancel()
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if statusItem == nil { return .terminateNow }
        if terminationPending { return .terminateLater }
        // Development/preview bundles never control the user's installed services.
        if serviceControl.resolve(dataRoot) == nil { return .terminateNow }
        terminationPending = true
        if !servicesStarting { stopServicesAndTerminate() }
        return .terminateLater
    }
    @objc func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            popover.performClose(nil)
            utilityMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender)
        } else { showQuickMenu() }
    }
    @objc func showQuickMenu() {
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil); return }
        refreshConnection()
        let height = min(600, max(340, (button.window?.screen?.visibleFrame.height ?? 800) - 40))
        popover.contentSize = NSSize(width: 380, height: height)
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }
    func setQuickVisible(_ visible: Bool) {
        quickWebView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('harness:quick-visibility',{detail:\(visible ? "true" : "false")}))", completionHandler: nil)
    }
    @objc func uninstallWorkLog() {
        guard serviceControl.resolve(dataRoot) != nil else { return }
        popover.performClose(nil)
        let fm = FileManager.default
        let stage = fm.temporaryDirectory.appendingPathComponent("worklog-uninstall-ui-\(UUID().uuidString)")
        do {
            try fm.createDirectory(at: stage, withIntermediateDirectories: false)
            let source = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/WorkLog Uninstaller.app")
            let target = stage.appendingPathComponent("WorkLog Uninstaller.app")
            try fm.copyItem(at: source, to: target)
            let config = NSWorkspace.OpenConfiguration(); config.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: target, configuration: config) { _, error in
                if let error = error {
                    try? fm.removeItem(at: stage)
                    DispatchQueue.main.async { let alert = NSAlert(error: error); alert.runModal() }
                }
            }
        } catch {
            try? fm.removeItem(at: stage)
            let alert = NSAlert(error: error); alert.runModal()
        }
    }

    func popoverDidShow(_ notification: Notification) { setQuickVisible(true) }
    func popoverDidClose(_ notification: Notification) { setQuickVisible(false) }
    func openMain(_ route: [String: Any]) {
        var target = route
        if let view = target["view"] as? String { target["view"] = normalizedRoute(view) }
        pendingRoute = target
        popover.performClose(nil)
        if webView == nil { loadMain() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        navigateWeb()
        presentServiceError()
    }
    @objc func navigate(_ sender: NSMenuItem) {
        openMain(["view": sender.representedObject as? String ?? "items"])
    }
    func navigateWeb() {
        guard mainReady, let route = pendingRoute,
              let bytes = try? JSONSerialization.data(withJSONObject: route), let quoted = String(data: bytes, encoding: .utf8) else { return }
        pendingRoute = nil
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('harness:navigate',{detail:\(quoted)}))", completionHandler: nil)
    }
    func makeWebView(frame: NSRect, quick: Bool) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let tokenJSON = String(data: try! JSONSerialization.data(withJSONObject: currentToken ?? "", options: [.fragmentsAllowed]), encoding: .utf8)!
        let script = "window.__HARNESS_TOKEN__ = \(tokenJSON); window.__HARNESS_QUICK_VISIBLE__ = \(popover.isShown ? "true" : "false");"
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if quick { config.userContentController.add(self, name: "openWorkLog") }
        else {
            config.userContentController.add(self, name: "openExternal")
            config.userContentController.add(self, name: "mainReady")
        }
        let view = WKWebView(frame: frame, configuration: config)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        return view
    }
    let offlineHTML = "<html lang='ko'><meta name='viewport' content='width=device-width, initial-scale=1'><body style='font-family:-apple-system;padding:28px;color:#171717;background:#fafafa;color-scheme:light'><h1 style='font-size:22px;color:#2563eb'>WorkLog</h1><h2 style='font-size:16px'>서비스 연결을 기다리고 있습니다.</h2><p style='font-size:13px;line-height:1.7;color:#737373'>로컬 서비스에 연결되면 현재 작업과 업무 이력이 표시됩니다. 자동으로 다시 확인합니다.</p></body></html>"
    func loadMain() {
        mainReady = false
        mainNeedsReload = false
        let view = makeWebView(frame: window.contentView!.bounds, quick: false)
        webView = view; window.contentView = view
        if let port = currentPort { view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)")!)) }
        else { view.loadHTMLString(offlineHTML, baseURL: nil) }
    }
    func refreshConnection() {
        let endpointURL = dataRoot.appendingPathComponent("manager.endpoint.json")
        guard let bytes = try? Data(contentsOf: endpointURL),
              let endpoint = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let port = endpoint["port"] as? Int,
              let rawToken = try? String(contentsOf: dataRoot.appendingPathComponent("token"), encoding: .utf8) else {
            connectionTask?.cancel(); connectionGeneration += 1
            connectionItem.title = "관리 서비스 연결 대기"
            statusItem.button?.title = ""
            statusItem.button?.toolTip = "WorkLog · 관리 서비스 연결 대기"
            if quickWebView == nil {
                let view = makeWebView(frame: quickController.view.bounds, quick: true)
                quickWebView = view; quickController.view = view
                view.loadHTMLString(offlineHTML, baseURL: nil)
            }
            return
        }
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if currentPort != port || currentToken != token {
            currentPort = port; currentToken = token; connectionGeneration += 1
            quickNeedsReload = false
            let view = makeWebView(frame: quickController.view.bounds, quick: true)
            quickWebView = view; quickController.view = view
            view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/quick")!))
            if webView != nil { loadMain() }
        }
        connectionTask?.cancel()
        let generation = connectionGeneration
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/quick")!); request.timeoutInterval = 2
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        connectionTask = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if (error as? URLError)?.code == .cancelled { return }
            let overview = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                guard let self = self, self.connectionGeneration == generation else { return }
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200, let overview = overview else {
                    self.connectionItem.title = "관리 서비스 연결 끊김"
                    self.statusItem.button?.title = ""
                    self.statusItem.button?.toolTip = "WorkLog · 관리 서비스 연결 끊김"
                    return
                }
                let counts = overview["counts"] as? [String: Any] ?? [:]
                let health = overview["health"] as? [String: Any] ?? [:]
                let current = counts["current"] as? Int ?? 0, notifications = counts["notifications"] as? Int ?? 0
                self.connectionItem.title = health["runtime_connected"] as? Bool == true ? "실행·관리 서비스 연결됨" : "관리 연결됨 · 실행 상태 확인 중"
                self.statusItem.button?.title = current > 0 ? " \(current)" : ""
                self.statusItem.button?.toolTip = "WorkLog · 현재 \(current)개 · 알림 \(notifications)개 · \(self.connectionItem.title)"
                // A failed navigation does not start the page's JavaScript retry loop.
                // Retry only those views, after the same service becomes reachable;
                // preserve healthy pages and their unsaved fields during polling.
                if self.quickNeedsReload, let view = self.quickWebView, !view.isLoading {
                    self.quickNeedsReload = false
                    view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/quick")!))
                }
                if self.mainNeedsReload, let view = self.webView, !view.isLoading {
                    self.mainNeedsReload = false; self.mainReady = false
                    view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)")!))
                }
            }
        }
        connectionTask?.resume()
    }
    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        if view === quickWebView { setQuickVisible(popover.isShown) }
        // WebKit can finish the document even when a stylesheet request failed.
        // Retry after service recovery instead of leaving an unstyled page open.
        view.evaluateJavaScript("Array.from(document.querySelectorAll('link[rel=stylesheet]')).some(link => !link.sheet || link.sheet.cssRules.length === 0)") { [weak self, weak view] value, error in
            guard let self = self, let view = view, error == nil, value as? Bool == true else { return }
            self.markNavigationFailure(view)
        }
    }
    func markNavigationFailure(_ view: WKWebView) {
        if view === quickWebView { quickNeedsReload = true }
        if view === webView { mainNeedsReload = true; mainReady = false }
    }
    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as? URLError)?.code != .cancelled { markNavigationFailure(view) }
    }
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as? URLError)?.code != .cancelled { markNavigationFailure(view) }
    }
    func webViewWebContentProcessDidTerminate(_ view: WKWebView) { markNavigationFailure(view) }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == currentPort else { return }
        if message.name == "mainReady", message.webView === webView {
            mainReady = true; navigateWeb(); return
        }
        if message.name == "openWorkLog", message.webView === quickWebView,
           let route = message.body as? [String: Any], let requestedView = route["view"] as? String {
            let view = normalizedRoute(requestedView)
            guard routes.contains(view) else { return }
            var target: [String: Any] = ["view": view]
            if let id = route["item_id"] as? String, !id.isEmpty, id.count <= 200 { target["item_id"] = id }
            if view == "notifications", let id = route["notification_id"] as? String, !id.isEmpty, id.count <= 200 { target["notification_id"] = id }
            openMain(target); return
        }
        guard message.name == "openExternal", message.webView === webView,
              let value = message.body as? String, let url = URL(string: value), url.scheme == "https", let host = url.host,
              url.user == nil, url.password == nil,
              (host == "auth.atlassian.com" && url.path == "/authorize") || (host.hasSuffix(".atlassian.net") && (url.path.hasPrefix("/browse/") || url.path.hasPrefix("/wiki/"))) else { return }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        decisionHandler(url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == currentPort) ? .allow : .cancel)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openMain(["view": "items"]); return true }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
