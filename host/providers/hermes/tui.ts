// Hermes has no TUI: it is an api_server, not a terminal app. `tui-session`
// (Continue as chat) can only say why not.
import type { TuiQuery, TuiSession } from "../tui.ts";

export function hermesTuiSession(_q: TuiQuery): TuiSession {
  throw new Error("Hermes is an api_server, not a terminal app: nothing to continue");
}
