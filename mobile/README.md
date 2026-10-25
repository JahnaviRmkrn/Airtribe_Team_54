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

For a signed release build (the only APK that may be offered for download —
debug builds are debuggable and debug-signed):

```bash
keytool -genkeypair -v -keystore muop-release.jks -alias muop \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 muop-release.jks   # keep the .jks itself out of git, forever
```

Set these GitHub Actions secrets: `MUOP_KEYSTORE_BASE64` (output above),
`MUOP_KEYSTORE_PASSWORD`, `MUOP_KEY_ALIAS` (`muop`), `MUOP_KEY_PASSWORD`.
CI then builds `app-release.apk` alongside the debug APK. Locally, export
the same four values as env vars (`MUOP_KEYSTORE_FILE` = path to the .jks)
and run `./gradlew assembleRelease`.
This machine's toolchain used here lives in `~/.local/share/android-dev/`
(JDK 21 + SDK, not committed).
