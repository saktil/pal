# Exercises the installed package itself: CLI, native/WASM probes from its closure, and the health endpoint.
{
  runCommand,
  curl,
  pal,
}:
runCommand "pal-smoke-${pal.version}"
  {
    nativeBuildInputs = [
      pal
      curl
    ];
    __darwinAllowLocalNetworking = true;
  }
  ''
    pal --version | grep -Fx 'pal ${pal.version}'
    pal --help | grep -F 'Usage: pal'
    pal probe | tee probe.jsonl
    test "$(grep -c '"ok":true' probe.jsonl)" -eq 4

    pal --port 0 --data-dir "$TMPDIR/data" > server.log 2>&1 &
    server=$!
    for _ in $(seq 100); do grep -q listening server.log && break; sleep 0.1; done
    port=$(grep -oE 'http://127\.0\.0\.1:[0-9]+' server.log | grep -oE '[0-9]+$')
    curl -fsS "http://127.0.0.1:$port/api/health" | tee health.json
    grep -F '"status":"ok"' health.json
    curl -fsS "http://127.0.0.1:$port/" | grep -F '<title>Pal</title>'
    kill -TERM "$server"
    wait "$server"
    test "$(stat -c %a "$TMPDIR/data")" = 700

    mkdir -p $out
    cp probe.jsonl health.json $out/
  ''
