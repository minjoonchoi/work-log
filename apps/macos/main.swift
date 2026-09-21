import Cocoa
import WebKit

struct ServiceControlPaths {
    let node: URL
    let script: URL
    let app: URL
}

final class ServiceControlClient {
    let resolve: (URL) -> ServiceControlPaths?
    init(resolve: @escaping (URL) -> ServiceControlPaths? = ServiceControlClient.installedPaths) { self.resolve = resolve }
    static func installedPaths(_ dataRoot: URL) -> ServiceControlPaths? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let app = home.appendingPathComponent("Applications/WorkLog.app")
        let data = home.appendingPathComponent("Library/Application Support/WorkLog")
        guard Bundle.main.bundleURL.standardizedFileURL.path == app.standardizedFileURL.path,
              dataRoot.standardizedFileURL.path == data.standardizedFileURL.path,
              FileManager.default.fileExists(atPath: data.appendingPathComponent("installation.json").path) else { return nil }
        return ServiceControlPaths(node: app.appendingPathComponent("Contents/MacOS/node"),
            script: app.appendingPathComponent("Contents/Resources/harness/scripts/service-control.mjs"), app: app)
    }
    func execute(_ action: String, dataRoot: URL, completion: @escaping (String?) -> Void) {
        guard let paths = resolve(dataRoot) else { completion(nil); return }
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
            ?? NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "WorkLog")
        icon?.size = NSSize(width: 18, height: 18)
        icon?.isTemplate = true
        statusItem.button?.image = icon
        statusItem.button?.setAccessibilityLabel("WorkLog 빠른 패널")
        statusItem.button?.toolTip = "WorkLog · 로컬 에이전트 업무"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked(_:))
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        utilityMenu = NSMenu()
        connectionItem = NSMenuItem(title: "서비스 연결 중…", action: nil, keyEquivalent: "")
        utilityMenu.addItem(connectionItem); utilityMenu.addItem(.separator())
        for (title, route, key) in [("업무 목록 열기", "items", "1"), ("현재 작업", "current", "2"), ("오늘 캘린더", "calendar", "3"), ("알림", "notifications", "4"), ("연결 설정", "settings", ",")] {
            let item = NSMenuItem(title: title, action: #selector(navigate(_:)), keyEquivalent: key)
            item.representedObject = route; item.target = self; utilityMenu.addItem(item)
        }
        utilityMenu.addItem(.separator())
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
        if !ProcessInfo.processInfo.arguments.contains("--background") {
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
    func showServiceControlError(_ message: String, stopping: Bool) {
        serviceControlError = message
        openMain(["view": "items"])
        let alert = NSAlert()
        alert.messageText = stopping ? "WorkLog를 종료하지 못했습니다." : "로컬 서비스를 시작하지 못했습니다."
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
