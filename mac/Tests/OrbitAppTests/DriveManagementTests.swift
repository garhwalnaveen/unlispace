import Foundation
import Testing
import OrbitKit
@testable import Orbit

/// Prompts that record what they asked, so a test can read the warning the user would see.
@MainActor final class RecordingPrompts: UserPrompts {
    var confirms: Bool
    private(set) var asked: [(title: String, message: String, action: String)] = []

    init(confirms: Bool = true) { self.confirms = confirms }

    func confirm(title: String, message: String, action: String) -> Bool {
        asked.append((title, message, action))
        return confirms
    }
    func chooseFile(message: String, action: String) -> URL? { nil }
}

@Suite @MainActor struct DriveManagementTests {
    private static let design = DriveInfo(driveId: "d-design", name: "Design", mountState: .mounted, mountPath: "/Volumes/Design")
    private static let archive = DriveInfo(driveId: "d-archive", name: "Archive", mountState: .unmounted)

    private func model(role: String = "owner", prompts: RecordingPrompts = RecordingPrompts()) async throws -> (AppModel, SnapshotClient) {
        let client = SnapshotClient(drives: [Self.design, Self.archive])
        try await Fixtures.workspace(client, drives: ["d-design", "d-archive"], role: role)
        let model = try await Fixtures.showing(client, prompts: prompts)
        await model.workspaces.load()
        return (model, client)
    }

    private func settle(_ condition: @MainActor () async -> Bool) async {
        for _ in 0..<200 where !(await condition()) { try? await Task.sleep(for: .milliseconds(5)) }
    }

    @Test func namesAreTrimmedBoundedAndMustChange() {
        #expect(DriveManagement.validName("  Brand  ") == "Brand")
        #expect(DriveManagement.validName("   ") == nil)
        #expect(DriveManagement.validName(String(repeating: "a", count: 101)) == nil)
        #expect(DriveManagement.validName(String(repeating: "a", count: 100)) != nil)
        #expect(DriveManagement.validName("Design", current: "Design") == nil)
        #expect(DriveManagement.validName("Design 2", current: "Design") == "Design 2")
    }

    @Test func aCopyGetsAFreeName() {
        #expect(DriveManagement.copyName(for: "Design", existing: ["Design"]) == "Design copy")
        #expect(DriveManagement.copyName(for: "Design", existing: ["Design", "design COPY"]) == "Design copy 2")
        #expect(DriveManagement.copyName(for: "Design", existing: ["Design copy", "Design copy 2"]) == "Design copy 3")
        let long = String(repeating: "a", count: 100)
        #expect(DriveManagement.copyName(for: long, existing: []).count <= DriveManagement.nameLimit)
    }

    @Test func theDeleteWarningSaysWhatHappensAndThatItCannotBeUndone() {
        let mounted = DriveManagement.deleteWarning(for: Self.design)
        #expect(mounted.contains("leaves Finder") && mounted.contains("nobody in the workspace can open its files"))
        #expect(mounted.contains("not finished uploading"))
        #expect(mounted.contains("can't be undone") && mounted.contains("make a copy"))
        // A drive that is not in Finder has no local changes to lose.
        #expect(!DriveManagement.deleteWarning(for: Self.archive).contains("not finished uploading"))
    }

    @Test func onlyOwnersAndAdminsCanManageADrive() async throws {
        let (owner, _) = try await model()
        #expect(owner.workspaces.canManage(driveID: "d-design"))
        #expect(owner.workspaces.workspace(forDrive: "d-design")?.name == "Acme")
        let (member, _) = try await model(role: "member")
        #expect(!member.workspaces.canManage(driveID: "d-design"))
        // A drive the workspace list does not mention is left for the server to decide.
        #expect(member.workspaces.canManage(driveID: "d-unknown"))
        let offline = Fixtures.offline()
        #expect(!offline.workspaces.canManage(driveID: "d-design"))
    }

    @Test func renameAndCopyAskTheServerAndReloadTheList() async throws {
        let (model, client) = try await model()
        try await client.reply("PATCH /drives/d-design", #"{"id":"d-design","name":"Brand"}"#)
        try await client.reply("POST /drives/d-design/fork", #"{"id":"d-copy","name":"Design copy"}"#)
        await client.setDrives([DriveInfo(driveId: "d-design", name: "Brand", mountState: .unmounted), Self.archive])
        try await model.workspaces.renameDrive(Self.design, to: "Brand")
        #expect(await client.requests.contains("PATCH /drives/d-design"))
        #expect(model.drives.drive(id: "d-design")?.name == "Brand")
        try await model.workspaces.copyDrive(Self.design, named: "Design copy")
        #expect(await client.requests.contains("POST /drives/d-design/fork"))
    }

    @Test func deletingAsksFirstAndDoesNothingWhenCancelled() async throws {
        let prompts = RecordingPrompts(confirms: false)
        let (model, client) = try await model(prompts: prompts)
        model.deleteDrive(Self.design)
        #expect(prompts.asked.count == 1)
        #expect(prompts.asked.first?.title == "Delete “Design”?")
        #expect(prompts.asked.first?.message == DriveManagement.deleteWarning(for: Self.design))
        #expect(prompts.asked.first?.action == "Delete Drive")
        try await Task.sleep(for: .milliseconds(30))
        #expect(await !client.requests.contains("DELETE /drives/d-design"))
    }

    @Test func aConfirmedDeleteRemovesTheDriveAndTakesItOutOfFinder() async throws {
        let (model, client) = try await model()
        try await client.reply("DELETE /drives/d-design", #"{"ok":true}"#)
        await client.setDrives([Self.archive])
        model.deleteDrive(Self.design)
        await settle { model.messages.notice != nil }
        #expect(await client.requests.contains("DELETE /drives/d-design"))
        #expect(await client.unmounted == ["d-design"])
        #expect(model.drives.drive(id: "d-design") == nil)
        #expect(model.messages.notice == "“Design” was deleted.")
        #expect(model.messages.error == nil)
    }

    @Test func aRefusedDeleteLeavesTheDriveAndExplainsWhy() async throws {
        let (model, client) = try await model()
        await client.fail("DELETE /drives/d-design", code: "forbidden")
        model.deleteDrive(Self.design)
        await settle { model.messages.error != nil }
        #expect(model.messages.error == "Only workspace owners and admins can delete a drive.")
        #expect(await client.unmounted.isEmpty)
        #expect(model.drives.drive(id: "d-design") != nil)
    }

    /// Today's background service forwards only the requests it knows, and delete is not one of them.
    @Test func aServiceThatCannotDeleteHandsOffToTheWebInsteadOfFailing() async throws {
        let (model, client) = try await model()
        var opened: [URL] = []
        model.openURL = { opened.append($0) }
        model.deleteDrive(Self.design)
        await settle { model.messages.notice != nil }
        #expect(await client.requests.contains("DELETE /drives/d-design"))
        #expect(opened.map(\.absoluteString) == ["https://orbit.example/drives/d-design"])
        #expect(model.messages.notice?.contains("open on the web") == true)
        #expect(model.messages.error == nil)
        // Nothing was deleted, so the drive stays in Finder.
        #expect(await client.unmounted.isEmpty)
        #expect(model.drives.drive(id: "d-design") != nil)
    }

    @Test func errorsFromTheServerAreSaidInPlainWords() {
        func message(_ code: String) -> String {
            DriveManagement.message(for: DaemonClientError.remote(DaemonError(code: code, message: "raw")), verb: "copy")
        }
        #expect(message("plan_limit").hasPrefix("Your files are safe."))
        #expect(message("drive_not_ready") == "This drive is busy. Try again in a moment.")
        #expect(message("forbidden").contains("owners and admins"))
        #expect(message("something_else").hasPrefix("Could not copy the drive"))
        #expect(DriveManagement.isUnsupported(DaemonClientError.remote(DaemonError(code: "bad_request", message: "unsupported API path"))))
        #expect(DriveManagement.isUnsupported(DaemonClientError.remote(DaemonError(code: "unsupported", message: ""))))
        #expect(!DriveManagement.isUnsupported(DaemonClientError.remote(DaemonError(code: "forbidden", message: ""))))
        #expect(!DriveManagement.isUnsupported(DaemonClientError.notConnected))
    }

    @Test func webPagesComeFromTheServersOwnAddress() async throws {
        let (model, _) = try await model()
        let config = try #require(model.workspaces.config)
        #expect(config.home?.absoluteString == "https://orbit.example")
        #expect(config.drivePage(driveId: "d-design")?.absoluteString == "https://orbit.example/drives/d-design")
        #expect(config.drivePage(driveId: "../settings") == nil)
        #expect(config.drivePage(driveId: "") == nil)
        #expect(config.page(orgId: "org1", section: "billing")?.absoluteString == "https://orbit.example/orgs/org1/billing")
    }
}
