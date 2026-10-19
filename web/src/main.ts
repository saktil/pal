import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { shownTheme } from "./lib/state.svelte.ts";

const target = document.querySelector("#app");
if (target === null) throw new Error("missing #app mount point");
// Before the first paint, so a light choice never flashes dark.
document.documentElement.dataset.theme = shownTheme();
mount(App, { target });
