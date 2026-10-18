#!/usr/bin/env bash
# Dijalankan setelah "npx cap add android": layar landscape penuh, tetap menyala, izinkan koneksi ws://
set -e
A=android/app/src/main
MAN=$A/AndroidManifest.xml
STY=$A/res/values/styles.xml

# Landscape (mengikuti sensor) + tidak restart saat rotasi
sed -i 's|<activity|<activity android:screenOrientation="sensorLandscape"|' "$MAN"
# Izinkan lalu lintas ws:// (server LAN/tanpa HTTPS)
grep -q usesCleartextTraffic "$MAN" || sed -i 's|<application|<application android:usesCleartextTraffic="true"|' "$MAN"

# Layar penuh, tanpa status bar, mengisi area poni
python3 - "$STY" <<'PY'
import sys,re
p=sys.argv[1];s=open(p,encoding='utf8').read()
add='''
        <item name="android:windowFullscreen">true</item>
        <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
        <item name="android:keepScreenOn">true</item>
        <item name="android:windowBackground">@android:color/black</item>
        <item name="android:navigationBarColor">@android:color/black</item>
        <item name="android:statusBarColor">@android:color/black</item>'''
s=re.sub(r'(<style name="AppTheme.NoActionBar"[^>]*>)',lambda m:m.group(1)+add,s,count=1)
open(p,'w',encoding='utf8').write(s)
PY

# Layar penuh sungguhan: sembunyikan bar navigasi/status (mode imersif) dan isi area poni.
# Tanpa ini, HP tertentu menyisakan pita abu-abu di tepi dan bar hitam di bawah, sehingga layar tampak "mengecil".
MA_FILE=$(find android/app/src/main/java -name MainActivity.java | head -n 1)
if [ -n "$MA_FILE" ]; then
  PKG=$(grep -m1 '^package ' "$MA_FILE" | sed 's/^package \(.*\);.*/\1/')
  cat > "$MA_FILE" <<JAVA
package $PKG;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= 28) {
      WindowManager.LayoutParams lp = getWindow().getAttributes();
      lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      getWindow().setAttributes(lp);
    }
    hideBars();
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) hideBars();
  }

  @SuppressWarnings("deprecation")
  private void hideBars() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        | View.SYSTEM_UI_FLAG_FULLSCREEN
        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  }
}
JAVA
  echo "MainActivity imersif dipasang di $MA_FILE"
fi
echo "Patch Android selesai"
