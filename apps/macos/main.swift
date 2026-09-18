import Cocoa
import WebKit

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
    var pendingRoute: [String: Any]?
    let routes = ["items", "current", "attention", "waiting-user", "calendar", "settings"]
    let dataRoot: URL = {
        let override = Bundle.main.object(forInfoDictionaryKey: "HarnessDataRoot") as? String
        let base = override ?? ProcessInfo.processInfo.environment["HARNESS_DATA_DIR"]
        return base.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/WorkLogHarness")
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let appMenu = NSMenu()
        let appRoot = NSMenuItem(); appMenu.addItem(appRoot)
        let submenu = NSMenu(); appRoot.submenu = submenu
        let quick = NSMenuItem(title: "빠른 패널 열기", action: #selector(showQuickMenu), keyEquivalent: "")
        quick.target = self; submenu.addItem(quick); submenu.addItem(.separator())
        submenu.addItem(withTitle: "Work Log 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editRoot = NSMenuItem(); appMenu.addItem(editRoot)
        let editMenu = NSMenu(title: "편집"); editRoot.submenu = editMenu
        editMenu.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "모두 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        NSApp.mainMenu = appMenu

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let icon = NSImage(systemSymbolName: "square.stack.3d.up", accessibilityDescription: "Work Log")
        icon?.isTemplate = true
        statusItem.button?.image = icon
        statusItem.button?.setAccessibilityLabel("Work Log 빠른 패널")
        statusItem.button?.toolTip = "Work Log · 로컬 에이전트 업무"
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked(_:))
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        utilityMenu = NSMenu()
        connectionItem = NSMenuItem(title: "서비스 연결 중…", action: nil, keyEquivalent: "")
        utilityMenu.addItem(connectionItem); utilityMenu.addItem(.separator())
        for (title, route, key) in [("업무 목록 열기", "items", "1"), ("현재 작업", "current", "2"), ("오늘 캘린더", "calendar", "3"), ("확인이 필요한 작업", "attention", "4"), ("사용자 답변 필요", "waiting-user", "5"), ("연결 설정", "settings", ",")] {
            let item = NSMenuItem(title: title, action: #selector(navigate(_:)), keyEquivalent: key)
            item.representedObject = route; item.target = self; utilityMenu.addItem(item)
        }
        utilityMenu.addItem(.separator())
        utilityMenu.addItem(withTitle: "Work Log 종료 (작업은 계속됨)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let viewRoot = NSMenuItem(); appMenu.addItem(viewRoot)
        let viewMenu = NSMenu(title: "보기"); viewRoot.submenu = viewMenu
        for item in utilityMenu.items where item.action == #selector(navigate(_:)) {
            let copy = item.copy() as! NSMenuItem; viewMenu.addItem(copy)
        }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Work Log"
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
            DispatchQueue.main.async { [weak self] in self?.showQuickMenu() }
        }
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
        pendingRoute = route
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
    let offlineHTML = "<html lang='ko'><meta name='viewport' content='width=device-width, initial-scale=1'><body style='font-family:-apple-system;padding:28px;color:#171717;background:#fafafa;color-scheme:light'><h1 style='font-size:22px;color:#2563eb'>Work Log</h1><h2 style='font-size:16px'>서비스 연결을 기다리고 있습니다.</h2><p style='font-size:13px;line-height:1.7;color:#737373'>로컬 서비스에 연결되면 현재 작업과 업무 이력이 표시됩니다. 자동으로 다시 확인합니다.</p></body></html>"
    func loadMain() {
        mainReady = false
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
            connectionItem.title = "관리 서비스 연결 대기"
            statusItem.button?.title = ""
            statusItem.button?.toolTip = "Work Log · 관리 서비스 연결 대기"
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
                    self.statusItem.button?.toolTip = "Work Log · 관리 서비스 연결 끊김"
                    return
                }
                let counts = overview["counts"] as? [String: Any] ?? [:]
                let health = overview["health"] as? [String: Any] ?? [:]
                let current = counts["current"] as? Int ?? 0, attention = counts["attention"] as? Int ?? 0
                self.connectionItem.title = health["runtime_connected"] as? Bool == true ? "실행·관리 서비스 연결됨" : "관리 연결됨 · 실행 상태 확인 중"
                self.statusItem.button?.title = current > 0 ? " \(current)" : ""
                let waiting = counts["waiting"] as? Int ?? 0
                self.statusItem.button?.toolTip = "Work Log · 현재 \(current)개 · 사용자 답변 \(waiting)개 · 확인 필요 \(attention)개 · \(self.connectionItem.title)"
            }
        }
        connectionTask?.resume()
    }
    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        if view === quickWebView { setQuickVisible(popover.isShown) }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == currentPort else { return }
        if message.name == "mainReady", message.webView === webView {
            mainReady = true; navigateWeb(); return
        }
        if message.name == "openWorkLog", message.webView === quickWebView,
           let route = message.body as? [String: Any], let view = route["view"] as? String, routes.contains(view) {
            var target: [String: Any] = ["view": view]
            if let id = route["item_id"] as? String, !id.isEmpty, id.count <= 200 { target["item_id"] = id }
            openMain(target); return
        }
        guard message.name == "openExternal", message.webView === webView,
              let value = message.body as? String, let url = URL(string: value), url.scheme == "https", let host = url.host,
              url.user == nil, url.password == nil,
              (host == "auth.atlassian.com" && url.path == "/authorize") || (host.hasSuffix(".atlassian.net") && url.path.hasPrefix("/browse/")) else { return }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        decisionHandler(url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == currentPort) ? .allow : .cancel)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showQuickMenu(); return true }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
