import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target === null) throw new Error("missing #app mount point");
mount(App, { target });
