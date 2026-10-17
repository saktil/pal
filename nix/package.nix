{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  autoPatchelfHook,
}:
let
  root = ../.;
  # Explicit whitelist: private handoff docs, .design, credentials and runtime data never enter a derivation.
  manifests = [
    (root + "/package.json")
    (root + "/pnpm-lock.yaml")
    (root + "/pnpm-workspace.yaml")
  ];
  appFiles = manifests ++ [
    (root + "/tsconfig.json")
    (root + "/vite.config.ts")
    (root + "/src")
    (root + "/web")
  ];
in
stdenv.mkDerivation (finalAttrs: {
  pname = "pal";
  version = (lib.importJSON (root + "/package.json")).version;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions appFiles;
  };

  pnpmDeps = fetchPnpmDeps {
    pname = "pal";
    # Only the manifests decide the dependency set, so source edits do not change this hash.
    src = lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions manifests;
    };
    pnpm = pnpm_11;
    fetcherVersion = 4;
    hash = "sha256-wPtvGwL40FQTF7P0Ce3eg/pyo+C+Lza1Y8trZi5HwbQ=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    makeWrapper
  ]
  # Prebuilt fff/ffi-rs libraries are generic glibc binaries; point them at Nix's libraries.
  ++ lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    pnpm prune --prod --ignore-scripts
    mkdir -p $out/lib/pal $out/bin
    cp -r dist node_modules package.json $out/lib/pal/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/pal --add-flags $out/lib/pal/dist/main.js
    runHook postInstall
  '';

  passthru = { inherit (finalAttrs) pnpmDeps; };

  meta = {
    description = "A durable, workspace-first personal AI application";
    mainProgram = "pal";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
})
