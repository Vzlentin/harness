#!/usr/bin/env node
// Node does not strip types under node_modules, where harness lives as a dependency of workflows. jiti compiles the
// source wherever the install is.
import { createJiti } from "jiti";

await createJiti(import.meta.url).import("../src/cli.ts");
