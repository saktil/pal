{
  description = "Pal: a durable, workspace-first personal AI application";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    devenv.url = "github:cachix/devenv/v2.4.0";
  };

  outputs =
    {
      self,
      nixpkgs,
      devenv,
      ...
    }@inputs:
    let
      # Only systems with a builder that has evaluated and tested these outputs.
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems (pkgs: {
        default = pkgs.callPackage ./nix/package.nix { };
      });

      apps = forSystems (pkgs: {
        default = {
          type = "app";
          program = pkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      checks = forSystems (
        pkgs:
        let
          pal = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        {
          package = pal;
          smoke = pkgs.callPackage ./nix/smoke.nix { inherit pal; };
          tests = pkgs.callPackage ./nix/tests.nix { inherit pal; };
        }
        # Chromium's macOS sandbox cannot start inside Nix's darwin build sandbox, and disabling it is not an option.
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          browser = pkgs.callPackage ./nix/browser.nix { inherit pal; };
        }
      );

      devShells = forSystems (pkgs: {
        default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [ ./devenv.nix ];
        };
      });
    };
}
