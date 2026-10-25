// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Unlispace",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Unlispace", targets: ["Unlispace"]),
        .library(name: "UnlispaceKit", targets: ["UnlispaceKit"]),
    ],
    targets: [
        // All logic lives in the library so it is unit-testable.
        .target(name: "UnlispaceKit"),
        // Thin SwiftUI/AppKit shell.
        .executableTarget(name: "Unlispace", dependencies: ["UnlispaceKit"]),
        .testTarget(name: "UnlispaceKitTests", dependencies: ["UnlispaceKit"]),
        .testTarget(name: "DaemonIntegrationTests", dependencies: ["UnlispaceKit"]),
        .testTarget(name: "UnlispaceAppTests", dependencies: ["Unlispace"]),
    ],
    swiftLanguageModes: [.v6]
)
