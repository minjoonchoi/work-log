import Cocoa

final class Uninstaller: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var staging: URL?
    var purgeConnections = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "WorkLog를 제거할까요?"
        alert.informativeText = "앱과 실행 서비스, WorkLog가 등록한 에이전트 훅을 제거합니다. 실행 중인 작업은 중단됩니다.\n\n업무 기록·산출물·동기화 이력은 보존됩니다. 연결 정보를 삭제하면 다시 설치할 때 Atlassian 연결을 새로 설정해야 합니다. Codex·Claude 자체 로그인과 다른 앱 설정은 유지됩니다."
        let purge = NSButton(checkboxWithTitle: "연결 정보도 모두 삭제 (Atlassian 인증·Keychain·연결 설정 백업)", target: nil, action: nil)
        purge.state = .off
        purge.frame = NSRect(x: 0, y: 0, width: 460, height: 30)
        alert.accessoryView = purge
        alert.alertStyle = .warning
        alert.addButton(withTitle: "취소"); alert.addButton(withTitle: "설치 제거")
        guard alert.runModal() == .alertSecondButtonReturn else { NSApp.terminate(nil); return }
        purgeConnections = purge.state == .on
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 130), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "WorkLog 설치 제거"
        let label = NSTextField(labelWithString: "WorkLog를 제거하고 있습니다…")
        label.frame = NSRect(x: 35, y: 55, width: 340, height: 25)
        window.contentView?.addSubview(label); window.center(); window.makeKeyAndOrderFront(nil)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let fm = FileManager.default
                let manifest = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/WorkLog/installation.json")
                let receipt = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
                let trees = receipt?["trees"] as? [[String: Any]]
                guard let appPath = trees?.first?["path"] as? String,
                      ["/Applications/WorkLog.app", fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/WorkLog.app").path].contains(appPath) else {
                    throw NSError(domain: "WorkLog", code: 1, userInfo: [NSLocalizedDescriptionKey: "설치된 앱 경로를 확인할 수 없습니다."])
                }
                let source = URL(fileURLWithPath: appPath).appendingPathComponent("Contents")
                let stage = fm.temporaryDirectory.appendingPathComponent("worklog-uninstall-runtime-\(UUID().uuidString)")
                self.staging = stage
                try fm.createDirectory(at: stage, withIntermediateDirectories: false)
                // Execute outside the installation so stopping/removing the app
                // cannot terminate or erase the uninstaller's dependencies.
                try fm.copyItem(at: source.appendingPathComponent("MacOS/node"), to: stage.appendingPathComponent("node"))
                try fm.copyItem(at: source.appendingPathComponent("Resources/harness"), to: stage.appendingPathComponent("harness"))
                let process = Process(), pipe = Pipe()
                process.executableURL = stage.appendingPathComponent("node")
                process.arguments = [stage.appendingPathComponent("harness/scripts/uninstall.mjs").path, "--apply"] + (self.purgeConnections ? ["--purge-connections"] : [])
                process.standardOutput = pipe; process.standardError = pipe
                try process.run()
                let output = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
                let text = String(data: output, encoding: .utf8) ?? "제거 결과를 읽을 수 없습니다."
                DispatchQueue.main.async { self.finish(process.terminationStatus == 0, text) }
            } catch { DispatchQueue.main.async { self.finish(false, error.localizedDescription) } }
        }
    }
    func finish(_ success: Bool, _ output: String) {
        window.orderOut(nil)
        let alert = NSAlert()
        alert.messageText = success ? "WorkLog 설치를 제거했습니다" : "설치 제거 결과를 확인하세요"
        alert.informativeText = success ? (purgeConnections ? "연결 정보와 Keychain 자격증명을 제거했습니다. 업무 기록은 보존했습니다." : "업무 기록과 Atlassian 인증 정보는 보존했습니다.") : String(output.suffix(6000))
        alert.alertStyle = success ? .informational : .warning
        alert.addButton(withTitle: "닫기"); alert.runModal(); NSApp.terminate(nil)
    }
    func applicationWillTerminate(_ notification: Notification) {
        if let stage = staging { try? FileManager.default.removeItem(at: stage) }
        let parent = Bundle.main.bundleURL.deletingLastPathComponent()
        if parent.lastPathComponent.hasPrefix("worklog-uninstall-ui-") && parent.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL {
            try? FileManager.default.removeItem(at: parent)
        }
    }
}
let delegate = Uninstaller()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
