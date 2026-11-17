// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Orbit",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Orbit", targets: ["Orbit"]),
        .library(name: "OrbitKit", targets: ["OrbitKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.6.4"),
    ],
    targets: [
        // All logic lives in the library so it is unit-testable.
        .target(name: "OrbitKit"),
        // Thin SwiftUI/AppKit shell.
        .executableTarget(name: "Orbit", dependencies: ["OrbitKit", .product(name: "Sparkle", package: "Sparkle")],
                          linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .target(name: "OrbitTestSupport", dependencies: ["OrbitKit"], path: "Tests/OrbitTestSupport"),
        .testTarget(name: "OrbitKitTests", dependencies: ["OrbitKit", "OrbitTestSupport"]),
        .testTarget(name: "DaemonIntegrationTests", dependencies: ["OrbitKit"]),
        .testTarget(name: "OrbitAppTests", dependencies: ["Orbit", "OrbitTestSupport"]),
    ],
    swiftLanguageModes: [.v6]
)
