// Draws the app icon (a rounded square with three lines) to a 1024px PNG.
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let inset = 100.0
let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let path = NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(red: 0.30, green: 0.44, blue: 0.93, alpha: 1),
           ending: NSColor(red: 0.20, green: 0.31, blue: 0.80, alpha: 1))!.draw(in: path, angle: -90)
NSColor.white.setStroke()
for (i, w) in [1.0, 1.0, 0.56].enumerated() {
    let y = size / 2 + 150 - Double(i) * 150
    let line = NSBezierPath()
    line.lineWidth = 72
    line.lineCapStyle = .round
    line.move(to: NSPoint(x: 300, y: y))
    line.line(to: NSPoint(x: 300 + 424 * w, y: y))
    line.stroke()
}
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
