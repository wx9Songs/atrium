// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "Atrium",
    platforms: [.macOS(.v12)],
    targets: [.executableTarget(name: "Atrium", path: "Sources/Atrium")]
)
