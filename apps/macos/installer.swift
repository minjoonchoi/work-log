import Cocoa

final class InstallerDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let confirmation = NSAlert()
        confirmation.messageText = "WorkLog 설치"
        confirmation.informativeText = "사용자 Applications 폴더에 WorkLog와 실행 서비스를 설치합니다. 기존 업무 기록은 유지됩니다. 에이전트와 Jira 연결은 설치 후 앱에서 설정하세요."
        confirmation.addButton(withTitle: "설치")
        confirmation.addButton(withTitle: "취소")
        guard confirmation.runModal() == .alertFirstButtonReturn else { NSApp.terminate(nil); return }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 140), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "WorkLog 설치"
        let label = NSTextField(labelWithString: "WorkLog를 설치하고 있습니다…")
        label.frame = NSRect(x: 65, y: 64, width: 300, height: 24)
        let spinner = NSProgressIndicator(frame: NSRect(x: 30, y: 65, width: 20, height: 20))
        spinner.style = .spinning; spinner.startAnimation(nil)
        window.contentView?.addSubview(label); window.contentView?.addSubview(spinner)
        window.center(); window.makeKeyAndOrderFront(nil)
        let payload = Bundle.main.resourceURL!.appendingPathComponent("WorkLog.app")
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process(), pipe = Pipe()
            process.executableURL = payload.appendingPathComponent("Contents/MacOS/node")
            process.arguments = [payload.appendingPathComponent("Contents/Resources/harness/scripts/install.mjs").path, "--apply", "--source-app", payload.path]
            process.standardOutput = pipe; process.standardError = pipe
            var environment = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            environment["PATH"] = ["\(home)/.local/bin", "\(home)/.volta/bin", "/opt/homebrew/bin", "/usr/local/bin", environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
            process.environment = environment
            do {
                try process.run()
                let output = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let message = String(data: output, encoding: .utf8) ?? "설치 결과를 읽을 수 없습니다."
                DispatchQueue.main.async { self.finish(process.terminationStatus == 0, message) }
            } catch {
                DispatchQueue.main.async { self.finish(false, error.localizedDescription) }
            }
        }
    }
    func finish(_ success: Bool, _ message: String) {
        window.orderOut(nil)
        let alert = NSAlert()
        alert.messageText = success ? "설치가 완료되었습니다" : "설치를 완료하지 못했습니다"
        alert.informativeText = success ? "WorkLog에서 연결 설정을 진행하세요. 설치 창을 닫은 뒤 디스크 이미지를 추출해도 됩니다." : String(message.suffix(5000))
        alert.alertStyle = success ? .informational : .warning
        alert.addButton(withTitle: success ? "WorkLog 열기" : "닫기")
        if success { alert.addButton(withTitle: "닫기") }
        if alert.runModal() == .alertFirstButtonReturn && success {
            NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/WorkLog.app"))
        }
        NSApp.terminate(nil)
    }
}
let delegate = InstallerDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
