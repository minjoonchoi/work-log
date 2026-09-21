import Foundation
import Security
import LocalAuthentication

// Only this application's OAuth and client credential records are accessible.
// No secret is accepted as an argv value.
func respond(_ object: [String: Any]) {
    let bytes = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(bytes)
}
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 262144,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let operation = request["operation"] as? String,
          let account = request["account"] as? String,
          account.range(of: "^(oauth|client)-[a-f0-9]{24}$", options: .regularExpression) != nil else {
        respond(["ok": false]); exit(1)
    }
    let authentication = LAContext()
    authentication.interactionNotAllowed = true
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "local.worklog.atlassian",
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
        kSecUseAuthenticationContext as String: authentication
    ]
    switch operation {
    case "get":
        var search = query
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecItemNotFound { respond(["ok": true, "value": NSNull()]) }
        else if status == errSecSuccess, let bytes = item as? Data {
            respond(["ok": true, "value": try JSONSerialization.jsonObject(with: bytes)])
        } else { respond(["ok": false, "status": status]); exit(1) }
    case "set":
        guard let value = request["value"] as? [String: Any] else { respond(["ok": false]); exit(1) }
        let bytes = try JSONSerialization.data(withJSONObject: value)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var create = query
            create[kSecValueData as String] = bytes
            create[kSecAttrLabel as String] = account.hasPrefix("client-") ? "WorkLog · Atlassian Client" : "WorkLog · Atlassian OAuth"
            status = SecItemAdd(create as CFDictionary, nil)
        }
        respond(["ok": status == errSecSuccess, "status": status])
        if status != errSecSuccess { exit(1) }
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        respond(["ok": status == errSecSuccess || status == errSecItemNotFound, "status": status])
        if status != errSecSuccess && status != errSecItemNotFound { exit(1) }
    default: respond(["ok": false]); exit(1)
    }
} catch { respond(["ok": false]); exit(1) }
