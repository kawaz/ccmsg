import { HYOUI_TERMINAL_SCHEME } from "@ccmsg/protocol";

/** The command each terminal scheme is managed by, which is what a terminal's
 * id decides: the scheme says which manager observed it (contract, DR-0026),
 * and only that manager can be asked anything about it.
 *
 * One entry, because one manager is what this instance can speak to. A terminal
 * of any other scheme — one a peer stated, one a manager this host does not
 * have — is one nothing here can act on, and is refused rather than handed to
 * whichever command happens to be installed. */
export const HYOUI_COMMAND = "hyoui";
const MANAGERS: Record<string, string> = { [HYOUI_TERMINAL_SCHEME]: HYOUI_COMMAND };

/** A terminal as the wire names it: the scheme, and the handle its manager
 * knows it by. Composed in one place so that a terminal reached from a run and
 * the same terminal on the `terminals` list are one id. */
export function terminalId(scheme: string, handle: string): string {
  return `${scheme}:${handle}`;
}

/** The command that manages this terminal and the handle to name it by, or
 * nothing where no manager here can act on it — a terminal whose id carries no
 * scheme, or one whose scheme is a manager this instance does not speak to. */
export function managerOf(id: string): { command: string; handle: string } | undefined {
  const at = id.indexOf(":");
  if (at <= 0) return undefined;
  const command = MANAGERS[id.slice(0, at)];
  const handle = id.slice(at + 1);
  return command === undefined || handle === "" ? undefined : { command, handle };
}
