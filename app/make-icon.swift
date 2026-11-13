// Builds the app icon from the artwork in icon-source.webp: a pink ribbon
// folded into a ring of rooms around an open court, with a small sunlit
// square in the middle.
//
//   swift make-icon.swift out.png             the macOS icon, 1024px, plate plus shadow
//   swift make-icon.swift out.png --flat 128  just the plate, edge to edge: the page's
//                                             logo and tab icon (web/src/logo.png)
import AppKit
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : "icon-1024.png"
var flat: CGFloat? = nil
if let i = args.firstIndex(of: "--flat"), i + 1 < args.count, let n = Double(args[i + 1]) { flat = CGFloat(n) }

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
guard let source = CGImageSourceCreateWithURL(here.appendingPathComponent("icon-source.webp") as CFURL, nil),
      let art = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    FileHandle.standardError.write("make-icon: cannot read icon-source.webp\n".data(using: .utf8)!)
    exit(1)
}

// The artwork is a 1283 x 1226 picture of the plate lying on a table. This is
// the plate itself, taken a little inside its edge (its corners are rounder
// than the macOS shape) so that none of the table or of the plate's own
// shadow comes along (pixels, origin top left).
let plateInArt = CGRect(x: 96, y: 72, width: 1076, height: 1076)
guard let plate = art.cropping(to: plateInArt) else { exit(1) }

// macOS icon grid: the plate is 824 of the 1024 canvas, corner radius 186.
let canvas = flat ?? 1024
let side = flat ?? 824
let scale = side / 824
let rect = CGRect(x: (canvas - side) / 2, y: (canvas - side) / 2, width: side, height: side)
let shape = CGPath(roundedRect: rect, cornerWidth: 186 * scale, cornerHeight: 186 * scale, transform: nil)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

let ctx = CGContext(data: nil, width: Int(canvas), height: Int(canvas), bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.interpolationQuality = .high

if flat == nil {
    // A soft, slightly rosy drop shadow under the plate.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x5a2a3c, 0.30))
    ctx.addPath(shape)
    ctx.setFillColor(rgb(0xfdf0e2))
    ctx.fillPath()
    ctx.restoreGState()
}

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
ctx.draw(plate, in: rect)
ctx.restoreGState()

// The plate is nearly white; a hairline keeps its edge on a light Dock or page.
let line = max(1, 2 * scale)
let inner = rect.insetBy(dx: line / 2, dy: line / 2)
ctx.addPath(CGPath(roundedRect: inner, cornerWidth: 186 * scale - line / 2, cornerHeight: 186 * scale - line / 2, transform: nil))
ctx.setStrokeColor(rgb(0x7a3a52, 0.12))
ctx.setLineWidth(line)
ctx.strokePath()

guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, image, nil)
if !CGImageDestinationFinalize(dest) { exit(1) }
