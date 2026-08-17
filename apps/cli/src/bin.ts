#!/usr/bin/env node
/**
 * Executable entry. Checks the Node baseline before loading anything else, then
 * defers to the real CLI through a dynamic import.
 *
 * Static imports are hoisted and evaluated before module body code, so a guard
 * placed alongside them would run too late to report a useful message. Dynamic
 * import delays evaluation until after the check has passed.
 */
import { assertSupportedNode } from "./node-guard.js";

assertSupportedNode();

await import("./main.js");
