import { version } from "../package.json";

/** This build of ccmsg, taken from the package it is published as so that the
 * binary, the CLI and the plugin it installs never name three versions. */
export const VERSION: string = version;
