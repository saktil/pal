{
  lib,
  stdenv,
  nodejs_24,
  pnpm_11,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  bash,
  coreutils,
  git,
  autoPatchelfHook,
  node-gyp,
  python3,
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
  # pnpm installs with --ignore-scripts, so node-pty is compiled here against this Node. Its prebuilds
  # (darwin/win32 only; 1.1.0's darwin spawn-helper lacks the executable bit) and Windows sources are dropped.
  buildNodePty = ''
    pushd node_modules/node-pty
    node-gyp rebuild --nodedir=${nodejs_24}
    node scripts/post-install.js
    rm -rf prebuilds third_party deps
    popd
  '';
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
    hash = "sha256-frxbvWkBTq+cd/EkeTasFpn0+3chbgxhwCjqY1LRbR4=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_11
    pnpmConfigHook
    makeWrapper
    node-gyp
    python3
  ]
  # Prebuilt fff/ffi-rs libraries are generic glibc binaries; point them at Nix's libraries.
  ++ lib.optional stdenv.hostPlatform.isLinux autoPatchelfHook;
  buildInputs = lib.optional stdenv.hostPlatform.isLinux stdenv.cc.cc.lib;

  buildPhase = ''
    runHook preBuild
    ${buildNodePty}
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    pnpm prune --prod --ignore-scripts
    mkdir -p $out/lib/pal $out/bin
    cp -r dist node_modules package.json $out/lib/pal/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/pal --add-flags $out/lib/pal/dist/main.js \
      --prefix PATH : ${lib.makeBinPath [ bash coreutils git nodejs_24 ]} \
      --set PAL_BASH ${lib.getExe bash} --set PAL_TIMEOUT ${coreutils}/bin/timeout
    runHook postInstall
  '';

  passthru = {
    inherit (finalAttrs) pnpmDeps;
    inherit buildNodePty;
  };

  meta = {
    description = "A durable, workspace-first personal AI application";
    mainProgram = "pal";
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
})
