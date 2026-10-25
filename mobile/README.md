# Muop Android (Capacitor)

Capacitor shell that loads [https://muop.win](https://muop.win) in a WebView
(`server.url` in `capacitor.config.json`). Needs internet; always serves the
deployed version. File inputs on the site open the Android file picker.

## Build the APK

Requires JDK 21 and the Android SDK (platform 35, build-tools 35).

```bash
cd mobile
export JAVA_HOME=<jdk-21> ANDROID_SDK_ROOT=<android-sdk>
echo "sdk.dir=$ANDROID_SDK_ROOT" > android/local.properties
cd android && ./gradlew assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk (debug-signed, sideloadable)
```

For a Play Store release build, create a keystore and run
`./gradlew assembleRelease` with signing configured in `android/app/build.gradle`.
This machine's toolchain used here lives in `~/.local/share/android-dev/`
(JDK 21 + SDK, not committed).
