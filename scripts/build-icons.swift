import AppKit
import Foundation

// The app mark deliberately uses only filled SVG primitives. Read the source
// directly so PNG/ICNS sizes cannot drift from the editable vector artwork.
struct Shape { let kind: String; let values: [String: String] }
final class Artwork: NSObject, XMLParserDelegate {
    var shapes: [Shape] = []
    var failure: String?
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        if name == "svg" {
            if attributes["viewBox"] != "0 0 1024 1024" { failure = "Expected a 1024-square SVG viewBox" }
        } else if name == "rect" || name == "circle" {
            shapes.append(Shape(kind: name, values: attributes))
        } else if name != "title" { failure = "Unsupported SVG element: \(name)" }
    }
}
func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
guard CommandLine.arguments.count >= 3 else { fail("Usage: swift build-icons.swift source.svg output.icns [preview.png]") }
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let destination = URL(fileURLWithPath: CommandLine.arguments[2])
let artwork = Artwork()
guard let parser = XMLParser(contentsOf: source) else { fail("Cannot read SVG") }
parser.delegate = artwork
guard parser.parse(), artwork.failure == nil, !artwork.shapes.isEmpty else { fail(artwork.failure ?? "Invalid SVG") }
func number(_ shape: Shape, _ name: String) -> CGFloat {
    guard let value = shape.values[name].flatMap(Double.init), value.isFinite else { fail("Invalid SVG \(name)") }
    return CGFloat(value)
}
func color(_ value: String?) -> NSColor {
    guard let value, value.count == 7, value.first == "#", let rgb = UInt32(value.dropFirst(), radix: 16) else { fail("Expected SVG RGB fill") }
    return NSColor(srgbRed: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
}
func bitmap(width: Int, height: Int, draw: () -> Void) -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: rep) else { fail("Cannot allocate icon bitmap") }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    context.cgContext.translateBy(x: 0, y: CGFloat(height)); context.cgContext.scaleBy(x: 1, y: -1)
    draw(); NSGraphicsContext.restoreGraphicsState(); return rep
}
func bounds(_ shape: Shape) -> NSRect {
    if shape.kind == "rect" {
        return NSRect(x: number(shape, "x"), y: number(shape, "y"), width: number(shape, "width"), height: number(shape, "height"))
    }
    let radius = number(shape, "r")
    return NSRect(x: number(shape, "cx") - radius, y: number(shape, "cy") - radius, width: radius * 2, height: radius * 2)
}
func fill(_ shape: Shape) {
    if shape.kind == "rect" {
        let radius = number(shape, "rx")
        NSBezierPath(roundedRect: bounds(shape), xRadius: radius, yRadius: radius).fill()
    } else { NSBezierPath(ovalIn: bounds(shape)).fill() }
}
func icon(_ size: Int) -> NSBitmapImageRep {
    bitmap(width: size, height: size) {
        let context = NSGraphicsContext.current!.cgContext
        context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
        for shape in artwork.shapes {
            color(shape.values["fill"]).setFill()
            fill(shape)
        }
    }
}
func statusIcon(_ size: Int) -> NSBitmapImageRep {
    let shapes = artwork.shapes.filter { ["mark", "cutout"].contains($0.values["data-role"] ?? "") }
    guard let first = shapes.first else { fail("SVG has no template mark") }
    let area = shapes.dropFirst().reduce(bounds(first)) { $0.union(bounds($1)) }
    return bitmap(width: size, height: size) {
        let context = NSGraphicsContext.current!.cgContext
        let margin = CGFloat(size) / 18, scale = (CGFloat(size) - margin * 2) / max(area.width, area.height)
        context.translateBy(x: (CGFloat(size) - area.width * scale) / 2, y: (CGFloat(size) - area.height * scale) / 2)
        context.scaleBy(x: scale, y: scale); context.translateBy(x: -area.minX, y: -area.minY)
        NSColor.black.setFill()
        for shape in shapes {
            context.setBlendMode(shape.values["data-role"] == "cutout" ? .clear : .normal)
            fill(shape)
        }
    }
}
func write(_ rep: NSBitmapImageRep, to file: URL) throws {
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("Cannot encode PNG") }
    try png.write(to: file)
}
let fm = FileManager.default
let temporary = fm.temporaryDirectory.appendingPathComponent("worklog-icons-" + UUID().uuidString)
let iconset = temporary.appendingPathComponent("WorkLog.iconset")
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: temporary) }
try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    try write(icon(points), to: iconset.appendingPathComponent("icon_\(points)x\(points).png"))
    try write(icon(points * 2), to: iconset.appendingPathComponent("icon_\(points)x\(points)@2x.png"))
}
let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["--convert", "icns", "--output", destination.path, iconset.path]
try process.run(); process.waitUntilExit()
guard process.terminationStatus == 0 else { fail("iconutil failed") }
try write(statusIcon(18), to: destination.deletingLastPathComponent().appendingPathComponent("WorkLogStatusTemplate.png"))
try write(statusIcon(36), to: destination.deletingLastPathComponent().appendingPathComponent("WorkLogStatusTemplate@2x.png"))
if CommandLine.arguments.count > 3 {
    let preview = URL(fileURLWithPath: CommandLine.arguments[3])
    try fm.createDirectory(at: preview.deletingLastPathComponent(), withIntermediateDirectories: true)
    let sheet = bitmap(width: 1280, height: 1088) {
        NSColor(srgbRed: 0.94, green: 0.95, blue: 0.96, alpha: 1).setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1280, height: 1088)).fill()
        let context = NSGraphicsContext.current!.cgContext
        for (size, x, y) in [(1024, 16, 32), (16, 1120, 100), (32, 1112, 220), (128, 1064, 360)] {
            let raster = icon(size)
            // Core Graphics image coordinates are flipped relative to SVG coordinates.
            context.saveGState(); context.translateBy(x: CGFloat(x), y: CGFloat(y + size)); context.scaleBy(x: 1, y: -1)
            context.draw(raster.cgImage!, in: CGRect(x: 0, y: 0, width: size, height: size)); context.restoreGState()
        }
    }
    try write(sheet, to: preview)
    try write(icon(1024), to: preview.deletingLastPathComponent().appendingPathComponent("worklog-icon-1024.png"))
    try write(icon(16), to: preview.deletingLastPathComponent().appendingPathComponent("worklog-icon-16.png"))
    try write(icon(32), to: preview.deletingLastPathComponent().appendingPathComponent("worklog-icon-32.png"))
    try write(statusIcon(16), to: preview.deletingLastPathComponent().appendingPathComponent("worklog-status-16.png"))
    try write(statusIcon(18), to: preview.deletingLastPathComponent().appendingPathComponent("worklog-status-18.png"))
    let statusSheet = bitmap(width: 720, height: 240) {
        let context = NSGraphicsContext.current!.cgContext
        for side in [0, 1] {
            (side == 0 ? NSColor.white : NSColor(white: 0.12, alpha: 1)).setFill()
            NSBezierPath(rect: NSRect(x: side * 360, y: 0, width: 360, height: 240)).fill()
            for (pixels, x, y, display) in [(16, 32, 32, 16), (18, 76, 31, 18), (18, 128, 48, 144)] {
                context.saveGState(); context.translateBy(x: CGFloat(side * 360 + x), y: CGFloat(y + display)); context.scaleBy(x: 1, y: -1)
                let rect = CGRect(x: 0, y: 0, width: display, height: display)
                context.clip(to: rect, mask: statusIcon(pixels).cgImage!)
                (side == 0 ? NSColor.black : NSColor.white).setFill(); context.fill(rect)
                context.restoreGState()
            }
        }
    }
    try write(statusSheet, to: preview.deletingLastPathComponent().appendingPathComponent("worklog-status-preview.png"))
}
print(destination.path)
