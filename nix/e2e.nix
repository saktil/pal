# Browser tests of the built UI: the test derivation plus nixpkgs' matched Chromium. Screenshots at the design's
# 1440/768/390 widths are kept in the output for review.
{
  makeFontsConf,
  dejavu_fonts,
  playwright-driver,
  tests,
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
  };
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
