{
  lib,
  stdenv,
  bun,
  nodejs,
  darwin,
  electron_41,
  makeWrapper,
  writableTmpDirAsHomeHook,
  autoPatchelfHook,
  copyDesktopItems,
  makeDesktopItem,
  zaovra,
}:
let
  electron = electron_41;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "zaovra-desktop";
  inherit (zaovra)
    version
    src
    node_modules
    patches
    ;

  nativeBuildInputs = [
    bun
    nodejs
    makeWrapper
    writableTmpDirAsHomeHook
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    autoPatchelfHook
    copyDesktopItems
  ]
  ++ lib.optionals stdenv.hostPlatform.isDarwin [
    # Ad-hoc sign the .app: --config.mac.identity=null below skips signing.
    darwin.autoSignDarwinBinariesHook
  ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    (lib.getLib stdenv.cc.cc)
  ];

  desktopItems = lib.optional stdenv.hostPlatform.isLinux (makeDesktopItem {
    name = "ai.zaovra.desktop";
    desktopName = "Zaovra";
    exec = "zaovra-desktop %U";
    icon = "ai.zaovra.desktop";
    # Electron 41 derives X11 WM_CLASS from app.name.
    startupWMClass = "Zaovra";
    categories = [ "Development" ];
  });

  env = zaovra.env // {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };

  postPatch =
    # NOTE: Relax Bun version check to be a warning instead of an error
    ''
      substituteInPlace packages/script/src/index.ts \
        --replace-fail 'throw new Error(`This script requires bun@''${expectedBunVersionRange}' \
                       'console.warn(`Warning: This script requires bun@''${expectedBunVersionRange}'
    ''
    # https://github.com/electron/electron/issues/31121
    # mac builds use a .app bundle which doesnt have this issue
    + lib.optionalString stdenv.isLinux ''
      BASE_PATH=packages/desktop
      FILES=(src/main/windows.ts)
      for file in "''${FILES[@]}"; do
        substituteInPlace $BASE_PATH/$file \
          --replace-fail "process.resourcesPath" "'$out/opt/zaovra-desktop/resources'"
      done
    '';

  preBuild = ''
    cp -r "${electron.dist}" $HOME/.electron-dist
    chmod -R u+w $HOME/.electron-dist

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules
  '';

  buildPhase = ''
    runHook preBuild

    cd packages/desktop

    bun run build
    npx electron-builder --dir \
      --config electron-builder.config.ts \
      --config.mac.identity=null \
      --config.electronDist="$HOME/.electron-dist"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
  ''
  + lib.optionalString stdenv.hostPlatform.isDarwin ''
    mkdir -p $out/Applications
    mv dist/mac*/*.app $out/Applications
    makeWrapper "$out/Applications/Zaovra.app/Contents/MacOS/Zaovra" $out/bin/zaovra-desktop
  ''
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    mkdir -p $out/opt/zaovra-desktop
    cp -r dist/linux*-unpacked/{resources,LICENSE*} $out/opt/zaovra-desktop
    install -Dm644 resources/icons/32x32.png \
      "$out/share/icons/hicolor/32x32/apps/ai.zaovra.desktop.png"
    install -Dm644 resources/icons/64x64.png \
      "$out/share/icons/hicolor/64x64/apps/ai.zaovra.desktop.png"
    install -Dm644 resources/icons/128x128.png \
      "$out/share/icons/hicolor/128x128/apps/ai.zaovra.desktop.png"
    install -Dm644 resources/icons/128x128@2x.png \
      "$out/share/icons/hicolor/256x256/apps/ai.zaovra.desktop.png"
    install -Dm644 resources/icons/icon.png \
      "$out/share/icons/hicolor/512x512/apps/ai.zaovra.desktop.png"
    install -Dm644 resources/ai.zaovra.desktop.metainfo.xml \
      "$out/share/metainfo/ai.zaovra.desktop.metainfo.xml"
    makeWrapper ${lib.getExe electron} $out/bin/zaovra-desktop \
     --inherit-argv0 \
     --set ELECTRON_FORCE_IS_PACKAGED 1 \
     --add-flags $out/opt/zaovra-desktop/resources/app.asar \
     --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}"
  ''
  + ''
    runHook postInstall
  '';

  autoPatchelfIgnoreMissingDeps = [
    "libc.musl-x86_64.so.1"
  ];

  meta = {
    description = "Zaovra Desktop App";
    mainProgram = "zaovra-desktop";
    inherit (zaovra.meta) homepage license platforms;
  };
})
