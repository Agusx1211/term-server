import { render } from "preact";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import { configurePwaIdentity, registerPwaWorker } from "./lib/pwa";
import "./styles.css";

configurePwaIdentity();
registerPwaWorker();
render(<App />, document.getElementById("app")!);
