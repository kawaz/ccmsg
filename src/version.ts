import { version } from "../package.json";

/** This build of ccmsg, taken from the package it is published as so that the
 * binary, the CLI and the plugin it installs never name three versions.
 *
 * It is also the daemon build `hello` and `instance.ping` report, which is what
 * makes "what a client is told" and "what was released" the same number. */
export const VERSION: string = version;
