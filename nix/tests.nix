# Runs the repository's own static checks, test suite and build offline from the same pinned dependencies.
{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  autoPatchelfHook,
  git,
  pal,
}:
let
  root = ../.;
in
stdenv.mkDerivation {
  pname = "pal-tests";
  inherit (pal) version pnpmDeps;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/tsconfig.json")
      (root + "/vite.config.ts")
      (root + "/vitest.config.ts")
      (root + "/eslint.config.js")
      (root + "/.prettierrc.json")
      (root + "/.prettierignore")
      (root + "/src")
      (root + "/web")
      (root + "/test")
      (root + "/scripts")
    ];
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    git
  ]
  ++ lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;
  __darwinAllowLocalNetworking = true;

  # Patch the prebuilt native libraries the tests load (the package does this at fixup); scripts need real shebangs.
  preBuild = ''
    patchShebangs scripts
  ''
  + lib.optionalString stdenv.hostPlatform.isLinux ''
    autoPatchelf node_modules
  '';

  buildPhase = ''
    runHook preBuild
    pnpm check
    pnpm test
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    touch $out
  '';
}
