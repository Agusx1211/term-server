import { render } from "preact";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import "./styles.css";

render(<App />, document.getElementById("app")!);
