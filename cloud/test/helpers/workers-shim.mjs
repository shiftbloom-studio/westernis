// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: Fabian Zimber / shiftbloom studio
//
// Lets Node load the Worker modules for unit tests:
//   - "cloudflare:workers" (imported by @cloudflare/containers) resolves to a tiny stub;
//   - the package's extensionless relative imports ("./lib/container") get their ".js".
// Import this module BEFORE dynamically importing anything from src/.
import { registerHooks } from "node:module";

const STUB = new URL("./cloudflare-workers-stub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
    if (
      specifier.startsWith(".") &&
      !/\.[cm]?js$/.test(specifier) &&
      context.parentURL?.includes("/node_modules/@cloudflare/containers/")
    ) {
      return nextResolve(`${specifier}.js`, context);
    }
    return nextResolve(specifier, context);
  },
});
