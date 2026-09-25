# Deployment Guide for Praxis Flutter Mobile

## Quick Start

```bash
# iOS (requires physical device or simulator)
flutter run -d ios

# Android (requires emulator or device)
flutter run -d android

# Web (for desktop browser testing)
flutter run -d web
```

## iOS Deployment

### Development (Simulator)

```bash
# List available simulators
flutter emulators

# Run on iPhone simulator
flutter run -d ios

# Or open in Xcode
open ios/Runner.xcworkspace
```

### Release (Physical Device)

Requires:
- Apple Developer account
- Provisioning profile
- Signing certificate

```bash
# Build for release
flutter build ios

# Or use Xcode
cd ios
xcodebuild -workspace Runner.xcworkspace \
  -scheme Runner \
  -configuration Release
```

### App Store Distribution

1. Build archive:
   ```bash
   flutter build ios --release
   ```

2. Sign with certificate and provisioning profile

3. Upload via Xcode Organizer or Apple Transporter

4. Submit for review

## Android Deployment

### Development (Emulator)

```bash
# List emulators
flutter emulators

# Launch emulator
flutter emulators --launch <emulator_id>

# Run app
flutter run -d android
```

### Release (Physical Device)

```bash
# Connect device via USB with USB debugging enabled
adb devices

# Run release build
flutter run -d android --release
```

### Google Play Distribution

1. Create signing key:
   ```bash
   keytool -genkey -v -keystore release.keystore \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias praxis-key
   ```

2. Create `android/key.properties`:
   ```properties
   storePassword=<password>
   keyPassword=<password>
   keyAlias=praxis-key
   storeFile=../release.keystore
   ```

3. Build app bundle:
   ```bash
   flutter build appbundle --release
   ```

4. Upload to Google Play Console

## Web Deployment

### Local Testing

```bash
# Start dev server
flutter run -d web

# Or production build
flutter build web --release

# Serve with HTTP server
cd build/web
python -m http.server 8000
```

### Cloud Deployment

#### Firebase Hosting

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Initialize Firebase
firebase init hosting

# Deploy
firebase deploy --only hosting
```

#### Docker

```bash
# Build Docker image
docker build -t praxis-flutter .

# Run container
docker run -p 8080:8080 praxis-flutter
```

## Environment Configuration

### Environment Variables

Create `.env` file:

```
PRAXIS_API_URL=https://praxis.example.com
PRAXIS_PORT=9876
APP_VERSION=0.0.1
```

Load in app:

```dart
final apiUrl = String.fromEnvironment(
  'PRAXIS_API_URL',
  defaultValue: 'localhost',
);
```

### Build Variants

#### iOS (Xcode Build Settings)

- Debug: Development configuration, local server
- Release: Production configuration, production server

#### Android (Gradle)

```gradle
buildTypes {
    debug {
        // Debug settings
    }
    release {
        // Release settings
        minifyEnabled true
    }
}
```

## Testing Before Release

### Manual Testing Checklist

- [ ] Connect to desktop successfully
- [ ] View work items and conversations
- [ ] Send and receive messages
- [ ] Markdown renders correctly
- [ ] Theme syncs from desktop
- [ ] Biometric auth works (if device supports)
- [ ] Navigation works smoothly
- [ ] No crashes during normal use
- [ ] Performance acceptable (smooth scrolling)
- [ ] Battery usage reasonable
- [ ] Network reconnection works

### Automated Testing

```bash
# Run all tests
flutter test

# Run integration tests
flutter test integration_test/

# With coverage
flutter test --coverage
lcov --list coverage/lcov.info
```

### Performance Testing

```bash
# Profile mode (closer to production)
flutter run --profile

# Check frame rendering
flutter run --enable-software-rendering
```

## Versioning

Update version in `pubspec.yaml`:

```yaml
version: 1.0.0+1
```

Format: `major.minor.patch+buildNumber`

For releases:
- Major: Breaking changes
- Minor: New features
- Patch: Bug fixes
- Build: Internal increment

## Release Notes

Template for release notes:

```
Version X.Y.Z - Released DATE

## New Features
- Feature 1
- Feature 2

## Bug Fixes
- Fix 1
- Fix 2

## Performance
- Improvement 1

## Breaking Changes
- Change 1 (if any)
```

## Rollback Procedure

If issues arise after release:

### iOS
1. Remove version from App Store Connect
2. Update build and resubmit (or release previous version)

### Android
1. Upload new version to Google Play
2. Mark previous version as deprecated
3. Users receive update prompt

### Web
1. Restore previous build from CDN
2. Or remove current version and redeploy previous

## Monitoring

### Crash Reporting

Implement crash reporting (Firebase Crashlytics recommended):

```dart
import 'package:firebase_crashlytics/firebase_crashlytics.dart';

FlutterError.onError = FirebaseCrashlytics.instance.recordFlutterError;
```

### Analytics

Track user engagement:

```dart
import 'package:firebase_analytics/firebase_analytics.dart';

final analytics = FirebaseAnalytics.instance;
await analytics.logAppOpen();
```

## Support

For issues:
1. Check logs: `flutter logs`
2. Review Crashlytics for crashes
3. Check App Store/Play Console reviews
4. File issues in project tracker
