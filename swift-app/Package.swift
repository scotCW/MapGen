// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HuntingMapGenerator",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "HuntingMapGenerator",
            path: "Sources/HuntingMapGenerator",
            resources: [.copy("Resources")]
        )
    ]
)
