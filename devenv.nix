{ pkgs, ... }:
{
  # Node and pnpm come from the flake's nixpkgs so the shell, package and checks share one ABI.
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      package = pkgs.pnpm_11;
    };
  };

  packages = [ pkgs.git ];

  # `devenv up`: API server on 7338 plus Vite on 5173, which forwards /api to it.
  processes.pal.exec = "pnpm dev";
}
