import Cocoa
let image = NSImage(size: NSSize(width: 640, height: 380))
image.lockFocus()
NSColor(calibratedRed: 0.97, green: 0.98, blue: 1, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: 640, height: 380).fill()
func label(_ text: String, y: CGFloat, font: NSFont, color: NSColor) {
 let style = NSMutableParagraphStyle(); style.alignment = .center
 (text as NSString).draw(in: NSRect(x: 20, y: y, width: 600, height: 45), withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: style])
}
label("WorkLog 설치", y: 290, font: .systemFont(ofSize: 26, weight: .semibold), color: NSColor(calibratedWhite: 0.12, alpha: 1))
label("WorkLog를 Applications 폴더로 드래그하세요", y: 255, font: .systemFont(ofSize: 15), color: NSColor(calibratedWhite: 0.4, alpha: 1))
let arrow = NSBezierPath(); arrow.lineWidth = 4; arrow.lineCapStyle = .round; arrow.lineJoinStyle = .round
arrow.move(to: NSPoint(x: 285, y: 185)); arrow.line(to: NSPoint(x: 355, y: 185)); arrow.move(to: NSPoint(x: 340, y: 200)); arrow.line(to: NSPoint(x: 355, y: 185)); arrow.line(to: NSPoint(x: 340, y: 170))
NSColor.systemBlue.setStroke(); arrow.stroke()
label("복사 후 Applications에서 WorkLog를 실행하세요", y: 42, font: .systemFont(ofSize: 13), color: NSColor(calibratedWhite: 0.4, alpha: 1))
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
