import SwiftUI

/// Empty host the UI-test bundle needs to exist; the tests drive the Praxis app by bundle id.
@main struct DriverHostApp: App { var body: some Scene { WindowGroup { Text("Praxis device driver") } } }
