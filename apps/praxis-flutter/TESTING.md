# Visual Testing Guide for Praxis Flutter Mobile

This document guides visual testing of the Flutter app against the Expo reference implementation.

## Prerequisites

- Flutter SDK 3.3.0+ installed
- For iOS: Xcode 14+, connected iPhone or simulator
- For Android: Android Studio + emulator or connected device
- Both Praxis desktop and mobile (Expo) apps running

## Building

### iOS

```bash
# Development
flutter run -d ios

# Release (on physical device)
./scripts/deploy-iphone.sh

# Build for release
flutter build ios
```

### Android

```bash
# Development
flutter run -d android

# Release
flutter build apk
flutter build appbundle
```

### Web (for quick desktop testing)

```bash
flutter run -d web
```

## Test Matrix

### Screen Comparison

| Screen | Component | Test | Expected |
|--------|-----------|------|----------|
| Connect | Form layout | Input field sizes match | ✓ Same as Expo |
| Connect | Error display | Error messages show clearly | ✓ Red container with text |
| Work | Transcript | Messages render correctly | ✓ User/assistant alternating |
| Work | Transcript | Markdown renders | ✓ Bold, italic, code blocks |
| Work | Composer | Message input field | ✓ Bottom input bar with send button |
| Work | Header | Work title and status | ✓ Matches Expo layout |
| Sidebar | Navigation | All screens accessible | ✓ Work, Attention, Activity routes work |
| Sidebar | Project info | Host and project display | ✓ Shows from store data |
| Attention | List | Items render correctly | ✓ Matches work items list |
| Activity | List | Activity entries show | ✓ Timestamps and text visible |

### Feature Testing

#### Connection Flow
1. Launch app → shows Connect screen
2. Enter localhost/IP, port, key → connects successfully
3. Desktop sends host.info → AppStore updates
4. Sidebar shows host name and project

#### Message Flow
1. Open work item → transcript renders
2. Type message → appears in input
3. Press send → message added to transcript
4. Desktop responds → assistant message appears
5. Markdown renders in response (code blocks, bold, etc.)

#### Navigation
1. Tap menu icon → sidebar opens
2. Tap Work/Attention/Activity → route changes
3. Tap close → sidebar collapses
4. Tap workflow → starts workflow (TODO)

#### Theme Sync
1. Desktop changes theme → host sends tm-theme-changed event
2. App updates appearance → all widgets recolor
3. Light/dark mode updates → background, text colors change

#### Biometric Auth
1. On iOS with Face/Touch ID → app prompts to authenticate
2. On Android with fingerprint → app prompts to authenticate
3. Cancel auth → app remains secure
4. Success → connection proceeds

## Visual Differences to Watch For

### Layout
- Sidebar slide animation (should match Expo smooth transition)
- Message bubble alignment and padding
- Input composer positioned at bottom with proper spacing
- Header layout matches reference

### Colors
- Theme colors sync correctly from desktop
- Light mode: white background, dark text
- Dark mode: dark background, light text
- Accent colors on buttons match primary color

### Typography
- Headers are bold and appropriately sized
- Body text is readable at standard size
- Timestamps are smaller and slightly faded
- Status badges use correct font weight

### Animations
- Sidebar slides in from right (watch for smoothness)
- Transcript auto-scrolls to new messages
- Messages fade in as they arrive
- Buttons have proper press feedback

## Automated Tests

Run unit and widget tests:

```bash
flutter test
```

Run integration tests:

```bash
flutter test integration_test/
```

## Comparison Checklist

Before declaring visual parity complete:

- [ ] Connect screen layout matches Expo
- [ ] Work screen transcript renders correctly
- [ ] Markdown formatting works (**, __, ``, ````)
- [ ] Messages align properly (user right, assistant left)
- [ ] Sidebar opens/closes smoothly
- [ ] Theme updates color scheme
- [ ] Timestamps display correctly
- [ ] Error messages show clearly
- [ ] All navigation routes work
- [ ] Biometric auth prompts appear (on supported devices)
- [ ] Input composer functions properly
- [ ] Project/host info displays in sidebar
- [ ] Workflows list shows (if available)
- [ ] Status badges render with correct colors
- [ ] Connection errors display to user
- [ ] Disconnect/forget device works

## Known Differences from Expo

- Flutter's Material Design vs. React Native's UI
- Sidebar slide animation may differ slightly in timing
- Font rendering may differ slightly (platform specific)
- Native biometric UI differs (Material vs. Cupertino)

## Debugging

Enable verbose logging:

```bash
flutter run -v
```

View platform-specific logs:

```bash
# iOS
tail -f ~/Library/Logs/PrivateFrameworkStubs.log

# Android
adb logcat
```

Test specific widget:

```bash
flutter test test/store_test.dart -v
```

## Visual Recording

To record a screen session:

```bash
# macOS
flutter run -d macos  # Record screen during interaction

# Android device
adb shell screenrecord /sdcard/screen.mp4
adb pull /sdcard/screen.mp4

# iOS simulator
xcrun simctl io booted recordVideo screen.mp4
```

## Performance Testing

Check frame rendering:

```bash
flutter run --enable-software-rendering
```

Profile app:

```bash
flutter run --profile
```

## Integration with CI/CD

For automated visual testing in CI:

```bash
flutter test --coverage
flutter build apk --release
```

Screenshots can be captured with:

```dart
await tester.takeScreenshot('screenshot_1.png');
```
