# Browser tests of the built UI: the test derivation plus nixpkgs' matched Chromium. Screenshots at the design's
# 1440/768/390 widths are kept in the output for review.
{
  lib,
  bash,
  makeFontsConf,
  dejavu_fonts,
  playwright-driver,
  tests,
  pal,
}:
tests.overrideAttrs {
  pname = "pal-e2e";
  env = {
    PLAYWRIGHT_BROWSERS_PATH = playwright-driver.browsers.override {
      withFirefox = false;
      withWebkit = false;
      withFfmpeg = false;
    };
    # The build sandbox has no font configuration, without which Chromium renders no text at all.
    FONTCONFIG_FILE = makeFontsConf { fontDirectories = [ dejavu_fonts ]; };
    # The packaged owner browser runtime, so its sandbox and egress are tested with the exact programs Pal ships.
    PAL_BASH = lib.getExe bash;
  }
  // pal.browserEnv;
  buildPhase = ''
    runHook preBuild
    pnpm build
    PAL_E2E_SCREENSHOTS=$PWD/screenshots pnpm test:e2e
    runHook postBuild
  '';
  installPhase = ''
    mkdir -p $out
    cp -r screenshots $out/
  '';
}
