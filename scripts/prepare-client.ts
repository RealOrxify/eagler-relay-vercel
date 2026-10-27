// bun run client path/to/eaglercraft26-3.html
// Copies the single-file 26.3 client into public/play/index.html and makes the page
// default to the relay on its own origin (wss://<your-vercel-domain>/), so players
// don't have to add a relay by hand. Saved relay lists in the browser still win.
const src = process.argv[2];
if (!src) {
  console.error("Usage: bun run client path/to/eaglercraft26-3.html");
  process.exit(2);
}
const MARKER = "window.eaglercraftXOpts = {";
const INJECT = `${MARKER}
\t\t\t// Injected by eagler-relay-vercel: use this site as the default relay.
\t\t\trelays: (function () {
\t\t\t\tvar p = window.location.protocol;
\t\t\t\tif (p !== "https:" && p !== "http:") return undefined;
\t\t\t\treturn [{ addr: (p === "https:" ? "wss://" : "ws://") + window.location.host + "/", comment: "This site (26.3 relay)", primary: true }];
\t\t\t})(),`;

let html = await Bun.file(src).text();
if (!html.includes("Eaglercraft 26.3")) console.warn("warning: this doesn't look like a 26.3 build (title check failed)");
if (html.includes("Injected by eagler-relay-vercel")) {
  console.log("already patched, copying as-is");
} else {
  const count = html.split(MARKER).length - 1;
  if (count !== 1) {
    console.error(`expected exactly one "${MARKER}" in the client, found ${count}; copying unpatched`);
  } else {
    html = html.replace(MARKER, INJECT);
  }
}
await Bun.write("public/play/index.html", html);
console.log(`wrote public/play/index.html (${(html.length / 1048576).toFixed(1)} MB)`);
