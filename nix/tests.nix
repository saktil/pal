{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  pnpmConfigHook,
  autoPatchelfHook,
  node-gyp,
  python3,
  git,
  pal,
  sourceRoot ? ../.,
}:
let
  root = sourceRoot;
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
      (root + "/vitest.feasibility.config.ts")
      (root + "/vitest.e2e.config.ts")
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
    node-gyp
    python3
    git
  ]
  ++ lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;
  __darwinAllowLocalNetworking = true;
  env = pal.releaseEnv;

  # Build node-pty and patch the prebuilt native libraries the tests load, as the package does; scripts need real shebangs.
  preBuild = ''
    patchShebangs scripts
    ${pal.buildNodePty}
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
